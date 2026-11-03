import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, idForNewProfile, profileIdFor } from './secrets.ts';

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

  describe('ID para una conexión nueva', () => {
    const params = { server: 'sql01', port: null, instance: 'ION', database: 'ION_Data', username: 'reader', domain: null };
    const moved = { ...params, server: '10.0.0.5' };

    it('usa el hash si nadie lo ocupa', () => {
      expect(idForNewProfile(params, [])).toBe(id);
    });

    it('reutiliza el ID de un perfil editado que hoy tiene esos parámetros', () => {
      expect(idForNewProfile(moved, [{ id, params: moved }])).toBe(id);
    });

    it('no pisa un perfil editado cuyo ID es el hash de sus parámetros anteriores', () => {
      const nuevo = idForNewProfile(params, [{ id, params: moved }]);
      expect(nuevo).not.toBe(id);
      expect(nuevo).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
