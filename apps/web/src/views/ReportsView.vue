<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { FORMAT_LABELS, relativePresetLabels, type HistoryEntryDTO, type ReportDTO } from '@repnode/shared';
import Icon from '../components/Icon.vue';
import RunReportModal from '../components/RunReportModal.vue';
import { get } from '../lib/api';
import { clone, formatBytes, formatIsoDate, formatLocal, formatNumber, makeMatcher, normalize } from '../lib/util';
import { useCatalogStore } from '../stores/catalog';
import { useReportsStore } from '../stores/reports';
import { useToastStore } from '../stores/toast';

const reports = useReportsStore();
const catalog = useCatalogStore();
const toast = useToastStore();
const router = useRouter();

const query = ref('');
const running = ref<ReportDTO | null>(null);
const history = ref<HistoryEntryDTO[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    await Promise.all([catalog.load(), reports.load()]);
    history.value = await get<HistoryEntryDTO[]>('/api/history');
  } catch (e) {
    toast.error(e);
  } finally {
    loading.value = false;
  }
});

const filtered = computed(() => {
  const m = makeMatcher(query.value);
  return reports.reports.filter((r) => m(normalize(r.name)));
});

function rangeText(r: ReportDTO): string {
  const range = r.definition.range;
  if (range.mode === 'fixed') return `${formatLocal(range.from)} → ${formatLocal(range.to)}`;
  return relativePresetLabels[range.preset] + (range.preset === 'lastNDays' ? ` (${range.days ?? 7} días)` : '');
}

function meterCount(r: ReportDTO): number {
  return catalog.effectiveSourceIds(r.definition.sourceIds, r.definition.tagIds).length;
}

async function duplicate(r: ReportDTO) {
  try {
    const copy = await reports.save({ ...clone(r.definition), name: `${r.name} (copia)` });
    toast.success('Reporte duplicado');
    router.push({ name: 'report-edit', params: { id: copy.id } });
  } catch (e) {
    toast.error(e);
  }
}

async function remove(r: ReportDTO) {
  if (!confirm(`¿Eliminar el reporte "${r.name}"?`)) return;
  try {
    await reports.remove(r.id);
    toast.success('Reporte eliminado');
  } catch (e) {
    toast.error(e);
  }
}

async function closeRun() {
  running.value = null;
  history.value = await get<HistoryEntryDTO[]>('/api/history').catch(() => history.value);
}

const statusLabel: Record<string, string> = { done: 'Completado', error: 'Error', cancelled: 'Cancelado', running: 'En curso', queued: 'En cola', assembling: 'Armando' };
</script>

