import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { PmeAuthConfig } from '../runtime-config.ts';

/**
 * Autenticación delegada en PME. RepNode se publica con el mismo origen que PME (https://servidor/repnode/), así
 * que el navegador también le envía la cookie de Forms Authentication de PME (.APPLICATIONFRAMEWORK). RepNode no la
 * descifra (no necesita el machineKey de PME): la reenvía a un endpoint de PME que exige sesión y devuelve el
 * usuario actual. Si PME responde con el usuario, la sesión es válida; si redirige al login o responde 401/403, no.
 */

export type PmeCheck =
  | { status: 'ok'; user: string }
  | { status: 'unauthenticated' }
  /** PME no respondió como se esperaba (caído, timeout, 5xx): no se cierra la sesión por esto. */
  | { status: 'error'; message: string };

/** Clasifica la respuesta de PME por su código HTTP. */
export function classifyPmeStatus(code: number): 'ok' | 'unauthenticated' | 'error' {
  if (code >= 200 && code < 300) return 'ok';
  // Forms Authentication redirige (302) a ~/Auth; algunos endpoints responden 401/403 directamente
  if ((code >= 300 && code < 400) || code === 401 || code === 403) return 'unauthenticated';
  return 'error';
}

/**
 * Nombre del usuario dentro de la respuesta JSON de PME. `field` es una ruta con puntos (p. ej. "user.name");
 * vacío = el JSON completo es el nombre (una cadena). Devuelve null si no es JSON o no hay un nombre utilizable:
 * así una página HTML de login respondida con 200 nunca cuenta como sesión válida.
 */
export function extractPmeUser(body: string, field: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  for (const key of field ? field.split('.') : []) {
    if (data === null || typeof data !== 'object') return null;
    data = (data as Record<string, unknown>)[key];
  }
  if (typeof data !== 'string' && typeof data !== 'number') return null;
  const user = String(data).trim();
  return user && user.length <= 256 ? user : null;
}

/** Nombres de las claves de primer nivel (sin valores), para ayudar a configurar REPNODE_PME_USER_FIELD. */
export function describeJsonShape(body: string): string {
  try {
    const data = JSON.parse(body) as unknown;
    if (Array.isArray(data)) return `arreglo de ${data.length} elementos`;
    if (data && typeof data === 'object') return `objeto con claves: ${Object.keys(data).slice(0, 30).join(', ')}`;
    return typeof data;
  } catch {
    return 'no es JSON';
  }
}

export function hashCookies(cookieHeader: string): string {
  return createHash('sha256').update(cookieHeader).digest('base64url');
}

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 5000;
/** Resultados recientes por cookie: evita consultar a PME en cada petición de la GUI. */
const CACHE_MS = 30_000;

export interface PmeAuthenticator {
  check(cookieHeader: string): Promise<PmeCheck>;
}

export function createPmeAuthenticator(cfg: PmeAuthConfig, log?: { warn: (o: object, msg: string) => void }): PmeAuthenticator {
  const url = new URL(cfg.userUrl);
  const isHttps = url.protocol === 'https:';
  const ca = cfg.caFile ? readFileSync(cfg.caFile) : undefined;
  const agent = isHttps
    ? new https.Agent({ keepAlive: true, maxSockets: 8, ca, rejectUnauthorized: !cfg.tlsInsecure })
    : new http.Agent({ keepAlive: true, maxSockets: 8 });
  const cache = new Map<string, { at: number; result: PmeCheck }>();
  const inFlight = new Map<string, Promise<PmeCheck>>();

  function request(cookieHeader: string): Promise<PmeCheck> {
    return new Promise((resolve) => {
      const req = (isHttps ? https : http).request(
        url,
        {
          method: 'GET',
          agent,
          timeout: TIMEOUT_MS,
          headers: { Cookie: cookieHeader, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        },
        (res) => {
          const kind = classifyPmeStatus(res.statusCode ?? 0);
          if (kind !== 'ok') {
            res.resume();
            resolve(kind === 'unauthenticated' ? { status: 'unauthenticated' } : { status: 'error', message: `PME respondió ${res.statusCode}` });
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > MAX_BODY) req.destroy(new Error('Respuesta de PME demasiado grande'));
          });
          res.on('end', () => {
            const user = extractPmeUser(body, cfg.userField);
            if (user) return resolve({ status: 'ok', user });
            // Nunca se registran valores: solo la forma de la respuesta, para configurar REPNODE_PME_USER_FIELD
            log?.warn({ shape: describeJsonShape(body), field: cfg.userField }, 'PME respondió sin un usuario reconocible');
            resolve({ status: 'unauthenticated' });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado consultando a PME')));
      req.on('error', (err) => resolve({ status: 'error', message: err.message }));
      req.end();
    });
  }

  return {
    async check(cookieHeader) {
      const key = hashCookies(cookieHeader);
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < CACHE_MS) return hit.result;
      let p = inFlight.get(key);
      if (!p) {
        p = request(cookieHeader).finally(() => inFlight.delete(key));
        inFlight.set(key, p);
      }
      const result = await p;
      // Los errores de PME no se cachean: el siguiente intento vuelve a consultar
      if (result.status !== 'error') {
        cache.set(key, { at: Date.now(), result });
        if (cache.size > 1000) cache.delete(cache.keys().next().value!);
      }
      return result;
    },
  };
}
