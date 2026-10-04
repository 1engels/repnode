<script setup lang="ts">
import type { ValidationResult } from '@repnode/shared';
import Icon from './Icon.vue';
import { formatNumber } from '../lib/util';

defineProps<{
  state: 'idle' | 'pending' | 'running' | 'done' | 'failed';
  result: ValidationResult | null;
  error: string | null;
}>();
const emit = defineEmits<{ details: []; retry: [] }>();
</script>

<template>
  <div class="flex min-w-0 items-center gap-2 text-sm">
    <template v-if="state === 'idle'">
      <Icon name="alert" class="text-slate-400" /> <span class="text-slate-500">Elige medidores y mediciones para validar</span>
    </template>
    <template v-else-if="state === 'pending' || state === 'running'">
      <Icon name="refresh" class="animate-spin text-brand-600" /> <span class="text-slate-600">Validando que haya datos en el rango…</span>
    </template>
    <template v-else-if="state === 'failed'">
      <Icon name="error" class="text-red-600" />
      <span class="truncate text-red-700">No se pudo validar: {{ error }}</span>
      <button class="btn btn-sm" @click="emit('retry')">Reintentar</button>
    </template>
    <template v-else-if="result?.status === 'ok'">
      <Icon name="ok" class="text-emerald-600" />
      <span class="text-emerald-800">Datos verificados: {{ formatNumber(result.summary.meters) }} medidores × {{ result.summary.quantities }} mediciones con datos</span>
    </template>
    <template v-else-if="result?.status === 'warning'">
      <Icon name="alert" class="text-amber-600" />
      <span class="text-amber-800">{{ result.summary.metersWithWarnings }} medidores con datos parciales (se puede generar)</span>
      <button class="btn btn-sm" @click="emit('details')">Ver detalle</button>
    </template>
    <template v-else-if="result?.status === 'error'">
      <Icon name="error" class="text-red-600" />
      <span class="font-medium text-red-700">{{ result.summary.metersWithErrors }} medidores sin datos para alguna medición</span>
      <button class="btn btn-sm btn-danger" @click="emit('details')">Ver problemas</button>
    </template>
  </div>
</template>
