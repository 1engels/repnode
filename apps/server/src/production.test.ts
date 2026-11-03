import { describe, expect, it } from 'vitest';
import { parseProductionEnv } from './production.ts';

const base = { REPNODE_SERVER: ' 10.0.0.5 ', REPNODE_AUTH_USER: 'report', REPNODE_AUTH_PASS: ' s3cret ' };

describe('parseProductionEnv', () => {
  it('informa las variables obligatorias que faltan', () => {
    expect(parseProductionEnv({})).toEqual({
      ok: false,
      missing: ['REPNODE_SERVER', 'REPNODE_AUTH_USER', 'REPNODE_AUTH_PASS'],
      error: null,
    });
    expect(parseProductionEnv({ ...base, REPNODE_AUTH_USER: '  ', REPNODE_AUTH_PASS: '' })).toMatchObject({
      ok: false,
      missing: ['REPNODE_AUTH_USER', 'REPNODE_AUTH_PASS'],
    });
  });

  it('usa 1433 e ION_Data por defecto, usuario SQL y confía en el certificado', () => {
    const r = parseProductionEnv(base);
    expect(r).toEqual({
      ok: true,
      password: ' s3cret ',
      params: {
        name: 'PME de producción',
        server: '10.0.0.5',
        port: 1433,
        instance: null,
        database: 'ION_Data',
        authType: 'sql',
        domain: null,
        username: 'report',
        encrypt: false,
        trustServerCertificate: true,
      },
    });
  });

  it('con instancia y sin puerto resuelve la instancia; un puerto explícito gana', () => {
    const inst = parseProductionEnv({ ...base, REPNODE_INSTANCE: 'ION' });
    expect(inst.ok && inst.params).toMatchObject({ instance: 'ION', port: null });
    const both = parseProductionEnv({ ...base, REPNODE_INSTANCE: 'ION', REPNODE_DB_PORT: '1500', REPNODE_DB_NAME: 'ION_Prod' });
    expect(both.ok && both.params).toMatchObject({ instance: 'ION', port: 1500, database: 'ION_Prod' });
  });

  it('rechaza un puerto inválido', () => {
    expect(parseProductionEnv({ ...base, REPNODE_DB_PORT: 'abc' })).toMatchObject({ ok: false, missing: [] });
    expect(parseProductionEnv({ ...base, REPNODE_DB_PORT: '70000' })).toMatchObject({ ok: false });
  });
});
