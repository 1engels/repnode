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

const SOCKET_HINTS: Record<string, string> = {
  ECONNREFUSED: 'conexión rechazada: nada escucha en ese puerto (¿la instancia usa otro puerto o tiene TCP/IP deshabilitado?)',
  EHOSTUNREACH: 'no hay ruta hacia el servidor (¿IP incorrecta, red o VPN?)',
  ENETUNREACH: 'la red del servidor no es alcanzable desde este equipo (¿IP incorrecta, red o VPN?)',
  ENOTFOUND: 'no se pudo resolver el nombre del servidor (DNS)',
  EAI_AGAIN: 'no se pudo resolver el nombre del servidor (DNS no disponible)',
  ETIMEDOUT: 'el servidor no respondió (¿firewall?)',
  ECONNRESET: 'el servidor cerró la conexión (¿cifrado TLS incompatible?)',
};

/**
 * Errores de red que tedious envuelve en `cause` (un AggregateError con un error por dirección IP probada),
 * p. ej. "ECONNREFUSED: conexión rechazada…". Sin esto el mensaje solo dice "Could not connect (sequence)".
 */
function socketCauses(err: unknown): string[] {
  const out = new Set<string>();
  const visit = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 5) return;
    const x = e as { code?: unknown; message?: string; errors?: unknown[]; cause?: unknown };
    if (Array.isArray(x.errors)) x.errors.forEach((inner) => visit(inner, depth + 1));
    // Los errores de sistema de Node llevan el código en el mensaje ("connect ECONNREFUSED 10.0.0.5:1433");
    // así se descartan los envoltorios de tedious/mssql (ESOCKET)
    if (typeof x.code === 'string' && (x.code in SOCKET_HINTS || x.message?.includes(x.code))) {
      out.add(`${x.code}: ${SOCKET_HINTS[x.code] ?? x.message}`);
    }
    visit(x.cause, depth + 1);
  };
  visit(err, 0);
  return [...out];
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
    case 'ECONNCLOSED': {
      const causes = socketCauses(e.originalError ?? err);
      if (!causes.length) return `No se pudo conectar al servidor: ${msg}`;
      return `No se pudo conectar al servidor: ${msg.replace(/ - Could not connect \((sequence|parallel)\)$/, '')} — ${causes.join('; ')}`;
    }
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
