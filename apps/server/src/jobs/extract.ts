import { createWriteStream } from 'node:fs';
import type { ConnectionPool, Request } from 'mssql';
import { LocalTimeFormatter, makeGrid, type OutputOptions, type TimeGrid } from '@repnode/shared';
import { bindCommon, dataSql, READ_COMMITTED, READ_UNCOMMITTED } from '../mssql/queries.ts';
import { BufferedWriter, CsvFormatter } from './csv.ts';
import { BOM, headerLine, KeyedWideSink, LongSink, WideSink, type QuantityColumn, type RowSink } from './formats.ts';

export interface ExtractContext {
  columns: QuantityColumn[];
  from: Date;
  to: Date;
  output: OutputOptions;
  readUncommitted: boolean;
  fmt: CsvFormatter;
  tf: LocalTimeFormatter;
  /** Grilla para completar filas vacías (null si la opción está desactivada) */
  grid: TimeGrid | null;
  /** Requests en curso, para poder cancelarlos */
  active: Set<Request>;
}

export function createExtractContext(
  columns: QuantityColumn[], fromUtcMs: number, toUtcMs: number, timezone: string, output: OutputOptions, readUncommitted: boolean,
): ExtractContext {
  return {
    columns,
    from: new Date(fromUtcMs),
    to: new Date(toUtcMs),
    output,
    readUncommitted,
    fmt: new CsvFormatter(output),
    tf: new LocalTimeFormatter(timezone),
    grid: output.fillGaps ? makeGrid(fromUtcMs, toUtcMs, output.intervalMinutes) : null,
    active: new Set(),
  };
}

/**
 * Extrae todas las mediciones de un medidor con UNA consulta en streaming y la escribe en `filePath`.
 * - wide/long: el archivo parcial no lleva BOM ni encabezado (se agregan al ensamblar).
 * - zip: cada parcial es un CSV completo (BOM + encabezado), sin columna Medidor.
 */
export function extractMeter(pool: ConnectionPool, sourceId: number, label: string, filePath: string, ctx: ExtractContext): Promise<{ rows: number; bytes: number; offGrid: number }> {
  const { output, fmt, tf, columns } = ctx;
  const perMeterFile = output.format === 'zip';
  const ws = createWriteStream(filePath, { highWaterMark: 1 << 20 });
  const req = pool.request();
  req.stream = true;

  const writer = new BufferedWriter(ws, (paused) => (paused ? req.pause() : req.resume()));
  const write = (s: string) => writer.write(s);
  if (perMeterFile) write(BOM + headerLine(fmt, output, columns, true));

  const meterField = fmt.field(label);
  const sink: RowSink =
    output.format === 'long'
      ? new LongSink(meterField, columns, fmt, tf, output.includeUtc, write, ctx.grid)
      : output.format === 'timestamp'
        ? new KeyedWideSink(columns, fmt, tf, write, ctx.grid)
        : new WideSink(perMeterFile ? '' : meterField + fmt.sep, columns, fmt, tf, output.includeUtc, write, ctx.grid);

  const params = bindCommon(req, sourceId, columns.map((c) => c.id), ctx.from, ctx.to);
  const text = dataSql(params, output.format === 'long' ? 'quantity' : 'time', ctx.readUncommitted ? READ_UNCOMMITTED : READ_COMMITTED);

  return new Promise((resolve, reject) => {
    let failed = false;
    ctx.active.add(req);
    req.on('row', (r: { QuantityID: number; TimestampUTC: Date; Value: number | null }) => {
      sink.onRow(r.QuantityID, r.TimestampUTC.getTime(), r.Value);
    });
    req.on('error', (err) => {
      if (failed) return;
      failed = true;
      ctx.active.delete(req);
      ws.destroy();
      reject(err);
    });
    req.on('done', () => {
      if (failed) return;
      ctx.active.delete(req);
      sink.finish();
      writer.end().then(() => resolve({ rows: sink.rows, bytes: writer.bytes, offGrid: sink.offGrid }), reject);
    });
    req.query(text);
  });
}
