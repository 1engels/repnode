import type { ConnectionParams, PanelIcon, PanelMode, ReportDefinition, Settings } from './schemas.ts';

export interface ProfileDTO extends ConnectionParams {
  id: string;
  name: string;
  hasStoredPassword: boolean;
  lastUsedAt: string | null;
}

/** none = app local (un usuario en este equipo); pme = embebida en PME, con el usuario de PME. */
export type AuthModeDTO = 'none' | 'pme';

export interface SessionDTO {
  mode: AuthModeDTO;
  /** Nombre del usuario de PME (modo pme, p. ej. "supervisor"); null en modo local. */
  user: string | null;
  /** Minutos sin actividad tras los que se cierra la sesión. */
  idleMinutes: number;
  connected: boolean;
  profileId: string | null;
  server: string | null;
  database: string | null;
  username: string | null;
  serverVersion: string | null;
}

/** Conexión a PME de producción definida por variables de entorno del servidor (nunca incluye la contraseña). */
export interface ProductionStatusDTO {
  /** Están definidas REPNODE_SERVER, REPNODE_AUTH_USER y REPNODE_AUTH_PASS (y el puerto, si se indica, es válido). */
  configured: boolean;
  /** Variables obligatorias que faltan. */
  missing: string[];
  /** La conexión se pudo establecer en la última comprobación. */
  available: boolean;
  /** Servidor y base, p. ej. "10.0.0.5,1433 · ION_Data". */
  target: string | null;
  username: string | null;
  serverVersion: string | null;
  error: string | null;
  checkedAt: string | null;
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

export interface PanelInputDTO {
  id: number;
  fromPanelId: number | null;
  origin: string | null;
  label: string | null;
  /** Medidor asociado (null si no tiene o si ya no existe en la BD) */
  sourceId: number | null;
  /** Tenía un medidor guardado que ya no existe en la BD */
  missingMeter: boolean;
}

export interface PanelDTO {
  id: number;
  name: string;
  mode: PanelMode;
  description: string | null;
  /** Posición en el diagrama; null = la calcula el layout automático */
  x: number | null;
  y: number | null;
  /** En orden: la primera entrada que viene de un tablero es la primaria */
  inputs: PanelInputDTO[];
  /** Medidor totalizador interno del tablero */
  totalizerSourceId: number | null;
  /** Tenía un totalizador guardado que ya no existe en la BD */
  missingTotalizer: boolean;
  /** Salidas (cargas y alimentadores de otros tableros) */
  loadSourceIds: number[];
  /** Salidas guardadas que ya no existen en la BD */
  missing: number;
  /** Color del encabezado (#rrggbb) o null */
  color: string | null;
  icon: PanelIcon;
}

export interface SpaceDTO {
  id: number;
  parentId: number | null;
  name: string;
  type: string | null;
  x: number | null;
  y: number | null;
  sourceIds: number[];
  missing: number;
}

export interface HierarchyDTO {
  panels: PanelDTO[];
  spaces: SpaceDTO[];
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
  /** En cola: cuántos jobs hay antes (1 = el siguiente); null si no está en cola. */
  queuePosition: number | null;
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
  /** Nombre del usuario de PME que lo generó (modo pme). */
  user: string | null;
}

export type { Settings };
