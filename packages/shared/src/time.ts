// Utilidades de zona horaria basadas solo en Intl (funcionan en Node y en el navegador).

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    getDtf(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) de la zona respecto a UTC en el instante dado: local = utc + offset. */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = getDtf(timeZone).formatToParts(new Date(utcMs));
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'year': y = Number(p.value); break;
      case 'month': mo = Number(p.value); break;
      case 'day': d = Number(p.value); break;
      case 'hour': h = Number(p.value) % 24; break;
      case 'minute': mi = Number(p.value); break;
      case 'second': s = Number(p.value); break;
    }
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const truncated = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return wall - truncated;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Convierte 'YYYY-MM-DDTHH:mm[:ss]' (hora de pared) a milisegundos de pared tratados como UTC. */
export function parseLocalWall(local: string): number {
  const m = LOCAL_RE.exec(local);
  if (!m) throw new Error(`Fecha/hora inválida: ${local}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

export function isLocalDateTime(value: string): boolean {
  return LOCAL_RE.test(value);
}

/** Hora local de pared en `timeZone` -> instante UTC (ms). */
export function localToUtcMs(local: string, timeZone: string): number {
  const wall = parseLocalWall(local);
  const off1 = tzOffsetMs(wall, timeZone);
  let utc = wall - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = wall - off2;
  return utc;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

/** Formatea milisegundos "de pared" como 'YYYY-MM-DD HH:mm:ss'. */
export function formatWall(wallMs: number, withSeconds = true): string {
  const d = new Date(wallMs);
  const base = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getUTCSeconds())}` : base;
}

/** Instante UTC -> 'YYYY-MM-DDTHH:mm' en la zona indicada (formato de <input type="datetime-local">). */
export function utcToLocalInput(utcMs: number, timeZone: string): string {
  return formatWall(utcMs + tzOffsetMs(utcMs, timeZone), false).replace(' ', 'T');
}

/**
 * Formateador rápido UTC -> local para millones de filas.
 * Cachea el offset por bloques de 15 minutos (las transiciones DST caen en esos límites).
 */
export class LocalTimeFormatter {
  private readonly cache = new Map<number, number>();
  private readonly timeZone: string;

  constructor(timeZone: string) {
    this.timeZone = timeZone;
  }

  offset(utcMs: number): number {
    const bucket = Math.floor(utcMs / 900_000);
    let off = this.cache.get(bucket);
    if (off === undefined) {
      off = tzOffsetMs(bucket * 900_000, this.timeZone);
      this.cache.set(bucket, off);
    }
    return off;
  }

  format(utcMs: number): string {
    return formatWall(utcMs + this.offset(utcMs));
  }
}

export function formatUtc(utcMs: number): string {
  return formatWall(utcMs);
}
