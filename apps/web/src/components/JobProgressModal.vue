<script setup lang="ts">
import { computed } from 'vue';
import type { JobState } from '@repnode/shared';
import BaseModal from './BaseModal.vue';
import Icon from './Icon.vue';
import { formatBytes, formatDuration, formatNumber } from '../lib/util';

const props = defineProps<{ job: JobState }>();
const emit = defineEmits<{ close: []; cancel: []; download: [] }>();

const terminal = computed(() => ['done', 'error', 'cancelled'].includes(props.job.status));
const pct = computed(() => {
  if (props.job.status === 'done') return 100;
  if (!props.job.metersTotal) return 0;
  return Math.min(99, Math.round((props.job.metersDone / props.job.metersTotal) * 100));
});
const statusText = computed(() => {
  switch (props.job.status) {
    case 'queued': return 'En cola…';
    case 'running': return 'Extrayendo datos de SQL Server…';
    case 'assembling': return 'Armando el archivo final…';
    case 'done': return 'Listo. La descarga comenzó automáticamente.';
    case 'cancelled': return 'Cancelado.';
    case 'error': return 'Ocurrió un error.';
  }
  return '';
});
</script>

<template>
  <BaseModal :title="`Generando · ${job.reportName}`" size="md" :closable="terminal" :tone="job.status === 'error' ? 'danger' : 'default'" @close="emit('close')">
    <div class="space-y-4">
      <div class="flex items-center gap-2 text-sm">
        <Icon v-if="job.status === 'done'" name="ok" :size="20" class="text-emerald-600" />
        <Icon v-else-if="job.status === 'error'" name="error" :size="20" class="text-red-600" />
        <Icon v-else-if="job.status === 'cancelled'" name="x" :size="20" class="text-slate-500" />
        <Icon v-else name="refresh" :size="20" class="animate-spin text-brand-600" />
        <span class="font-medium">{{ statusText }}</span>
      </div>

      <div>
        <div class="h-3 overflow-hidden rounded-full bg-slate-100">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="job.status === 'error' ? 'bg-red-500' : job.status === 'done' ? 'bg-emerald-500' : 'bg-brand-600'"
            :style="{ width: pct + '%' }"
          />
        </div>
        <div class="mt-1 flex justify-between text-xs text-slate-500">
          <span>{{ formatNumber(job.metersDone) }} / {{ formatNumber(job.metersTotal) }} medidores</span>
          <span>{{ pct }}%</span>
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Filas</dt><dd class="font-semibold">{{ formatNumber(job.rows) }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Tamaño</dt><dd class="font-semibold">{{ formatBytes(job.bytes) }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Tiempo</dt><dd class="font-semibold">{{ formatDuration(job.elapsedMs) }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Restante</dt><dd class="font-semibold">{{ terminal ? '—' : formatDuration(job.etaMs) }}</dd></div>
      </dl>

      <p class="truncate text-xs text-slate-500">Archivo: <span class="font-mono text-slate-700">{{ job.fileName }}</span></p>
      <p v-if="job.forced" class="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <Icon name="alert" :size="18" class="text-amber-600" />
        Generado de todas formas: algunos medidores no tienen datos para ciertas mediciones, así que hay celdas o filas vacías.
      </p>
      <p v-if="job.offGridRows" class="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <Icon name="alert" :size="18" class="text-amber-600" />
        {{ formatNumber(job.offGridRows) }} fila(s) con datos que no caen en un intervalo exacto se incluyeron como filas extra:
        los días afectados tienen más filas que el bloque esperado.
      </p>
      <p v-if="job.error" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{{ job.error }}</p>
    </div>
    <template #footer>
      <button v-if="!terminal" class="btn btn-danger" @click="emit('cancel')"><Icon name="x" /> Cancelar</button>
      <button v-if="job.status === 'done'" class="btn" @click="emit('download')"><Icon name="download" /> Descargar de nuevo</button>
      <button v-if="terminal" class="btn btn-primary" @click="emit('close')">Cerrar</button>
    </template>
  </BaseModal>
</template>
