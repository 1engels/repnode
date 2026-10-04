import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ReportDTO, ReportDefinition } from '@repnode/shared';
import { del, get, post, put } from '../lib/api';

export const useReportsStore = defineStore('reports', () => {
  const reports = ref<ReportDTO[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    reports.value = await get<ReportDTO[]>('/api/reports');
    loaded.value = true;
  }

  async function save(def: ReportDefinition, id?: number | null): Promise<ReportDTO> {
    const r = id ? await put<ReportDTO>(`/api/reports/${id}`, def) : await post<ReportDTO>('/api/reports', def);
    reports.value = [...reports.value.filter((x) => x.id !== r.id), r].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return r;
  }

  async function remove(id: number): Promise<void> {
    await del(`/api/reports/${id}`);
    reports.value = reports.value.filter((r) => r.id !== id);
  }

  function reset(): void {
    reports.value = [];
    loaded.value = false;
  }

  return { reports, loaded, load, save, remove, reset };
});
