import { z } from 'zod';
import { isLocalDateTime, isValidTimeZone } from './time.ts';

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
    password: z.string(),
    remember: z.boolean().default(false),
    /** Secreto aleatorio generado y guardado por el navegador (base64). Requerido si remember = true. */
    clientSecret: z.string().min(32).max(200).optional(),
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
    format: z.enum(['wide', 'long', 'zip']).default('wide'),
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

export const timeZoneSchema = z.string().min(1).refine(isValidTimeZone, 'Zona horaria inválida');

/** Selección mínima necesaria para validar o extraer. */
export const selectionSchema = z.object({
  sourceIds: z.array(z.number().int()).default([]),
  tagIds: z.array(z.number().int()).default([]),
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
export const TAG_PALETTE = [
  '#2563eb', '#0284c7', '#0891b2', '#0d9488', '#16a34a', '#65a30d',
  '#d97706', '#ea580c', '#dc2626', '#db2777', '#7c3aed', '#475569',
] as const;

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

export const presetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  quantityIds: z.array(z.number().int()).min(1),
});

export const settingsSchema = z.object({
  workers: z.number().int().min(1).max(16),
  concurrency: z.number().int().min(1).max(32),
  readUncommitted: z.boolean(),
  downloadTtlMinutes: z.number().int().min(5).max(24 * 60),
  requestTimeoutSeconds: z.number().int().min(30).max(6 * 3600),
});
export type Settings = z.infer<typeof settingsSchema>;