<template>
  <div class="space-y-8">
    <div class="flex flex-wrap items-end gap-4">
      <div class="flex-1">
        <h1 class="text-2xl font-semibold text-slate-900">Reportes</h1>
        <p class="mt-1 text-sm text-slate-600">Elige un reporte guardado para generar su CSV, o crea uno nuevo.</p>
      </div>
      <div class="relative w-64">
        <Icon name="search" class="absolute top-2.5 left-3 text-slate-400" />
        <input v-model="query" class="input pl-9" placeholder="Buscar reporte…" />
      </div>
      <RouterLink to="/reports/new" class="btn btn-primary"><Icon name="plus" /> Nuevo reporte</RouterLink>
    </div>

    <div v-if="loading" class="flex items-center gap-2 py-12 text-slate-500"><Icon name="refresh" class="animate-spin" /> Cargando…</div>

    <div v-else-if="!reports.reports.length" class="card flex flex-col items-center gap-3 p-12 text-center">
      <div class="flex size-14 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon name="file" :size="28" /></div>
      <h2 class="text-lg font-semibold">Todavía no hay reportes</h2>
      <p class="max-w-md text-sm text-slate-600">
        Un reporte define qué medidores y mediciones exportar, el rango de fechas, la zona horaria y el formato del archivo. Guárdalo para generarlo con un clic.
      </p>
      <RouterLink to="/reports/new" class="btn btn-primary mt-2"><Icon name="plus" /> Crear el primer reporte</RouterLink>
    </div>

    <div v-else class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <article v-for="r in filtered" :key="r.id" class="card flex flex-col p-4">
        <div class="flex items-start gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name="file" :size="20" /></div>
          <div class="min-w-0 flex-1">
            <h2 class="truncate font-semibold">{{ r.name }}</h2>
            <p class="text-xs text-slate-500">Actualizado {{ formatIsoDate(r.updatedAt.replace(' ', 'T') + 'Z') }}</p>
          </div>
        </div>
        <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt class="text-slate-500">Medidores</dt>
          <dd class="text-right font-medium">
            {{ formatNumber(meterCount(r)) }}<span v-if="r.definition.tagIds.length" class="text-slate-500"> (+{{ r.definition.tagIds.length }} tag)</span>
          </dd>
          <dt class="text-slate-500">Mediciones</dt><dd class="text-right font-medium">{{ r.definition.quantityIds.length }}</dd>
          <dt class="text-slate-500">Rango</dt><dd class="truncate text-right font-medium">{{ rangeText(r) }}</dd>
          <dt class="text-slate-500">Formato</dt>
          <dd class="text-right font-medium">{{ FORMAT_LABELS[r.definition.output.format] ?? FORMAT_LABELS.wide }}</dd>
        </dl>
        <div class="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
          <button class="btn btn-primary btn-sm" @click="running = r"><Icon name="download" /> Generar CSV</button>
          <RouterLink :to="{ name: 'report-edit', params: { id: r.id } }" class="btn btn-sm"><Icon name="edit" /> Editar</RouterLink>
          <button class="btn btn-ghost btn-sm ml-auto" title="Duplicar" @click="duplicate(r)"><Icon name="copy" /></button>
          <button class="btn btn-ghost btn-sm text-red-600" title="Eliminar" @click="remove(r)"><Icon name="trash" /></button>
        </div>
      </article>
      <p v-if="!filtered.length" class="text-sm text-slate-500">Ningún reporte coincide con la búsqueda.</p>
    </div>

    <section v-if="history.length">
      <h2 class="label">Últimas ejecuciones</h2>
      <div class="card overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-left text-xs text-slate-500 uppercase">
            <tr>
              <th class="px-3 py-2">Fecha</th><th class="px-3 py-2">Reporte</th><th class="px-3 py-2">Archivo</th>
              <th class="px-3 py-2 text-right">Medidores</th><th class="px-3 py-2 text-right">Filas</th><th class="px-3 py-2 text-right">Tamaño</th><th class="px-3 py-2">Estado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in history.slice(0, 15)" :key="h.id" class="border-t border-slate-100">
              <td class="px-3 py-2 whitespace-nowrap">{{ formatIsoDate(h.startedAt) }}</td>
              <td class="px-3 py-2">{{ h.reportName }}</td>
              <td class="max-w-56 truncate px-3 py-2 font-mono text-xs">{{ h.fileName }}</td>
              <td class="px-3 py-2 text-right">{{ formatNumber(h.meters) }}</td>
              <td class="px-3 py-2 text-right">{{ formatNumber(h.rows) }}</td>
              <td class="px-3 py-2 text-right">{{ formatBytes(h.bytes) }}</td>
              <td class="px-3 py-2">
                <span
                  class="chip"
                  :class="h.status === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : h.status === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-600'"
                  :title="h.error ?? ''"
                >{{ statusLabel[h.status] ?? h.status }}</span>
                <span v-if="h.forced" class="chip ml-1 border-amber-200 bg-amber-50 text-amber-700" title="Generado de todas formas pese a datos faltantes">con faltantes</span>
                <span
                  v-if="h.offGridRows"
                  class="chip ml-1 border-amber-200 bg-amber-50 text-amber-700"
                  :title="`${h.offGridRows} fila(s) con datos fuera de los intervalos exactos se incluyeron como filas extra`"
                >+{{ formatNumber(h.offGridRows) }} fuera de intervalo</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <RunReportModal v-if="running" :report="running" @close="closeRun" />
  </div>
</template>
