import { describe, expect, it } from 'vitest';
import { LocalTimeFormatter, localToUtcMs, tzOffsetMs, utcToLocalInput } from './time.ts';
import { resolveRange } from './range.ts';
import { renderFileName, sanitizeFileName } from './filename.ts';

describe('zonas horarias', () => {
  it('convierte hora local de Lima a UTC (ejemplo del software original)', () => {
    expect(new Date(localToUtcMs('2025-01-01T00:00', 'America/Lima')).toISOString()).toBe('2025-01-01T05:00:00.000Z');
    expect(new Date(localToUtcMs('2026-05-01T00:00', 'America/Lima')).toISOString()).toBe('2026-05-01T05:00:00.000Z');
  });

  it('respeta transiciones de horario de verano', () => {
    // Nueva York: 2025-03-09 02:00 EST -> 03:00 EDT
    expect(tzOffsetMs(Date.parse('2025-03-09T06:59:00Z'), 'America/New_York')).toBe(-5 * 3600_000);
    expect(tzOffsetMs(Date.parse('2025-03-09T07:00:00Z'), 'America/New_York')).toBe(-4 * 3600_000);
    expect(new Date(localToUtcMs('2025-07-01T12:00', 'America/New_York')).toISOString()).toBe('2025-07-01T16:00:00.000Z');
  });

  it('el formateador con caché coincide con Intl directo', () => {
    const tzs = ['America/Santiago', 'Europe/Madrid', 'Australia/Lord_Howe', 'Asia/Kolkata', 'UTC'];
    for (const tz of tzs) {
      const f = new LocalTimeFormatter(tz);
      for (let t = Date.parse('2025-01-01T00:00:00Z'); t < Date.parse('2026-01-01T00:00:00Z'); t += 7 * 3600_000 + 13 * 60_000) {
        const expected = utcToLocalInput(t, tz).replace('T', ' ');
        expect(f.format(t).slice(0, 16)).toBe(expected);
      }
    }
  });
});

describe('rangos relativos', () => {
  const now = Date.parse('2026-03-15T15:30:00Z'); // domingo, 10:30 en Lima

  it('mes anterior', () => {
    const r = resolveRange({ mode: 'relative', preset: 'previousMonth' }, 'America/Lima', now);
    expect(r.fromLocal).toBe('2026-02-01T00:00');
    expect(r.toLocal).toBe('2026-03-01T00:00');
    expect(new Date(r.fromUtcMs).toISOString()).toBe('2026-02-01T05:00:00.000Z');
  });

  it('ayer y últimos N días', () => {
    expect(resolveRange({ mode: 'relative', preset: 'yesterday' }, 'America/Lima', now).fromLocal).toBe('2026-03-14T00:00');
    const r = resolveRange({ mode: 'relative', preset: 'lastNDays', days: 30 }, 'America/Lima', now);
    expect(r.fromLocal).toBe('2026-02-13T00:00');
    expect(r.toLocal).toBe('2026-03-15T00:00');
  });

  it('semana anterior (lunes a lunes)', () => {
    const r = resolveRange({ mode: 'relative', preset: 'previousWeek' }, 'America/Lima', now);
    expect(r.fromLocal).toBe('2026-03-02T00:00');
    expect(r.toLocal).toBe('2026-03-09T00:00');
  });

  it('rango fijo', () => {
    const r = resolveRange({ mode: 'fixed', from: '2025-01-01T00:00', to: '2026-05-01T00:00' }, 'America/Lima');
    expect(new Date(r.toUtcMs).toISOString()).toBe('2026-05-01T05:00:00.000Z');
  });
});

describe('nombres de archivo', () => {
  it('sanea caracteres inválidos en Windows', () => {
    expect(sanitizeFileName('a<b>:c"d/e\\f|g?h*  .')).toBe('a_b__c_d_e_f_g_h_');
    expect(sanitizeFileName('CON')).toBe('reporte');
  });

  it('aplica la plantilla', () => {
    const name = renderFileName('{reporte}_{desde}_{hasta}', {
      reportName: 'Energía Planta',
      fromLocal: '2025-01-01T00:00',
      toLocal: '2026-05-01T06:30',
      generatedLocal: '2026-10-03T10:00',
    }, 'csv');
    expect(name).toBe('Energía Planta_20250101_20260501-0630.csv');
  });
});
