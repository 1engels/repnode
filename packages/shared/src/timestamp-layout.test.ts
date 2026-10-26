import { describe, expect, it } from 'vitest';
import { splitColumns, timestampColumnOrder } from './timestamp-layout.ts';

describe('orden de columnas por estampa de tiempo', () => {
  it('por medidor conserva el orden medidor-mayor', () => {
    expect(timestampColumnOrder(2, 3, false)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('por medición intercala los medidores', () => {
    // M0q0, M1q0, M0q1, M1q1, M0q2, M1q2
    expect(timestampColumnOrder(2, 3, true)).toEqual([0, 3, 1, 4, 2, 5]);
  });
});

describe('reparto en varios archivos', () => {
  it('un solo archivo si cabe', () => {
    expect(splitColumns(500, 4, false)).toEqual([{ start: 0, end: 2000 }]);
  });

  it('por medidor no parte las columnas de un medidor', () => {
    // 3 medidores × 4 mediciones, límite 10 → [M0,M1] (8) y [M2] (4)
    expect(splitColumns(3, 4, false, 10)).toEqual([{ start: 0, end: 8 }, { start: 8, end: 12 }]);
  });

  it('por medición no parte una medición si cabe entera', () => {
    // 4 medidores × 3 mediciones, límite 9 → [q0,q1] (8) y [q2] (4)
    expect(splitColumns(4, 3, true, 9)).toEqual([{ start: 0, end: 8 }, { start: 8, end: 12 }]);
  });

  it('corta una unidad que sola supera el límite', () => {
    // 25 medidores × 1 medición, por medición, límite 10 → 10 + 10 + 5
    expect(splitColumns(25, 1, true, 10)).toEqual([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 25 }]);
  });

  it('nunca supera el límite y cubre todas las columnas', () => {
    const chunks = splitColumns(4001, 4, false);
    expect(chunks.every((c) => c.end - c.start <= 16_000)).toBe(true);
    expect(chunks.at(-1)!.end).toBe(16_004);
    expect(chunks).toHaveLength(2);
  });
});
