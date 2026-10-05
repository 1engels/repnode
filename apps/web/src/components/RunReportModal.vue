<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { FORMAT_LABELS, relativePresetLabels, resolveRange, type DateRange, type ReportDTO } from '@repnode/shared';
import BaseModal from './BaseModal.vue';
import DateRangeEditor from './DateRangeEditor.vue';
import Icon from './Icon.vue';
import JobProgressModal from './JobProgressModal.vue';
import ValidationErrorModal from './ValidationErrorModal.vue';
import ValidationStatus from './ValidationStatus.vue';
import { useJobRunner } from '../lib/useJobRunner';
import { useValidation } from '../lib/useValidation';
import { clone, formatLocal, formatNumber } from '../lib/util';
import { useCatalogStore } from '../stores/catalog';

const props = defineProps<{ report: ReportDTO }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const catalog = useCatalogStore();

const def = computed(() => props.report.definition);
const useOverride = ref(false);
const override = ref<DateRange>(clone(def.value.range));
const timezone = ref(def.value.timezone);
const showIssues = ref(false);

const effectiveRange = computed(() => (useOverride.value ? override.value : def.value.range));
const resolved = computed(() => {
  try {
    return resolveRange(effectiveRange.value, def.value.timezone);
  } catch {
    return null;
  }
});
const meters = computed(() => catalog.effectiveSourceIds(def.value.sourceIds, def.value.tagIds).length);

const validation = useValidation(
  () => (resolved.value && resolved.value.fromUtcMs < resolved.value.toUtcMs ? { reportId: props.report.id, rangeOverride: useOverride.value ? override.value : undefined } : null),
  300,
);
const runner = useJobRunner();
watch(runner.rejectedValidation, (r) => r && (showIssues.value = true));

const rangeLabel = computed(() => {
  const r = def.value.range;
  return r.mode === 'fixed' ? 'Fechas fijas' : relativePresetLabels[r.preset] + (r.preset === 'lastNDays' ? ` (${r.days ?? 7})` : '');
});

function applyRange(from: string, to: string) {
  useOverride.value = true;
  override.value = { mode: 'fixed', from, to };
  showIssues.value = false;
}

async function generate() {
  if (!validation.canGenerate.value) {
    if (validation.result.value?.status === 'error') showIssues.value = true;
    return;
  }
  await runner.start({ reportId: props.report.id, rangeOverride: useOverride.value ? override.value : undefined });
}

async function forceGenerate() {
  showIssues.value = false;
  await runner.start({ reportId: props.report.id, rangeOverride: useOverride.value ? override.value : undefined, force: true });
}

const hasErrors = computed(() => (runner.rejectedValidation.value ?? validation.result.value)?.status === 'error');

function edit() {
  emit('close');
  router.push({ name: 'report-edit', params: { id: props.report.id } });
}
</script>

<template>
  <BaseModal v-if="!runner.open.value" :title="`Generar · ${report.name}`" size="lg" @close="emit('close')">
    <div class="space-y-4">
      <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Medidores</dt><dd class="font-semibold">{{ formatNumber(meters) }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Mediciones</dt><dd class="font-semibold">{{ def.quantityIds.length }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Rango guardado</dt><dd class="font-semibold">{{ rangeLabel }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-2"><dt class="text-xs text-slate-500">Formato</dt><dd class="font-semibold">{{ FORMAT_LABELS[def.output.format] ?? FORMAT_LABELS.wide }}</dd></div>
      </dl>

      <div v-if="resolved" class="text-sm text-slate-700">
        Periodo: <b>{{ formatLocal(resolved.fromLocal) }}</b> → <b>{{ formatLocal(resolved.toLocal) }}</b> <span class="text-slate-500">({{ def.timezone }})</span>
      </div>

      <label class="flex items-center gap-2 text-sm font-medium">
        <input v-model="useOverride" type="checkbox" class="checkbox" /> Usar otro rango solo para esta ejecución
      </label>
      <div v-if="useOverride" class="rounded-lg border border-slate-200 p-4">
        <DateRangeEditor v-model:range="override" v-model:timezone="timezone" compact />
        <p v-if="timezone !== def.timezone" class="mt-2 text-xs text-amber-700">La zona horaria del reporte ({{ def.timezone }}) no cambia; edita el reporte para cambiarla.</p>
      </div>

      <div class="rounded-lg border border-slate-200 p-3">
        <ValidationStatus :state="validation.state.value" :result="validation.result.value" :error="validation.error.value" @details="showIssues = true" @retry="validation.run()" />
      </div>
    </div>
    <template #footer>
      <button class="btn mr-auto" @click="edit"><Icon name="edit" /> Editar reporte</button>
      <button class="btn" @click="emit('close')">Cancelar</button>
      <button v-if="hasErrors && !validation.busy.value" class="btn btn-danger" :disabled="runner.starting.value" @click="showIssues = true">
        Generar de todas formas…
      </button>
      <span :title="validation.blockReason.value">
        <button class="btn btn-primary" :class="!validation.canGenerate.value && 'cursor-not-allowed opacity-50'" :disabled="runner.starting.value" @click="generate">
          <Icon :name="runner.starting.value ? 'refresh' : 'download'" :class="runner.starting.value && 'animate-spin'" /> Generar CSV
        </button>
      </span>
    </template>
  </BaseModal>

  <ValidationErrorModal
    v-if="showIssues && (runner.rejectedValidation.value || validation.result.value)"
    :result="(runner.rejectedValidation.value ?? validation.result.value)!"
    :timezone="def.timezone"
    :editable="false"
    can-force
    :fill-gaps="def.output.fillGaps"
    @close="showIssues = false"
    @force="forceGenerate"
    @apply-range="applyRange"
    @edit="edit"
  />
  <JobProgressModal
    v-if="runner.open.value && runner.job.value"
    :job="runner.job.value"
    @close="runner.close(); emit('close')"
    @cancel="runner.cancel()"
    @download="runner.download()"
  />
</template>
