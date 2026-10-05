<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { FORMAT_LABELS, isValidTimeZone, outputSchema, reportDefinitionSchema, resolveRange, type ReportDefinition, type ValidationResult } from '@repnode/shared';
import DateRangeEditor from '../components/DateRangeEditor.vue';
import Icon from '../components/Icon.vue';
import JobProgressModal from '../components/JobProgressModal.vue';
import MeasurementPicker from '../components/MeasurementPicker.vue';
import MeterPicker from '../components/MeterPicker.vue';
import OutputEditor from '../components/OutputEditor.vue';
import ValidationErrorModal from '../components/ValidationErrorModal.vue';
import ValidationStatus from '../components/ValidationStatus.vue';
import { useJobRunner } from '../lib/useJobRunner';
import { useValidation } from '../lib/useValidation';
import { clone, formatNumber, localTimeZone } from '../lib/util';
import { useCatalogStore } from '../stores/catalog';
import { useReportsStore } from '../stores/reports';
import { useToastStore } from '../stores/toast';

const props = defineProps<{ id?: string }>();
const router = useRouter();
const catalog = useCatalogStore();
const reports = useReportsStore();
const toast = useToastStore();

type Step = 'meters' | 'quantities' | 'range' | 'output';

function emptyDraft(): ReportDefinition {
  return {
    name: '',
    sourceIds: [],
    tagIds: [],
    quantityIds: [],
    range: { mode: 'relative', preset: 'previousMonth' },
    timezone: localTimeZone(),
    output: outputSchema.parse({}),
  };
}

const draft = ref<ReportDefinition>(emptyDraft());
const reportId = ref<number | null>(props.id ? Number(props.id) : null);
const step = ref<Step>('meters');
const loading = ref(true);
const saving = ref(false);
const savedSnapshot = ref('');
const showIssues = ref(false);
const modalResult = ref<ValidationResult | null>(null);

onMounted(async () => {
  try {
    await catalog.load();
    if (reportId.value) {
      if (!reports.loaded) await reports.load();
      const r = reports.reports.find((x) => x.id === reportId.value);
      if (!r) {
        toast.error('El reporte no existe');
        router.replace('/reports');
        return;
      }
      draft.value = { ...emptyDraft(), ...clone(r.definition), output: outputSchema.parse(r.definition.output ?? {}) };
    }
    savedSnapshot.value = JSON.stringify(draft.value);
  } catch (e) {
    toast.error(e);
  } finally {
    loading.value = false;
  }
});

const dirty = computed(() => !loading.value && JSON.stringify(draft.value) !== savedSnapshot.value);
onBeforeRouteLeave(() => {
  if (dirty.value && !confirm('Hay cambios sin guardar. ¿Salir de todas formas?')) return false;
});

const effectiveIds = computed(() => catalog.effectiveSourceIds(draft.value.sourceIds, draft.value.tagIds));

