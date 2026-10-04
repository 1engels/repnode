import type { WriteStream } from 'node:fs';
import type { OutputOptions } from '@repnode/shared';

/** BOM UTF-8: Excel en Windows detecta así la codificación (acentos, ñ, símbolos de unidades). */
export const BOM = '﻿';
export const EOL = '\r\n';

export class CsvFormatter {
  readonly sep: string;
  private readonly decimalComma: boolean;
  private readonly decimals: number | null;
  private readonly needsQuote: RegExp;

  constructor(opts: Pick<OutputOptions, 'delimiter' | 'decimal' | 'decimals'>) {
    this.sep = opts.delimiter;
    this.decimalComma = opts.decimal === ',';
    this.decimals = opts.decimals;
    const sepClass = this.sep === '\t' ? '\\t' : this.sep;
    this.needsQuote = new RegExp(`[${sepClass}"\\r\\n]|^\\s|\\s$`);
  }

  /** Campo de texto con comillas RFC 4180 si hace falta. */
  field(value: string): string {
    return this.needsQuote.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }

  num(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '';
    const s = this.decimals == null ? String(v) : v.toFixed(this.decimals);
    return this.decimalComma ? s.replace('.', ',') : s;
  }

  line(fields: string[]): string {
    return fields.join(this.sep) + EOL;
  }
}

/** Escritura con buffer y contrapresión: pausa la consulta SQL si el disco no da abasto. */
export class BufferedWriter {
  bytes = 0;
  private buf: string[] = [];
  private size = 0;
  private readonly ws: WriteStream;
  private readonly onPressure: (paused: boolean) => void;
  private static readonly FLUSH_AT = 1 << 16;

  constructor(ws: WriteStream, onPressure: (paused: boolean) => void) {
    this.ws = ws;
    this.onPressure = onPressure;
  }

  write(s: string): void {
    this.buf.push(s);
    this.size += s.length;
    if (this.size >= BufferedWriter.FLUSH_AT) this.flush();
  }

  flush(): void {
    if (!this.size) return;
    const chunk = this.buf.join('');
    this.buf = [];
    this.size = 0;
    this.bytes += Buffer.byteLength(chunk);
    if (!this.ws.write(chunk)) {
      this.onPressure(true);
      this.ws.once('drain', () => this.onPressure(false));
    }
  }

  end(): Promise<void> {
    this.flush();
    return new Promise((resolve, reject) => {
      this.ws.once('error', reject);
      this.ws.end(() => resolve());
    });
  }
}
