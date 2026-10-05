<script setup lang="ts">
import { computed } from 'vue';
import {
  GRID_INTERVALS, gridSlotCount, isValidTimeZone, makeGrid, MAX_FILE_COLUMNS, MAX_GRID_ROWS, renderFileName, resolveRange, splitColumns,
  utcToLocalInput, type DateRange, type OutputOptions,
} from '@repnode/shared';
import Icon from './Icon.vue';
import { formatNumber } from '../lib/util';

const output = defineModel<OutputOptions>({ required: true });
const props = defineProps<{ reportName: string; range: DateRange; timezone: string; meterCount?: number; quantityCount?: number }>();

const formats = [
  { id: 'wide', title: 'Ancho', icon: 'file', desc: 'Una fila por medidor y fecha/hora; una columna por medición. Ideal para Excel.', example: 'Medidor;FechaHora;kWh;kVARh\nTablero 1;2025-01-01 00:15:00;10,5;2,1' },
  { id: 'long', title: 'Largo', icon: 'layers', desc: 'Una fila por valor (medidor, medición, fecha). Ideal para Power BI y tablas dinámicas.', example: 'Medidor;Medicion;Unidad;FechaHora;Valor\nTablero 1;kWh del;kWh;2025-01-01 00:15:00;10,5' },
  { id: 'zip', title: 'ZIP por medidor', icon: 'copy', desc: 'Un CSV (formato ancho) por medidor dentro de un archivo .zip.', example: 'Tablero 1.csv\nTablero 2.csv\n…' },
  {
    id: 'timestamp', title: 'Por estampa de tiempo', icon: 'clock',
    desc: 'Una fila por fecha/hora con todos los medidores; una columna por medidor y medición (GRUPO.MEDIDOR.Medición).',
    example: 'FechaHora;PLANTA.TAB1.kWh [kWh];PLANTA.TAB2.kWh [kWh]\n2025-01-01 00:15:00;10,5;7,3',
  },
] as const;

function set<K extends keyof OutputOptions>(key: K, value: OutputOptions[K]) {
  output.value = { ...output.value, [key]: value };
}

function setDelimiter(d: OutputOptions['delimiter']) {
  // Evita la combinación inválida "," + coma decimal
  output.value = { ...output.value, delimiter: d, decimal: d === ',' && output.value.decimal === ',' ? '.' : output.value.decimal };
}

const preview = computed(() => {
  try {
    if (!isValidTimeZone(props.timezone)) return '';
    const r = resolveRange(props.range, props.timezone);
    return renderFileName(output.value.fileName, {
      reportName: props.reportName || 'Reporte',
      fromLocal: r.fromLocal,
      toLocal: r.toLocal,
      generatedLocal: utcToLocalInput(Date.now(), props.timezone),
    }, output.value.format === 'zip' || layout.value.files > 1 ? 'zip' : 'csv');
  } catch {
    return '';
  }
});

// Formato por estampa de tiempo: columnas = medidores × mediciones, repartidas en archivos de hasta MAX_FILE_COLUMNS
const layout = computed(() => {
  const meters = props.meterCount ?? 0;
  const quantities = props.quantityCount ?? 0;
  const columns = meters * quantities;
  if (output.value.format !== 'timestamp' || !columns) return { columns, files: 1 };
  return { columns, files: splitColumns(meters, quantities, output.value.columnsByQuantity).length };
});

// Estimación de filas con la grilla completa (se escriben aunque no haya datos)
const grid = computed(() => {
  const perDay = 1440 / output.value.intervalMinutes;
  try {
    if (!isValidTimeZone(props.timezone)) return { perDay, slots: null, total: null };
    const r = resolveRange(props.range, props.timezone);
    const slots = gridSlotCount(makeGrid(r.fromUtcMs, r.toUtcMs, output.value.intervalMinutes));
    // Por estampa de tiempo hay una sola fila por casillero para todos los medidores
    if (output.value.format === 'timestamp') return { perDay, slots, total: slots };
    const perMeter = slots * (output.value.format === 'long' ? props.quantityCount || 1 : 1);
    return { perDay, slots, total: props.meterCount ? perMeter * props.meterCount : null };
  } catch {
    return { perDay, slots: null, total: null };
  }
});

