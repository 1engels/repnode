/**
 * Límite de intentos fallidos por clave (p. ej. la IP) en una ventana de tiempo. Frena la prueba masiva de
 * contraseñas de SQL Server a través de RepNode, que además podría bloquear cuentas por la política de bloqueo.
 */
export function createAttemptLimiter(opts: { max: number; windowMs: number }) {
  const failures = new Map<string, number[]>();

  function recent(key: string, now: number): number[] {
    const list = (failures.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  }

  return {
    /** Milisegundos que faltan para poder reintentar; 0 = permitido. */
    retryAfterMs(key: string, now = Date.now()): number {
      const list = recent(key, now);
      return list.length >= opts.max ? opts.windowMs - (now - list[0]) : 0;
    },
    fail(key: string, now = Date.now()): void {
      const list = recent(key, now);
      list.push(now);
      failures.set(key, list);
      if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}
