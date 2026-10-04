import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config, paths } from './config.ts';
import { HttpError } from './errors.ts';
import { initJobs, shutdownJobs } from './jobs/job-manager.ts';
import { disconnect } from './mssql/session.ts';
import catalogRoutes from './routes/catalog.ts';
import connectionRoutes from './routes/connection.ts';
import reportRoutes from './routes/reports.ts';
import { loadOrCreateMasterKey } from './security/secrets.ts';

const app = Fastify({
  logger: config.isProd
    ? { level: config.logLevel }
    : { level: config.logLevel, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } },
  bodyLimit: 20 * 1024 * 1024,
  disableRequestLogging: true,
});

// App local: solo se aceptan peticiones dirigidas a localhost (protege contra DNS rebinding)
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
app.addHook('onRequest', async (req, reply) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && config.host === '127.0.0.1') {
    return reply.code(403).send({ error: 'forbidden', message: 'Host no permitido' });
  }
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

await app.register(connectionRoutes, { masterKey });
await app.register(catalogRoutes);
await app.register(reportRoutes);

// En producción el backend sirve el frontend compilado (un solo proceso)
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Ruta no encontrada' });
    return reply.sendFile('index.html');
  });
}

const shutdown = async () => {
  await shutdownJobs();
  await disconnect();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(`RepNode escuchando en http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}  (datos: ${config.dataDir})`);
