import { firstSlot, formatUtc, type LocalTimeFormatter, type OutputOptions, type TimeGrid } from '@repnode/shared';
import { BOM, EOL, type CsvFormatter } from './csv.ts';

export interface QuantityColumn {
  id: number;
  name: string;
  unit: string | null;
}

/** Recibe las filas de una consulta (ya ordenadas) y escribe líneas CSV. */
export interface RowSink {
  rows: number;
  /** Filas con datos fuera de la grilla (solo con relleno de filas) */
  offGrid: number;
  onRow(quantityId: number, tsMs: number, value: number | null): void;
  finish(): void;
}

type Write = (s: string) => void;

export function columnHeader(q: QuantityColumn): string {
  return q.unit ? `${q.name} [${q.unit}]` : q.name;
}

/** Encabezado del archivo final (formato ancho/largo) o de cada CSV dentro del ZIP. */
export function headerLine(fmt: CsvFormatter, output: OutputOptions, columns: QuantityColumn[], perMeterFile: boolean): string {
  const time = output.includeUtc ? ['FechaHora', 'FechaHoraUTC'] : ['FechaHora'];
  if (output.format === 'long') {
    return fmt.line(['Medidor', 'Medicion', 'Unidad', ...time, 'Valor'].map((f) => fmt.field(f)));
  }
  const meter = perMeterFile ? [] : ['Medidor'];
  return fmt.line([...meter, ...time, ...columns.map(columnHeader)].map((f) => fmt.field(f)));
}

/**
 * Formato ancho: una fila por timestamp con una columna por medición.
 * Las filas llegan ordenadas por (TimestampUTC, QuantityID), así que el pivot se hace en streaming.
 * Con `grid`, cada casillero sin datos se escribe como fila con los valores vacíos; los timestamps
 * con datos fuera de la grilla se conservan como filas extra (`offGrid`).
 */
export class WideSink implements RowSink {
  rows = 0;
  offGrid = 0;
  private curTs = -1;
  private next: number;
  private readonly vals: (number | null)[];
  private readonly colIndex: Map<number, number>;
  private readonly prefix: string;
  private readonly blankTail: string;
  private readonly fmt: CsvFormatter;
  private readonly tf: LocalTimeFormatter;
  private readonly includeUtc: boolean;
  private readonly write: Write;
  private readonly grid: TimeGrid | null;

  constructor(
    prefix: string, columns: QuantityColumn[], fmt: CsvFormatter, tf: LocalTimeFormatter, includeUtc: boolean, write: Write,
    grid: TimeGrid | null = null,
  ) {
    this.prefix = prefix;
    this.colIndex = new Map(columns.map((c, i) => [c.id, i]));
    this.vals = new Array(columns.length).fill(null);
    this.blankTail = fmt.sep.repeat(columns.length);
    this.fmt = fmt;
    this.tf = tf;
    this.includeUtc = includeUtc;
    this.write = write;
    this.grid = grid;
    this.next = grid ? firstSlot(grid) : 0;
  }

  onRow(quantityId: number, tsMs: number, value: number | null): void {
    if (tsMs !== this.curTs) {
      this.flushRow();
      if (this.grid) this.alignTo(tsMs);
      this.curTs = tsMs;
    }
    const i = this.colIndex.get(quantityId);
    if (i !== undefined) this.vals[i] = value;
  }

  protected timeFields(tsMs: number): string {
    return this.includeUtc ? this.tf.format(tsMs) + this.fmt.sep + formatUtc(tsMs) : this.tf.format(tsMs);
  }

  /** Escribe los casilleros vacíos anteriores a `tsMs`; si `tsMs` no es un casillero, cuenta como fila extra. */
  private alignTo(tsMs: number): void {
    const g = this.grid!;
    this.fillUntil(Math.min(tsMs - 1, g.toMs));
    if (tsMs === this.next) this.next += g.stepMs;
    else this.offGrid++;
  }

  private fillUntil(limitMs: number): void {
    const step = this.grid!.stepMs;
    for (; this.next <= limitMs; this.next += step) {
      this.write(this.prefix + this.timeFields(this.next) + this.blankTail + EOL);
      this.rows++;
    }
  }

