import sql from 'mssql';
import type { ConnectionParams, SessionDTO } from '@repnode/shared';
import { describeSqlError, HttpError } from '../errors.ts';
import { settings } from '../store/sqlite.ts';
import { buildMssqlConfig } from './config.ts';
import { loadCatalog, type Catalog } from './catalog.ts';

export interface Session {
  profileId: string;
  params: ConnectionParams;
  password: string;
  pool: sql.ConnectionPool;
  catalog: Catalog;
  serverVersion: string;
}

let current: Session | null = null;

const REQUIRED_OBJECTS = ['Source', 'Quantity', 'SourceQuantity', 'DataLog2', 'vwDataLog2'];

async function openPool(params: ConnectionParams, password: string): Promise<{ pool: sql.ConnectionPool; version: string }> {
  const s = settings.get();
  const pool = new sql.ConnectionPool(
    buildMssqlConfig(params, password, { poolMax: Math.max(8, s.concurrency * 2), requestTimeoutMs: s.requestTimeoutSeconds * 1000 }),
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

export async function connect(profileId: string, params: ConnectionParams, password: string): Promise<Session> {
  const { pool, version } = await openPool(params, password);
  let catalog: Catalog;
  try {
    catalog = await loadCatalog(pool);
  } catch (err) {
    await pool.close().catch(() => {});
    throw new HttpError(500, `Error leyendo el catálogo: ${describeSqlError(err)}`, 'catalog_failed');
  }
  await disconnect();
  current = { profileId, params, password, pool, catalog, serverVersion: version };
  return current;
}

export async function disconnect(): Promise<void> {
  const s = current;
  current = null;
  if (s) await s.pool.close().catch(() => {});
}

export async function refreshCatalog(): Promise<Catalog> {
  const s = requireSession();
  s.catalog = await loadCatalog(s.pool);
  return s.catalog;
}

export function getSession(): Session | null {
  return current;
}

export function requireSession(): Session {
  if (!current) throw new HttpError(409, 'No hay conexión activa con SQL Server', 'not_connected');
  return current;
}

export function sessionDTO(): SessionDTO {
  const s = current;
  return {
    connected: !!s,
    profileId: s?.profileId ?? null,
    server: s ? s.params.server + (s.params.instance ? `\\${s.params.instance}` : s.params.port ? `,${s.params.port}` : '') : null,
    database: s?.params.database ?? null,
    username: s ? (s.params.authType === 'ntlm' && s.params.domain ? `${s.params.domain}\\` : '') + s.params.username : null,
    serverVersion: s?.serverVersion ?? null,
  };
}
