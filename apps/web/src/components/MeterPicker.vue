<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { checkboxSelect, type MeterValidation } from '@repnode/shared';
import Icon from './Icon.vue';
import MeterFilterBar from './MeterFilterBar.vue';
import MeterLabel from './MeterLabel.vue';
import PasteListModal from './PasteListModal.vue';
import TagChip from './TagChip.vue';
import { useCatalogStore, type IndexedSource } from '../stores/catalog';
import { useToastStore } from '../stores/toast';
import { useMeterFilters } from '../lib/useMeterFilters';
import { formatNumber } from '../lib/util';
import { meterErrorCount, meterIssueTooltip } from '../lib/issues';

// Lista única de medidores del reporte: casillas = selección directa; los tags del reporte
// (dinámicos) suman sus miembros al generar. Los tags se administran en /tags.
const props = defineProps<{ issues: Map<number, MeterValidation>; timezone?: string }>();
const sourceIds = defineModel<number[]>('sourceIds', { required: true });
const tagIds = defineModel<number[]>('tagIds', { required: true });

const catalog = useCatalogStore();
const toast = useToastStore();
const router = useRouter();
const tagsHref = router.resolve({ name: 'tags' }).href;

const direct = computed(() => new Set(sourceIds.value));
const effective = computed(() => new Set(catalog.effectiveSourceIds(sourceIds.value, tagIds.value)));

/** Medidor → nombres de los tags del reporte que lo incluyen */
const viaTags = computed(() => {
  const m = new Map<number, string[]>();
  for (const tid of tagIds.value) {
    const t = catalog.tagById.get(tid);
    if (!t) continue;
    for (const sid of t.sourceIds) {
      let arr = m.get(sid);
      if (!arr) m.set(sid, (arr = []));
      arr.push(t.name);
    }
  }
  return m;
});

// ---------------------------------------------------------------------------
// Filtros y vista
// ---------------------------------------------------------------------------
type View = 'all' | 'selected' | 'issues';
const view = ref<View>('all');
const showPaste = ref(false);

const filters = useMeterFilters({ onlyWithData: true }, () => {
  if (view.value === 'selected') return (s: IndexedSource) => effective.value.has(s.id);
  if (view.value === 'issues') return (s: IndexedSource) => effective.value.has(s.id) && props.issues.has(s.id);
  return null;
});
const filtered = filters.filtered;
const ids = computed(() => filtered.value.map((s) => s.id));

const issueCounts = computed(() => {
  let errors = 0;
  let partial = 0;
  for (const sid of effective.value) {
    const i = props.issues.get(sid);
    if (i?.status === 'error') errors++;
    else if (i?.status === 'partial') partial++;
  }
  return { errors, partial };
});
watch(issueCounts, (c) => {
  if (view.value === 'issues' && !c.errors && !c.partial) view.value = 'all';
});

const filteredDirectCount = computed(() => filtered.value.reduce((n, s) => n + (direct.value.has(s.id) ? 1 : 0), 0));

// ---------------------------------------------------------------------------
// Selección directa (casillas; Shift + clic aplica a un rango)
// ---------------------------------------------------------------------------
const anchor = shallowRef<number | null>(null);

function toggle(index: number, e: MouseEvent) {
  const id = ids.value[index];
  if (!e.shiftKey && !direct.value.has(id) && viaTags.value.has(id)) {
    toast.info(`Incluido por el tag «${viaTags.value.get(id)!.join('», «')}». Quítalo de los tags del reporte para excluirlo.`);
    return;
  }
  const r = checkboxSelect(ids.value, { selected: direct.value, anchor: anchor.value }, index, e.shiftKey);
  anchor.value = r.anchor;
  sourceIds.value = [...r.selected];
}

function selectFiltered(select: boolean) {
  const set = new Set(sourceIds.value);
  for (const s of filtered.value) {
    if (select) set.add(s.id);
    else set.delete(s.id);
  }
  sourceIds.value = [...set];
}

function addIds(list: number[]) {
  const before = sourceIds.value.length;
  sourceIds.value = [...new Set([...sourceIds.value, ...list])];
  toast.success(`${sourceIds.value.length - before} medidores agregados`);
  showPaste.value = false;
}

function clearAll() {
  if (effective.value.size > 20 && !confirm(`¿Quitar los ${effective.value.size} medidores del reporte?`)) return;
  sourceIds.value = [];
  tagIds.value = [];
}

