import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { nanoid } from 'nanoid';
import type { FastifyBaseLogger } from 'fastify';
import { renderFileName, utcToLocalInput, type JobState, type ReportDefinition, type ValidationResult } from '@repnode/shared';
import { paths } from '../config.ts';
import { buildMssqlConfig } from '../mssql/config.ts';
import type { Session } from '../mssql/session.ts';
import type { ResolvedSelection } from '../selection.ts';
import { history, settings } from '../store/sqlite.ts';
import { assemble } from './assemble.ts';
import type { QuantityColumn } from './formats.ts';
import type { MeterTask, WorkerInput, WorkerMessage } from './protocol.ts';

interface Job {
  state: JobState;
  profileId: string;
  emitter: EventEmitter;
  dir: string;
  outFile: string;
  workers: Worker[];
  cancelRequested: boolean;
  run: () => Promise<void>;
  cleanupTimer?: NodeJS.Timeout;
}

const WORKER_HEAP_MB = 256;

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running: Job | null = null;
let log: FastifyBaseLogger | null = null;

export function initJobs(logger: FastifyBaseLogger): void {
  log = logger;
  history.markInterrupted();
  // Limpia temporales de ejecuciones anteriores
  for (const entry of readdirSync(paths.jobs)) rmSync(join(paths.jobs, entry), { recursive: true, force: true });
}

function publish(job: Job, force = false): void {
  const now = Date.now();
  const s = job.state;
  if (s.startedAt) {
    s.elapsedMs = (s.finishedAt ? Date.parse(s.finishedAt) : now) - Date.parse(s.startedAt);
    s.etaMs = s.status === 'running' && s.metersDone > 0 ? Math.round((s.elapsedMs / s.metersDone) * (s.metersTotal - s.metersDone)) : null;
  }
  const last = (job as Job & { lastPublish?: number }).lastPublish ?? 0;
  if (!force && now - last < 200) return;
  (job as Job & { lastPublish?: number }).lastPublish = now;
  job.emitter.emit('update', { ...s });
}

function finish(job: Job, status: JobState['status'], error: string | null = null): void {
  job.state.status = status;
  job.state.error = error;
  job.state.finishedAt = new Date().toISOString();
  history.finish(job.state.id, status, job.state.rows, job.state.bytes, error, job.state.offGridRows);
  publish(job, true);
  const ttl = settings.get().downloadTtlMinutes * 60_000;
  const keepFile = status === 'done';
  if (!keepFile) rmSync(job.dir, { recursive: true, force: true });
  job.cleanupTimer = setTimeout(() => {
    rmSync(job.dir, { recursive: true, force: true });
    jobs.delete(job.state.id);
  }, keepFile ? ttl : 5 * 60_000);
  job.cleanupTimer.unref();
}

