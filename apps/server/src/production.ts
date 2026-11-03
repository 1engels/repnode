import type { ConnectionParams } from '@repnode/shared';

/** Variables de entorno obligatorias para la conexión a PME de producción. */
export const PRODUCTION_REQUIRED_VARS = ['REPNODE_SERVER', 'REPNODE_AUTH_USER', 'REPNODE_AUTH_PASS'] as const;

export type ProductionEnv =
  | { ok: true; params: ConnectionParams; password: string }
  | { ok: false; missing: string[]; error: string | null };

/**
 * Conexión de producción a partir de REPNODE_SERVER, REPNODE_INSTANCE, REPNODE_DB_PORT, REPNODE_DB_NAME,
 * REPNODE_AUTH_USER y REPNODE_AUTH_PASS. Siempre usa usuario SQL y confía en el certificado del servidor.
 * Un puerto explícito gana sobre la instancia (igual que en el formulario); sin puerto ni instancia se usa 1433.
 */
export function parseProductionEnv(env: Record<string, string | undefined>): ProductionEnv {
  const val = (k: string) => env[k]?.trim() || null;
  // La contraseña no se recorta (puede tener espacios al borde): solo falta si está vacía
  const missing = PRODUCTION_REQUIRED_VARS.filter((k) => (k === 'REPNODE_AUTH_PASS' ? !env[k] : !val(k)));
  if (missing.length) return { ok: false, missing, error: null };

  const rawPort = val('REPNODE_DB_PORT');
  const port = rawPort === null ? null : Number(rawPort);
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    return { ok: false, missing: [], error: `REPNODE_DB_PORT no es un puerto válido: "${rawPort}"` };
  }
  const instance = val('REPNODE_INSTANCE');
  return {
    ok: true,
    params: {
      name: 'PME de producción',
      server: val('REPNODE_SERVER')!,
      port: port ?? (instance ? null : 1433),
      instance,
      database: val('REPNODE_DB_NAME') ?? 'ION_Data',
      authType: 'sql',
      domain: null,
      username: val('REPNODE_AUTH_USER')!,
      encrypt: false,
      trustServerCertificate: true,
    },
    password: env.REPNODE_AUTH_PASS!,
  };
}
