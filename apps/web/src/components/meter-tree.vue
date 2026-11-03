<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import {
  flattenSpaceTree, flattenSupplyTree, primaryParent, spaceDescendants, spacePath, supplyDownstream, treeKey,
  type HierarchyKind, type MeterValidation, type TreeRow,
} from '@repnode/shared';
import Icon from './Icon.vue';
import MeterLabel from './MeterLabel.vue';
import TagChip from './TagChip.vue';
import { useCatalogStore } from '../stores/catalog';
import { useHierarchyStore } from '../stores/hierarchy';
import { useToastStore } from '../stores/toast';
import { meterErrorCount, meterIssueTooltip } from '../lib/issues';

// Vista de árbol del selector de medidores (Suministro o Comercial). Marcar un nodo lo agrega al
// reporte como nodo dinámico; marcar un medidor es selección directa (lo resuelve el padre).
// Un medidor puede aparecer en varias filas (salida de un tablero y entrada de otros): solo se marca la fila elegida;
// las casillas de los nodos no reflejan los medidores de abajo, para no simular una ruta seleccionada.
const props = defineProps<{
  kind: HierarchyKind;
  /** Medidores que pasan los filtros */
  visibleIds: readonly number[];
  /** Hay filtros activos: se ocultan los nodos sin coincidencias y se expande todo */
  filtering: boolean;
  effective: ReadonlySet<number>;
  direct: ReadonlySet<number>;
  issues: Map<number, MeterValidation>;
  timezone?: string;
}>();
const panelIds = defineModel<number[]>('panelIds', { required: true });
const spaceIds = defineModel<number[]>('spaceIds', { required: true });
const emit = defineEmits<{ toggleMeter: [sourceId: number] }>();

const catalog = useCatalogStore();
const h = useHierarchyStore();
const toast = useToastStore();

// Al inicio, solo las raíces expandidas
const expanded = ref(new Set<string>());
let initialized = false;
watch(
  () => h.loaded,
  (loaded) => {
    if (!loaded || initialized) return;
    initialized = true;
    expanded.value = new Set([
      ...h.panels.filter((p) => primaryParent(p) == null).map((p) => treeKey.panel(p.id)),
      ...h.spaces.filter((s) => s.parentId == null).map((s) => treeKey.space(s.id)),
    ]);
  },
  { immediate: true },
);

// Con filtros se expande todo cada vez que cambian los resultados, pero se puede contraer; al quitarlos vuelve lo
// que estaba expandido antes
let beforeFilter: Set<string> | null = null;
const allNodeKeys = () => [...h.panels.map((p) => treeKey.panel(p.id)), ...h.spaces.map((s) => treeKey.space(s.id)), treeKey.unassigned];
watch(
  () => [props.filtering, props.visibleIds, h.loaded] as const,
  ([filtering]) => {
    if (filtering && h.loaded) {
      beforeFilter ??= expanded.value;
      expanded.value = new Set(allNodeKeys());
    } else if (beforeFilter) {
      expanded.value = beforeFilter;
      beforeFilter = null;
    }
  },
  { immediate: true },
);

const visibleSet = computed(() => new Set(props.visibleIds));
const rows = computed<TreeRow[]>(() => {
  const opts = {
    sourceIds: catalog.sources.map((s) => s.id),
    expanded: expanded.value,
    match: (id: number) => visibleSet.value.has(id),
    prune: props.filtering,
  };
  return props.kind === 'supply' ? flattenSupplyTree(h.panels, opts) : flattenSpaceTree(h.spaces, opts);
});

