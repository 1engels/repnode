import type { ConnectionPool } from 'mssql';
import type { CatalogDTO, QuantityDTO, SourceDTO } from '@repnode/shared';

export interface Coverage {
  min: number;
  max: number;
}

export interface Catalog {
  loadedAt: Date;
  sources: SourceDTO[];
  sourceById: Map<number, SourceDTO>;
  sourceByName: Map<string, SourceDTO>;
  quantityById: Map<number, QuantityDTO>;
  quantityByName: Map<string, QuantityDTO>;
  /** sourceId -> quantityId -> rango [min, max] (ms UTC) según dbo.SourceQuantity */
  coverage: Map<number, Map<number, Coverage>>;
}

function groupOf(name: string): string {
  const i = name.indexOf('.');
  return i > 0 ? name.slice(0, i) : '(sin grupo)';
}

/** Carga los metadatos con 3 consultas (reemplaza las llamadas spDAL_GetIDForSource / GetNameForMeasurement / GetMeasurements). */
export async function loadCatalog(pool: ConnectionPool): Promise<Catalog> {
  const [src, qty, sq] = await Promise.all([
    pool.request().query<{ ID: number; Name: string; DisplayName: string; SourceType: string | null }>(
      `SELECT s.ID, s.Name, s.DisplayName, st.Name AS SourceType
       FROM dbo.Source s WITH (NOLOCK)
       LEFT JOIN dbo.SourceType st WITH (NOLOCK) ON st.ID = s.SourceTypeID`,
    ),
    pool.request().query<{ ID: number; Name: string; Unit: string | null }>(
      'SELECT ID, Name, Unit FROM dbo.Quantity WITH (NOLOCK)',
    ),
    pool.request().query<{ SourceID: number; QuantityID: number; MinTs: Date; MaxTs: Date }>(
      'SELECT SourceID, QuantityID, MinTimestampUtc AS MinTs, MaxTimestampUtc AS MaxTs FROM dbo.SourceQuantity WITH (NOLOCK)',
    ),
  ]);

  const sources: SourceDTO[] = src.recordset
    .map((r) => ({
      id: r.ID,
      name: r.Name,
      displayName: r.DisplayName || r.Name,
      group: groupOf(r.Name),
      type: r.SourceType ?? '',
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'es', { numeric: true }));

  const quantityById = new Map<number, QuantityDTO>();
  const quantityByName = new Map<string, QuantityDTO>();
  for (const r of qty.recordset) {
    const q = { id: r.ID, name: r.Name, unit: r.Unit || null };
    quantityById.set(q.id, q);
    quantityByName.set(q.name, q);
  }

  const coverage = new Map<number, Map<number, Coverage>>();
  for (const r of sq.recordset) {
    let m = coverage.get(r.SourceID);
    if (!m) coverage.set(r.SourceID, (m = new Map()));
    m.set(r.QuantityID, { min: r.MinTs.getTime(), max: r.MaxTs.getTime() });
  }

  return {
    loadedAt: new Date(),
    sources,
    sourceById: new Map(sources.map((s) => [s.id, s])),
    sourceByName: new Map(sources.map((s) => [s.name, s])),
    quantityById,
    quantityByName,
    coverage,
  };
}

export function catalogToDTO(c: Catalog): CatalogDTO {
  const sourceQuantities: Record<number, number[]> = {};
  const used = new Set<number>();
  for (const [sid, m] of c.coverage) {
    const ids = [...m.keys()];
    sourceQuantities[sid] = ids;
    ids.forEach((q) => used.add(q));
  }
  const quantities = [...used]
    .map((id) => c.quantityById.get(id))
    .filter((q): q is QuantityDTO => !!q)
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  return { loadedAt: c.loadedAt.toISOString(), sources: c.sources, quantities, sourceQuantities };
}
