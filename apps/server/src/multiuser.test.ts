import { describe, expect, it } from 'vitest';
import { classifyPmeStatus, describeJsonShape, extractPmeUser } from './auth/pme-auth.ts';
import { parseCookies, pickCookieHeader, serializeCookie } from './http/cookies.ts';
import { createAttemptLimiter } from './http/rate-limit.ts';
import { hostName, isAllowedHost, isCrossSiteRequest } from './http/security.ts';
import { parseRuntimeConfig } from './runtime-config.ts';
import { expiryReason, ownerKey, pickEviction } from './sessions/registry.ts';

describe('configuración multiusuario', () => {
  it('por defecto es el modo local con 15 min de inactividad', () => {
    const { config, errors } = parseRuntimeConfig({});
    expect(errors).toEqual([]);
    expect(config.authMode).toBe('none');
    expect(config.sessionIdleMs).toBe(15 * 60_000);
    expect(config.maxConcurrentJobs).toBe(1);
    expect(config.pme).toBeNull();
  });

  it('el modo pme usa /repnode-auth salvo que se indique otro endpoint', () => {
    const def = parseRuntimeConfig({ REPNODE_AUTH_MODE: 'pme' });
    expect(def.errors).toEqual([]);
    expect(def.config.pme?.userUrl).toBe('http://127.0.0.1/repnode-auth/whoami.ashx');
    expect(def.config.pme?.userField).toBe('user');
    expect(parseRuntimeConfig({ REPNODE_AUTH_MODE: 'pme', REPNODE_PME_USER_URL: 'ftp://x' }).errors.join()).toMatch(/REPNODE_PME_USER_URL/);
    const { config, errors } = parseRuntimeConfig({
      REPNODE_AUTH_MODE: 'pme',
      REPNODE_PME_USER_URL: 'https://127.0.0.1/Web/api/user',
      REPNODE_PME_USER_FIELD: 'user.name',
      REPNODE_ALLOWED_HOSTS: 'SrvPme, srvpme.empresa.local',
    });
    expect(errors).toEqual([]);
    expect(config.pme?.cookies).toEqual(['.APPLICATIONFRAMEWORK']);
    expect(config.pme?.loginUrl).toBe('/Web/Auth');
    expect(config.allowedHosts).toEqual(['srvpme', 'srvpme.empresa.local']);
  });

  it('no acepta ignorar el certificado de un PME remoto', () => {
    const { errors } = parseRuntimeConfig({ REPNODE_AUTH_MODE: 'pme', REPNODE_PME_USER_URL: 'https://otro/Web', REPNODE_PME_TLS_INSECURE: '1' });
    expect(errors.join()).toMatch(/TLS_INSECURE/);
  });

  it('informa los números inválidos', () => {
    const { errors, config } = parseRuntimeConfig({ REPNODE_SESSION_IDLE_MINUTES: 'diez', REPNODE_MAX_SESSIONS: '0' });
    expect(errors).toHaveLength(2);
    expect(config.sessionIdleMs).toBe(15 * 60_000);
  });
});

describe('cookies', () => {
  it('lee el encabezado Cookie', () => {
    const c = parseCookies('a=1; .APPLICATIONFRAMEWORK=ABC==; b="x y"; a=2');
    expect(c.get('a')).toBe('1');
    expect(c.get('.APPLICATIONFRAMEWORK')).toBe('ABC==');
    expect(c.get('b')).toBe('x y');
  });

  it('reenvía a PME solo sus cookies', () => {
    const h = 'repnode.sid=secreto; .APPLICATIONFRAMEWORK=T1; ASP.NET_SessionId=S1';
    expect(pickCookieHeader(h, ['.APPLICATIONFRAMEWORK'])).toBe('.APPLICATIONFRAMEWORK=T1');
    expect(pickCookieHeader(h, ['ASP.NET_SessionId', '.APPLICATIONFRAMEWORK'])).toBe('ASP.NET_SessionId=S1; .APPLICATIONFRAMEWORK=T1');
    expect(pickCookieHeader(undefined, ['x'])).toBe('');
  });

  it('escribe la cookie de sesión con sus atributos', () => {
    expect(serializeCookie('repnode.sid', 'abc', { path: '/repnode', httpOnly: true, secure: true, sameSite: 'Strict' }))
      .toBe('repnode.sid=abc; Path=/repnode; HttpOnly; Secure; SameSite=Strict');
    expect(() => serializeCookie('x', 'a;b', { path: '/' })).toThrow();
  });
});

