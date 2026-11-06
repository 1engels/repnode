import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BASE_PATH } from '@repnode/shared';
import { hashCookies, type PmeAuthenticator } from '../auth/pme-auth.ts';
import { isLoopbackHost, type RuntimeConfig } from '../runtime-config.ts';
import { SessionLimitError, type SessionRegistry, type UserSession } from '../sessions/registry.ts';
import { parseCookies, pickCookieHeader, serializeCookie } from './cookies.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Sesión del usuario que hace la petición (solo en rutas /api). */
    userSession: UserSession | null;
  }
}

export const SESSION_COOKIE = 'repnode.sid';
const API_PREFIX = `${BASE_PATH}/api/`;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Nombre de host sin puerto, en minúsculas ("[::1]:3210" → "[::1]"). */
export function hostName(hostHeader: string | undefined): string {
  const h = (hostHeader ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

export function isAllowedHost(hostHeader: string | undefined, allowed: string[]): boolean {
  const h = hostName(hostHeader);
  return isLoopbackHost(h) || allowed.includes(h);
}

/**
 * Protección CSRF: con la cookie de sesión, otro sitio podría hacer que el navegador envíe peticiones a RepNode.
 * Las peticiones que modifican algo se rechazan si el navegador dice que vienen de otro sitio (Sec-Fetch-Site) o si
 * su Origin no es este servidor. Sin esos encabezados no es un navegador (scripts, curl) y no hay riesgo de CSRF.
 */
export function isCrossSiteRequest(method: string, headers: { origin?: string; host?: string; 'sec-fetch-site'?: string }, allowed: string[]): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  if (!headers.origin) return false;
  if (headers.origin === 'null') return true;
  let origin: URL;
  try {
    origin = new URL(headers.origin);
  } catch {
    return true;
  }
  if (origin.host === (headers.host ?? '').toLowerCase()) return false;
  // Detrás de un proxy que no conserva el Host, se compara con los nombres permitidos explícitamente
  return !allowed.includes(origin.hostname.toLowerCase());
}

/** CSP de la GUI. Vue Flow usa estilos en línea; elkjs corre en un worker del mismo origen. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://d1bkrjcva2ouq1.cloudfront.net", // logo de PTSYS en el encabezado
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function deny(reply: FastifyReply, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: code, message, details });
}

export interface SecurityOptions {
  runtime: RuntimeConfig;
  registry: SessionRegistry;
  pme: PmeAuthenticator | null;
}

export function registerSecurity(app: FastifyInstance, { runtime, registry, pme }: SecurityOptions): void {
  app.decorateRequest('userSession', null);

  function setSessionCookie(req: FastifyRequest, reply: FastifyReply, s: UserSession): void {
    reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, s.id, {
      path: BASE_PATH,
      httpOnly: true,
      secure: req.protocol === 'https',
      sameSite: 'Strict',
    }));
  }

  /** Sesión de la petición en modo pme: validada con PME o null (ya se respondió con el error). */
  async function pmeSession(req: FastifyRequest, reply: FastifyReply, current: UserSession | null): Promise<UserSession | null> {
    const cfg = runtime.pme!;
    const loginDetails = { loginUrl: cfg.loginUrl };
    const pmeCookies = pickCookieHeader(req.headers.cookie, cfg.cookies);
    if (!pmeCookies) {
      if (current) await registry.destroy(current.id);
      deny(reply, 401, 'not_authenticated', 'Inicia sesión en Power Monitoring Expert para usar RepNode.', loginDetails);
      return null;
    }
    const hash = hashCookies(pmeCookies);
    const now = Date.now();
    if (current && current.pmeCookieHash === hash && now - current.pmeCheckedAt < cfg.recheckMs) return current;

    const r = await pme!.check(pmeCookies);
    if (r.status === 'error') {
      // Si PME no responde, una sesión ya validada con esas mismas cookies sigue sirviendo hasta el próximo intento
      if (current && current.pmeCookieHash === hash) return current;
      req.log.warn({ err: r.message }, 'no se pudo validar la sesión con PME');
      deny(reply, 503, 'pme_unavailable', 'No se pudo comprobar la sesión con Power Monitoring Expert. Intenta de nuevo en unos segundos.');
      return null;
    }
    if (r.status === 'unauthenticated') {
      if (current) await registry.destroy(current.id);
      deny(reply, 401, 'not_authenticated', 'La sesión de Power Monitoring Expert terminó. Vuelve a iniciar sesión.', loginDetails);
      return null;
    }
    if (current && current.user === r.user) {
      current.pmeCookieHash = hash;
      current.pmeCheckedAt = now;
      return current;
    }
    // Otro usuario inició sesión en PME en este navegador: la sesión anterior (y su conexión) se cierra
    if (current) await registry.destroy(current.id);
    const s = registry.create(r.user, hash, now);
    setSessionCookie(req, reply, s);
    return s;
  }

  app.addHook('onRequest', async (req, reply) => {
    // Solo se aceptan los nombres de host esperados (protege contra DNS rebinding)
    if (!isAllowedHost(req.headers.host, runtime.allowedHosts)) {
      // Se informa el nombre recibido para saber qué agregar a REPNODE_ALLOWED_HOSTS
      const host = hostName(req.headers.host).slice(0, 255);
      req.log.warn({ host }, 'Host no permitido (agrégalo a REPNODE_ALLOWED_HOSTS si es legítimo)');
      return deny(reply, 403, 'forbidden', `Host no permitido: ${host || '(vacío)'}. Agrégalo a REPNODE_ALLOWED_HOSTS si es un nombre legítimo del servidor.`);
    }
    if (!req.url.startsWith(API_PREFIX)) return;

    if (isCrossSiteRequest(req.method, req.headers as Record<string, string | undefined>, runtime.allowedHosts)) {
      return deny(reply, 403, 'forbidden_origin', 'Petición rechazada: no proviene de RepNode');
    }

    const current = registry.get(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
    let s: UserSession | null;
    try {
      if (runtime.authMode === 'pme') {
        s = await pmeSession(req, reply, current);
        if (!s) return reply;
      } else if (current) {
        s = current;
      } else {
        s = registry.create(null, null);
        setSessionCookie(req, reply, s);
      }
    } catch (err) {
      if (err instanceof SessionLimitError) return deny(reply, 503, 'too_many_sessions', err.message);
      throw err;
    }
    s.lastSeen = Date.now();
    req.userSession = s;
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith(API_PREFIX) && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
}