function toggleExpand(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

// ---------------------------------------------------------------------------
// Nodos dinámicos: marcados directamente o cubiertos por un ancestro marcado
// ---------------------------------------------------------------------------
const coveredPanels = computed(() => supplyDownstream(h.panels, panelIds.value));
const coveredSpaces = computed(() => spaceDescendants(h.spaces, spaceIds.value));

type NodeState = 'selected' | 'covered' | 'none';
function nodeState(kind: 'panel' | 'space', id: number): NodeState {
  if ((kind === 'panel' ? panelIds.value : spaceIds.value).includes(id)) return 'selected';
  return (kind === 'panel' ? coveredPanels : coveredSpaces).value.has(id) ? 'covered' : 'none';
}

// Estado de las casillas de los nodos visibles
const nodeStates = computed(() => {
  const m = new Map<string, NodeState>();
  for (const r of rows.value) if (r.kind === 'panel' || r.kind === 'space') m.set(r.key, nodeState(r.kind, r.id));
  return m;
});

function toggleNode(kind: 'panel' | 'space', id: number) {
  const model = kind === 'panel' ? panelIds : spaceIds;
  const state = nodeState(kind, id);
  if (state === 'covered') {
    const by = kind === 'panel'
      ? h.panels.filter((p) => panelIds.value.includes(p.id) && supplyDownstream(h.panels, [p.id]).has(id)).map((p) => p.name)
      : spacePath(h.spaces, id).filter((x) => spaceIds.value.includes(x)).map((x) => h.spaceById.get(x)!.name);
    toast.info(`Incluido por «${by.join('», «')}». Quítalo de los nodos del reporte para excluirlo.`);
    return;
  }
  model.value = state === 'selected' ? model.value.filter((x) => x !== id) : [...model.value, id];
}

// ---------------------------------------------------------------------------
// Medidores en varias filas: cuál fila muestra la selección
// ---------------------------------------------------------------------------
type MeterRow = Extract<TreeRow, { kind: 'meter' }>;
/** Fila en la que el usuario marcó cada medidor (si no, la de su lugar físico: `m:<id>`) */
const pickedRow = ref(new Map<number, string>());
/** Medidores que aportan los nodos dinámicos del reporte */
const nodeMeters = computed(() => new Set(props.kind === 'supply' ? h.panelSources(panelIds.value) : h.spaceSources(spaceIds.value)));

/**
 * selected = marcado en esta fila; covered = lo incluye un nodo (y la fila está dentro de ese nodo) o un tag (en la
 * fila de su lugar físico); elsewhere = está en el reporte por otra fila; none = no está.
 */
type MeterState = 'selected' | 'covered' | 'elsewhere' | 'none';
function meterState(r: MeterRow): MeterState {
  const id = r.sourceId;
  if (!props.effective.has(id)) return 'none';
  if (props.direct.has(id)) return r.key === (pickedRow.value.get(id) ?? `m:${id}`) ? 'selected' : 'elsewhere';
  if (nodeMeters.value.has(id)) {
    const covered = props.kind === 'supply' ? coveredPanels.value : coveredSpaces.value;
    return r.nodeId != null && covered.has(r.nodeId) ? 'covered' : 'elsewhere';
  }
  return r.key === `m:${id}` ? 'covered' : 'elsewhere';
}
const marked = (r: MeterRow) => {
  const st = meterState(r);
  return st === 'selected' || st === 'covered';
};

function onMeterClick(r: MeterRow) {
  const id = r.sourceId;
  const state = meterState(r);
  const next = new Map(pickedRow.value);
  // Ya marcado en otra fila: la marca pasa a esta (sigue en el reporte)
  if (state === 'elsewhere' && props.direct.has(id)) {
    next.set(id, r.key);
    pickedRow.value = next;
    return;
  }
  if (state === 'none') next.set(id, r.key);
  else next.delete(id);
  pickedRow.value = next;
  emit('toggleMeter', id);
}

function meterRowClass(r: MeterRow, issue: MeterValidation | undefined) {
  const state = meterState(r);
  if (state === 'selected' || state === 'covered') {
    if (issue?.status === 'error') return 'bg-red-50/70';
    if (issue?.status === 'partial') return 'bg-amber-50/60';
    return state === 'selected' ? 'bg-brand-50/60' : 'bg-brand-50/30';
  }
  return 'hover:bg-slate-50';
}

function meterTitle(r: MeterRow): string {
  const state = meterState(r);
  if (state === 'elsewhere') {
    return props.direct.has(r.sourceId) ? 'Ya está en el reporte por otra fila. Clic para marcarlo aquí.' : 'Está en el reporte por un tag o por otro nodo.';
  }
  const issue = props.issues.get(r.sourceId);
  return state !== 'none' && issue ? meterIssueTooltip(issue, catalog.quantityById, props.timezone) : '';
}

// ---------------------------------------------------------------------------
// Vínculos: llevan a la instancia real del tablero (bajo su entrada primaria)
// ---------------------------------------------------------------------------
const flash = ref<string | null>(null);

async function goToPanel(id: number) {
  const next = new Set(expanded.value);
  const seen = new Set<number>();
  for (let p = h.panelById.get(id); p; ) {
    const parent = primaryParent(p);
    if (parent == null || seen.has(parent)) break;
    seen.add(parent);
    next.add(treeKey.panel(parent));
    p = h.panelById.get(parent);
  }
  expanded.value = next;
  await nextTick();
  const index = rows.value.findIndex((r) => r.key === treeKey.panel(id));
  if (index < 0) return;
  virt.value.scrollToIndex(index, { align: 'center' });
  flash.value = treeKey.panel(id);
  setTimeout(() => (flash.value = null), 1500);
}

function roleLabel(r: TreeRow): string {
  if (r.kind !== 'meter') return '';
  if (r.role === 'input' && r.nodeId != null) {
    const inp = h.panelById.get(r.nodeId)?.inputs[r.inputIndex ?? 0];
    const from = inp?.fromPanelId != null ? h.panelById.get(inp.fromPanelId)?.name : inp?.origin;
    return `Entrada ${(r.inputIndex ?? 0) + 1}${inp?.label ? ` · ${inp.label}` : ''}${from ? ` · desde ${from}` : ''}`;
  }
  if (r.role === 'totalizer') return 'Totalizador';
  if (r.role === 'load') {
    const feeds = h.supplyPlace.get(r.sourceId)?.feeds;
    return feeds ? `Salida → ${h.feedsText(feeds, 3)}` : 'Salida';
  }
  return '';
}

const nodeName = (r: TreeRow) =>
  r.kind === 'panel' || r.kind === 'link' ? h.panelById.get(r.id)?.name : r.kind === 'space' ? h.spaceById.get(r.id)?.name : '';

// ---------------------------------------------------------------------------
// Lista virtualizada
// ---------------------------------------------------------------------------
const listEl = ref<HTMLElement | null>(null);
const virt = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => listEl.value,
    estimateSize: (i: number) => (rows.value[i]?.kind === 'meter' ? 48 : 40),
    getItemKey: (i: number) => rows.value[i]?.key ?? i,
    overscan: 12,
  })),
);
watch(() => props.kind, () => virt.value.scrollToOffset(0));

