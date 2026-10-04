export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** Mensaje legible para errores de mssql/tedious. */
export function describeSqlError(err: unknown): string {
  const e = err as { code?: string; message?: string; originalError?: { message?: string } };
  const msg = e?.originalError?.message ?? e?.message ?? String(err);
  switch (e?.code) {
    case 'ELOGIN':
      return `Error de autenticación: ${msg}`;
    case 'ETIMEOUT':
      return `Tiempo de espera agotado: ${msg}`;
    case 'ESOCKET':
    case 'ECONNCLOSED':
      return `No se pudo conectar al servidor: ${msg}`;
    case 'EINSTLOOKUP':
      return `No se encontró la instancia (¿SQL Server Browser activo?): ${msg}`;
    default:
      return msg;
  }
}

/** Errores transitorios en los que vale la pena reintentar. */
export function isTransientSqlError(err: unknown): boolean {
  const e = err as { code?: string; number?: number; originalError?: { code?: string } };
  const code = e?.code ?? e?.originalError?.code;
  if (code && ['ETIMEOUT', 'ESOCKET', 'ECONNRESET', 'ECONNCLOSED', 'ECONNREFUSED'].includes(code)) return true;
  // 1205 = deadlock, 1222 = lock timeout, 40613/40501 = servicio ocupado
  return e?.number === 1205 || e?.number === 1222 || e?.number === 40613 || e?.number === 40501;
}
