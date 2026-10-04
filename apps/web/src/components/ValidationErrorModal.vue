<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ValidationResult } from '@repnode/shared';
import BaseModal from './BaseModal.vue';
import Icon from './Icon.vue';
import { useCatalogStore } from '../stores/catalog';
import { describeIssue, issueLabels } from '../lib/issues';
import { downloadCsv, formatLocal, formatNumber } from '../lib/util';

const props = defineProps<{
  result: ValidationResult;
  timezone: string;
  /** false cuando se abre desde la lista de reportes (no se edita la selección en sitio) */
  editable: boolean;
  /** Muestra "Generar de todas formas" cuando hay errores */
  canForce?: boolean;
  /** El reporte completa filas vacías (cambia el texto de la confirmación) */
  fillGaps?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  removeMeters: [ids: number[]];
  removeQuantities: [ids: number[]];
  applyRange: [fromLocal: string, toLocal: string];
  goto: [step: 'meters' | 'quantities' | 'range'];
  edit: [];
  force: [];
}>();

const catalog = useCatalogStore();
const showPartial = ref(false);

const errorMeters = computed(() => props.result.meters.filter((m) => m.status === 'error'));
const partialMeters = computed(() => props.result.meters.filter((m) => m.status === 'partial'));
const errorQuantities = computed(() => props.result.quantities.filter((q) => q.errors > 0));
const hasMissingQuantity = computed(() => errorMeters.value.some((m) => m.issues.some((i) => i.status === 'missing_quantity')));
const hasOutOfRange = computed(() => errorMeters.value.some((m) => m.issues.some((i) => i.status === 'no_data_in_range')));

const name = (sid: number) => catalog.sourceById.get(sid)?.displayName ?? `#${sid}`;
const qname = (qid: number) => catalog.quantityById.get(qid)?.name ?? `#${qid}`;

function force() {
  const blanks = props.fillGaps
    ? 'Sus valores quedarán en blanco en la grilla de filas completas.'
    : 'Esas celdas quedarán vacías y los medidores sin ningún dato no tendrán filas.';
  const msg = `${props.result.summary.metersWithErrors} medidor(es) no tienen datos para una o más mediciones en el rango. ${blanks}

¿Generar el archivo de todas formas?`;
  if (confirm(msg)) emit('force');
}

function exportProblems() {
  const rows = [['Medidor', 'Nombre interno', 'Medicion', 'Problema', 'Primer dato (UTC)', 'Ultimo dato (UTC)', 'Disponible desde (UTC)', 'Disponible hasta (UTC)']];
  for (const m of props.result.meters) {
    for (const i of m.issues) {
      rows.push([
        name(m.sourceId), catalog.sourceById.get(m.sourceId)?.name ?? '', qname(i.quantityId), issueLabels[i.status],
        i.firstUtc ?? '', i.lastUtc ?? '', i.availableFromUtc ?? '', i.availableToUtc ?? '',
      ]);
    }
  }
  downloadCsv(`problemas_validacion_${props.result.fromLocal.slice(0, 10)}.csv`, rows);
}
</script>

