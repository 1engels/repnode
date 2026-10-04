import { describe, expect, it, vi } from 'vitest';

// validate.ts importa el repositorio SQLite; en pruebas se reemplaza por un stub
vi.mock('./store/sqlite.ts', () => ({ settings: { get: () => ({}) } }));
const { classify } = await import('./validate.ts');

const D = 86_400_000;
const from = Date.parse('2025-01-01T05:00:00Z');
const to = Date.parse('2025-02-01T05:00:00Z');
const now = Date.parse('2026-01-01T00:00:00Z');

function cov(entries: [number, number, number, number][]) {
  const m = new Map<number, Map<number, { min: number; max: number }>>();
  for (const [s, q, min, max] of entries) {
    if (!m.has(s)) m.set(s, new Map());
    m.get(s)!.set(q, { min, max });
  }
  return m;
}

describe('classify', () => {
  it('todo OK', () => {
    const r = classify({
      sourceIds: [1], quantityIds: [10], fromUtcMs: from, toUtcMs: to, nowMs: now, timezone: 'America/Lima',
      coverage: cov([[1, 10, from - D, to + D]]),
      real: new Map([['1:10', { first: from + 900_000, last: to }]]),
    });
    expect(r.status).toBe('ok');
    expect(r.meters).toHaveLength(0);
    expect(r.summary.ok).toBe(1);
  });

  it('marca medición inexistente y sin datos en rango como error', () => {
    const r = classify({
      sourceIds: [1, 2], quantityIds: [10, 20], fromUtcMs: from, toUtcMs: to, nowMs: now, timezone: 'America/Lima',
      coverage: cov([[1, 10, from, to], [1, 20, from, to], [2, 10, from - 100 * D, from - 50 * D]]),
      real: new Map([['1:10', { first: from + 1, last: to }], ['1:20', { first: from + 1, last: to }], ['2:10', { first: null, last: null }]]),
    });
    expect(r.status).toBe('error');
    expect(r.summary.metersWithErrors).toBe(1);
    const m2 = r.meters.find((m) => m.sourceId === 2)!;
    expect(m2.issues.map((i) => i.status).sort()).toEqual(['missing_quantity', 'no_data_in_range']);
    expect(r.quantities).toEqual([{ quantityId: 10, errors: 1, partial: 0 }, { quantityId: 20, errors: 1, partial: 0 }]);
    // Hay una medición inexistente: ajustar el rango no lo arregla
    expect(r.suggestedRange).toBeNull();
  });

  it('cobertura parcial es advertencia y no bloquea', () => {
    const r = classify({
      sourceIds: [1], quantityIds: [10], fromUtcMs: from, toUtcMs: to, nowMs: now, timezone: 'UTC',
      coverage: cov([[1, 10, from + 10 * D, to]]),
      real: new Map([['1:10', { first: from + 10 * D, last: to }]]),
    });
    expect(r.status).toBe('warning');
    expect(r.meters[0].status).toBe('partial');
  });

  it('no avisa por el futuro cuando el rango termina después de ahora', () => {
    const r = classify({
      sourceIds: [1], quantityIds: [10], fromUtcMs: from, toUtcMs: to, nowMs: from + 5 * D, timezone: 'UTC',
      coverage: cov([[1, 10, from, from + 5 * D]]),
      real: new Map([['1:10', { first: from + 1000, last: from + 5 * D - 3600_000 }]]),
    });
    expect(r.status).toBe('ok');
  });

  it('sugiere un rango donde todos los pares tienen datos', () => {
    const r = classify({
      sourceIds: [1, 2], quantityIds: [10], fromUtcMs: from, toUtcMs: to, nowMs: now, timezone: 'UTC',
      coverage: cov([[1, 10, from - 30 * D, to], [2, 10, from + 20 * D, to + 30 * D]]),
      real: new Map([['1:10', { first: from + 1, last: to }], ['2:10', { first: null, last: null }]]),
    });
    expect(r.status).toBe('error');
    expect(r.suggestedRange).toEqual({ fromLocal: '2025-01-21T00:00', toLocal: '2025-02-02T00:00' });
  });
});
