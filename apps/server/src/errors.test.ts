import sql from 'mssql';
import { describe, expect, it } from 'vitest';
import { describeSqlError } from './errors.ts';

function sysError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Misma forma que arma mssql 12 / tedious 20 cuando falla el socket. */
function socketFailure(...inner: Error[]): Error {
  const tedious = Object.assign(
    new Error('Failed to connect to 10.0.0.5:1433 - Could not connect (sequence)', { cause: new AggregateError(inner, 'Could not connect (sequence)') }),
    { code: 'ESOCKET' },
  );
  return Object.assign(new Error(tedious.message), { code: 'ESOCKET', originalError: tedious });
}

describe('describeSqlError', () => {
  it('explica el error de red que tedious esconde en el AggregateError', () => {
    expect(describeSqlError(socketFailure(sysError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:1433')))).toBe(
      'No se pudo conectar al servidor: Failed to connect to 10.0.0.5:1433 — ECONNREFUSED: conexión rechazada: nada escucha en ese ' +
        'puerto (¿la instancia usa otro puerto o tiene TCP/IP deshabilitado?)',
    );
  });

  it('muestra el mensaje original si el código no tiene explicación y no repite causas', () => {
    const msg = describeSqlError(
      socketFailure(sysError('EACCES', 'connect EACCES 10.0.0.5:1433'), sysError('EACCES', 'connect EACCES 10.0.0.5:1433')),
    );
    expect(msg).toBe('No se pudo conectar al servidor: Failed to connect to 10.0.0.5:1433 — EACCES: connect EACCES 10.0.0.5:1433');
  });

  it('sin causa conocida deja el mensaje como estaba', () => {
    const err = Object.assign(new Error('Connection lost'), { code: 'ECONNCLOSED' });
    expect(describeSqlError(err)).toBe('No se pudo conectar al servidor: Connection lost');
  });

  it('con un puerto cerrado real', async () => {
    // El puerto 1 de localhost no tiene servicio: el sistema rechaza la conexión al instante
    const pool = new sql.ConnectionPool({
      server: '127.0.0.1', port: 1, user: 'x', password: 'x', connectionTimeout: 5000,
      options: { encrypt: false, trustServerCertificate: true },
    });
    const err = await pool.connect().then(() => null, (e: unknown) => e);
    await pool.close().catch(() => {});
    expect(describeSqlError(err)).toMatch(/^No se pudo conectar al servidor: Failed to connect to 127\.0\.0\.1:1 — ECONNREFUSED: conexión rechazada/);
  });
});