const firstSlotLabel = computed(() => {
  const m = output.value.intervalMinutes;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

function insertToken(token: string) {
  set('fileName', (output.value.fileName + token).slice(0, 150));
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <span class="label">Formato del archivo</span>
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <button
          v-for="f in formats"
          :key="f.id"
          type="button"
          class="card p-4 text-left transition hover:border-brand-300"
          :class="output.format === f.id && '!border-brand-500 ring-2 ring-brand-100'"
          @click="set('format', f.id)"
        >
          <div class="flex items-center gap-2 font-semibold"><Icon :name="f.icon" /> {{ f.title }}</div>
          <p class="mt-1 text-xs text-slate-600">{{ f.desc }}</p>
          <pre class="mt-3 overflow-hidden rounded bg-slate-50 p-2 text-[10px] leading-snug text-slate-500">{{ f.example }}</pre>
        </button>
      </div>
    </div>

    <div v-if="output.format === 'timestamp'" class="space-y-2 rounded-lg border border-brand-500/40 bg-brand-50/30 p-3">
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" class="checkbox mt-0.5" :checked="output.columnsByQuantity" @change="set('columnsByQuantity', ($event.target as HTMLInputElement).checked)" />
        <span>
          <span class="font-medium">Agrupar columnas por medición</span>
          <span class="block text-xs text-slate-500">
            <template v-if="output.columnsByQuantity">Todos los medidores de una medición juntos: TAB1.kWh, TAB2.kWh…, TAB1.kVARh, TAB2.kVARh…</template>
            <template v-else>Todas las mediciones de un medidor juntas: TAB1.kWh, TAB1.kVARh, TAB2.kWh, TAB2.kVARh…</template>
          </span>
        </span>
      </label>
      <p class="text-xs text-slate-600">
        Encabezados <span class="font-mono">GRUPO.MEDIDOR.Medición [unidad]</span>, con los medidores ordenados por GRUPO.MEDIDOR.
        <template v-if="layout.columns"> · <b>{{ formatNumber(layout.columns) }}</b> columnas de datos</template>
      </p>
      <p v-if="layout.files > 1" class="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        <Icon name="alert" :size="16" class="shrink-0 text-amber-600" />
        <span>
          Supera las {{ formatNumber(MAX_FILE_COLUMNS) }} columnas por archivo: se entregarán <b>{{ layout.files }} archivos CSV</b> dentro de un ZIP,
          sin partir {{ output.columnsByQuantity ? 'una medición' : 'un medidor' }} entre archivos cuando sea posible.
        </span>
      </p>
    </div>

    <div class="grid gap-4 md:grid-cols-4">
      <div>
        <label class="label" for="sep">Separador de campos</label>
        <select id="sep" class="input" :value="output.delimiter" @change="setDelimiter(($event.target as HTMLSelectElement).value as OutputOptions['delimiter'])">
          <option value=";">Punto y coma ( ; )</option>
          <option value=",">Coma ( , )</option>
          <option value="&#9;">Tabulación</option>
        </select>
      </div>
      <div>
        <label class="label" for="dec">Separador decimal</label>
        <select id="dec" class="input" :value="output.decimal" @change="set('decimal', ($event.target as HTMLSelectElement).value as OutputOptions['decimal'])">
          <option value="," :disabled="output.delimiter === ','">Coma ( 1,5 )</option>
          <option value=".">Punto ( 1.5 )</option>
        </select>
      </div>
      <div>
        <label class="label" for="decimals">Decimales</label>
        <select id="decimals" class="input" :value="output.decimals ?? ''" @change="set('decimals', ($event.target as HTMLSelectElement).value === '' ? null : Number(($event.target as HTMLSelectElement).value))">
          <option value="">Todos (sin redondear)</option>
          <option v-for="n in 7" :key="n - 1" :value="n - 1">{{ n - 1 }}</option>
        </select>
      </div>
      <div>
        <label class="label" for="label">Nombre del medidor</label>
        <select
          id="label"
          class="input"
          :disabled="output.format === 'timestamp'"
          :title="output.format === 'timestamp' ? 'Este formato siempre usa GRUPO.MEDIDOR' : ''"
          :value="output.format === 'timestamp' ? 'name' : output.meterLabel"
          @change="set('meterLabel', ($event.target as HTMLSelectElement).value as OutputOptions['meterLabel'])">
          <option value="displayName">Nombre visible</option>
          <option value="name">Nombre interno (Grupo.Medidor)</option>
        </select>
      </div>
    </div>

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" class="checkbox" :checked="output.includeUtc" @change="set('includeUtc', ($event.target as HTMLInputElement).checked)" />
      Incluir también la columna FechaHoraUTC
    </label>

    <div class="rounded-lg border border-slate-200 p-3" :class="output.fillGaps && 'border-brand-500/40 bg-brand-50/30'">
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" class="checkbox mt-0.5" :checked="output.fillGaps" @change="set('fillGaps', ($event.target as HTMLInputElement).checked)" />
        <span>
          <span class="font-medium">Completar filas faltantes</span>
          <span class="block text-xs text-slate-500">
            Escribe una fila por cada intervalo del rango aunque no haya dato; solo el valor queda en blanco. Útil para fórmulas de Excel
            por bloques (por ejemplo, 96 filas por día a 15 minutos).
          </span>
        </span>
      </label>
      <div v-if="output.fillGaps" class="mt-3 space-y-2 pl-6">
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-sm" for="interval">
            Intervalo
            <select id="interval" class="input w-auto py-1.5" :value="output.intervalMinutes" @change="set('intervalMinutes', Number(($event.target as HTMLSelectElement).value) as OutputOptions['intervalMinutes'])">
              <option v-for="m in GRID_INTERVALS" :key="m" :value="m">{{ m === 60 ? '1 hora' : `${m} min` }}</option>
            </select>
          </label>
          <span class="text-xs text-slate-600">
            <b>{{ formatNumber(grid.perDay) }}</b> filas por día{{ output.format === 'long' ? ' por medición' : '' }}
            <template v-if="grid.slots != null && output.format !== 'timestamp'"> ·{{ formatNumber(grid.slots) }} por {{ output.format === 'long' ? 'medición y medidor' : 'medidor' }} en este rango</template>
            <template v-if="grid.total != null"> · ≈ {{ formatNumber(grid.total) }} en total</template>
          </span>
        </div>
        <p v-if="grid.total != null && grid.total > MAX_GRID_ROWS" class="text-xs font-medium text-red-700">
          Supera el máximo de {{ formatNumber(MAX_GRID_ROWS) }} filas: usa un intervalo mayor o un rango más corto.
        </p>
        <p class="text-xs text-slate-500">
          Los intervalos siguen el rango (inicio excluido, fin incluido): un día va de {{ firstSlotLabel }} a 00:00 del día siguiente. Un dato que no cae en un intervalo exacto se incluye como fila extra y se avisa al terminar.
        </p>
      </div>
    </div>

    <div>
      <label class="label" for="fname">Nombre del archivo</label>
      <input id="fname" class="input font-mono" :value="output.fileName" maxlength="150" @input="set('fileName', ($event.target as HTMLInputElement).value)" />
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-slate-500">Insertar:</span>
        <button v-for="t in ['{reporte}', '{desde}', '{hasta}', '{generado}']" :key="t" type="button" class="btn btn-sm font-mono" @click="insertToken(t)">{{ t }}</button>
      </div>
      <p v-if="preview" class="mt-2 text-sm text-slate-600">Vista previa: <span class="font-mono font-medium text-slate-800">{{ preview }}</span></p>
    </div>

    <p class="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
      Los CSV se generan en UTF-8 con BOM y saltos de línea de Windows (CRLF), así que Excel los abre con doble clic mostrando bien tildes, ñ y unidades.
      Con «;» y coma decimal se ajusta a Excel en español.
    </p>
  </div>
</template>
