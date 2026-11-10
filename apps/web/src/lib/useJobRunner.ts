import { onBeforeUnmount, ref, shallowRef } from 'vue';
import type { DateRange, JobState, ReportDefinition, ValidationResult } from '@repnode/shared';
import { ApiError, apiUrl, get, post } from './api';
import { triggerDownload } from './util';
import { useToastStore } from '../stores/toast';

/** `force`: generar aunque la validación tenga errores (el usuario ya confirmó) */
export type JobBody =
  | { reportId: number; rangeOverride?: DateRange; force?: boolean }
  | { definition: ReportDefinition; rangeOverride?: DateRange; force?: boolean };

const TERMINAL = new Set(['done', 'error', 'cancelled']);
/** Si en este tiempo no llega ni el primer evento SSE, se consulta el estado periódicamente. */
const SSE_GRACE_MS = 3000;
const POLL_MS = 2000;

/**
 * Lanza un job, sigue el progreso y descarga el archivo al terminar. El progreso llega por SSE; detrás de un proxy
 * que retiene la respuesta (medido: IIS + ARR de PME, aun con responseBufferLimit 0, deja /events en 0 bytes) no
 * llega ni el primer evento, y entonces se consulta GET /api/jobs/:id cada 2 s.
 */
export function useJobRunner() {
  const toast = useToastStore();
  const job = ref<JobState | null>(null);
  const open = ref(false);
  const starting = ref(false);
  /** Si el servidor rechaza por validación (por ejemplo, los datos cambiaron) */
  const rejectedValidation = shallowRef<ValidationResult | null>(null);
  let es: EventSource | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Job ya descargado automáticamente (SSE y la consulta pueden informar el final las dos). */
  let downloadedId: string | null = null;

  function stopFollowing(): void {
    es?.close();
    es = null;
    if (graceTimer) clearTimeout(graceTimer);
    if (pollTimer) clearInterval(pollTimer);
    graceTimer = pollTimer = null;
  }

  function apply(s: JobState): void {
    // Una respuesta atrasada de otro job no pisa el actual
    if (job.value && job.value.id !== s.id) return;
    job.value = s;
    if (!TERMINAL.has(s.status)) return;
    stopFollowing();
    if (s.status === 'done' && downloadedId !== s.id) {
      downloadedId = s.id;
      download();
    }
  }

  async function poll(id: string): Promise<void> {
    try {
      apply(await get<JobState>(`/api/jobs/${id}`));
    } catch {
      // Un fallo puntual no detiene el seguimiento: se reintenta en la próxima vuelta
    }
  }

  function listen(id: string): void {
    stopFollowing();
    es = new EventSource(apiUrl(`/api/jobs/${id}/events`));
    es.onmessage = (ev) => {
      // Llegan eventos: no hace falta consultar
      if (graceTimer) clearTimeout(graceTimer);
      if (pollTimer) clearInterval(pollTimer);
      graceTimer = pollTimer = null;
      apply(JSON.parse(ev.data) as JobState);
    };
    graceTimer = setTimeout(() => {
      graceTimer = null;
      void poll(id);
      pollTimer = setInterval(() => void poll(id), POLL_MS);
    }, SSE_GRACE_MS);
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
    if (job.value?.status === 'done') triggerDownload(apiUrl(`/api/jobs/${job.value.id}/download`));
  }

  async function cancel(): Promise<void> {
    if (!job.value) return;
    const id = job.value.id;
    await post(`/api/jobs/${id}/cancel`).catch((e) => toast.error(e));
    // Sin eventos SSE el modal se enteraría recién en la próxima consulta
    void poll(id);
  }

  function close(): void {
    open.value = false;
    if (job.value && TERMINAL.has(job.value.status)) stopFollowing();
  }

  onBeforeUnmount(stopFollowing);

  return { job, open, starting, rejectedValidation, start, cancel, close, download };
}
