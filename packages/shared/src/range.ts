import type { DateRange } from './schemas.ts';
import { formatWall, localToUtcMs, tzOffsetMs } from './time.ts';

export interface ResolvedRange {
  /** Hora local de pared 'YYYY-MM-DDTHH:mm' */
  fromLocal: string;
  toLocal: string;
  fromUtcMs: number;
  toUtcMs: number;
}

const DAY = 86_400_000;

function wallToInput(wallMs: number): string {
  return formatWall(wallMs, false).replace(' ', 'T');
}

/**
 * Resuelve un rango (fijo o relativo) en la zona horaria indicada.
 * Los rangos relativos usan días completos [inicio 00:00, fin 00:00) en hora local.
 * Las semanas empiezan el lunes.
 */
export function resolveRange(range: DateRange, timeZone: string, nowMs = Date.now()): ResolvedRange {
  let fromLocal: string;
  let toLocal: string;

  if (range.mode === 'fixed') {
    fromLocal = range.from;
    toLocal = range.to;
  } else {
    const nowWall = nowMs + tzOffsetMs(nowMs, timeZone);
    const today = Math.floor(nowWall / DAY) * DAY;
    const d = new Date(today);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const weekday = (d.getUTCDay() + 6) % 7; // 0 = lunes
    let a: number;
    let b: number;
    switch (range.preset) {
      case 'today':
        a = today; b = today + DAY; break;
      case 'yesterday':
        a = today - DAY; b = today; break;
      case 'lastNDays':
        a = today - (range.days ?? 7) * DAY; b = today; break;
      case 'currentWeek':
        a = today - weekday * DAY; b = a + 7 * DAY; break;
      case 'previousWeek':
        b = today - weekday * DAY; a = b - 7 * DAY; break;
      case 'currentMonth':
        a = Date.UTC(y, m, 1); b = Date.UTC(y, m + 1, 1); break;
      case 'previousMonth':
        a = Date.UTC(y, m - 1, 1); b = Date.UTC(y, m, 1); break;
      case 'currentYear':
        a = Date.UTC(y, 0, 1); b = Date.UTC(y + 1, 0, 1); break;
      case 'previousYear':
        a = Date.UTC(y - 1, 0, 1); b = Date.UTC(y, 0, 1); break;
    }
    fromLocal = wallToInput(a);
    toLocal = wallToInput(b);
  }

  return {
    fromLocal,
    toLocal,
    fromUtcMs: localToUtcMs(fromLocal, timeZone),
    toUtcMs: localToUtcMs(toLocal, timeZone),
  };
}
