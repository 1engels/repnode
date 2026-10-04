import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { DateRange, MeterValidation, Selection, ValidationResult } from '@repnode/shared';
import { ApiError, post } from './api';

export type ValidationRequest =
  | { selection: Selection; rangeOverride?: DateRange }
  | { reportId: number; rangeOverride?: DateRange };

/**
 * Valida automáticamente (con debounce) cada vez que cambia la selección.
 * Generar solo se habilita cuando la última validación terminó sin errores.
 * `extraKey` permite revalidar por cambios que no alteran la petición (p. ej. miembros de un tag dinámico).
 */
export function useValidation(source: () => ValidationRequest | null, delay = 500, extraKey?: () => unknown) {
  const state = ref<'idle' | 'pending' | 'running' | 'done' | 'failed'>('idle');
  const result = shallowRef<ValidationResult | null>(null);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let seq = 0;

  async function run(): Promise<ValidationResult | null> {
    const req = source();
    controller?.abort();
    if (timer) clearTimeout(timer);
    if (!req) {
      state.value = 'idle';
      result.value = null;
      error.value = null;
      return null;
    }
    const my = ++seq;
    controller = new AbortController();
    state.value = 'running';
    error.value = null;
    try {
      const r = await post<ValidationResult>('/api/reports/validate', req, controller.signal);
      if (my !== seq) return null;
      result.value = r;
      state.value = 'done';
      return r;
    } catch (err) {
      if (my !== seq || (err as Error).name === 'AbortError') return null;
      result.value = null;
      error.value = err instanceof ApiError ? err.message : String(err);
      state.value = 'failed';
      return null;
    }
  }

  function schedule(): void {
    controller?.abort();
    if (timer) clearTimeout(timer);
    if (!source()) {
      seq++;
      state.value = 'idle';
      result.value = null;
      return;
    }
    state.value = 'pending';
    timer = setTimeout(run, delay);
  }

  watch(() => JSON.stringify([source(), extraKey?.()]), schedule, { immediate: true });
  onBeforeUnmount(() => {
    controller?.abort();
    if (timer) clearTimeout(timer);
  });

  const meterIssues = computed(() => new Map<number, MeterValidation>((result.value?.meters ?? []).map((m) => [m.sourceId, m])));
  const quantityIssues = computed(() => new Map((result.value?.quantities ?? []).map((q) => [q.quantityId, q])));
  const busy = computed(() => state.value === 'pending' || state.value === 'running');
  const canGenerate = computed(() => state.value === 'done' && !!result.value && result.value.status !== 'error');
  const blockReason = computed(() => {
    if (state.value === 'idle') return 'Completa la selección de medidores y mediciones';
    if (busy.value) return 'Validando datos…';
    if (state.value === 'failed') return 'La validación falló: ' + (error.value ?? '');
    if (result.value?.status === 'error') return 'Hay medidores sin datos para las mediciones seleccionadas';
    return '';
  });

  return { state, result, error, busy, canGenerate, blockReason, meterIssues, quantityIssues, run, schedule };
}
