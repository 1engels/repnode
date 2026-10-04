// Worker thread: tiene su propio pool de conexiones y procesa su parte de los medidores
// con C consultas concurrentes. Toda la CPU de formateo (zonas horarias, números, CSV)
// ocurre aquí, fuera del hilo que atiende la API.
import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import sql from 'mssql';
import pLimit from 'p-limit';
import { describeSqlError, isTransientSqlError } from '../errors.ts';
import { createExtractContext, extractMeter } from './extract.ts';
import { partPath, type ParentMessage, type WorkerInput, type WorkerMessage } from './protocol.ts';

const input = workerData as WorkerInput;
const port = parentPort!;
const send = (m: WorkerMessage) => port.postMessage(m);

const MAX_ATTEMPTS = 3;
let cancelled = false;

const ctx = createExtractContext(input.columns, input.fromUtcMs, input.toUtcMs, input.timezone, input.output, input.readUncommitted);
const pool = new sql.ConnectionPool({ ...input.mssql, pool: { max: input.concurrency, min: 0, idleTimeoutMillis: 30_000 } });

port.on('message', (m: ParentMessage) => {
  if (m.type === 'cancel') {
    cancelled = true;
    for (const r of ctx.active) r.cancel();
  }
});

async function processMeter(task: WorkerInput['meters'][number]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (cancelled) return;
    try {
      const { rows, bytes, offGrid } = await extractMeter(pool, task.sourceId, task.label, partPath(input.dir, task.index), ctx);
      send({ type: 'meter', index: task.index, rows, bytes, offGrid });
      return;
    } catch (err) {
      if (cancelled) return;
      if (attempt >= MAX_ATTEMPTS || !isTransientSqlError(err)) {
        throw new Error(`Medidor "${task.label}": ${describeSqlError(err)}`);
      }
      send({ type: 'retry', index: task.index, attempt, error: describeSqlError(err) });
      await sleep(1000 * 3 ** (attempt - 1));
    }
  }
}

async function main(): Promise<void> {
  await pool.connect();
  const limit = pLimit(input.concurrency);
  try {
    await Promise.all(input.meters.map((m) => limit(() => processMeter(m))));
  } catch (err) {
    cancelled = true;
    limit.clearQueue();
    for (const r of ctx.active) r.cancel();
    throw err;
  } finally {
    await pool.close().catch(() => {});
  }
}

main()
  .then(
    () => send({ type: 'done' }),
    (err) => send({ type: 'fatal', error: err instanceof Error ? err.message : describeSqlError(err) }),
  )
  // Sin trabajo pendiente: que el listener de mensajes no mantenga vivo el hilo
  .finally(() => port.unref());
