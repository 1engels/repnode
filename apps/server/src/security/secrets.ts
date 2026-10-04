import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConnectionParams } from '@repnode/shared';

/**
 * Las contraseñas no se pueden "hashear" porque hay que reutilizarlas para conectarse a SQL Server.
 * Se cifran con AES-256-GCM usando una clave derivada (HKDF-SHA256) de:
 *   - la clave maestra del backend (data/master.key), y
 *   - un secreto aleatorio que solo guarda el navegador (localStorage).
 * Ninguno de los dos almacenes por sí solo permite recuperar la contraseña.
 */

export interface EncryptedSecret {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
}

const INFO_PREFIX = 'repnode/pwd/v1/';

export function loadOrCreateMasterKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Clave maestra inválida en ${path}`);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  return key;
}

function deriveKey(masterKey: Buffer, clientSecret: string, profileId: string): Buffer {
  const salt = Buffer.from(clientSecret, 'base64');
  if (salt.length < 16) throw new Error('Secreto de cliente inválido');
  return Buffer.from(hkdfSync('sha256', masterKey, salt, INFO_PREFIX + profileId, 32));
}

export function encryptSecret(masterKey: Buffer, clientSecret: string, profileId: string, plain: string): EncryptedSecret {
  const key = deriveKey(masterKey, clientSecret, profileId);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(profileId));
  const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { cipher, iv, tag: c.getAuthTag() };
}

export function decryptSecret(masterKey: Buffer, clientSecret: string, profileId: string, enc: EncryptedSecret): string {
  const key = deriveKey(masterKey, clientSecret, profileId);
  const d = createDecipheriv('aes-256-gcm', key, enc.iv);
  d.setAAD(Buffer.from(profileId));
  d.setAuthTag(enc.tag);
  return Buffer.concat([d.update(enc.cipher), d.final()]).toString('utf8');
}

/** ID estable del perfil: hash SHA-256 de los datos que identifican la conexión. */
export function profileIdFor(p: Pick<ConnectionParams, 'server' | 'port' | 'instance' | 'database' | 'username' | 'domain'>): string {
  const key = [p.server, p.port ?? '', p.instance ?? '', p.database, p.domain ?? '', p.username]
    .map((v) => String(v).trim().toLowerCase())
    .join('|');
  return createHash('sha256').update(key).digest('hex');
}
