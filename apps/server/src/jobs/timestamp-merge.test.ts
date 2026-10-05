import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTimeFormatter, outputSchema } from '@repnode/shared';
import { assemble } from './assemble.ts';
import { CsvFormatter } from './csv.ts';
import { KeyedWideSink, type QuantityColumn } from './formats.ts';
import { partPath, type MeterTask } from './protocol.ts';
import { mergeByTimestamp } from './timestamp-merge.ts';

const cols: QuantityColumn[] = [
  { id: 96, name: 'kWh del', unit: 'kWh' },
  { id: 106, name: 'kVARh del', unit: null },
];
const t0 = Date.parse('2025-01-01T05:15:00Z'); // 00:15 en Lima
const t1 = Date.parse('2025-01-01T05:30:00Z');
const fmt = new CsvFormatter({ delimiter: ';', decimal: ',', decimals: null });
const tf = new LocalTimeFormatter('America/Lima');

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

/** Escribe el parcial de un medidor con el sink real. */
function writePart(index: number, rows: [number, number, number | null][]) {
  let text = '';
  const sink = new KeyedWideSink(cols, fmt, tf, (s) => (text += s));
  for (const [q, ts, v] of rows) sink.onRow(q, ts, v);
  sink.finish();
  writeFileSync(partPath(dir, index), text);
}

describe('combinación por estampa de tiempo', () => {
  it('mergeByTimestamp une por timestamp y deja vacíos los medidores sin ese dato', async () => {
    dir = mkdtempSync(join(tmpdir(), 'repnode-'));
    writePart(0, [[96, t0, 1], [106, t0, 2], [96, t1, 3]]);
    writePart(1, [[106, t1, 4]]);
    const rows: string[] = [];
    const n = await mergeByTimestamp(
      [{ path: partPath(dir, 0), width: 2 }, { path: partPath(dir, 1), width: 2 }, { path: partPath(dir, 9), width: 2 }],
      ';',
      (ts, v) => void rows.push(`${ts}|${v}`),
    );
    expect(n).toBe(2);
    expect(rows).toEqual([`${t0}|1;2;;;;`, `${t1}|3;;;4;;`]);
  });

  it('assemble: encabezado GRUPO.MEDIDOR.Medición [unidad], orden por nombre y columnas por medición', async () => {
    dir = mkdtempSync(join(tmpdir(), 'repnode-'));
    // index 0 = PLANTA.B, index 1 = PLANTA.A → en el archivo A va primero
    writePart(0, [[96, t0, 10]]);
    writePart(1, [[96, t0, 20], [106, t0, 21]]);
    const meters: MeterTask[] = [
      { index: 0, sourceId: 1, label: 'PLANTA.B' },
      { index: 1, sourceId: 2, label: 'PLANTA.A' },
    ];
    const outFile = join(dir, 'out.csv');
    const output = outputSchema.parse({ format: 'timestamp', columnsByQuantity: true });
    const res = await assemble({ dir, outFile, meters, columns: cols, output, timezone: 'America/Lima', fileName: 'r.csv' });
    expect(res.rows).toBe(1);
    expect(readFileSync(outFile, 'utf8')).toBe(
      '\uFEFFFechaHora;PLANTA.A.kWh del [kWh];PLANTA.B.kWh del [kWh];PLANTA.A.kVARh del;PLANTA.B.kVARh del\r\n' +
      '2025-01-01 00:15:00;20;10;21;\r\n',
    );
  });

  it('assemble: más de 16.000 columnas se reparten en varios archivos (y combina en dos niveles)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'repnode-'));
    const meters: MeterTask[] = [];
    for (let i = 0; i < 8001; i++) {
      meters.push({ index: i, sourceId: i, label: `G.M${String(i).padStart(5, '0')}` });
      writePart(i, [[96, t0, i]]);
    }
    const output = outputSchema.parse({ format: 'timestamp' });
    const res = await assemble({ dir, outFile: join(dir, 'out.zip'), meters, columns: cols, output, timezone: 'America/Lima', fileName: 'r.zip' });
    expect(res.rows).toBe(1);
    // 8001 medidores × 2 = 16.002 columnas → 8000 medidores (16.000) + 1 medidor
    const [h1, r1] = readFileSync(join(dir, 'parte-1.csv'), 'utf8').split('\r\n');
    const [h2, r2] = readFileSync(join(dir, 'parte-2.csv'), 'utf8').split('\r\n');
    expect(h1.split(';')).toHaveLength(16_001);
    expect(h2).toBe('\uFEFFFechaHora;G.M08000.kWh del [kWh];G.M08000.kVARh del');
    expect(r1.split(';')[16_000]).toBe('');
    expect(r1.split(';')[15_999]).toBe('7999');
    expect(r2).toBe('2025-01-01 00:15:00;8000;');
  }, 60_000);
});
