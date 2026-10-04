import pLimit from 'p-limit';
import { utcToLocalInput, type MeterValidation, type PairIssue, type ValidationResult } from '@repnode/shared';
import type { Coverage } from './mssql/catalog.ts';
import { bindCommon, chunk, coverageSql, MAX_QUANTITIES_PER_QUERY, READ_COMMITTED, READ_UNCOMMITTED } from './mssql/queries.ts';
import type { Session } from './mssql/session.ts';
import type { ResolvedSelection } from './selection.ts';
import { settings } from './store/sqlite.ts';
import { describeSqlError, HttpError } from './errors.ts';

const DAY = 86_400_000;
/** Huecos mayores a esto al inicio/fin del rango se reportan como cobertura parcial. */
export const PARTIAL_TOLERANCE_MS = DAY;

export interface RealCoverage {
  first: number | null;
  last: number | null;
}

export interface ClassifyInput {
  sourceIds: number[];
  quantityIds: number[];
  fromUtcMs: number;
  toUtcMs: number;
  nowMs: number;
  timezone: string;
  /** dbo.SourceQuantity */
  coverage: Map<number, Map<number, Coverage>>;
  /** Resultado exacto de la consulta SQL; clave `${sourceId}:${quantityId}` */
  real: Map<string, RealCoverage>;
}

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

function dayStartLocal(utcMs: number, tz: string): string {
  return utcToLocalInput(utcMs, tz).slice(0, 10) + 'T00:00';
}
function nextDayStartLocal(utcMs: number, tz: string): string {
  const d = utcToLocalInput(utcMs, tz).slice(0, 10);
  const next = new Date(Date.parse(d + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
  return next + 'T00:00';
}

/** Clasificación pura (sin SQL) para poder probarla. */
export function classify(input: ClassifyInput): ValidationResult {
  const { sourceIds, quantityIds, fromUtcMs, toUtcMs, nowMs, timezone, coverage, real } = input;
  const effectiveEnd = Math.min(toUtcMs, nowMs);
  const meters: MeterValidation[] = [];
  const perQuantity = new Map<number, { errors: number; partial: number }>(quantityIds.map((q) => [q, { errors: 0, partial: 0 }]));
  let ok = 0, partial = 0, missing = 0, metersWithErrors = 0, metersWithWarnings = 0;
  let anyMissingQuantity = false;
  let availFrom = -Infinity, availTo = Infinity;

  for (const sid of sourceIds) {
    const issues: PairIssue[] = [];
    let hasError = false;
    for (const qid of quantityIds) {
      const cov = coverage.get(sid)?.get(qid) ?? null;
      const r = real.get(`${sid}:${qid}`) ?? { first: null, last: null };
      if (cov) {
        availFrom = Math.max(availFrom, cov.min);
        availTo = Math.min(availTo, cov.max);
      }
      const base = { quantityId: qid, firstUtc: iso(r.first), lastUtc: iso(r.last), availableFromUtc: iso(cov?.min), availableToUtc: iso(cov?.max) };

      if (r.first == null || r.last == null) {
        missing++;
        hasError = true;
        perQuantity.get(qid)!.errors++;
        if (!cov) anyMissingQuantity = true;
        issues.push({ ...base, status: cov ? 'no_data_in_range' : 'missing_quantity' });
      } else if (r.first - fromUtcMs > PARTIAL_TOLERANCE_MS || effectiveEnd - r.last > PARTIAL_TOLERANCE_MS) {
        partial++;
        perQuantity.get(qid)!.partial++;
        issues.push({ ...base, status: 'partial' });
      } else {
        ok++;
      }
    }
    if (issues.length) {
      meters.push({ sourceId: sid, status: hasError ? 'error' : 'partial', issues });
      if (hasError) metersWithErrors++;
      else metersWithWarnings++;
    }
  }

  // Rango sugerido: intersección del rango pedido con el rango donde todos los pares tienen datos
  let suggestedRange: ValidationResult['suggestedRange'] = null;
  if (missing > 0 && !anyMissingQuantity && Number.isFinite(availFrom) && Number.isFinite(availTo) && availFrom < availTo) {
    let a = Math.max(fromUtcMs, availFrom);
    let b = Math.min(toUtcMs, availTo);
    if (a >= b) { a = availFrom; b = availTo; }
    suggestedRange = { fromLocal: dayStartLocal(a, timezone), toLocal: nextDayStartLocal(b, timezone) };
  }

  return {
    status: missing > 0 ? 'error' : partial > 0 ? 'warning' : 'ok',
    checkedAt: new Date(nowMs).toISOString(),
    fromUtc: new Date(fromUtcMs).toISOString(),
    toUtc: new Date(toUtcMs).toISOString(),
    fromLocal: utcToLocalInput(fromUtcMs, timezone),
    toLocal: utcToLocalInput(toUtcMs, timezone),
    sourceIds,
    summary: {
      meters: sourceIds.length,
      quantities: quantityIds.length,
      pairs: sourceIds.length * quantityIds.length,
      ok, partial, missing, metersWithErrors, metersWithWarnings,
    },
    meters,
    quantities: [...perQuantity].filter(([, v]) => v.errors || v.partial).map(([quantityId, v]) => ({ quantityId, ...v })),
    suggestedRange,
  };
}

// Caché de validaciones recientes: si el usuario ya validó exactamente la misma selección,
// el job no vuelve a consultar.
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: ValidationResult }>();

export function selectionKey(profileId: string, sel: ResolvedSelection): string {
  return [profileId, sel.range.fromUtcMs, sel.range.toUtcMs, sel.quantityIds.join(','), sel.sourceIds.join(',')].join('|');
}

/** fresh = true siempre consulta (endpoint de validación); false reutiliza un resultado reciente (jobs). */
export async function validateCached(session: Session, sel: ResolvedSelection, fresh: boolean, signal?: AbortSignal): Promise<ValidationResult> {
  const key = selectionKey(session.profileId, sel);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS && hit.result.status !== 'error') return hit.result;
  const result = await validateSelection(session, sel, signal);
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return result;
}

