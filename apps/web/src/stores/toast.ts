import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);
  let seq = 0;

  function push(kind: Toast['kind'], message: string, ms = kind === 'error' ? 7000 : 3500): void {
    const id = ++seq;
    toasts.value.push({ id, kind, message });
    setTimeout(() => dismiss(id), ms);
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  return {
    toasts,
    dismiss,
    success: (m: string) => push('success', m),
    error: (m: string | unknown) => push('error', typeof m === 'string' ? m : (m as Error)?.message ?? String(m)),
    info: (m: string) => push('info', m),
  };
});
