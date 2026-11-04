/** Lectura y escritura mínima de cookies (RFC 6265), sin dependencias. */

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    // Si se repite, gana la primera (la de la ruta más específica, según el orden que envía el navegador)
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * Encabezado Cookie solo con las cookies indicadas, en el orden pedido. Se usa para reenviar a PME únicamente su
 * cookie de sesión: la de RepNode y cualquier otra del navegador nunca salen de este servidor.
 */
export function pickCookieHeader(header: string | undefined, names: string[]): string {
  const all = parseCookies(header);
  return names.filter((n) => all.has(n)).map((n) => `${n}=${all.get(n)}`).join('; ');
}

export interface CookieOptions {
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Segundos; 0 borra la cookie. Sin valor = cookie de sesión del navegador. */
  maxAge?: number;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  if (!TOKEN.test(name)) throw new Error(`Nombre de cookie inválido: ${name}`);
  if (/[\s",;\\]/.test(value)) throw new Error('Valor de cookie inválido');
  const parts = [`${name}=${value}`, `Path=${o.path}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite) parts.push(`SameSite=${o.sameSite}`);
  return parts.join('; ');
}
