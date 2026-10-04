import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');

export const config = {
  host: process.env.REPNODE_HOST ?? '127.0.0.1',
  port: Number(process.env.REPNODE_PORT ?? 3210),
  dataDir: resolve(process.env.REPNODE_DATA_DIR ?? join(repoRoot, 'data')),
  webDist: join(repoRoot, 'apps/web/dist'),
  isProd: process.env.NODE_ENV === 'production' || process.argv.includes('--prod'),
  logLevel: process.env.REPNODE_LOG_LEVEL ?? 'info',
};

export const paths = {
  db: join(config.dataDir, 'app.db'),
  masterKey: join(config.dataDir, 'master.key'),
  jobs: join(config.dataDir, 'jobs'),
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(paths.jobs, { recursive: true });
