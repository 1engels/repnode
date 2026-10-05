import { createReadStream, createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { ZipArchive } from 'archiver';
import {
  formatUtc, LocalTimeFormatter, sanitizeFileName, splitColumns, timestampColumnOrder, type OutputOptions,
} from '@repnode/shared';
import { CsvFormatter, EOL } from './csv.ts';
import { BOM, columnHeader, headerLine, type QuantityColumn } from './formats.ts';
import { partPath, type MeterTask } from './protocol.ts';
import { mergeByTimestamp, type MergeInput } from './timestamp-merge.ts';

export interface AssembleInput {
  dir: string;
  outFile: string;
  meters: MeterTask[];
  columns: QuantityColumn[];
  output: OutputOptions;
  timezone: string;
  /** Nombre del archivo de descarga (para nombrar las partes dentro del ZIP) */
  fileName: string;
}

export interface AssembleResult {
  bytes: number;
  /** Filas finales cuando difieren de la suma de los parciales (formato por estampa de tiempo) */
  rows: number | null;
}

/** Une los parciales en el archivo final (CSV o ZIP). */
export async function assemble(input: AssembleInput): Promise<AssembleResult> {
  const { dir, outFile, meters, columns, output } = input;
  const ordered = [...meters].sort((a, b) => a.index - b.index);
  let rows: number | null = null;

  if (output.format === 'timestamp') {
    rows = await assembleTimestamp(input);
  } else if (output.format === 'zip') {
    await zipFiles(outFile, ordered.map((m) => {
      const base = sanitizeFileName(m.label, `medidor_${m.sourceId}`);
      return { path: partPath(dir, m.index), base };
    }));
  } else {
    const out = createWriteStream(outFile, { highWaterMark: 1 << 20 });
    out.write(BOM + headerLine(new CsvFormatter(output), output, columns, false));
    // Copia manual con contrapresión: pipeline({ end: false }) acumula listeners en `out` por cada parcial
    for (const m of ordered) {
      const p = partPath(dir, m.index);
      if (!existsSync(p)) continue;
      for await (const chunk of createReadStream(p, { highWaterMark: 1 << 20 })) {
        if (!out.write(chunk)) await once(out, 'drain');
      }
    }
    await endStream(out);
  }
  return { bytes: (await stat(outFile)).size, rows };
}

/** Empaqueta archivos en un ZIP; los nombres repetidos llevan " (n)". */
async function zipFiles(outFile: string, files: { path: string; base: string }[]): Promise<void> {
  const out = createWriteStream(outFile);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(out);
  const used = new Map<string, number>();
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    const n = (used.get(f.base.toLowerCase()) ?? 0) + 1;
    used.set(f.base.toLowerCase(), n);
    archive.file(f.path, { name: n === 1 ? `${f.base}.csv` : `${f.base} (${n}).csv` });
  }
  await archive.finalize();
  await done;
}

function endStream(ws: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.end(() => resolve());
  });
}

/** Escritura con buffer de 64 KB y contrapresión. */
class FileOut {
  private buf = '';
  private readonly ws: WriteStream;

  constructor(path: string) {
    this.ws = createWriteStream(path, { highWaterMark: 1 << 20 });
  }

  async write(s: string): Promise<void> {
    this.buf += s;
    if (this.buf.length >= 1 << 16) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.buf) return;
    const ok = this.ws.write(this.buf);
    this.buf = '';
    if (!ok) await once(this.ws, 'drain');
  }

  async end(): Promise<void> {
    await this.flush();
    await endStream(this.ws);
  }
}

/** Más parciales que esto se combinan en dos niveles, para no abrir cientos de archivos a la vez. */
const MAX_OPEN_FILES = 256;

/**
 * Formato por estampa de tiempo: combina los parciales de todos los medidores ordenando por timestamp.
 * Columnas `GRUPO.MEDIDOR.Medición [unidad]`; si superan MAX_FILE_COLUMNS se reparten en varios CSV dentro de un ZIP.
 */
async function assembleTimestamp({ dir, outFile, meters, columns, output, timezone, fileName }: AssembleInput): Promise<number> {
  const fmt = new CsvFormatter(output);
  const sep = fmt.sep;
  const tf = new LocalTimeFormatter(timezone);
  const Q = columns.length;
  // Las columnas siguen el orden GRUPO.MEDIDOR (la etiqueta de este formato es Source.Name)
  const byName = [...meters].sort((a, b) => a.label.localeCompare(b.label, 'es', { numeric: true }));
  const N = byName.length;

  let inputs: MergeInput[] = byName.map((m) => ({ path: partPath(dir, m.index), width: Q }));
  if (inputs.length > MAX_OPEN_FILES) {
    // Primer nivel: cada grupo produce un parcial con los valores de sus medidores concatenados (mismo orden)
    const groups: MergeInput[] = [];
    for (let g = 0; g * MAX_OPEN_FILES < inputs.length; g++) {
      const slice = inputs.slice(g * MAX_OPEN_FILES, (g + 1) * MAX_OPEN_FILES);
      const path = join(dir, `merge-${g}.part`);
      const out = new FileOut(path);
      await mergeByTimestamp(slice, sep, (ts, values) => out.write(ts + sep + values + EOL));
      await out.end();
      groups.push({ path, width: slice.length * Q });
    }
    inputs = groups;
  }

  const order = timestampColumnOrder(N, Q, output.columnsByQuantity);
  const chunks = splitColumns(N, Q, output.columnsByQuantity);
  const header = (idx: number) => fmt.field(`${byName[Math.floor(idx / Q)].label}.${columnHeader(columns[idx % Q])}`);
  const timeHeader = output.includeUtc ? ['FechaHora', 'FechaHoraUTC'] : ['FechaHora'];

  const multi = chunks.length > 1;
  const partFiles = chunks.map((_, k) => join(dir, `parte-${k + 1}.csv`));
  const outs = chunks.map((_, k) => new FileOut(multi ? partFiles[k] : outFile));
  for (let k = 0; k < chunks.length; k++) {
    const { start, end } = chunks[k];
    const names: string[] = [];
    for (let j = start; j < end; j++) names.push(header(order[j]));
    await outs[k].write(BOM + timeHeader.join(sep) + sep + names.join(sep) + EOL);
  }

  // Sin reordenar ni partir, la concatenación de los parciales ya es la fila final
  const passthrough = !multi && !output.columnsByQuantity;
  const rows = await mergeByTimestamp(inputs, sep, async (ts, values) => {
    const time = output.includeUtc ? tf.format(ts) + sep + formatUtc(ts) : tf.format(ts);
    if (passthrough) return outs[0].write(time + sep + values + EOL);
    const fields = values.split(sep);
    for (let k = 0; k < chunks.length; k++) {
      let line = time;
      for (let j = chunks[k].start; j < chunks[k].end; j++) line += sep + fields[order[j]];
      await outs[k].write(line + EOL);
    }
  });
  for (const o of outs) await o.end();

  if (multi) {
    const base = sanitizeFileName(fileName.replace(/\.(csv|zip)$/i, ''));
    await zipFiles(outFile, partFiles.map((path, k) => ({ path, base: `${base} (parte ${k + 1} de ${chunks.length})` })));
  }
  return rows;
}
