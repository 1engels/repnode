import { defineStore } from 'pinia';
import { computed, shallowRef, ref } from 'vue';
import { TAG_PALETTE, type CatalogDTO, type PresetDTO, type QuantityDTO, type SourceDTO, type TagDTO } from '@repnode/shared';
import { del, get, post, put } from '../lib/api';
import { notifyTagsChanged, onTagsChanged } from '../lib/tagSync';
import { normalize } from '../lib/util';
import { useHierarchyStore } from './hierarchy';

export interface IndexedSource extends SourceDTO {
  search: string;
}

/** Selección de medidores de un reporte (los nodos son opcionales en reportes guardados antes de las jerarquías). */
export interface MeterSelection {
  sourceIds: number[];
  tagIds: number[];
  panelIds?: number[];
  spaceIds?: number[];
}

export const useCatalogStore = defineStore('catalog', () => {
  const catalog = shallowRef<CatalogDTO | null>(null);
  const tags = ref<TagDTO[]>([]);
  const tagColors = ref<string[]>([]);
  const presets = ref<PresetDTO[]>([]);
  /** Mediciones favoritas del usuario actual (se guardan en el servidor por usuario). */
  const favoriteQuantityIds = ref<Set<number>>(new Set());
  const loading = ref(false);

  // En la GUI los medidores se listan por GRUPO.MEDIDOR (Source.Name)
  const sources = computed<IndexedSource[]>(() =>
    (catalog.value?.sources ?? [])
      .map((s) => ({ ...s, search: normalize(`${s.displayName} ${s.name} ${s.group} ${s.type}`) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true })),
  );
  const sourceById = computed(() => new Map(sources.value.map((s) => [s.id, s])));
  const quantities = computed<QuantityDTO[]>(() => catalog.value?.quantities ?? []);
  const quantityById = computed(() => new Map(quantities.value.map((q) => [q.id, q])));
  const sourceQuantities = computed(() => {
    const m = new Map<number, Set<number>>();
    for (const [sid, qids] of Object.entries(catalog.value?.sourceQuantities ?? {})) m.set(Number(sid), new Set(qids));
    return m;
  });
  const groups = computed(() => {
    const counts = new Map<string, number>();
    for (const s of sources.value) counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  });
  const models = computed(() => {
    const counts = new Map<string, number>();
    for (const s of sources.value) if (s.type) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  });
  const tagById = computed(() => new Map(tags.value.map((t) => [t.id, t])));
  const tagsBySource = computed(() => {
    const m = new Map<number, TagDTO[]>();
    for (const t of tags.value) {
      for (const sid of t.sourceIds) {
        let arr = m.get(sid);
        if (!arr) m.set(sid, (arr = []));
        arr.push(t);
      }
    }
    return m;
  });

  async function load(force = false): Promise<void> {
    if (catalog.value && !force) return;
    loading.value = true;
    try {
      const [c, t, colors, p, fav] = await Promise.all([
        force ? post<CatalogDTO>('/api/catalog/refresh') : get<CatalogDTO>('/api/catalog'),
        get<TagDTO[]>('/api/tags'),
        get<string[]>('/api/tag-colors'),
        get<PresetDTO[]>('/api/presets'),
        get<number[]>('/api/favorite-quantities'),
      ]);
      // Con el catálogo nuevo cambian los IDs resueltos de las jerarquías
      await useHierarchyStore().load();
      catalog.value = c;
      setTags(t);
      tagColors.value = colors;
      presets.value = p;
      favoriteQuantityIds.value = new Set(fav);
    } finally {
      loading.value = false;
    }
  }

  function reset(): void {
    catalog.value = null;
    useHierarchyStore().reset();
    setTags([]);
    tagColors.value = [];
    presets.value = [];
    favoriteQuantityIds.value = new Set();
  }

  /** Medidores efectivos: selección directa + tags dinámicos + nodos dinámicos de las jerarquías, en orden del catálogo. */
  function effectiveSourceIds(sel: MeterSelection): number[] {
    const set = new Set(sel.sourceIds.filter((id) => sourceById.value.has(id)));
    for (const tid of sel.tagIds) tagById.value.get(tid)?.sourceIds.forEach((id) => set.add(id));
    const h = useHierarchyStore();
    if (sel.panelIds?.length) h.panelSources(sel.panelIds).forEach((id) => set.add(id));
    if (sel.spaceIds?.length) h.spaceSources(sel.spaceIds).forEach((id) => set.add(id));
    return sources.value.filter((s) => set.has(s.id)).map((s) => s.id);
  }

  // Tags. `tagsSeq` evita que una recarga lenta pise el resultado de un cambio posterior.
  let tagsSeq = 0;
  function setTags(list: TagDTO[]): void {
    tagsSeq++;
    tags.value = list;
  }

  async function reloadTags(): Promise<void> {
    if (!catalog.value) return;
    const seq = tagsSeq;
    const [t, colors] = await Promise.all([get<TagDTO[]>('/api/tags'), get<string[]>('/api/tag-colors')]);
    if (seq === tagsSeq) setTags(t);
    tagColors.value = colors;
  }
  onTagsChanged(() => void reloadTags().catch(() => {}));

  async function mutateTags(req: Promise<TagDTO[]>): Promise<TagDTO[]> {
    setTags(await req);
    notifyTagsChanged();
    return tags.value;
  }

  /** Crea el tag (opcionalmente con miembros) y lo devuelve. */
  async function createTag(name: string, color: string, sourceIds: number[] = []): Promise<TagDTO | undefined> {
    const list = await mutateTags(post<TagDTO[]>('/api/tags', { name, color, sourceIds }));
    if (!TAG_PALETTE.includes(color as never)) tagColors.value = await get<string[]>('/api/tag-colors');
    const key = name.trim().replace(/\s+/g, ' ');
    return list.find((t) => t.name === key);
  }
  async function updateTag(id: number, name: string, color: string): Promise<void> {
    await mutateTags(put<TagDTO[]>(`/api/tags/${id}`, { name, color }));
    if (!TAG_PALETTE.includes(color as never)) tagColors.value = await get<string[]>('/api/tag-colors');
  }
  const deleteTag = (id: number) => mutateTags(del<TagDTO[]>(`/api/tags/${id}`));
  const setTagMembers = (id: number, sourceIds: number[], action: 'add' | 'remove') =>
    mutateTags(post<TagDTO[]>(`/api/tags/${id}/members`, { sourceIds, action }));

  async function addTagColor(color: string): Promise<void> {
    tagColors.value = await post<string[]>('/api/tag-colors', { color });
    notifyTagsChanged();
  }
  async function deleteTagColor(color: string): Promise<void> {
    tagColors.value = await del<string[]>(`/api/tag-colors/${color.replace('#', '')}`);
    notifyTagsChanged();
  }

  // Presets
  const savePreset = async (name: string, quantityIds: number[]) => (presets.value = await post<PresetDTO[]>('/api/presets', { name, quantityIds }));
  /** Marca o desmarca una favorita; se refleja al instante y se revierte si falla. */
  async function toggleFavoriteQuantity(id: number): Promise<void> {
    const favorite = !favoriteQuantityIds.value.has(id);
    const next = new Set(favoriteQuantityIds.value);
    if (favorite) next.add(id);
    else next.delete(id);
    favoriteQuantityIds.value = next;
    try {
      favoriteQuantityIds.value = new Set(await post<number[]>('/api/favorite-quantities', { quantityId: id, favorite }));
    } catch (e) {
      const back = new Set(favoriteQuantityIds.value);
      if (favorite) back.delete(id);
      else back.add(id);
      favoriteQuantityIds.value = back;
      throw e;
    }
  }
  const deletePreset = async (id: number) => (presets.value = await del<PresetDTO[]>(`/api/presets/${id}`));

  return {
    catalog, tags, tagColors, presets, loading, sources, sourceById, quantities, quantityById, sourceQuantities, groups, models, tagById,
    tagsBySource, load, reset, effectiveSourceIds, reloadTags, createTag, updateTag, deleteTag, setTagMembers, addTagColor, deleteTagColor,
    savePreset, deletePreset, favoriteQuantityIds, toggleFavoriteQuantity,
  };
});
