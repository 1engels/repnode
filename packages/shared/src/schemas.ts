import { z } from 'zod';
import { isLocalDateTime, isValidTimeZone } from './time.ts';

/**
 * Ruta bajo la que se publica RepNode (GUI y API), también en desarrollo. Así funciona igual detrás del proxy de IIS
 * de PME (https://servidor/repnode/), con el mismo origen que PME, que en localhost.
 */
export const BASE_PATH = '/repnode';

// ---------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------

export const connectionParamsSchema = z.object({
  name: z.string().trim().max(120).optional(),
  server: z.string().trim().min(1, 'Servidor requerido'),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  instance: z.string().trim().max(120).nullable().default(null),
  database: z.string().trim().min(1).default('ION_Data'),
  authType: z.enum(['sql', 'ntlm']).default('sql'),
  domain: z.string().trim().max(120).nullable().default(null),
  username: z.string().trim().min(1, 'Usuario requerido'),
  encrypt: z.boolean().default(false),
  trustServerCertificate: z.boolean().default(true),
});
export type ConnectionParams = z.infer<typeof connectionParamsSchema>;

/** Conexión nueva (con contraseña) o conexión desde un perfil recordado (con secreto de cliente). */
export const connectRequestSchema = z.union([
  z.object({
    params: connectionParamsSchema,
    /** Al editar un perfil, vacía = reutilizar la contraseña guardada (requiere su clientSecret). */
    password: z.string(),
    remember: z.boolean().default(false),
    /** Secreto aleatorio generado y guardado por el navegador (base64). Requerido si remember = true. */
    clientSecret: z.string().min(32).max(200).optional(),
    /** Perfil que se edita: conserva su ID (y con él reportes, tags y jerarquías) aunque cambien los parámetros. */
    profileId: z.string().min(16).max(128).optional(),
  }),
  z.object({
    profileId: z.string().min(16).max(128),
    clientSecret: z.string().min(32).max(200),
  }),
]);
export type ConnectRequest = z.infer<typeof connectRequestSchema>;

// ---------------------------------------------------------------------------
// Rango de fechas
// ---------------------------------------------------------------------------

const localDateTime = z.string().refine(isLocalDateTime, 'Formato esperado YYYY-MM-DDTHH:mm');

export const relativePresets = [
  'today',
  'yesterday',
  'lastNDays',
  'currentWeek',
  'previousWeek',
  'currentMonth',
  'previousMonth',
  'currentYear',
  'previousYear',
] as const;
export type RelativePreset = (typeof relativePresets)[number];

export const relativePresetLabels: Record<RelativePreset, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  lastNDays: 'Últimos N días',
  currentWeek: 'Semana en curso',
  previousWeek: 'Semana anterior',
  currentMonth: 'Mes en curso',
  previousMonth: 'Mes anterior',
  currentYear: 'Año en curso',
  previousYear: 'Año anterior',
};

export const rangeSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('fixed'), from: localDateTime, to: localDateTime }),
    z.object({
      mode: z.literal('relative'),
      preset: z.enum(relativePresets),
      days: z.number().int().min(1).max(3660).optional(),
    }),
  ])
  .refine((r) => r.mode !== 'fixed' || r.from < r.to, 'La fecha inicial debe ser anterior a la final');
export type DateRange = z.infer<typeof rangeSchema>;

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------

/** Intervalos permitidos para completar filas (minutos); todos dividen el día en bloques exactos. */
export const GRID_INTERVALS = [1, 5, 10, 15, 30, 60] as const;

export const outputSchema = z
  .object({
    format: z.enum(['wide', 'long', 'zip', 'timestamp']).default('wide'),
    /** Formato por estampa de tiempo: columnas agrupadas por medición (M1.q1, M2.q1…) en vez de por medidor */
    columnsByQuantity: z.boolean().default(false),
    delimiter: z.enum([';', ',', '\t']).default(';'),
    decimal: z.enum([',', '.']).default('.'),
    decimals: z.number().int().min(0).max(10).nullable().default(null),
    includeUtc: z.boolean().default(false),
    meterLabel: z.enum(['displayName', 'name']).default('name'),
    fileName: z.string().trim().min(1).max(150).default('{reporte}_{desde}_{hasta}'),
    /** Completar con filas vacías (valor en blanco) cada casillero de la grilla sin dato */
    fillGaps: z.boolean().default(false),
    intervalMinutes: z.literal(GRID_INTERVALS).default(15),
  })
  .refine((o) => !(o.delimiter === ',' && o.decimal === ','), {
    message: 'El separador de campos y el decimal no pueden ser ambos coma',
    path: ['decimal'],
  });
