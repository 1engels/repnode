import { describe, expect, it } from 'vitest';
import { LocalTimeFormatter, makeGrid, outputSchema } from '@repnode/shared';
import { CsvFormatter } from './csv.ts';
import { headerLine, LongSink, WideSink, type QuantityColumn } from './formats.ts';

const cols: QuantityColumn[] = [
  { id: 96, name: 'kWh del', unit: 'kWh' },
  { id: 106, name: 'kVARh del', unit: null },
];
const tf = new LocalTimeFormatter('America/Lima');
const t0 = Date.parse('2025-01-01T05:15:00Z');
const t1 = Date.parse('2025-01-01T05:30:00Z');

function collect() {
  const out: string[] = [];
  return { out, write: (s: string) => out.push(s) };
}

describe('CsvFormatter', () => {
  it('usa coma decimal y comillas RFC 4180', () => {
    const f = new CsvFormatter({ delimiter: ';', decimal: ',', decimals: null });
    expect(f.num(1234.5)).toBe('1234,5');
    expect(f.num(null)).toBe('');
    expect(f.num(Number.NaN)).toBe('');
    expect(f.field('Tablero; "A"')).toBe('"Tablero; ""A"""');
    expect(f.field('Simple')).toBe('Simple');
  });

  it('respeta los decimales fijos y el punto decimal', () => {
    const f = new CsvFormatter({ delimiter: ',', decimal: '.', decimals: 2 });
    expect(f.num(1.005)).toBe('1.00');
    expect(f.num(3)).toBe('3.00');
    expect(f.field('a,b')).toBe('"a,b"');
  });
});

describe('formato ancho', () => {
  it('pivota filas ordenadas por timestamp y deja vacíos los datos faltantes', () => {
    const fmt = new CsvFormatter({ delimiter: ';', decimal: ',', decimals: null });
    const { out, write } = collect();
    const sink = new WideSink('Medidor 1;', cols, fmt, tf, false, write);
    sink.onRow(96, t0, 10.5);
    sink.onRow(106, t0, 2);
    sink.onRow(96, t1, 11);
    sink.finish();
    expect(out.join('')).toBe('Medidor 1;2025-01-01 00:15:00;10,5;2\r\nMedidor 1;2025-01-01 00:30:00;11;\r\n');
    expect(sink.rows).toBe(2);
  });

  it('encabezado con unidades y columna UTC opcional', () => {
    const output = outputSchema.parse({ includeUtc: true });
    const fmt = new CsvFormatter(output);
    expect(headerLine(fmt, output, cols, false)).toBe('Medidor;FechaHora;FechaHoraUTC;kWh del [kWh];kVARh del\r\n');
    expect(headerLine(fmt, output, cols, true)).toBe('FechaHora;FechaHoraUTC;kWh del [kWh];kVARh del\r\n');
  });
});

describe('formato largo', () => {
  it('una fila por medición', () => {
    const fmt = new CsvFormatter({ delimiter: ';', decimal: ',', decimals: null });
    const { out, write } = collect();
    const sink = new LongSink('M1', cols, fmt, tf, true, write);
    sink.onRow(106, t0, 0.25);
    sink.finish();
    expect(out.join('')).toBe('M1;kVARh del;;2025-01-01 00:15:00;2025-01-01 05:15:00;0,25\r\n');
  });

  it('rechaza separador y decimal ambos coma', () => {
    expect(() => outputSchema.parse({ delimiter: ',', decimal: ',' })).toThrow();
  });
});

describe('completar filas (grilla)', () => {
  const fmt = new CsvFormatter({ delimiter: ';', decimal: ',', decimals: null });
  const from = Date.parse('2025-01-01T05:00:00Z'); // 00:00 en Lima
  const min = 60_000;
  const grid = makeGrid(from, from + 60 * min, 15); // 00:15, 00:30, 00:45, 01:00

  it('ancho: rellena los casilleros vacíos antes, entre y después de los datos', () => {
    const { out, write } = collect();
    const sink = new WideSink('M;', cols, fmt, tf, false, write, grid);
    sink.onRow(96, from + 30 * min, 1);
    sink.onRow(106, from + 30 * min, 2);
    sink.finish();
    expect(out.join('')).toBe(
      'M;2025-01-01 00:15:00;;\r\nM;2025-01-01 00:30:00;1;2\r\nM;2025-01-01 00:45:00;;\r\nM;2025-01-01 01:00:00;;\r\n',
    );
    expect(sink.rows).toBe(4);
    expect(sink.offGrid).toBe(0);
  });

  it('ancho: un medidor sin datos genera la grilla completa en blanco', () => {
    const { out, write } = collect();
    const sink = new WideSink('', cols, fmt, tf, true, write, grid);
    sink.finish();
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('2025-01-01 00:15:00;2025-01-01 05:15:00;;\r\n');
  });

  it('ancho: un dato fuera de la grilla se conserva como fila extra y se cuenta', () => {
    const { out, write } = collect();
    const sink = new WideSink('', cols, fmt, tf, false, write, grid);
    sink.onRow(96, from + 22 * min, 5);
    sink.finish();
    expect(out.map((l) => l.slice(11, 16))).toEqual(['00:15', '00:22', '00:30', '00:45', '01:00']);
    expect(sink.rows).toBe(5);
    expect(sink.offGrid).toBe(1);
  });

  it('largo: grilla completa por medición en orden de QuantityID, también sin datos', () => {
    const { out, write } = collect();
    const sink = new LongSink('M', cols, fmt, tf, false, write, grid);
    // Solo llega kVARh (106) en 00:45; kWh (96) no tiene datos
    sink.onRow(106, from + 45 * min, 3);
    sink.finish();
    const lines = out.join('').split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 4).every((l) => l.startsWith('M;kWh del;kWh;') && l.endsWith(';'))).toBe(true);
    expect(lines[6]).toBe('M;kVARh del;;2025-01-01 00:45:00;3');
    expect(lines[7]).toBe('M;kVARh del;;2025-01-01 01:00:00;');
    expect(sink.offGrid).toBe(0);
  });

  it('sin grilla no agrega filas', () => {
    const { out, write } = collect();
    const sink = new LongSink('M', cols, fmt, tf, false, write);
    sink.finish();
    expect(out).toHaveLength(0);
  });
});
