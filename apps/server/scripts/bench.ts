// Benchmark: enfoque anterior (un SP por par medidor×medición, en serie) vs motor de RepNode (workers × consultas paralelas).
// Uso: pnpm --filter @repnode/server bench   (configurable en .env.test.local, ver .env.test.example)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import sql from 'mssql';
import { outputSchema } from '@repnode/shared';
import { buildMssqlConfig } from '../src/mssql/config.ts';
import { loadCatalog } from '../src/mssql/catalog.ts';
import { assemble } from '../src/jobs/assemble.ts';
import type { MeterTask, WorkerInput, WorkerMessage } from '../src/jobs/protocol.ts';
import { testConnection } from './test-env.ts';
import { getIdForSource, getLoggedDataSmpTv, getNameForMeasurement, legacyMode } from './legacy.ts';

const DAY = 86_400_000;
const { params, password } = testConnection();
const nMeters = Number(process.env.BENCH_METERS ?? 50);
const days = Number(process.env.BENCH_DAYS ?? 30);
const configs = (process.env.BENCH_CONFIGS ?? '1x1,1x4,2x4,4x4').split(',').map((c) => c.split('x').map(Number) as [number, number]);

const pool = new sql.ConnectionPool(buildMssqlConfig(params, password, { poolMax: 2, requestTimeoutMs: 1_800_000 }));
await pool.connect();
const cat = await loadCatalog(pool);

// Mediciones: las indicadas o las 4 más comunes
let qids = (process.env.BENCH_QUANTITIES ?? '').split(',').filter(Boolean).map(Number);
if (!qids.length) {
  const freq = new Map<number, number>();
  for (const m of cat.coverage.values()) for (const q of m.keys()) freq.set(q, (freq.get(q) ?? 0) + 1);
  qids = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([q]) => q);
}
const real = cat.sources.filter((s) => qids.every((q) => cat.coverage.get(s.id)?.has(q)));
if (!real.length) throw new Error('Ningún medidor tiene todas las mediciones elegidas');
// Si hay menos medidores reales que BENCH_METERS, se repiten para simular la carga
const meters = Array.from({ length: Math.min(nMeters, Math.max(nMeters, real.length)) }, (_, i) => real[i % real.length]);
if (real.length < nMeters) console.log(`(Solo ${real.length} medidores reales con esas mediciones: se repiten hasta ${nMeters})`);
const maxes = meters.flatMap((s) => qids.map((q) => cat.coverage.get(s.id)!.get(q)!.max)).sort((a, b) => a - b);
const to = new Date(Math.floor(maxes[Math.floor(maxes.length / 2)] / DAY) * DAY + DAY);
const from = new Date(to.getTime() - days * DAY);

console.log(`Medidores: ${meters.length} · Mediciones: ${qids.map((q) => cat.quantityById.get(q)?.name).join(', ')}`);
console.log(`Rango UTC: ${from.toISOString()} → ${to.toISOString()} (${days} días)\n`);

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 100);
const mb = (b: number) => (b / 1048576).toFixed(1) + ' MB';



// (b) Motor nuevo
await pool.close();
const columns = qids.map((q) => ({ id: q, name: cat.quantityById.get(q)!.name, unit: cat.quantityById.get(q)!.unit }));
const output = outputSchema.parse({ format: 'wide' });
const tasks: MeterTask[] = meters.map((s, index) => ({ index, sourceId: s.id, label: s.displayName }));

for (const [k, c] of configs) {
  peakRss = 0;
  const dir = mkdtempSync(join(tmpdir(), 'repnode-bench-'));
  const t0 = performance.now();
  let rows = 0;
  const shards: MeterTask[][] = Array.from({ length: k }, () => []);
  tasks.forEach((m, i) => shards[i % k].push(m));
  await Promise.all(shards.map((shard, workerNo) => new Promise<void>((resolve, reject) => {
    const data: WorkerInput = {
      workerNo, mssql: buildMssqlConfig(params, password, { poolMax: c, requestTimeoutMs: 1_800_000 }), readUncommitted: true,
      concurrency: c, meters: shard, columns, fromUtcMs: from.getTime(), toUtcMs: to.getTime(), timezone: 'America/Lima', output, dir,
    };
    const heap = Number(process.env.BENCH_HEAP_MB ?? 256); // igual que job-manager
    const w = new Worker(new URL('../src/jobs/job-worker.ts', import.meta.url), { workerData: data, ...(heap ? { resourceLimits: { maxOldGenerationSizeMb: heap, maxYoungGenerationSizeMb: 16 } } : {}) });
    w.on('message', (m: WorkerMessage) => {
      if (m.type === 'meter') rows += m.rows;
      if (m.type === 'fatal') reject(new Error(m.error));
    });
    w.on('error', reject);
    w.on('exit', () => resolve());
  })));
  const tExtract = performance.now() - t0;
  const { bytes } = await assemble({ dir, outFile: join(dir, 'out.csv'), meters: tasks, columns, output, timezone: 'America/Lima', fileName: 'out.csv' });
  const ms = performance.now() - t0;
  console.log(`RepNode ${k} worker(s) × ${c} consultas: ${(ms / 1000).toFixed(1)} s · ${rows.toLocaleString('es')} filas CSV · ${mb(bytes)} · extracción ${(tExtract / 1000).toFixed(1)} s + ensamblado ${((ms - tExtract) / 1000).toFixed(1)} s · RSS máx ${mb(peakRss)}`);
  rmSync(dir, { recursive: true, force: true });
}
// (a) al final: carga cada resultado completo en memoria y contaminaría la medición de RSS
const pool2 = new sql.ConnectionPool(buildMssqlConfig(params, password, { poolMax: 2, requestTimeoutMs: 1_800_000 }));
await pool2.connect();

{
  peakRss = 0;
  const t0 = performance.now();
  let rows = 0;
  for (const s of meters) {
    await getIdForSource(pool2, s.name);
    for (const q of qids) await getNameForMeasurement(pool2, q);
    for (const q of qids) {
      const r = await getLoggedDataSmpTv(pool2, s.id, q, from, to);
      rows += r.recordset.length;
    }
  }
  const ms = performance.now() - t0;
  console.log(`Anterior (${legacyMode()} por par, en serie): ${(ms / 1000).toFixed(1)} s · ${rows.toLocaleString('es')} valores · ${Math.round(rows / (ms / 1000)).toLocaleString('es')} valores/s · RSS máx ${mb(peakRss)}`);
}
await pool2.close();
clearInterval(sampler);