export type OutputOptions = z.infer<typeof outputSchema>;

export const FORMAT_LABELS: Record<OutputOptions['format'], string> = {
  wide: 'CSV ancho',
  long: 'CSV largo',
  zip: 'ZIP por medidor',
  timestamp: 'Por estampa de tiempo',
};

export const timeZoneSchema = z.string().min(1).refine(isValidTimeZone, 'Zona horaria inválida');

/** Selección mínima necesaria para validar o extraer. */
export const selectionSchema = z.object({
  sourceIds: z.array(z.number().int()).default([]),
  tagIds: z.array(z.number().int()).default([]),
  /** Nodos dinámicos de las jerarquías: tableros (con su aguas abajo) y espacios (con sus subespacios) */
  panelIds: z.array(z.number().int()).default([]),
  spaceIds: z.array(z.number().int()).default([]),
  quantityIds: z.array(z.number().int()).min(1, 'Selecciona al menos una medición').max(1000, 'Máximo 1000 mediciones por reporte'),
  range: rangeSchema,
  timezone: timeZoneSchema,
});
export type Selection = z.infer<typeof selectionSchema>;

export const reportDefinitionSchema = selectionSchema.extend({
  name: z.string().trim().min(1, 'Nombre requerido').max(120),
  output: outputSchema,
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

// `force`: generar aunque la validación tenga errores (medidores o mediciones sin datos)
export const jobRequestSchema = z.union([
  z.object({ reportId: z.number().int(), rangeOverride: rangeSchema.optional(), force: z.boolean().default(false) }),
  z.object({ definition: reportDefinitionSchema, rangeOverride: rangeSchema.optional(), force: z.boolean().default(false) }),
]);
export type JobRequest = z.infer<typeof jobRequestSchema>;

// ---------------------------------------------------------------------------
// Tags, presets y configuración
// ---------------------------------------------------------------------------

/** Paleta base de tags. Los colores fuera de ella se guardan como personalizados del perfil. */
/** Colores base de tags (y de tableros). Otro color se elige con el selector y queda como personalizado. */
export const TAG_PALETTE = ['#2563eb', '#0891b2', '#0d9488', '#16a34a', '#d97706', '#dc2626', '#db2777', '#7c3aed'] as const;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido (formato #RRGGBB)')
  .transform((c) => c.toLowerCase());

export const tagInputSchema = z.object({
  // Se permiten espacios internos; los repetidos se reducen a uno
  name: z.string().trim().min(1).max(60).transform((s) => s.replace(/\s+/g, ' ')),
  color: hexColorSchema.default(TAG_PALETTE[0]),
});

/** Al crear un tag se pueden indicar sus miembros iniciales (p. ej. "crear tag con la selección"). */
export const tagCreateSchema = tagInputSchema.extend({
  sourceIds: z.array(z.number().int()).default([]),
});

export const tagColorSchema = z.object({ color: hexColorSchema });

export const tagMembersSchema = z.object({
  sourceIds: z.array(z.number().int()).min(1),
  action: z.enum(['add', 'remove']),
});

/** Mismo contrato que los miembros de un tag: cargas de un tablero o medidores de un espacio. */
export const hierarchyMembersSchema = tagMembersSchema;

// ---------------------------------------------------------------------------
// Jerarquías: Suministro (tableros con entradas y cargas) y Comercial (espacios)
// ---------------------------------------------------------------------------

const nodeName = z.string().trim().min(1, 'Nombre requerido').max(80).transform((s) => s.replace(/\s+/g, ' '));
/** Texto opcional: vacío = null */
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().default(null).transform((s) => (s ? s.replace(/\s+/g, ' ') : null));
const coord = z.number().nullable().default(null);

/** sum = entradas simultáneas (se suman); ats = entradas alternativas (conmutación / respaldo) */
export const panelModeSchema = z.enum(['sum', 'ats']);
export type PanelMode = z.infer<typeof panelModeSchema>;

export const PANEL_MODE_LABELS: Record<PanelMode, string> = {
  sum: 'Cargas concurrentes (suma)',
  ats: 'Conmutación / respaldo (ATS)',
};

export const MAX_PANEL_INPUTS = 16;

/** Ícono del tablero según lo que alimenta (la GUI los dibuja con @tabler/icons-vue) */
export const PANEL_ICONS = ['other', 'hvac', 'plug', 'lighting', 'store', 'elevator', 'motor'] as const;
export const panelIconSchema = z.enum(PANEL_ICONS);
export type PanelIcon = z.infer<typeof panelIconSchema>;

export const PANEL_ICON_LABELS: Record<PanelIcon, string> = {
  other: 'Otros',
  hvac: 'HVAC',
  plug: 'Tomacorrientes',
  lighting: 'Iluminación',
  store: 'Tiendas',
  elevator: 'Ascensores',
  motor: 'Bombas o motores',
};

/** Entrada (terminal virtual) de un tablero: viene de otro tablero o de una fuente externa. */
export const panelInputSchema = z.object({
  fromPanelId: z.number().int().nullable().default(null),
  /** Fuente externa (p. ej. "Red pública", "Grupo electrógeno"), solo si no viene de un tablero */
  origin: optionalText(80),
  label: optionalText(60),
  /** Medidor asociado a la entrada */
  sourceId: z.number().int().nullable().default(null),
});
export type PanelInput = z.infer<typeof panelInputSchema>;

export const panelSaveSchema = z.object({
  name: nodeName,
  mode: panelModeSchema.default('sum'),
  description: optionalText(500),
  inputs: z.array(panelInputSchema).max(MAX_PANEL_INPUTS, `Máximo ${MAX_PANEL_INPUTS} entradas por tablero`).default([]),
  /** Medidor totalizador interno del tablero */
  totalizerSourceId: z.number().int().nullable().default(null),
  /** Color del encabezado de la caja en el diagrama (null = sin color) */
  color: hexColorSchema.nullable().default(null),
  icon: panelIconSchema.default('other'),
});
export type PanelSave = z.infer<typeof panelSaveSchema>;

/** Al crear se pueden indicar las cargas iniciales y la posición en el diagrama (creación rápida). */
export const panelCreateSchema = panelSaveSchema.extend({
  sourceIds: z.array(z.number().int()).default([]),
  x: coord,
  y: coord,
});

export const SPACE_TYPES = ['Edificio', 'Piso', 'Zona', 'Local', 'Área común'] as const;

export const spaceSaveSchema = z.object({
  name: nodeName,
  type: optionalText(40),
  parentId: z.number().int().nullable().default(null),
});
export type SpaceSave = z.infer<typeof spaceSaveSchema>;

export const spaceCreateSchema = spaceSaveSchema.extend({
  sourceIds: z.array(z.number().int()).default([]),
  x: coord,
  y: coord,
});

export const hierarchyKindSchema = z.enum(['supply', 'commercial']);
export type HierarchyKind = z.infer<typeof hierarchyKindSchema>;

/** Posiciones de las cajas del diagrama; `reset` las borra para volver al layout automático. */
export const hierarchyLayoutSchema = z.object({
  kind: hierarchyKindSchema,
  positions: z.array(z.object({ id: z.number().int(), x: z.number(), y: z.number() })).max(10000).default([]),
  reset: z.boolean().default(false),
});

/** Saca medidores de una jerarquía (quedan "sin ubicar"). */
export const hierarchyUnassignSchema = z.object({
  kind: hierarchyKindSchema,
  sourceIds: z.array(z.number().int()).min(1),
});

export const presetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  quantityIds: z.array(z.number().int()).min(1),
});

/** Marca o desmarca una medición como favorita del usuario. */
export const favoriteQuantitySchema = z.object({
  quantityId: z.number().int(),
  favorite: z.boolean(),
});

export const settingsSchema = z.object({
  workers: z.number().int().min(1).max(16),
  concurrency: z.number().int().min(1).max(32),
  readUncommitted: z.boolean(),
  downloadTtlMinutes: z.number().int().min(5).max(24 * 60),
  requestTimeoutSeconds: z.number().int().min(30).max(6 * 3600),
});
export type Settings = z.infer<typeof settingsSchema>;
