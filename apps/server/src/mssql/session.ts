import sql from 'mssql';
import type { FastifyRequest } from 'fastify';
import { pmeDisplayName, type ConnectionParams, type SessionDTO } from '@repnode/shared';
import { runtimeConfig } from '../config.ts';
import { describeSqlError, HttpError } from '../errors.ts';
import { settings } from '../store/sqlite.ts';
import { buildMssqlConfig } from './config.ts';
import { loadCatalog, type Catalog } from './catalog.ts';

/**
 * Conexión SQL de una sesión de usuario: cada usuario tiene su propio pool (ver sessions/registry.ts). El catálogo es
 * de solo lectura y se comparte entre las sesiones que apuntan a la misma base con el mismo login.
 */
export interface Session {
  profileId: string;
  params: ConnectionParams;
  password: string;
  pool: sql.ConnectionPool;
  readonly catalog: Catalog;
  serverVersion: string;
  /** Clave del catálogo compartido. */
  catalogKey: string;
}

const catalogs = new Map<string, { catalog: Catalog; refs: number }>();

function catalogKeyFor(profileId: string, p: ConnectionParams): string {
  return [profileId, p.server, p.port ?? '', p.instance ?? '', p.database, p.domain ?? '', p.username].join('|').toLowerCase();
}

const REQUIRED_OBJECTS = ['Source', 'Quantity', 'SourceQuantity', 'DataLog2', 'vwDataLog2'];

async function openPool(params: ConnectionParams, password: string): Promise<{ pool: sql.ConnectionPool; version: string }> {
  const s = settings.get();
  const pool = new sql.ConnectionPool(
    buildMssqlConfig(params, password, {
      poolMax: runtimeConfig.sessionPoolMax ?? Math.max(8, s.concurrency * 2),
      requestTimeoutMs: s.requestTimeoutSeconds * 1000,
    }),
  );
  try {
    await pool.connect();
  } catch (err) {
    await pool.close().catch(() => {});
    throw new HttpError(400, describeSqlError(err), 'connect_failed');
  }
  try {
    const info = await pool.request().query<{ v: string; major: number; db: string }>(
      "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, CAST(PARSENAME(CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)), 4) AS int) AS major, DB_NAME() AS db",
    );
    const { v, major } = info.recordset[0];
    if (major < 13) throw new HttpError(400, `SQL Server ${v} no soportado (se requiere 2016 o superior)`, 'unsupported_version');

    const objs = await pool.request().query<{ name: string }>(
      `SELECT name FROM sys.objects WHERE schema_id = SCHEMA_ID('dbo') AND name IN (${REQUIRED_OBJECTS.map((o) => `'${o}'`).join(',')})`,
    );
    const found = new Set(objs.recordset.map((r) => r.name));
    const missing = REQUIRED_OBJECTS.filter((o) => !found.has(o));
    if (missing.length) {
      throw new HttpError(400, `La base de datos "${params.database}" no parece ser ION_Data de PME (faltan: ${missing.join(', ')})`, 'invalid_database');
    }
    return { pool, version: v };
  } catch (err) {
    await pool.close().catch(() => {});
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, describeSqlError(err), 'connect_failed');
  }
}

/** Prueba la conexión sin dejarla activa. */
export async function testConnection(params: ConnectionParams, password: string): Promise<string> {
  const { pool, version } = await openPool(params, password);
  await pool.close();
  return version;
}

/** Abre el pool de una sesión. Si otra sesión ya tiene el catálogo de esa base, lo reutiliza. */
export async function openSqlSession(profileId: string, params: ConnectionParams, password: string): Promise<Session> {
  const { pool, version } = await openPool(params, password);
  const key = catalogKeyFor(profileId, params);
  let entry = catalogs.get(key);
  if (!entry) {
    try {
      entry = { catalog: await loadCatalog(pool), refs: 0 };
    } catch (err) {
      await pool.close().catch(() => {});
      throw new HttpError(500, `Error leyendo el catálogo: ${describeSqlError(err)}`, 'catalog_failed');
    }
    // Otra sesión pudo cargarlo mientras tanto: se usa una sola copia
    entry = catalogs.get(key) ?? entry;
    catalogs.set(key, entry);
  }
  entry.refs++;
  return {
    profileId,
    params,
    password,
    pool,
    serverVersion: version,
    catalogKey: key,
    get catalog() {
      return catalogs.get(key)!.catalog;
    },
  };
}

export async function closeSqlSession(s: Session): Promise<void> {
  const entry = catalogs.get(s.catalogKey);
  if (entry && --entry.refs <= 0) catalogs.delete(s.catalogKey);
  await s.pool.close().catch(() => {});
}

/** Recarga el catálogo; lo ven todas las sesiones que lo comparten. */
export async function refreshCatalog(s: Session): Promise<Catalog> {
  const catalog = await loadCatalog(s.pool);
  const entry = catalogs.get(s.catalogKey);
  if (entry) entry.catalog = catalog;
  else catalogs.set(s.catalogKey, { catalog, refs: 1 });
  return catalog;
}

/** Conexión SQL de la sesión del usuario que hace la petición. */
export function requireSession(req: FastifyRequest): Session {
  const s = req.userSession?.sql;
  if (!s) throw new HttpError(409, 'No hay conexión activa con SQL Server', 'not_connected');
  return s;
}

export function sessionDTO(req: FastifyRequest): SessionDTO {
  const u = req.userSession;
  const s = u?.sql ?? null;
  return {
    mode: runtimeConfig.authMode,
    user: u?.user ? pmeDisplayName(u.user) : null,
    idleMinutes: Math.round(runtimeConfig.sessionIdleMs / 60_000),
    connected: !!s,
    profileId: s?.profileId ?? null,
    server: s ? s.params.server + (s.params.instance ? `\\${s.params.instance}` : s.params.port ? `,${s.params.port}` : '') : null,
    database: s?.params.database ?? null,
    username: s ? (s.params.authType === 'ntlm' && s.params.domain ? `${s.params.domain}\\` : '') + s.params.username : null,
    serverVersion: s?.serverVersion ?? null,
  };
}
