import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, profileIdFor } from './secrets.ts';

const master = randomBytes(32);
const clientSecret = randomBytes(32).toString('base64');
const id = profileIdFor({ server: 'sql01', port: null, instance: 'ION', database: 'ION_Data', username: 'reader', domain: null });

describe('secretos', () => {
  it('cifra y descifra la contraseña', () => {
    const enc = encryptSecret(master, clientSecret, id, 'P@ssw0rd ñ');
    expect(enc.cipher.toString('utf8')).not.toContain('P@ssw0rd');
    expect(decryptSecret(master, clientSecret, id, enc)).toBe('P@ssw0rd ñ');
  });

  it('falla sin el secreto del navegador correcto', () => {
    const enc = encryptSecret(master, clientSecret, id, 'secreto');
    expect(() => decryptSecret(master, randomBytes(32).toString('base64'), id, enc)).toThrow();
  });

  it('falla con otra clave maestra o con datos alterados', () => {
    const enc = encryptSecret(master, clientSecret, id, 'secreto');
    expect(() => decryptSecret(randomBytes(32), clientSecret, id, enc)).toThrow();
    const tampered = { ...enc, cipher: Buffer.from(enc.cipher) };
    tampered.cipher[0] ^= 0xff;
    expect(() => decryptSecret(master, clientSecret, id, tampered)).toThrow();
  });

  it('falla si se usa con otro perfil', () => {
    const enc = encryptSecret(master, clientSecret, id, 'secreto');
    expect(() => decryptSecret(master, clientSecret, 'otro-perfil', enc)).toThrow();
  });

  it('el ID de perfil es estable e insensible a mayúsculas', () => {
    const a = profileIdFor({ server: 'SQL01', port: null, instance: 'ion', database: 'ion_data', username: 'Reader', domain: null });
    expect(a).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});
