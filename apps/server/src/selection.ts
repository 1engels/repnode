import { resolveRange, type DateRange, type ResolvedRange, type Selection } from '@repnode/shared';
import { HttpError } from './errors.ts';
import type { Session } from './mssql/session.ts';
import { tags as tagsRepo } from './store/sqlite.ts';

export interface ResolvedSelection {
  sourceIds: number[];
  quantityIds: number[];
  range: ResolvedRange;
  timezone: string;
}

/** Medidores efectivos = selección directa ∪ miembros actuales de los tags dinámicos. */
export function resolveMeters(session: Session, sourceIds: number[], tagIds: number[]): number[] {
  const { catalog } = session;
  const out = new Set<number>();
  for (const id of sourceIds) if (catalog.sourceById.has(id)) out.add(id);
  if (tagIds.length) {
    const wanted = new Set(tagIds);
    for (const t of tagsRepo.list(session.profileId)) {
      if (!wanted.has(t.id)) continue;
      for (const name of t.members) {
        const s = catalog.sourceByName.get(name);
        if (s) out.add(s.id);
      }
    }
  }
  // Orden estable: el del catálogo (alfabético por nombre visible)
  const order = new Map(catalog.sources.map((s, i) => [s.id, i]));
  return [...out].sort((a, b) => order.get(a)! - order.get(b)!);
}

export function resolveSelection(session: Session, sel: Selection, rangeOverride?: DateRange): ResolvedSelection {
  const sourceIds = resolveMeters(session, sel.sourceIds, sel.tagIds);
  if (!sourceIds.length) throw new HttpError(400, 'Selecciona al menos un medidor', 'empty_selection');
  const quantityIds = [...new Set(sel.quantityIds)].filter((q) => session.catalog.quantityById.has(q));
  if (!quantityIds.length) throw new HttpError(400, 'Selecciona al menos una medición', 'empty_selection');
  const range = resolveRange(rangeOverride ?? sel.range, sel.timezone);
  if (range.fromUtcMs >= range.toUtcMs) throw new HttpError(400, 'Rango de fechas inválido', 'invalid_range');
  return { sourceIds, quantityIds, range, timezone: sel.timezone };
}
