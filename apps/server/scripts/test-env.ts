// Lee la conexión de pruebas desde apps/server/.env.test.local (no versionado).
import type { ConnectionParams } from '@repnode/shared';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`Falta la variable ${name} en apps/server/.env.test.local (ver .env.test.example)`);
    process.exit(1);
  }
  return v;
}

export function testConnection(): { params: ConnectionParams; password: string } {
  const instance = process.env.TEST_SQL_INSTANCE || null;
  const port = process.env.TEST_SQL_PORT ? Number(process.env.TEST_SQL_PORT) : null;
  const domain = process.env.TEST_SQL_DOMAIN || null;
  return {
    params: {
      server: env('TEST_SQL_SERVER'),
      port,
      instance,
      database: env('TEST_SQL_DATABASE', 'ION_Data'),
      authType: domain ? 'ntlm' : 'sql',
      domain,
      username: env('TEST_SQL_USER'),
      encrypt: process.env.TEST_SQL_ENCRYPT === 'true',
      trustServerCertificate: process.env.TEST_SQL_TRUST_CERT !== 'false',
    },
    password: env('TEST_SQL_PASSWORD'),
  };
}