const rangeValid = computed(() => {
  if (!isValidTimeZone(draft.value.timezone)) return false;
  try {
    const r = resolveRange(draft.value.range, draft.value.timezone);
    return r.fromUtcMs < r.toUtcMs;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// Validación automática
// ---------------------------------------------------------------------------
const validation = useValidation(() => {
  if (loading.value || !effectiveIds.value.length || !draft.value.quantityIds.length || !rangeValid.value) return null;
  const { sourceIds, tagIds, quantityIds, range, timezone } = draft.value;
  return { selection: { sourceIds, tagIds, quantityIds, range, timezone } };
}, 500, () => (draft.value.tagIds.length ? effectiveIds.value.join(',') : ''));

// El modal se abre solo cuando aparece un error nuevo estando en los pasos finales;
// en los pasos 1 y 2 basta con las marcas en las listas.
let lastShownSignature = '';
watch(validation.result, (r) => {
  if (!r || r.status !== 'error') return;
  const sig = `${r.summary.missing}|${r.summary.metersWithErrors}|${r.fromUtc}|${r.toUtc}`;
  if ((step.value === 'range' || step.value === 'output') && sig !== lastShownSignature) {
    lastShownSignature = sig;
    openIssues(r);
  }
});

function openIssues(r: ValidationResult | null = validation.result.value) {
  if (!r) return;
  modalResult.value = r;
  showIssues.value = true;
}

// Acciones rápidas del modal
function removeMeters(ids: number[]) {
  const remove = new Set(ids);
  const direct = new Set(draft.value.sourceIds);
  if (ids.some((id) => !direct.has(id)) && draft.value.tagIds.length) {
    // Hay medidores que vienen de tags dinámicos: se convierten a selección fija para poder quitarlos
    draft.value.sourceIds = effectiveIds.value;
    draft.value.tagIds = [];
    toast.info('Los tags dinámicos se convirtieron en selección fija para poder quitar medidores individuales');
  }
  draft.value.sourceIds = draft.value.sourceIds.filter((id) => !remove.has(id));
  toast.success(`${ids.length} medidores quitados`);
  showIssues.value = false;
}

function removeQuantities(ids: number[]) {
  const remove = new Set(ids);
  draft.value.quantityIds = draft.value.quantityIds.filter((q) => !remove.has(q));
  toast.success(`${ids.length} mediciones quitadas`);
  showIssues.value = false;
}

function applyRange(from: string, to: string) {
  draft.value.range = { mode: 'fixed', from, to };
  toast.success('Rango ajustado al periodo con datos disponibles');
  showIssues.value = false;
}

function goto(s: Step) {
  step.value = s;
  showIssues.value = false;
}

// ---------------------------------------------------------------------------
// Guardar / generar
// ---------------------------------------------------------------------------
const nameError = computed(() => (!draft.value.name.trim() ? 'Escribe un nombre para el reporte' : ''));

async function save(): Promise<boolean> {
  const parsed = reportDefinitionSchema.safeParse(draft.value);
  if (!parsed.success) {
    toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos del reporte');
    if (!draft.value.name.trim()) document.getElementById('report-name')?.focus();
    return false;
  }
  saving.value = true;
  try {
    const r = await reports.save(parsed.data, reportId.value);
    const isNew = !reportId.value;
    reportId.value = r.id;
    savedSnapshot.value = JSON.stringify(draft.value);
    toast.success('Reporte guardado');
    if (isNew) router.replace({ name: 'report-edit', params: { id: r.id } });
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  } finally {
    saving.value = false;
  }
}

const runner = useJobRunner();
watch(runner.rejectedValidation, (r) => r && openIssues(r));

async function generate(force = false) {
  if (!force && !validation.canGenerate.value) {
    if (validation.result.value?.status === 'error') openIssues();
    else toast.info(validation.blockReason.value);
    return;
  }
  showIssues.value = false;
  const def = { ...draft.value, name: draft.value.name.trim() || 'Reporte' };
  const parsed = reportDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos del reporte');
    return;
  }
  await runner.start({ definition: parsed.data, force });
}

const steps = computed(() => [
  { id: 'meters' as Step, n: 1, title: 'Medidores', sub: `${formatNumber(effectiveIds.value.length)} seleccionados`, ok: effectiveIds.value.length > 0, err: validation.result.value?.summary.metersWithErrors },
  { id: 'quantities' as Step, n: 2, title: 'Mediciones', sub: `${draft.value.quantityIds.length} seleccionadas`, ok: draft.value.quantityIds.length > 0, err: validation.result.value?.quantities.filter((q) => q.errors).length },
  { id: 'range' as Step, n: 3, title: 'Rango y zona horaria', sub: draft.value.range.mode === 'fixed' ? 'Fechas fijas' : 'Relativo', ok: rangeValid.value, err: 0 },
  { id: 'output' as Step, n: 4, title: 'Archivo de salida', sub: FORMAT_LABELS[draft.value.output.format], ok: true, err: 0 },
]);
const stepIndex = computed(() => steps.value.findIndex((s) => s.id === step.value));
</script>

<template>
  <div v-if="loading" class="flex items-center justify-center gap-2 py-24 text-slate-500"><Icon name="refresh" class="animate-spin" /> Cargando catálogo…</div>
  <div v-else class="pb-28">
    <div class="mb-5 flex flex-wrap items-center gap-3">
      <RouterLink to="/reports" class="btn btn-ghost btn-sm"><Icon name="left" /> Reportes</RouterLink>
      <div class="min-w-64 flex-1">
        <input
          id="report-name"
          v-model="draft.name"
          class="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold text-slate-900 placeholder:text-slate-400 hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:outline-none"
          placeholder="Nombre del reporte…"
          maxlength="120"
        />
      </div>
      <span v-if="dirty" class="chip border-amber-200 bg-amber-50 text-amber-700">Sin guardar</span>
    </div>

    <nav class="mb-5 grid gap-2 sm:grid-cols-4">
      <button
        v-for="s in steps"
        :key="s.id"
        class="flex items-center gap-3 rounded-xl border p-3 text-left transition"
        :class="step === s.id ? 'border-brand-500 bg-white shadow-sm ring-2 ring-brand-100' : 'border-slate-200 bg-white/60 hover:bg-white'"
        @click="step = s.id"
      >
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
          :class="s.err ? 'bg-red-100 text-red-700' : s.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'"
        >
          <Icon v-if="s.err" name="error" />
          <template v-else>{{ s.n }}</template>
        </span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-semibold">{{ s.title }}</span>
          <span class="block truncate text-xs" :class="s.err ? 'text-red-600' : 'text-slate-500'">{{ s.err ? `${s.err} con problemas` : s.sub }}</span>
        </span>
      </button>
    </nav>

    <MeterPicker v-if="step === 'meters'" v-model:source-ids="draft.sourceIds" v-model:tag-ids="draft.tagIds" :issues="validation.meterIssues.value" :timezone="draft.timezone" />
    <MeasurementPicker v-else-if="step === 'quantities'" v-model="draft.quantityIds" :meter-ids="effectiveIds" :issues="validation.quantityIssues.value" />
    <section v-else-if="step === 'range'" class="card p-6">
      <DateRangeEditor v-model:range="draft.range" v-model:timezone="draft.timezone" />
    </section>
    <section v-else class="card p-6">
      <OutputEditor
        v-model="draft.output"
        :report-name="draft.name"
        :range="draft.range"
        :timezone="draft.timezone"
        :meter-count="effectiveIds.length"
        :quantity-count="draft.quantityIds.length"
      />
    </section>

    <!-- Barra inferior fija: validación + acciones -->
    <div class="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur">
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
        <ValidationStatus class="min-w-0 flex-1" :state="validation.state.value" :result="validation.result.value" :error="validation.error.value" @details="openIssues()" @retry="validation.run()" />
        <button class="btn" :disabled="stepIndex === 0" @click="step = steps[stepIndex - 1].id"><Icon name="left" /> Anterior</button>
        <button v-if="stepIndex < steps.length - 1" class="btn" @click="step = steps[stepIndex + 1].id">Siguiente <Icon name="right" /></button>
        <button class="btn" :disabled="saving" :title="nameError" @click="save"><Icon name="check" /> Guardar</button>
        <span :title="validation.blockReason.value">
          <button
            class="btn btn-primary"
            :class="!validation.canGenerate.value && 'cursor-not-allowed opacity-50'"
            :aria-disabled="!validation.canGenerate.value"
            :disabled="runner.starting.value"
            @click="generate()"
          >
            <Icon :name="runner.starting.value ? 'refresh' : 'download'" :class="runner.starting.value && 'animate-spin'" /> Generar CSV
          </button>
        </span>
      </div>
    </div>

    <ValidationErrorModal
      v-if="showIssues && modalResult"
      :result="modalResult"
      :timezone="draft.timezone"
      editable
      can-force
      :fill-gaps="draft.output.fillGaps"
      @close="showIssues = false"
      @force="generate(true)"
      @remove-meters="removeMeters"
      @remove-quantities="removeQuantities"
      @apply-range="applyRange"
      @goto="goto"
    />
    <JobProgressModal v-if="runner.open.value && runner.job.value" :job="runner.job.value" @close="runner.close()" @cancel="runner.cancel()" @download="runner.download()" />
  </div>
</template>