<template>
  <BaseModal :title="errorMeters.length ? 'Faltan datos en el rango' : 'Advertencias de datos'" :tone="errorMeters.length ? 'danger' : 'warning'" size="xl" @close="emit('close')">
    <div class="space-y-5">
      <p v-if="errorMeters.length" class="text-sm text-slate-700">
        <b>{{ formatNumber(result.summary.metersWithErrors) }}</b> de {{ formatNumber(result.summary.meters) }} medidores no tienen datos para una o más de las
        {{ result.summary.quantities }} mediciones seleccionadas entre <b>{{ formatLocal(result.fromLocal) }}</b> y <b>{{ formatLocal(result.toLocal) }}</b> ({{ timezone }}).
        Para evitar un CSV con columnas vacías sin darte cuenta, la generación está bloqueada: corrígelo con las acciones de abajo
        <template v-if="canForce">o usa <b>Generar de todas formas</b> si los faltantes son esperados</template>.
      </p>
      <p v-else class="text-sm text-slate-700">
        Todos los medidores tienen datos, pero <b>{{ partialMeters.length }}</b> tienen datos solo en parte del rango. Puedes generar igual.
      </p>

      <div v-if="errorMeters.length" class="grid gap-3 md:grid-cols-3">
        <div class="rounded-lg border border-slate-200 p-3">
          <div class="text-xs font-semibold text-slate-500 uppercase">Paso 1 · Medidores</div>
          <p class="mt-1 text-sm">Quita los {{ errorMeters.length }} medidores marcados en rojo en la lista de seleccionados.</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button v-if="editable" class="btn btn-sm btn-danger" @click="emit('removeMeters', errorMeters.map((m) => m.sourceId))"><Icon name="trash" /> Quitar medidores sin datos</button>
            <button v-if="editable" class="btn btn-sm" @click="emit('goto', 'meters')">Ir a Medidores</button>
          </div>
        </div>
        <div class="rounded-lg border border-slate-200 p-3" :class="hasMissingQuantity && 'border-red-200 bg-red-50/40'">
          <div class="text-xs font-semibold text-slate-500 uppercase">Paso 2 · Mediciones</div>
          <p class="mt-1 text-sm">
            <template v-if="hasMissingQuantity">Algunos medidores no registran ciertas mediciones.</template>
            <template v-else>Revisa las mediciones marcadas.</template>
            {{ errorQuantities.length }} medición(es) afectada(s).
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button v-if="editable" class="btn btn-sm btn-danger" @click="emit('removeQuantities', errorQuantities.map((q) => q.quantityId))"><Icon name="trash" /> Quitar mediciones sin datos</button>
            <button v-if="editable" class="btn btn-sm" @click="emit('goto', 'quantities')">Ir a Mediciones</button>
          </div>
        </div>
        <div class="rounded-lg border border-slate-200 p-3" :class="hasOutOfRange && 'border-amber-200 bg-amber-50/40'">
          <div class="text-xs font-semibold text-slate-500 uppercase">Paso 3 · Rango</div>
          <p class="mt-1 text-sm">
            <template v-if="hasOutOfRange">Hay medidores con datos fuera del rango elegido.</template>
            <template v-else>El rango no es la causa principal.</template>
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button v-if="result.suggestedRange" class="btn btn-sm btn-primary" @click="emit('applyRange', result.suggestedRange.fromLocal, result.suggestedRange.toLocal)">
              <Icon name="calendar" /> Ajustar a {{ formatLocal(result.suggestedRange.fromLocal) }} – {{ formatLocal(result.suggestedRange.toLocal) }}
            </button>
            <button v-if="editable" class="btn btn-sm" @click="emit('goto', 'range')">Ir a Rango</button>
          </div>
        </div>
      </div>

      <div v-if="errorMeters.length">
        <h3 class="mb-2 text-sm font-semibold">Detalle por medidor</h3>
        <div class="max-h-80 overflow-auto rounded-lg border border-slate-200">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 uppercase">
              <tr><th class="px-3 py-2">Medidor</th><th class="px-3 py-2">Medición</th><th class="px-3 py-2">Motivo</th></tr>
            </thead>
            <tbody>
              <template v-for="m in errorMeters.slice(0, 500)" :key="m.sourceId">
                <tr v-for="(i, k) in m.issues.filter((x) => x.status !== 'partial')" :key="i.quantityId" class="border-t border-slate-100">
                  <td class="px-3 py-1.5 align-top">
                    <template v-if="k === 0">
                      <div class="font-medium">{{ name(m.sourceId) }}</div>
                      <div class="text-xs text-slate-500">{{ catalog.sourceById.get(m.sourceId)?.name }}</div>
                    </template>
                  </td>
                  <td class="px-3 py-1.5 align-top">{{ qname(i.quantityId) }}</td>
                  <td class="px-3 py-1.5 align-top" :class="i.status === 'missing_quantity' ? 'text-red-700' : 'text-amber-800'">{{ describeIssue(i, timezone) }}</td>
                </tr>
              </template>
            </tbody>
          </table>
          <p v-if="errorMeters.length > 500" class="p-2 text-center text-xs text-slate-500">Mostrando 500 de {{ errorMeters.length }}. Exporta la lista para verlos todos.</p>
        </div>
      </div>

      <div v-if="partialMeters.length">
        <button class="flex items-center gap-1 text-sm font-medium text-amber-800" @click="showPartial = !showPartial">
          <Icon :name="showPartial ? 'down' : 'right'" /> {{ partialMeters.length }} medidores con datos parciales (no bloquea)
        </button>
        <ul v-if="showPartial" class="mt-2 max-h-56 overflow-auto rounded-lg border border-amber-200 bg-amber-50/40 p-2 text-xs">
          <li v-for="m in partialMeters.slice(0, 300)" :key="m.sourceId" class="py-0.5">
            <b>{{ name(m.sourceId) }}</b>: {{ m.issues.map((i) => `${qname(i.quantityId)} — ${describeIssue(i, timezone)}`).join(' · ') }}
          </li>
        </ul>
      </div>
    </div>

    <template #footer>
      <button class="btn mr-auto" @click="exportProblems"><Icon name="download" /> Exportar lista de problemas (CSV)</button>
      <button v-if="!editable" class="btn" @click="emit('edit')"><Icon name="edit" /> Editar reporte</button>
      <button v-if="canForce && errorMeters.length" class="btn btn-danger" @click="force"><Icon name="download" /> Generar de todas formas</button>
      <button class="btn btn-primary" @click="emit('close')">Entendido</button>
    </template>
  </BaseModal>
</template>
