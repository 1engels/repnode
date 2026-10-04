import type { ConnectionParams, ReportDefinition, Settings } from './schemas.ts';

export interface ProfileDTO extends ConnectionParams {
  id: string;
  name: string;
  hasStoredPassword: boolean;
  lastUsedAt: string | null;
}

export interface SessionDTO {
  connected: boolean;
  profileId: string | null;
  server: string | null;
  database: string | null;
  username: string | null;
  serverVersion: string | null;
}

export interface SourceDTO {
  id: number;
  name: string;
  displayName: string;
  /** Prefijo de Source.Name antes del primer '.' (grupo automático) */
  group: string;
  type: string;
}

export interface QuantityDTO {
  id: number;
  name: string;
  unit: string | null;
}

export interface CatalogDTO {
  loadedAt: string;
  sources: SourceDTO[];
  /** Solo mediciones que tienen datos registrados en algún medidor */
  quantities: QuantityDTO[];
  /** sourceId -> quantityIds con datos (según SourceQuantity) */
  sourceQuantities: Record<number, number[]>;
}

export interface TagDTO {
  id: number;
  name: string;
  color: string;
  sourceIds: number[];
  /** Miembros guardados que ya no existen en la BD */
  missing: number;
}

export interface PresetDTO {
  id: number;
  name: string;
  quantityIds: number[];
}

export interface ReportDTO {
  id: number;
  name: string;
  definition: ReportDefinition;
  createdAt: string;
  updatedAt: string;
}

export type PairStatus = 'ok' | 'partial' | 'missing_quantity' | 'no_data_in_range';

export interface PairIssue {
  quantityId: number;
  status: Exclude<PairStatus, 'ok'>;
  /** Primer / último dato real dentro del rango (ISO UTC) */
  firstUtc: string | null;
  lastUtc: string | null;
  /** Datos disponibles fuera del rango según SourceQuantity (ISO UTC) */
  availableFromUtc: string | null;
  availableToUtc: string | null;
}

export interface MeterValidation {
  sourceId: number;
  status: 'partial' | 'error';
  issues: PairIssue[];
}

export interface ValidationResult {
  status: 'ok' | 'warning' | 'error';
  checkedAt: string;
  fromUtc: string;
  toUtc: string;
  fromLocal: string;
  toLocal: string;
  /** Medidores efectivos (selección directa + tags dinámicos) */
  sourceIds: number[];
  summary: {
    meters: number;
    quantities: number;
    pairs: number;
    ok: number;
    partial: number;
    missing: number;
    metersWithErrors: number;
    metersWithWarnings: number;
  };
  /** Solo medidores con problemas */
  meters: MeterValidation[];
  /** Por medición: cuántos medidores fallan / son parciales */
  quantities: { quantityId: number; errors: number; partial: number }[];
  /** Rango (local) en el que todos los pares tienen datos, si existe */
  suggestedRange: { fromLocal: string; toLocal: string } | null;
}

export type JobStatus = 'queued' | 'running' | 'assembling' | 'done' | 'error' | 'cancelled';

export interface JobState {
  id: string;
  status: JobStatus;
  reportName: string;
  fileName: string;
  metersTotal: number;
  metersDone: number;
  rows: number;
  bytes: number;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  etaMs: number | null;
  error: string | null;
  /** Generado con "Generar de todas formas" pese a errores de validación */
  forced: boolean;
  /** Con filas completadas: timestamps con datos que no caen en la grilla (se escriben como filas extra) */
  offGridRows: number;
}

export interface HistoryEntryDTO {
  id: string;
  reportId: number | null;
  reportName: string;
  status: JobStatus;
  fileName: string;
  meters: number;
  rows: number;
  bytes: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  forced: boolean;
  offGridRows: number;
}

export type { Settings };