  private flushRow(): void {
    if (this.curTs < 0) return;
    const sep = this.fmt.sep;
    let line = this.prefix + this.timeFields(this.curTs);
    for (let i = 0; i < this.vals.length; i++) {
      line += sep + this.fmt.num(this.vals[i]);
      this.vals[i] = null;
    }
    this.write(line + EOL);
    this.rows++;
  }

  finish(): void {
    this.flushRow();
    this.curTs = -1;
    if (this.grid) this.fillUntil(this.grid.toMs);
  }
}

/**
 * Parcial del formato "por estampa de tiempo": como el ancho, pero la primera columna es el timestamp en ms UTC
 * (`ts;v1;v2…`), para que el ensamblado combine todos los medidores ordenando por tiempo.
 */
export class KeyedWideSink extends WideSink {
  constructor(columns: QuantityColumn[], fmt: CsvFormatter, tf: LocalTimeFormatter, write: Write, grid: TimeGrid | null = null) {
    super('', columns, fmt, tf, false, write, grid);
  }

  protected override timeFields(tsMs: number): string {
    return String(tsMs);
  }
}

/**
 * Formato largo (normalizado): Medidor; Medición; Unidad; FechaHora; Valor.
 * Las filas llegan ordenadas por (QuantityID, TimestampUTC). Con `grid`, cada medición recibe su grilla
 * completa (también las que no tienen ningún dato), en el mismo orden por QuantityID.
 */
export class LongSink implements RowSink {
  rows = 0;
  offGrid = 0;
  private readonly qPrefix: Map<number, string>;
  private readonly fmt: CsvFormatter;
  private readonly tf: LocalTimeFormatter;
  private readonly includeUtc: boolean;
  private readonly write: Write;
  private readonly grid: TimeGrid | null;
  /** Mediciones en el orden en que llegan de SQL; `pos` apunta a la siguiente aún no empezada */
  private readonly order: number[];
  private pos = 0;
  private curQ: number | null = null;
  private next = 0;

  constructor(
    meterField: string, columns: QuantityColumn[], fmt: CsvFormatter, tf: LocalTimeFormatter, includeUtc: boolean, write: Write,
    grid: TimeGrid | null = null,
  ) {
    const sep = fmt.sep;
    this.qPrefix = new Map(columns.map((c) => [c.id, meterField + sep + fmt.field(c.name) + sep + fmt.field(c.unit ?? '') + sep]));
    this.fmt = fmt;
    this.tf = tf;
    this.includeUtc = includeUtc;
    this.write = write;
    this.grid = grid;
    this.order = columns.map((c) => c.id).sort((a, b) => a - b);
  }

  onRow(quantityId: number, tsMs: number, value: number | null): void {
    const p = this.qPrefix.get(quantityId);
    if (p === undefined) return;
    if (this.grid) {
      if (quantityId !== this.curQ) this.startQuantity(quantityId);
      this.fillUntil(p, Math.min(tsMs - 1, this.grid.toMs));
      if (tsMs === this.next) this.next += this.grid.stepMs;
      else this.offGrid++;
    }
    this.line(p, tsMs, this.fmt.num(value));
  }

  private line(prefix: string, tsMs: number, value: string): void {
    const sep = this.fmt.sep;
    let line = prefix + this.tf.format(tsMs);
    if (this.includeUtc) line += sep + formatUtc(tsMs);
    this.write(line + sep + value + EOL);
    this.rows++;
  }

  private fillUntil(prefix: string, limitMs: number): void {
    const step = this.grid!.stepMs;
    for (; this.next <= limitMs; this.next += step) this.line(prefix, this.next, '');
  }

  /** Cierra la medición en curso y escribe grillas vacías para las que no tuvieron datos antes de `quantityId`. */
  private startQuantity(quantityId: number | null): void {
    const g = this.grid!;
    if (this.curQ !== null) this.fillUntil(this.qPrefix.get(this.curQ)!, g.toMs);
    while (this.pos < this.order.length && this.order[this.pos] !== quantityId) {
      this.next = firstSlot(g);
      this.fillUntil(this.qPrefix.get(this.order[this.pos])!, g.toMs);
      this.pos++;
    }
    this.pos++;
    this.curQ = quantityId;
    this.next = firstSlot(g);
  }

  finish(): void {
    if (this.grid) this.startQuantity(null);
  }
}

export { BOM };