export function clearValidationCache(): void {
  cache.clear();
}

/**
 * Validación previa: consulta el primer/último dato real de cada par medidor × medición en el rango.
 * Se consulta incluso si SourceQuantity no tiene la fila, por si esa tabla está desactualizada.
 */
export async function validateSelection(session: Session, sel: ResolvedSelection, signal?: AbortSignal): Promise<ValidationResult> {
  const s = settings.get();
  const isolation = s.readUncommitted ? READ_UNCOMMITTED : READ_COMMITTED;
  const limit = pLimit(Math.max(1, Math.min(s.workers * s.concurrency, 16)));
  const from = new Date(sel.range.fromUtcMs);
  const to = new Date(sel.range.toUtcMs);
  const real = new Map<string, RealCoverage>();
  const qChunks = chunk(sel.quantityIds, MAX_QUANTITIES_PER_QUERY);

  try {
    await Promise.all(
      sel.sourceIds.map((sid) =>
        limit(async () => {
          if (signal?.aborted) return;
          for (const qids of qChunks) {
            const req = session.pool.request();
            const params = bindCommon(req, sid, qids, from, to);
            const res = await req.query<{ QuantityID: number; FirstTs: Date | null; LastTs: Date | null }>(coverageSql(params, isolation));
            for (const r of res.recordset) {
              real.set(`${sid}:${r.QuantityID}`, { first: r.FirstTs?.getTime() ?? null, last: r.LastTs?.getTime() ?? null });
            }
          }
        }),
      ),
    );
  } catch (err) {
    throw new HttpError(502, `Error validando datos: ${describeSqlError(err)}`, 'validation_failed');
  }
  if (signal?.aborted) throw new HttpError(499, 'Validación cancelada', 'aborted');

  return classify({
    sourceIds: sel.sourceIds,
    quantityIds: sel.quantityIds,
    fromUtcMs: sel.range.fromUtcMs,
    toUtcMs: sel.range.toUtcMs,
    nowMs: Date.now(),
    timezone: sel.timezone,
    coverage: session.catalog.coverage,
    real,
  });
}
