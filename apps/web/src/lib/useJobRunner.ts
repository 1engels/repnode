import { onBeforeUnmount, ref, shallowRef } from 'vue';
import type { DateRange, JobState, ReportDefinition, ValidationResult } from '@repnode/shared';
import { ApiError, post } from './api';
import { triggerDownload } from './util';
import { useToastStore } from '../stores/toast';

/** `force`: generar aunque la validación tenga errores (el usuario ya confirmó) */
export type JobBody =
  | { reportId: number; rangeOverride?: DateRange; force?: boolean }
  | { definition: ReportDefinition; rangeOverride?: DateRange; force?: boolean };

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** Lanza un job, sigue el progreso por SSE y descarga el archivo al terminar. */
export function useJobRunner() {
  const toast = useToastStore();
  const job = ref<JobState | null>(null);
  const open = ref(false);
  const starting = ref(false);
  /** Si el servidor rechaza por validación (por ejemplo, los datos cambiaron) */
  const rejectedValidation = shallowRef<ValidationResult | null>(null);
  let es: EventSource | null = null;

  function listen(id: string): void {
    es?.close();
    es = new EventSource(`/api/jobs/${id}/events`);
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data) as JobState;
      job.value = s;
      if (TERMINAL.has(s.status)) {
        es?.close();
        es = null;
        if (s.status === 'done') download();
      }
    };
  }

  async function start(body: JobBody): Promise<void> {
    starting.value = true;
    rejectedValidation.value = null;
    try {
      const s = await post<JobState>('/api/jobs', body);
      job.value = s;
      open.value = true;
      listen(s.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') rejectedValidation.value = err.details as ValidationResult;
      else toast.error(err);
    } finally {
      starting.value = false;
    }
  }

  function download(): void {
    if (job.value?.status === 'done') triggerDownload(`/api/jobs/${job.value.id}/download`);
  }

  async function cancel(): Promise<void> {
    if (job.value) await post(`/api/jobs/${job.value.id}/cancel`).catch((e) => toast.error(e));
  }

  function close(): void {
    open.value = false;
    if (job.value && TERMINAL.has(job.value.status)) {
      es?.close();
      es = null;
    }
  }

  onBeforeUnmount(() => es?.close());

  return { job, open, starting, rejectedValidation, start, cancel, close, download };
}
