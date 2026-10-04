import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectionParamsSchema, connectRequestSchema, type ProfileDTO } from '@repnode/shared';
import { HttpError } from '../errors.ts';
import { connect, disconnect, sessionDTO, testConnection } from '../mssql/session.ts';
import { decryptSecret, encryptSecret, profileIdFor } from '../security/secrets.ts';
import { profiles, type StoredProfile } from '../store/sqlite.ts';
import { clearValidationCache } from '../validate.ts';

const testSchema = z.union([
  z.object({ params: connectionParamsSchema, password: z.string() }),
  z.object({ profileId: z.string(), clientSecret: z.string() }),
]);

function toDTO(p: StoredProfile): ProfileDTO {
  return { ...p.params, id: p.id, name: p.name, hasStoredPassword: !!p.secret, lastUsedAt: p.lastUsedAt };
}

function defaultName(p: z.infer<typeof connectionParamsSchema>): string {
  return `${p.database} @ ${p.server}${p.instance ? `\\${p.instance}` : ''}`;
}

export default async function connectionRoutes(app: FastifyInstance, opts: { masterKey: Buffer }) {
  const { masterKey } = opts;

  function unlock(profileId: string, clientSecret: string) {
    const p = profiles.get(profileId);
    if (!p || !p.secret) throw new HttpError(404, 'El perfil no existe o no tiene contraseña guardada; ingrésala de nuevo', 'profile_not_found');
    try {
      return { profile: p, password: decryptSecret(masterKey, clientSecret, p.id, p.secret) };
    } catch {
      throw new HttpError(401, 'No se pudo descifrar la contraseña guardada (¿se borraron los datos del navegador?). Ingrésala de nuevo.', 'decrypt_failed');
    }
  }

  app.get('/api/session', async () => sessionDTO());

  app.post('/api/connection/test', async (req) => {
    const body = testSchema.parse(req.body);
    const version = 'params' in body
      ? await testConnection(body.params, body.password)
      : await (async () => {
          const { profile, password } = unlock(body.profileId, body.clientSecret);
          return testConnection(profile.params, password);
        })();
    return { ok: true, version };
  });

  app.post('/api/connection/connect', async (req) => {
    const body = connectRequestSchema.parse(req.body);
    let profile: ProfileDTO | null = null;

    if ('params' in body) {
      const params = { ...body.params, name: body.params.name || defaultName(body.params) };
      const id = profileIdFor(params);
      await connect(id, params, body.password);
      if (body.remember) {
        if (!body.clientSecret) throw new HttpError(400, 'Falta el secreto de cliente para recordar la conexión', 'missing_client_secret');
        profiles.upsert(id, params.name, params, encryptSecret(masterKey, body.clientSecret, id, body.password));
        profile = toDTO(profiles.get(id)!);
      } else {
        profile = { ...params, id, name: params.name, hasStoredPassword: false, lastUsedAt: null };
      }
    } else {
      const { profile: stored, password } = unlock(body.profileId, body.clientSecret);
      await connect(stored.id, stored.params, password);
      profiles.touch(stored.id);
      profile = toDTO(profiles.get(stored.id)!);
    }
    clearValidationCache();
    return { session: sessionDTO(), profile };
  });

  app.post('/api/connection/disconnect', async () => {
    await disconnect();
    clearValidationCache();
    return sessionDTO();
  });

  app.get('/api/profiles', async () => profiles.list().map(toDTO));

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    profiles.remove(req.params.id);
    return { ok: true };
  });
}