function next(): void {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  job.run()
    .catch((err) => {
      log?.error({ err, job: job.state.id }, 'job falló');
      if (!['done', 'error', 'cancelled'].includes(job.state.status)) finish(job, 'error', err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      running = null;
      next();
    });
}

export interface CreateJobInput {
  session: Session;
  definition: ReportDefinition;
  reportId: number | null;
  selection: ResolvedSelection;
  validation: ValidationResult;
  /** Se generó pese a errores de validación */
  forced: boolean;
}

export function createJob({ session, definition, reportId, selection, validation, forced }: CreateJobInput): JobState {
  const { catalog } = session;
  const id = nanoid(16);
  const dir = join(paths.jobs, id);
  mkdirSync(dir, { recursive: true });

  const output = definition.output;
  const meters: MeterTask[] = selection.sourceIds.map((sid, index) => {
    const s = catalog.sourceById.get(sid)!;
    return { index, sourceId: sid, label: output.meterLabel === 'name' ? s.name : s.displayName };
  });
  const columns: QuantityColumn[] = selection.quantityIds.map((qid) => {
    const q = catalog.quantityById.get(qid)!;
    return { id: q.id, name: q.name, unit: q.unit };
  });

  const ext = output.format === 'zip' ? 'zip' : 'csv';
  const fileName = renderFileName(output.fileName, {
    reportName: definition.name,
    fromLocal: selection.range.fromLocal,
    toLocal: selection.range.toLocal,
    generatedLocal: utcToLocalInput(Date.now(), selection.timezone),
  }, ext);

  const state: JobState = {
    id,
    status: 'queued',
    reportName: definition.name,
    fileName,
    metersTotal: meters.length,
    metersDone: 0,
    rows: 0,
    bytes: 0,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    etaMs: null,
    error: null,
    forced,
    offGridRows: 0,
  };

  const job: Job = {
    state,
    profileId: session.profileId,
    emitter: new EventEmitter(),
    dir,
    outFile: join(dir, `output.${ext}`),
    workers: [],
    cancelRequested: false,
    run: async () => {
      const cfg = settings.get();
      state.status = 'running';
      state.startedAt = new Date().toISOString();
      publish(job, true);

      // Reparto round-robin para que cada worker reciba medidores de todo el rango alfabético
      const k = Math.max(1, Math.min(cfg.workers, meters.length));
      const shards: MeterTask[][] = Array.from({ length: k }, () => []);
      meters.forEach((m, i) => shards[i % k].push(m));
      const mssqlCfg = buildMssqlConfig(session.params, session.password, { poolMax: cfg.concurrency, requestTimeoutMs: cfg.requestTimeoutSeconds * 1000 });

      await new Promise<void>((resolve, reject) => {
        let pending = k;
        let failed = false;
        const fail = (msg: string) => {
          if (failed) return;
          failed = true;
          for (const w of job.workers) w.postMessage({ type: 'cancel' });
          setTimeout(() => job.workers.forEach((w) => w.terminate()), 3000).unref();
          reject(new Error(msg));
        };
        shards.forEach((shard, workerNo) => {
          const data: WorkerInput = {
            workerNo,
            mssql: mssqlCfg,
            readUncommitted: cfg.readUncommitted,
            concurrency: cfg.concurrency,
            meters: shard,
            columns,
            fromUtcMs: selection.range.fromUtcMs,
            toUtcMs: selection.range.toUtcMs,
            timezone: selection.timezone,
            output,
            dir,
          };
          // Sin límite, V8 deja crecer el heap con basura de corta vida (medido: ~250 MB por worker).
          // El trabajo es streaming, así que un tope bajo fuerza GC frecuente sin perder velocidad.
          const w = new Worker(new URL('./job-worker.ts', import.meta.url), {
            workerData: data,
            resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 16 },
          });
          job.workers.push(w);
          w.on('message', (m: WorkerMessage) => {
            switch (m.type) {
              case 'meter':
                state.metersDone++;
                state.rows += m.rows;
                state.bytes += m.bytes;
                state.offGridRows += m.offGrid;
                publish(job);
                break;
              case 'retry':
                log?.warn({ job: id, meter: meters[m.index]?.label, attempt: m.attempt, error: m.error }, 'reintentando medidor');
                break;
              case 'fatal':
                fail(m.error);
                break;
              case 'done':
                break;
            }
          });
          w.on('error', (err) => fail(err.message));
          w.on('exit', () => {
            pending--;
            if (pending === 0 && !failed) resolve();
          });
        });
      });
      job.workers = [];

      if (job.cancelRequested) {
        finish(job, 'cancelled');
        return;
      }
      state.status = 'assembling';
      publish(job, true);
      state.bytes = await assemble(dir, job.outFile, meters, columns, output);
      finish(job, 'done');
    },
  };

  jobs.set(id, job);
  history.insert({ id, profileId: session.profileId, reportId, reportName: definition.name, fileName, meters: meters.length, validation: validation.summary, forced });
  queue.push(job);
  next();
  return { ...state };
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || ['done', 'error', 'cancelled'].includes(job.state.status)) return false;
  job.cancelRequested = true;
  const qi = queue.indexOf(job);
  if (qi >= 0) {
    queue.splice(qi, 1);
    finish(job, 'cancelled');
    return true;
  }
  for (const w of job.workers) w.postMessage({ type: 'cancel' });
  // Si un worker no responde, se termina a la fuerza
  setTimeout(() => job.workers.forEach((w) => w.terminate()), 3000).unref();
  return true;
}

export function subscribe(id: string, fn: (s: JobState) => void): (() => void) | null {
  const job = jobs.get(id);
  if (!job) return null;
  job.emitter.on('update', fn);
  fn({ ...job.state });
  return () => job.emitter.off('update', fn);
}

export async function shutdownJobs(): Promise<void> {
  for (const job of jobs.values()) {
    for (const w of job.workers) await w.terminate();
  }
}
