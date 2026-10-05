import { existsSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/** Lee un archivo línea a línea con un buffer propio: casi todas las llamadas a next() se resuelven sin E/S. */
export class LineReader {
  private fh: FileHandle | null;
  private readonly buf = Buffer.allocUnsafe(1 << 16);
  private lines: string[] = [];
  private idx = 0;
  private rest = '';

  private constructor(fh: FileHandle | null) {
    this.fh = fh;
  }

  /** Un parcial inexistente se lee como vacío. */
  static async open(path: string): Promise<LineReader> {
    return new LineReader(existsSync(path) ? await open(path, 'r') : null);
  }

  async next(): Promise<string | null> {
    for (;;) {
      while (this.idx < this.lines.length) {
        const line = this.lines[this.idx++];
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (clean) return clean;
      }
      if (!this.fh) return null;
      await this.fill();
    }
  }

  private async fill(): Promise<void> {
    const { bytesRead } = await this.fh!.read(this.buf, 0, this.buf.length, null);
    this.idx = 0;
    if (bytesRead === 0) {
      this.lines = this.rest ? [this.rest] : [];
      this.rest = '';
      await this.close();
      return;
    }
    // Los parciales solo tienen dígitos, signos y separadores (ASCII)
    const parts = (this.rest + this.buf.toString('latin1', 0, bytesRead)).split('\n');
    this.rest = parts.pop()!;
    this.lines = parts;
  }

  async close(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    await fh?.close();
  }
}

/** Montículo mínimo de (timestamp, índice de entrada). */
class MinHeap {
  private ts: number[] = [];
  private ix: number[] = [];

  get size(): number {
    return this.ts.length;
  }

  peek(): number {
    return this.ts[0];
  }

  push(ts: number, i: number): void {
    let k = this.ts.length;
    this.ts.push(ts);
    this.ix.push(i);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.less(p, k)) break;
      this.swap(p, k);
      k = p;
    }
  }

  pop(): number {
    const top = this.ix[0];
    const lastTs = this.ts.pop()!;
    const lastIx = this.ix.pop()!;
    if (this.ts.length) {
      this.ts[0] = lastTs;
      this.ix[0] = lastIx;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < this.ts.length && this.less(l, m)) m = l;
        if (r < this.ts.length && this.less(r, m)) m = r;
        if (m === k) break;
        this.swap(k, m);
        k = m;
      }
    }
    return top;
  }

  // A igual timestamp desempata por índice, para un orden determinista
  private less(a: number, b: number): boolean {
    return this.ts[a] < this.ts[b] || (this.ts[a] === this.ts[b] && this.ix[a] < this.ix[b]);
  }

  private swap(a: number, b: number): void {
    [this.ts[a], this.ts[b]] = [this.ts[b], this.ts[a]];
    [this.ix[a], this.ix[b]] = [this.ix[b], this.ix[a]];
  }
}

export interface MergeInput {
  path: string;
  /** Cantidad de valores por línea (después del timestamp) */
  width: number;
}

/**
 * Combina parciales `ts;v1;…;vW` ordenados por timestamp. Por cada timestamp distinto llama a `onRow` con la
 * concatenación de los valores de todas las entradas, en su orden, con celdas vacías donde una entrada no tiene ese
 * timestamp. Devuelve la cantidad de filas.
 */
export async function mergeByTimestamp(
  inputs: MergeInput[], sep: string, onRow: (tsMs: number, values: string) => void | Promise<void>,
): Promise<number> {
  const n = inputs.length;
  const readers = await Promise.all(inputs.map((i) => LineReader.open(i.path)));
  const blanks = inputs.map((i) => sep.repeat(Math.max(0, i.width - 1)));
  const heads: string[] = new Array(n).fill('');
  const current: (string | null)[] = new Array(n).fill(null);
  const heap = new MinHeap();

  async function advance(i: number): Promise<void> {
    const line = await readers[i].next();
    if (line == null) return;
    const cut = line.indexOf(sep);
    heads[i] = cut < 0 ? '' : line.slice(cut + 1);
    heap.push(Number(cut < 0 ? line : line.slice(0, cut)), i);
  }

  try {
    for (let i = 0; i < n; i++) await advance(i);
    let rows = 0;
    const touched: number[] = [];
    while (heap.size) {
      const ts = heap.peek();
      while (heap.size && heap.peek() === ts) {
        const i = heap.pop();
        current[i] = heads[i];
        touched.push(i);
      }
      let values = '';
      for (let i = 0; i < n; i++) values += (i ? sep : '') + (current[i] ?? blanks[i]);
      await onRow(ts, values);
      rows++;
      for (const i of touched) {
        current[i] = null;
        await advance(i);
      }
      touched.length = 0;
    }
    return rows;
  } finally {
    await Promise.all(readers.map((r) => r.close()));
  }
}
