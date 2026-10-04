import type { config as MssqlConfig } from 'mssql';
import type { ConnectionParams } from '@repnode/shared';

export interface PoolOptions {
  poolMax: number;
  requestTimeoutMs: number;
}

/** Configuración de mssql/tedious a partir del perfil. Es un objeto plano para poder enviarlo a los workers. */
export function buildMssqlConfig(p: ConnectionParams, password: string, opts: PoolOptions): MssqlConfig {
  const cfg: MssqlConfig = {
    server: p.server,
    database: p.database,
    user: p.username,
    password,
    connectionTimeout: 20_000,
    requestTimeout: opts.requestTimeoutMs,
    pool: { max: opts.poolMax, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: p.encrypt,
      trustServerCertificate: p.trustServerCertificate,
      useUTC: true,
      enableArithAbort: true,
      appName: 'RepNode',
      packetSize: 32_768,
    },
  };
  // Un puerto explícito evita depender de SQL Server Browser (UDP 1434), igual que "servidor\instancia,puerto" en SSMS
  if (p.port) cfg.port = p.port;
  else if (p.instance) cfg.options!.instanceName = p.instance;
  // Con "domain" mssql usa autenticación NTLM (Windows)
  if (p.authType === 'ntlm') cfg.domain = p.domain ?? '';
  return cfg;
}
