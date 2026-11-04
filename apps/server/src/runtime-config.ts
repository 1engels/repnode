/**
 * Opciones de ejecución multiusuario leídas de variables de entorno (REPNODE_*). Es puro para poder probarlo;
 * `config.ts` lo aplica sobre `process.env` al arrancar.
 */

export type AuthMode = 'none' | 'pme';

export interface PmeAuthConfig {
  /** Endpoint de PME que exige sesión y devuelve el usuario actual (JSON). Lo llama el servidor con la cookie del usuario. */
  userUrl: string;
  /** Ruta con puntos al nombre del usuario dentro del JSON (vacía = el JSON es el nombre). */
  userField: string;
  /** Cookies del navegador que se reenvían a PME (las demás nunca salen de RepNode). */
  cookies: string[];
  /** Página de inicio de sesión de PME a la que se manda al usuario sin sesión. */
  loginUrl: string;
  /** Cada cuánto se vuelve a confirmar con PME que la sesión sigue abierta. */
  recheckMs: number;
  /** Aceptar el certificado de PME sin validarlo (solo si userUrl apunta a este mismo equipo). */
  tlsInsecure: boolean;
  /** Certificado (PEM) en el que confiar para userUrl, p. ej. el autofirmado de PME. */
  caFile: string | null;
}

export interface RuntimeConfig {
  authMode: AuthMode;
  /** Nombres de host aceptados además de localhost (p. ej. el del servidor de PME). */
  allowedHosts: string[];
  sessionIdleMs: number;
  sessionMaxMs: number;
  maxSessions: number;
  /** Conexiones máximas del pool SQL de cada sesión (null = según la configuración de rendimiento). */
  sessionPoolMax: number | null;
  maxConcurrentJobs: number;
  maxJobsPerUser: number;
  pme: PmeAuthConfig | null;
}

/** Endpoint de deploy/iis/repnode-auth: valida la cookie de PME y responde {"user":"..."}. */
export const DEFAULT_PME_USER_URL = 'http://127.0.0.1/repnode-auth/whoami.ashx';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

function int(env: Record<string, string | undefined>, key: string, def: number, min: number, max: number, errors: string[]): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${key} debe ser un entero entre ${min} y ${max} (valor: "${raw}")`);
    return def;
  }
  return n;
}

export function parseRuntimeConfig(env: Record<string, string | undefined>): { config: RuntimeConfig; errors: string[] } {
  const errors: string[] = [];
  const rawMode = env.REPNODE_AUTH_MODE?.trim().toLowerCase() || 'none';
  const authMode: AuthMode = rawMode === 'pme' ? 'pme' : 'none';
  if (rawMode !== 'pme' && rawMode !== 'none') errors.push(`REPNODE_AUTH_MODE debe ser "none" o "pme" (valor: "${rawMode}")`);

  const allowedHosts = (env.REPNODE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  let pme: PmeAuthConfig | null = null;
  if (authMode === 'pme') {
    const userUrl = env.REPNODE_PME_USER_URL?.trim() || DEFAULT_PME_USER_URL;
    let url: URL | null = null;
    try {
      url = new URL(userUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      errors.push('REPNODE_PME_USER_URL debe ser una URL http(s) absoluta');
    }
    const tlsInsecure = env.REPNODE_PME_TLS_INSECURE === '1';
    if (tlsInsecure && url && !isLoopbackHost(url.hostname)) {
      errors.push('REPNODE_PME_TLS_INSECURE=1 solo se permite si REPNODE_PME_USER_URL apunta a este equipo (localhost/127.0.0.1)');
    }
    const cookies = (env.REPNODE_PME_COOKIES ?? '.APPLICATIONFRAMEWORK').split(',').map((c) => c.trim()).filter(Boolean);
    if (!cookies.length) errors.push('REPNODE_PME_COOKIES no puede quedar vacía');
    pme = {
      userUrl,
      // Sin URL propia se usa /repnode-auth, que responde {"user":"..."}
      userField: env.REPNODE_PME_USER_FIELD?.trim() ?? (env.REPNODE_PME_USER_URL?.trim() ? '' : 'user'),
      cookies,
      loginUrl: env.REPNODE_PME_LOGIN_URL?.trim() || '/Web/Auth',
      recheckMs: int(env, 'REPNODE_PME_RECHECK_SECONDS', 120, 10, 3600, errors) * 1000,
      tlsInsecure,
      caFile: env.REPNODE_PME_CA_FILE?.trim() || null,
    };
  }

  const poolMax = env.REPNODE_SESSION_POOL_MAX?.trim() ? int(env, 'REPNODE_SESSION_POOL_MAX', 8, 1, 64, errors) : null;
  return {
    config: {
      authMode,
      allowedHosts,
      sessionIdleMs: int(env, 'REPNODE_SESSION_IDLE_MINUTES', 15, 1, 24 * 60, errors) * 60_000,
      sessionMaxMs: int(env, 'REPNODE_SESSION_MAX_HOURS', 12, 1, 7 * 24, errors) * 3_600_000,
      maxSessions: int(env, 'REPNODE_MAX_SESSIONS', 100, 1, 10_000, errors),
      sessionPoolMax: poolMax,
      maxConcurrentJobs: int(env, 'REPNODE_MAX_CONCURRENT_JOBS', 1, 1, 16, errors),
      maxJobsPerUser: int(env, 'REPNODE_MAX_JOBS_PER_USER', 2, 1, 50, errors),
      pme,
    },
    errors,
  };
}
