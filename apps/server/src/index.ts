import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { createPmeAuthenticator } from './auth/pme-auth.ts';
import { config, paths, runtimeConfig, runtimeConfigErrors } from './config.ts';
import { HttpError } from './errors.ts';
import { registerSecurity } from './http/security.ts';
import { hasActiveJobs, initJobs, shutdownJobs } from './jobs/job-manager.ts';
import { parseProductionEnv } from './production.ts';
import { createRegistry, ownerKey } from './sessions/registry.ts';
import catalogRoutes from './routes/catalog.ts';
import connectionRoutes from './routes/connection.ts';
import hierarchyRoutes from './routes/hierarchy.ts';
import reportRoutes from './routes/reports.ts';
import { loadOrCreateMasterKey } from './security/secrets.ts';

const app = Fastify({
  logger: config.isProd
    ? { level: config.logLevel }
    : { level: config.logLevel, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
  bodyLimit: 20 * 1024 * 1024,
  disableRequestLogging: true,
  // Solo el proxy de IIS en este mismo equipo puede declarar la IP y el protocolo del cliente (X-Forwarded-*)
  trustProxy: ['127.0.0.1', '::1'],
});

if (runtimeConfigErrors.length) {
  for (const e of runtimeConfigErrors) app.log.error(e);
  process.exit(1);
}
if (runtimeConfig.authMode === 'pme') {
  // Embebido en PME todos usan la cuenta de servicio: sin ella no hay forma de conectarse
  const env = parseProductionEnv(process.env);
  if (!env.ok) {
    app.log.error(env.error ?? `Modo pme: faltan variables de entorno de la conexión a PME: ${env.missing.join(', ')}`);
    process.exit(1);
  }
}

const registry = createRegistry({
  idleMs: runtimeConfig.sessionIdleMs,
  maxMs: runtimeConfig.sessionMaxMs,
  maxSessions: runtimeConfig.maxSessions,
  isBusy: (s) => hasActiveJobs(ownerKey(s)),
  onExpire: (s, reason) => app.log.info({ user: s.user, reason }, 'sesión cerrada'),
});
registry.start();

registerSecurity(app, {
  runtime: runtimeConfig,
  registry,
  pme: runtimeConfig.pme ? createPmeAuthenticator(runtimeConfig.pme, app.log) : null,
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
    return reply.code(400).send({ error: 'invalid_input', message });
  }
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
  req.log.error({ err }, 'error no controlado');
  return reply.code(500).send({ error: 'internal', message: e.message ?? 'Error interno' });
});

const masterKey = loadOrCreateMasterKey(paths.masterKey);
initJobs(app.log);

// Todo (API y GUI) vive bajo /repnode: es la ruta que publica el proxy de IIS junto a las aplicaciones de PME
const base = config.basePath;
await app.register(async (scoped) => {
  await scoped.register(connectionRoutes, { masterKey, registry });
  await scoped.register(catalogRoutes);
  await scoped.register(hierarchyRoutes);
  await scoped.register(reportRoutes);
}, { prefix: base });

// En producción el backend sirve el frontend compilado (un solo proceso)
const hasDist = existsSync(config.webDist);
if (hasDist) await app.register(fastifyStatic, { root: config.webDist, prefix: `${base}/`, wildcard: false });
app.get('/', (_req, reply) => reply.redirect(`${base}/`));
app.get(base, (_req, reply) => reply.redirect(`${base}/`));
app.setNotFoundHandler((req, reply) => {
  const path = req.url.split('?')[0];
  // Rutas de la SPA (vue-router): se responde index.html. Un archivo que no existe (p. ej. un asset de otra
  // compilación) es un 404, no la página: si no, el navegador recibe HTML donde esperaba JS o CSS.
  const isFile = /\.[a-z0-9]+$/i.test(path);
  if (hasDist && !isFile && path.startsWith(`${base}/`) && !path.startsWith(`${base}/api/`)) return reply.sendFile('index.html');
  return reply.code(404).send({ error: 'not_found', message: 'Ruta no encontrada' });
});

const shutdown = async () => {
  await shutdownJobs();
  await registry.closeAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(`RepNode escuchando en http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}${base}/  (modo: ${runtimeConfig.authMode}, datos: ${config.dataDir})`);
