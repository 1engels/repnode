import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { connectionParamsSchema, connectRequestSchema, type ProductionStatusDTO, type ProfileDTO } from '@repnode/shared';
import { HttpError } from '../errors.ts';
import { runtimeConfig } from '../config.ts';
import { createAttemptLimiter } from '../http/rate-limit.ts';
import { openSqlSession, sessionDTO, testConnection } from '../mssql/session.ts';
import { parseProductionEnv } from '../production.ts';
import { decryptSecret, encryptSecret, idForNewProfile, profileIdFor } from '../security/secrets.ts';
import type { SessionRegistry } from '../sessions/registry.ts';
import { profiles, type StoredProfile } from '../store/sqlite.ts';

const testSchema = z.union([
  z.object({ params: connectionParamsSchema, password: z.string(), profileId: z.string().optional(), clientSecret: z.string().optional() }),
  z.object({ profileId: z.string(), clientSecret: z.string() }),
]);

function toDTO(p: StoredProfile): ProfileDTO {
  return { ...p.params, id: p.id, name: p.name, hasStoredPassword: !!p.secret, lastUsedAt: p.lastUsedAt };
}

function defaultName(p: z.infer<typeof connectionParamsSchema>): string {
  return `${p.database} @ ${p.server}${p.instance ? `\\${p.instance}` : ''}`;
}

function describeTarget(p: z.infer<typeof connectionParamsSchema>): string {
  return `${p.server}${p.port ? `,${p.port}` : p.instance ? `\\${p.instance}` : ''} · ${p.database}`;
}

/** Resultado de la última comprobación de la conexión de producción; se reutiliza un minuto. */
const PRODUCTION_CHECK_TTL_MS = 60_000;
let productionCheck: { at: number; promise: Promise<ProductionStatusDTO> } | null = null;

async function checkProduction(): Promise<ProductionStatusDTO> {
  const env = parseProductionEnv(process.env);
  const checkedAt = new Date().toISOString();
  if (!env.ok) {
    return { configured: false, missing: env.missing, available: false, target: null, username: null, serverVersion: null, error: env.error, checkedAt };
  }
  const base = { configured: true, missing: [], target: describeTarget(env.params), username: env.params.username, checkedAt };
  try {
    const version = await testConnection(env.params, env.password);
    return { ...base, available: true, serverVersion: version, error: null };
  } catch (err) {
    return { ...base, available: false, serverVersion: null, error: (err as Error).message };
  }
}

function productionStatus(refresh: boolean): Promise<ProductionStatusDTO> {
  if (refresh || !productionCheck || Date.now() - productionCheck.at > PRODUCTION_CHECK_TTL_MS) {
    productionCheck = { at: Date.now(), promise: checkProduction() };
  }
  return productionCheck.promise;
}

/** Conexiones manuales fallidas: 10 por IP cada 5 minutos. */
const attempts = createAttemptLimiter({ max: 10, windowMs: 5 * 60_000 });

