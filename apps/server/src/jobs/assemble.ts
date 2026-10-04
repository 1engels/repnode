import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { ZipArchive } from 'archiver';
import { sanitizeFileName, type OutputOptions } from '@repnode/shared';
import { CsvFormatter } from './csv.ts';
import { BOM, headerLine, type QuantityColumn } from './formats.ts';
import { partPath, type MeterTask } from './protocol.ts';

/** Une los archivos parciales en orden (ancho/largo) o los empaqueta en un ZIP. Devuelve el tamaño final. */
export async function assemble(dir: string, outFile: string, meters: MeterTask[], columns: QuantityColumn[], output: OutputOptions): Promise<number> {
  const ordered = [...meters].sort((a, b) => a.index - b.index);

  if (output.format === 'zip') {
    const out = createWriteStream(outFile);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const done = new Promise<void>((resolve, reject) => {
      out.on('close', resolve);
      out.on('error', reject);
      archive.on('error', reject);
    });
    archive.pipe(out);
    const used = new Map<string, number>();
    for (const m of ordered) {
      const p = partPath(dir, m.index);
      if (!existsSync(p)) continue;
      const base = sanitizeFileName(m.label, `medidor_${m.sourceId}`);
      const n = (used.get(base.toLowerCase()) ?? 0) + 1;
      used.set(base.toLowerCase(), n);
      archive.file(p, { name: n === 1 ? `${base}.csv` : `${base} (${n}).csv` });
    }
    await archive.finalize();
    await done;
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
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  }
  return (await stat(outFile)).size;
}