describe('autenticación con PME', () => {
  it('clasifica las respuestas', () => {
    expect(classifyPmeStatus(200)).toBe('ok');
    expect(classifyPmeStatus(302)).toBe('unauthenticated');
    expect(classifyPmeStatus(401)).toBe('unauthenticated');
    expect(classifyPmeStatus(500)).toBe('error');
  });

  it('extrae el usuario del JSON', () => {
    expect(extractPmeUser('{"user":{"name":" jperez "}}', 'user.name')).toBe('jperez');
    expect(extractPmeUser('"supervisor"', '')).toBe('supervisor');
    expect(extractPmeUser('{"id":42}', 'id')).toBe('42');
  });

  it('no acepta una página HTML ni un usuario vacío', () => {
    expect(extractPmeUser('<html>Login</html>', '')).toBeNull();
    expect(extractPmeUser('{"name":""}', 'name')).toBeNull();
    expect(extractPmeUser('{"name":null}', 'name')).toBeNull();
    expect(extractPmeUser('{"a":1}', 'user.name')).toBeNull();
  });

  it('describe la forma de la respuesta sin valores', () => {
    expect(describeJsonShape('{"userName":"x","level":3}')).toBe('objeto con claves: userName, level');
    expect(describeJsonShape('<html>')).toBe('no es JSON');
  });
});

describe('seguridad HTTP', () => {
  it('compara nombres de host sin el puerto', () => {
    expect(hostName('LocalHost:5173')).toBe('localhost');
    expect(hostName('[::1]:3210')).toBe('[::1]');
    expect(isAllowedHost('127.0.0.1:3210', [])).toBe(true);
    expect(isAllowedHost('srvpme', ['srvpme'])).toBe(true);
    expect(isAllowedHost('evil.com', ['srvpme'])).toBe(false);
  });

  it('rechaza peticiones que modifican desde otro sitio', () => {
    const allowed = ['srvpme'];
    expect(isCrossSiteRequest('GET', { 'sec-fetch-site': 'cross-site' }, allowed)).toBe(false);
    expect(isCrossSiteRequest('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }, allowed)).toBe(true);
    expect(isCrossSiteRequest('POST', { 'sec-fetch-site': 'same-site' }, allowed)).toBe(true);
    expect(isCrossSiteRequest('POST', { origin: 'https://evil.com', host: 'srvpme' }, allowed)).toBe(true);
    expect(isCrossSiteRequest('POST', { origin: 'null' }, allowed)).toBe(true);
  });

  it('acepta el mismo origen, detrás del proxy y fuera de un navegador', () => {
    const allowed = ['srvpme'];
    expect(isCrossSiteRequest('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173', host: 'localhost:5173' }, allowed)).toBe(false);
    expect(isCrossSiteRequest('PUT', { origin: 'https://srvpme', host: '127.0.0.1:3210' }, allowed)).toBe(false);
    expect(isCrossSiteRequest('DELETE', {}, allowed)).toBe(false);
  });

  it('limita los intentos fallidos por clave', () => {
    const l = createAttemptLimiter({ max: 2, windowMs: 1000 });
    l.fail('ip', 0);
    expect(l.retryAfterMs('ip', 10)).toBe(0);
    l.fail('ip', 100);
    expect(l.retryAfterMs('ip', 500)).toBe(500);
    expect(l.retryAfterMs('ip', 1001)).toBe(0);
    l.fail('ip', 1100);
    l.reset('ip');
    expect(l.retryAfterMs('ip', 1200)).toBe(0);
  });
});

describe('sesiones', () => {
  const policy = { idleMs: 15 * 60_000, maxMs: 12 * 3_600_000 };

  it('vencen por inactividad salvo con jobs en curso', () => {
    const s = { createdAt: 0, lastSeen: 0 };
    expect(expiryReason(s, 14 * 60_000, policy, false)).toBeNull();
    expect(expiryReason(s, 15 * 60_000, policy, false)).toBe('idle');
    expect(expiryReason(s, 15 * 60_000, policy, true)).toBeNull();
  });

  it('vencen por duración máxima aunque haya actividad o jobs', () => {
    expect(expiryReason({ createdAt: 0, lastSeen: policy.maxMs - 1 }, policy.maxMs, policy, true)).toBe('max_age');
  });

  it('al llegar al tope desaloja la más inactiva sin conexión ni jobs', () => {
    const list = [
      { id: 'a', lastSeen: 1, sql: {} as never },
      { id: 'b', lastSeen: 2, sql: null },
      { id: 'c', lastSeen: 3, sql: null },
      { id: 'd', lastSeen: 0, sql: null },
    ];
    expect(pickEviction(list, (s) => s.id === 'd')?.id).toBe('b');
    expect(pickEviction(list.slice(0, 1), () => false)).toBeNull();
  });

  it('los jobs pertenecen al usuario de PME o, en modo local, al equipo', () => {
    expect(ownerKey({ user: 'JPerez' })).toBe('pme:jperez');
    expect(ownerKey({ user: null })).toBe('local');
  });
});