// ---------------------------------------------------------------------------
// Tags del reporte (dinámicos)
// ---------------------------------------------------------------------------
const addTag = ref<number | ''>('');
const unusedTags = computed(() => catalog.tags.filter((t) => !tagIds.value.includes(t.id)));

function addDynamic() {
  if (addTag.value === '') return;
  tagIds.value = [...new Set([...tagIds.value, addTag.value])];
  addTag.value = '';
}

function removeDynamic(id: number) {
  tagIds.value = tagIds.value.filter((t) => t !== id);
}

// ---------------------------------------------------------------------------
// Lista virtualizada
// ---------------------------------------------------------------------------
const listEl = ref<HTMLElement | null>(null);
const virt = useVirtualizer(
  computed(() => ({ count: filtered.value.length, getScrollElement: () => listEl.value, estimateSize: () => 48, overscan: 12 })),
);
watch(
  () => [filters.state.query, filters.state.group, filters.state.model, filters.state.tag, filters.state.onlyWithData, view.value],
  () => virt.value.scrollToOffset(0),
);

const MAX_ROW_TAGS = 3;
</script>

<template>
  <section class="card flex flex-col">
    <header class="space-y-3 border-b border-slate-100 p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-semibold">Medidores del reporte <span class="text-brand-700">({{ formatNumber(effective.size) }})</span></h3>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span v-if="issueCounts.errors" class="chip border-red-200 bg-red-50 text-red-700"><Icon name="error" :size="12" /> {{ issueCounts.errors }} sin datos</span>
          <span v-if="issueCounts.partial" class="chip border-amber-200 bg-amber-50 text-amber-700"><Icon name="alert" :size="12" /> {{ issueCounts.partial }} parciales</span>
          <button class="btn btn-ghost btn-sm text-red-600" :disabled="!effective.size" @click="clearAll"><Icon name="trash" /> Quitar todos</button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 p-2">
        <span class="text-xs font-medium text-slate-600" title="Todos los miembros actuales del tag entran al reporte; se resuelven al generar">Tags del reporte:</span>
        <span v-if="!tagIds.length" class="text-xs text-slate-400">ninguno</span>
        <TagChip
          v-for="tid in tagIds"
          :key="tid"
          :name="catalog.tagById.get(tid)?.name ?? 'Tag eliminado'"
          :color="catalog.tagById.get(tid)?.color ?? '#94a3b8'"
          :count="catalog.tagById.get(tid)?.sourceIds.length ?? 0"
          removable
          @remove="removeDynamic(tid)"
        />
        <div class="ml-auto flex items-center gap-2">
          <select v-if="unusedTags.length" v-model="addTag" class="input w-auto py-1 text-xs" @change="addDynamic">
            <option value="">+ Agregar tag al reporte</option>
            <option v-for="t in unusedTags" :key="t.id" :value="t.id">{{ t.name }} ({{ t.sourceIds.length }})</option>
          </select>
          <a :href="tagsHref" target="_blank" rel="noopener" class="btn btn-sm" title="Abre la configuración de tags en una pestaña nueva"><Icon name="tag" :size="12" /> Editar tags</a>
        </div>
      </div>

      <MeterFilterBar :state="filters.state" :active="filters.active.value" @clear="filters.clear()">
        <div class="flex overflow-hidden rounded-lg border border-slate-300 text-xs">
          <button class="px-2.5 py-1.5" :class="view === 'all' ? 'bg-slate-800 text-white' : 'bg-white hover:bg-slate-50'" @click="view = 'all'">Todos</button>
          <button class="border-l border-slate-300 px-2.5 py-1.5" :class="view === 'selected' ? 'bg-slate-800 text-white' : 'bg-white hover:bg-slate-50'" @click="view = 'selected'">
            Seleccionados ({{ formatNumber(effective.size) }})
          </button>
          <button
            class="border-l border-slate-300 px-2.5 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            :class="view === 'issues' ? 'bg-slate-800 text-white' : 'bg-white hover:bg-slate-50'"
            :disabled="!issueCounts.errors && !issueCounts.partial"
            @click="view = 'issues'"
          >
            Con problemas ({{ issueCounts.errors + issueCounts.partial }})
          </button>
        </div>
      </MeterFilterBar>

      <div class="flex flex-wrap items-center gap-2">
        <button class="btn btn-sm" :disabled="!filtered.length" @click="selectFiltered(true)"><Icon name="check" /> Seleccionar filtrados ({{ formatNumber(filtered.length) }})</button>
        <button class="btn btn-sm" :disabled="!filteredDirectCount" @click="selectFiltered(false)">Deseleccionar filtrados</button>
        <button class="btn btn-sm" @click="showPaste = true"><Icon name="clipboard" /> Pegar lista</button>
        <span class="ml-auto text-xs text-slate-500">{{ formatNumber(filtered.length) }} de {{ formatNumber(catalog.sources.length) }}</span>
      </div>
    </header>

    <div ref="listEl" class="h-[480px] overflow-auto">
      <div v-if="!filtered.length" class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500">
        <Icon name="layers" :size="28" class="text-slate-300" />
        {{ view === 'selected' && !effective.size ? 'Aún no hay medidores en el reporte: marca los de la lista, pega una lista o agrega un tag.' : 'Ningún medidor coincide con los filtros' }}
      </div>
      <div :style="{ height: virt.getTotalSize() + 'px', position: 'relative' }">
        <div
          v-for="row in virt.getVirtualItems()"
          :key="String(row.key)"
          class="absolute inset-x-0 top-0 flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 select-none"
          :class="{
            'bg-red-50/70': effective.has(filtered[row.index].id) && issues.get(filtered[row.index].id)?.status === 'error',
            'bg-amber-50/60': effective.has(filtered[row.index].id) && issues.get(filtered[row.index].id)?.status === 'partial',
            'bg-brand-50/60': effective.has(filtered[row.index].id) && !issues.has(filtered[row.index].id),
            'hover:bg-slate-50': !effective.has(filtered[row.index].id),
          }"
          :style="{ height: row.size + 'px', transform: `translateY(${row.start}px)` }"
          :title="effective.has(filtered[row.index].id) && issues.get(filtered[row.index].id) ? meterIssueTooltip(issues.get(filtered[row.index].id)!, catalog.quantityById, timezone) : ''"
          @click="toggle(row.index, $event)"
        >
          <input
            type="checkbox"
            class="checkbox pointer-events-none shrink-0"
            :class="!direct.has(filtered[row.index].id) && effective.has(filtered[row.index].id) && 'opacity-50'"
            :checked="effective.has(filtered[row.index].id)"
            tabindex="-1"
          />
          <template v-if="effective.has(filtered[row.index].id) && issues.get(filtered[row.index].id)">
            <Icon v-if="issues.get(filtered[row.index].id)!.status === 'error'" name="error" :size="18" class="text-red-600" />
            <Icon v-else name="alert" :size="18" class="text-amber-600" />
          </template>
          <MeterLabel :source="filtered[row.index]" class="flex-1">
            <template v-if="effective.has(filtered[row.index].id) && issues.get(filtered[row.index].id)?.status === 'error'">
              <span class="font-medium text-red-700">{{ meterErrorCount(issues.get(filtered[row.index].id)!) }} medición(es) sin datos</span>
            </template>
            <template v-else-if="effective.has(filtered[row.index].id) && issues.get(filtered[row.index].id)?.status === 'partial'">
              <span class="font-medium text-amber-700">datos parciales</span>
            </template>
            <template v-else-if="!direct.has(filtered[row.index].id) && viaTags.get(filtered[row.index].id)">
              <span class="text-slate-500">incluido por tag: {{ viaTags.get(filtered[row.index].id)!.join(', ') }}</span>
            </template>
            <template v-else-if="filtered[row.index].displayName !== filtered[row.index].name">{{ filtered[row.index].displayName }}</template>
          </MeterLabel>
          <div class="hidden max-w-[45%] shrink-0 items-center justify-end gap-1 overflow-hidden sm:flex">
            <TagChip
              v-for="t in (catalog.tagsBySource.get(filtered[row.index].id) ?? []).slice(0, MAX_ROW_TAGS)"
              :key="t.id"
              :name="t.name"
              :color="t.color"
              small
            />
            <span
              v-if="(catalog.tagsBySource.get(filtered[row.index].id)?.length ?? 0) > MAX_ROW_TAGS"
              class="text-[11px] text-slate-400"
              :title="catalog.tagsBySource.get(filtered[row.index].id)!.map((t) => t.name).join(', ')"
            >
              +{{ catalog.tagsBySource.get(filtered[row.index].id)!.length - MAX_ROW_TAGS }}
            </span>
          </div>
        </div>
      </div>
    </div>
    <footer class="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Consejo: Shift + clic marca o desmarca un rango completo.</footer>

    <PasteListModal v-if="showPaste" @close="showPaste = false" @add="addIds" />
  </section>
</template>
