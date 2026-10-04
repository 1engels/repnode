// Grilla de tiempo para completar filas vacías. Sigue la semántica del rango (inicio excluido, fin incluido):
// un día completo a 15 min da los casilleros 00:15 … 00:00 del día siguiente (96 filas).

export interface TimeGrid {
  fromMs: number;
  toMs: number;
  stepMs: number;
}

export function makeGrid(fromUtcMs: number, toUtcMs: number, intervalMinutes: number): TimeGrid {
  return { fromMs: fromUtcMs, toMs: toUtcMs, stepMs: intervalMinutes * 60_000 };
}

/** Cantidad de casilleros en (from, to]. */
export function gridSlotCount(g: TimeGrid): number {
  return g.toMs > g.fromMs ? Math.floor((g.toMs - g.fromMs) / g.stepMs) : 0;
}

/** Primer casillero (el inicio del rango está excluido). */
export function firstSlot(g: TimeGrid): number {
  return g.fromMs + g.stepMs;
}

export function isOnGrid(g: TimeGrid, tsMs: number): boolean {
  return tsMs > g.fromMs && tsMs <= g.toMs && (tsMs - g.fromMs) % g.stepMs === 0;
}

/** Tope de filas al completar la grilla (se escriben aunque no haya datos). */
export const MAX_GRID_ROWS = 50_000_000;
