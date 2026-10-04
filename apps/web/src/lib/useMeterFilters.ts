import { computed, reactive, watch } from 'vue';
import { useCatalogStore, type IndexedSource } from '../stores/catalog';
import { makeMatcher } from './util';

/** '' = todos, 'none' = sin tags, número = id del tag */
export type TagFilter = '' | 'none' | number;

export interface MeterFilterState {
  query: string;
  group: string;
  model: string;
  tag: TagFilter;
  onlyWithData: boolean;
}

/** Filtros comunes de la lista de medidores (búsqueda, grupo, modelo, tag, con datos). */
export function useMeterFilters(defaults: Partial<MeterFilterState> = {}, extra?: () => ((s: IndexedSource) => boolean) | null) {
  const catalog = useCatalogStore();
  const initial: MeterFilterState = { query: '', group: '', model: '', tag: '', onlyWithData: false, ...defaults };
  const state = reactive<MeterFilterState>({ ...initial });

  // Si otra ventana elimina el tag usado como filtro, se quita el filtro
  watch(
    () => catalog.tags,
    () => {
      if (typeof state.tag === 'number' && !catalog.tagById.has(state.tag)) state.tag = '';
    },
  );

  const filtered = computed<IndexedSource[]>(() => {
    const match = makeMatcher(state.query);
    const tag = state.tag;
    const tagSet = typeof tag === 'number' ? new Set(catalog.tagById.get(tag)?.sourceIds ?? []) : null;
    const bySource = catalog.tagsBySource;
    const sq = catalog.sourceQuantities;
    const more = extra?.() ?? null;
    return catalog.sources.filter(
      (s) =>
        (!state.group || s.group === state.group) &&
        (!state.model || s.type === state.model) &&
        (!tagSet || tagSet.has(s.id)) &&
        (tag !== 'none' || !bySource.has(s.id)) &&
        (!state.onlyWithData || sq.has(s.id)) &&
        match(s.search) &&
        (!more || more(s)),
    );
  });

  const active = computed(() => !!(state.query || state.group || state.model || state.tag !== '' || state.onlyWithData !== initial.onlyWithData));

  function clear(): void {
    Object.assign(state, initial);
  }

  return { state, filtered, active, clear };
}