export default async function connectionRoutes(app: FastifyInstance, opts: { masterKey: Buffer; registry: SessionRegistry }) {
  const { masterKey, registry } = opts;

  /**
   * Conexión con credenciales escritas por el usuario. En modo pme no existe: todos usan la cuenta de servicio
   * (variables REPNODE_*) y ningún usuario de PME ve ni ingresa credenciales de SQL Server.
   */
  async function manual<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
    if (runtimeConfig.authMode === 'pme') {
      throw new HttpError(403, 'En RepNode embebido en PME la conexión a SQL Server es la del servidor', 'manual_connection_disabled');
    }
    const wait = attempts.retryAfterMs(req.ip);
    if (wait > 0) {
      throw new HttpError(429, `Demasiados intentos fallidos. Espera ${Math.ceil(wait / 60_000)} min antes de volver a intentar.`, 'too_many_attempts');
    }
    try {
      const result = await fn();
      attempts.reset(req.ip);
      return result;
    } catch (err) {
      if (err instanceof HttpError && ['connect_failed', 'decrypt_failed'].includes(err.code)) attempts.fail(req.ip);
      throw err;
    }
  }

  /** Abre el pool del usuario que hace la petición y cierra el anterior. */
  async function connect(req: FastifyRequest, profileId: string, params: z.infer<typeof connectionParamsSchema>, password: string): Promise<void> {
    await registry.setSql(req.userSession!, await openSqlSession(profileId, params, password));
  }

  function unlock(profileId: string, clientSecret: string) {
    const p = profiles.get(profileId);
    if (!p || !p.secret) throw new HttpError(404, 'El perfil no existe o no tiene contraseña guardada; ingrésala de nuevo', 'profile_not_found');
    try {
      return { profile: p, password: decryptSecret(masterKey, clientSecret, p.id, p.secret) };
    } catch {
      throw new HttpError(401, 'No se pudo descifrar la contraseña guardada (¿se borraron los datos del navegador?). Ingrésala de nuevo.', 'decrypt_failed');
    }
  }

  /** Contraseña escrita o, si se edita un perfil y se dejó vacía, la guardada. */
  function resolvePassword(password: string, profileId?: string, clientSecret?: string): string {
    if (password || !profileId || !clientSecret) return password;
    return profiles.get(profileId)?.secret ? unlock(profileId, clientSecret).password : password;
  }

  app.get('/api/session', async (req) => sessionDTO(req));

  app.post('/api/connection/test', async (req) => manual(req, async () => {
    const body = testSchema.parse(req.body);
    const version = 'params' in body
      ? await testConnection(body.params, resolvePassword(body.password, body.profileId, body.clientSecret))
      : await (async () => {
          const { profile, password } = unlock(body.profileId, body.clientSecret);
          return testConnection(profile.params, password);
        })();
    return { ok: true, version };
  }));

  app.post('/api/connection/connect', async (req) => manual(req, async () => {
    const body = connectRequestSchema.parse(req.body);
    let profile: ProfileDTO | null = null;

    if ('params' in body) {
      const params = { ...body.params, name: body.params.name || defaultName(body.params) };
      // Editar un perfil conserva su ID: los reportes, tags y jerarquías siguen asociados aunque cambie el servidor.
      const id = body.profileId ?? idForNewProfile(params, profiles.list());
      const password = resolvePassword(body.password, body.profileId, body.clientSecret);
      await connect(req, id, params, password);
      if (body.remember || body.profileId) {
        if (!body.clientSecret) throw new HttpError(400, 'Falta el secreto de cliente para recordar la conexión', 'missing_client_secret');
        profiles.upsert(id, params.name, params, encryptSecret(masterKey, body.clientSecret, id, password));
        profile = toDTO(profiles.get(id)!);
      } else {
        profile = { ...params, id, name: params.name, hasStoredPassword: false, lastUsedAt: null };
      }
    } else {
      const { profile: stored, password } = unlock(body.profileId, body.clientSecret);
      await connect(req, stored.id, stored.params, password);
      profiles.touch(stored.id);
      profile = toDTO(profiles.get(stored.id)!);
    }
    return { session: sessionDTO(req), profile };
  }));

  app.get<{ Querystring: { refresh?: string } }>('/api/connection/production', async (req) => productionStatus(req.query.refresh === '1'));

  app.post('/api/connection/production/connect', async (req) => {
    const env = parseProductionEnv(process.env);
    if (!env.ok) {
      throw new HttpError(400, env.error ?? `Faltan variables de entorno: ${env.missing.join(', ')}`, 'production_not_configured');
    }
    // Reutiliza el ID de una conexión recordada con los mismos datos, para compartir sus reportes, tags y jerarquías
    const hash = profileIdFor(env.params);
    const id = profiles.list().find((p) => profileIdFor(p.params) === hash)?.id ?? hash;
    try {
      await connect(req, id, env.params, env.password);
    } catch (err) {
      productionCheck = null;
      throw err;
    }
    return { session: sessionDTO(req) };
  });

  app.post('/api/connection/disconnect', async (req) => {
    await registry.setSql(req.userSession!, null);
    return sessionDTO(req);
  });

  app.get('/api/profiles', async (req) => manual(req, async () => profiles.list().map(toDTO)));

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => manual(req, async () => {
    profiles.remove(req.params.id);
    return { ok: true };
  }));
}
