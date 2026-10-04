import { describe, expect, it } from 'vitest';
import { firstSlot, gridSlotCount, isOnGrid, makeGrid } from './grid.ts';

const day = Date.UTC(2025, 0, 1, 5); // 2025-01-01 00:00 en America/Lima
const H = 3_600_000;

describe('grilla de tiempo', () => {
  it('un día a 15 min tiene 96 casilleros: 00:15 … 24:00', () => {
    const g = makeGrid(day, day + 24 * H, 15);
    expect(gridSlotCount(g)).toBe(96);
    expect(firstSlot(g)).toBe(day + 15 * 60_000);
    expect(isOnGrid(g, day + 24 * H)).toBe(true);
  });

  it('el inicio está excluido y el fin incluido', () => {
    const g = makeGrid(day, day + H, 15);
    expect(isOnGrid(g, day)).toBe(false);
    expect(isOnGrid(g, day + H)).toBe(true);
    expect(isOnGrid(g, day + H + 15 * 60_000)).toBe(false);
  });

  it('detecta timestamps fuera de la grilla', () => {
    const g = makeGrid(day, day + H, 15);
    expect(isOnGrid(g, day + 7 * 60_000)).toBe(false);
    expect(isOnGrid(g, day + 30 * 60_000 + 1)).toBe(false);
  });

  it('un rango que no es múltiplo del intervalo deja fuera el resto final', () => {
    expect(gridSlotCount(makeGrid(day, day + 50 * 60_000, 15))).toBe(3);
    expect(gridSlotCount(makeGrid(day, day, 15))).toBe(0);
  });
});