const MAX_ROW_TAGS = 3;
const indent = (depth: number) => ({ paddingLeft: `${12 + depth * 20}px` });
const isEmpty = computed(() => (props.kind === 'supply' ? !h.panels.length : !h.spaces.length));
</script>

<template>
  <div ref="listEl" class="h-[480px] overflow-auto">
    <div v-if="isEmpty" class="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">
      Aún no hay {{ kind === 'supply' ? 'tableros' : 'espacios' }}. Créalos en <b>Jerarquías</b>; mientras tanto todos los medidores aparecen en «Sin ubicar».
    </div>
    <div v-if="!rows.length" class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500">
      <Icon name="tree" :size="28" class="text-slate-300" />
      Ningún medidor coincide con los filtros
    </div>
    <div :style="{ height: virt.getTotalSize() + 'px', position: 'relative' }">
      <template v-for="item in virt.getVirtualItems()" :key="String(item.key)">
        <div
          v-for="r in rows[item.index] ? [rows[item.index]] : []"
          :key="r.key"
          class="absolute inset-x-0 top-0 flex items-center gap-2 border-b border-slate-100 pr-4 select-none"
          :style="{ height: item.size + 'px', transform: `translateY(${item.start}px)`, ...indent(r.depth) }"
          :class="[r.kind !== 'meter' && 'bg-slate-50/70', flash === r.key && '!bg-brand-100 transition-colors']"
        >
          <!-- Tablero o espacio -->
          <template v-if="r.kind === 'panel' || r.kind === 'space'">
            <button
              type="button"
              class="grid size-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-slate-200"
              :class="!r.hasChildren && 'invisible'"
              :title="r.expanded ? 'Contraer' : 'Expandir'"
              @click="toggleExpand(r.key)"
            >
              <Icon :name="r.expanded ? 'down' : 'right'" :size="14" />
            </button>
            <div class="flex min-w-0 flex-1 cursor-pointer items-center gap-2" @click="toggleNode(r.kind, r.id)">
              <input
                type="checkbox"
                class="checkbox pointer-events-none shrink-0"
                :class="nodeStates.get(r.key) === 'covered' && 'opacity-50'"
                :checked="nodeStates.get(r.key) === 'selected' || nodeStates.get(r.key) === 'covered'"
                tabindex="-1"
              />
              <Icon :name="r.kind === 'panel' ? 'panel' : 'building'" :size="15" class="text-slate-500" />
              <span class="truncate text-sm font-semibold text-slate-800">{{ nodeName(r) }}</span>
              <span v-if="r.kind === 'panel' && h.panelById.get(r.id)?.mode === 'ats'" class="chip border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-700" title="Conmutación / respaldo (ATS)">ATS</span>
              <span v-if="r.kind === 'space' && h.spaceById.get(r.id)?.type" class="shrink-0 text-xs text-slate-400">{{ h.spaceById.get(r.id)?.type }}</span>
              <span class="shrink-0 text-xs text-slate-400">({{ r.count }})</span>
              <span v-if="nodeStates.get(r.key) === 'selected'" class="shrink-0 text-[11px] text-brand-700">nodo del reporte</span>
            </div>
          </template>

          <!-- Vínculo a un tablero alimentado también desde aquí -->
          <template v-else-if="r.kind === 'link'">
            <span class="size-5 shrink-0" />
            <button
              type="button"
              class="flex min-w-0 items-center gap-2 text-sm text-slate-600 hover:text-brand-700"
              title="Este tablero también se alimenta desde aquí. Clic para ir a la instancia real."
              @click="goToPanel(r.id)"
            >
              <Icon name="link" :size="14" />
              <span class="truncate italic">{{ nodeName(r) }}</span>
              <span class="shrink-0 text-xs text-slate-400">({{ r.count }}) · también alimentado desde aquí</span>
            </button>
          </template>

          <!-- Grupo "Sin ubicar" -->
          <template v-else-if="r.kind === 'unassigned'">
            <button type="button" class="flex items-center gap-2 text-sm font-medium text-slate-600" @click="toggleExpand(r.key)">
              <span class="grid size-5 place-items-center rounded text-slate-500 hover:bg-slate-200"><Icon :name="r.expanded ? 'down' : 'right'" :size="14" /></span>
              <Icon name="layers" :size="15" class="text-slate-400" /> Sin ubicar
              <span class="text-xs font-normal text-slate-400">({{ r.count }})</span>
            </button>
          </template>

          <!-- Medidor -->
          <template v-else>
            <div
              v-for="src in catalog.sourceById.has(r.sourceId) ? [catalog.sourceById.get(r.sourceId)!] : []"
              :key="src.id"
              class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 pl-5"
              :class="meterRowClass(r, issues.get(src.id))"
              :title="meterTitle(r)"
              @click="onMeterClick(r)"
            >
              <input
                type="checkbox"
                class="checkbox pointer-events-none shrink-0"
                :class="meterState(r) === 'covered' && 'opacity-50'"
                :checked="marked(r)"
                tabindex="-1"
              />
              <template v-if="marked(r) && issues.get(src.id)">
                <Icon v-if="issues.get(src.id)!.status === 'error'" name="error" :size="18" class="text-red-600" />
                <Icon v-else name="alert" :size="18" class="text-amber-600" />
              </template>
              <MeterLabel :source="src" class="flex-1">
                <template v-if="marked(r) && issues.get(src.id)?.status === 'error'">
                  <span class="font-medium text-red-700">{{ meterErrorCount(issues.get(src.id)!) }} medición(es) sin datos</span>
                </template>
                <template v-else-if="roleLabel(r)">
                  <span :class="r.role === 'input' ? 'text-sky-700' : 'text-slate-500'">{{ roleLabel(r) }}</span>
                  <span v-if="meterState(r) === 'elsewhere'" class="text-slate-400"> · en el reporte por otra fila</span>
                </template>
                <template v-else-if="meterState(r) === 'elsewhere'"><span class="text-slate-400">En el reporte por otra fila</span></template>
                <template v-else-if="src.displayName !== src.name">{{ src.displayName }}</template>
              </MeterLabel>
              <div class="hidden max-w-[40%] shrink-0 items-center justify-end gap-1 overflow-hidden sm:flex">
                <TagChip v-for="t in (catalog.tagsBySource.get(src.id) ?? []).slice(0, MAX_ROW_TAGS)" :key="t.id" :name="t.name" :color="t.color" small />
                <span v-if="(catalog.tagsBySource.get(src.id)?.length ?? 0) > MAX_ROW_TAGS" class="text-[11px] text-slate-400">
                  +{{ catalog.tagsBySource.get(src.id)!.length - MAX_ROW_TAGS }}
                </span>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
