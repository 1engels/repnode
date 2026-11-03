<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { checkboxSelect, clickSelect, spacePath, type HierarchyKind, type ListSelection } from '@repnode/shared';
import Icon from '../Icon.vue';
import MeterFilterBar from '../MeterFilterBar.vue';
import { useMeterDrag } from '../../lib/use-meter-drag';
import { useMeterFilters } from '../../lib/useMeterFilters';
import { formatNumber } from '../../lib/util';
import { useCatalogStore, type IndexedSource } from '../../stores/catalog';
import { useHierarchyStore } from '../../stores/hierarchy';

// Lista de medidores del editor de jerarquías: filtros, selección múltiple (clic, Ctrl, Shift) y
// origen del arrastre hacia el diagrama. Muestra dónde está cada medidor en la jerarquía activa.
const props = defineProps<{ kind: HierarchyKind }>();
const selected = defineModel<Set<number>>('selected', { required: true });
const emit = defineEmits<{ focus: [sourceId: number]; locate: [sourceId: number]; unassign: [sourceIds: number[]] }>();

const catalog = useCatalogStore();
const h = useHierarchyStore();
const drag = useMeterDrag();

type Placement = 'all' | 'unassigned' | 'assigned';
const placement = ref<Placement>('all');
const placed = (id: number) => (props.kind === 'supply' ? h.supplyPlace.has(id) : h.spacePlace.has(id));

const filters = useMeterFilters({}, () => {
  if (placement.value === 'unassigned') return (s: IndexedSource) => !placed(s.id);
  if (placement.value === 'assigned') return (s: IndexedSource) => placed(s.id);
  return null;
});
const filtered = filters.filtered;
const ids = computed(() => filtered.value.map((s) => s.id));
const unassignedCount = computed(() => catalog.sources.reduce((n, s) => n + (placed(s.id) ? 0 : 1), 0));

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------
const anchor = shallowRef<number | null>(null);
function apply(r: ListSelection) {
  selected.value = r.selected;
  anchor.value = r.anchor;
}
// Al filtrar, la selección se limita a lo visible
watch(ids, (list) => {
  if (!selected.value.size) return;
  const visible = new Set(list);
  const kept = [...selected.value].filter((id) => visible.has(id));
  if (kept.length !== selected.value.size) selected.value = new Set(kept);
});

function onRowClick(index: number, e: MouseEvent) {
  apply(clickSelect(ids.value, { selected: selected.value, anchor: anchor.value }, index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
  emit('focus', ids.value[index]);
}
function onCheck(index: number, e: MouseEvent) {
  apply(checkboxSelect(ids.value, { selected: selected.value, anchor: anchor.value }, index, e.shiftKey));
}
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selected.value = new Set(ids.value);
  } else if (e.key === 'Escape') selected.value = new Set();
}
const allSelected = computed(() => !!ids.value.length && selected.value.size === ids.value.length);

// ---------------------------------------------------------------------------
// Arrastre: si la fila está seleccionada se arrastra toda la selección
// ---------------------------------------------------------------------------
function onDragStart(e: DragEvent, id: number) {
  // El v-model de la selección se actualiza en el siguiente render: se usa el conjunto local
  const sel = selected.value.has(id) ? selected.value : new Set([id]);
  if (sel !== selected.value) apply({ selected: sel, anchor: id });
  const list = ids.value.filter((x) => sel.has(x));
  drag.start(e, list, list.map((x) => catalog.sourceById.get(x)?.name ?? ''));
}

const overUnassign = ref(false);
function onUnassignDrop(e: DragEvent) {
  overUnassign.value = false;
  if (!drag.accepts(e)) return;
  e.preventDefault();
  emit('unassign', drag.read(e));
  drag.end();
}

// ---------------------------------------------------------------------------
// Ubicación de cada medidor en la jerarquía activa
// ---------------------------------------------------------------------------
function where(id: number): { text: string; title: string } | null {
  if (props.kind === 'supply') {
    const p = h.supplyPlace.get(id);
    if (!p) return null;
    const name = h.panelById.get(p.panelId)?.name ?? '';
    if (p.role === 'input') return { text: `${name} · E${(p.inputIndex ?? 0) + 1}`, title: `Entrada ${(p.inputIndex ?? 0) + 1} de ${name}` };
    if (p.role === 'totalizer') return { text: `${name} · totalizador`, title: `Totalizador de ${name}` };
    if (!p.feeds) return { text: `${name} · salida`, title: `Salida de ${name}` };
    const to = p.feeds.map((f) => h.panelById.get(f.panelId)?.name ?? '¿?').join(', ');
    const deriv = p.feeds.length > 1 ? ' (derivación)' : '';
    return { text: `${name} · salida → ${to}`, title: `Salida de ${name} que alimenta a ${h.feedsText(p.feeds)}${deriv}` };
  }
  const sid = h.spacePlace.get(id);
  if (sid == null) return null;
  const path = spacePath(h.spaces, sid).map((x) => h.spaceById.get(x)!.name);
  return { text: path.slice(-2).join(' › '), title: path.join(' › ') };
}

const listEl = ref<HTMLElement | null>(null);
const virt = useVirtualizer(
  computed(() => ({ count: filtered.value.length, getScrollElement: () => listEl.value, estimateSize: () => 64, overscan: 10, getItemKey: (i: number) => filtered.value[i]?.id ?? i })),
);
watch(() => [filters.state.query, filters.state.group, filters.state.model, filters.state.tag, placement.value], () => virt.value.scrollToOffset(0));
</script>

<template>
  <section class="card flex min-h-0 flex-col">
    <header class="space-y-2 border-b border-slate-100 p-3">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">Medidores</h2>
        <span class="text-xs text-slate-500">{{ formatNumber(filtered.length) }} de {{ formatNumber(catalog.sources.length) }}</span>
      </div>
      <MeterFilterBar :state="filters.state" :active="filters.active.value || placement !== 'all'" @clear="filters.clear(); placement = 'all'">
        <select v-model="placement" class="input w-auto py-1.5" :class="placement !== 'all' && 'border-brand-500'">
          <option value="all">Todos</option>
          <option value="unassigned">Sin ubicar ({{ formatNumber(unassignedCount) }})</option>
          <option value="assigned">Ubicados</option>
        </select>
      </MeterFilterBar>
      <div class="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs">
        <input
          type="checkbox"
          class="checkbox"
          :checked="allSelected"
          :indeterminate="!!selected.size && !allSelected"
          :disabled="!filtered.length"
          title="Seleccionar todos los filtrados"
          @change="selected = allSelected ? new Set() : new Set(ids)"
        />
        <span class="font-medium text-slate-600">{{ selected.size ? `${formatNumber(selected.size)} seleccionados` : 'Sin selección' }}</span>
        <span class="ml-auto text-slate-400">Arrastra al diagrama</span>
      </div>
    </header>

    <div
      v-if="drag.dragging.value"
      class="m-2 rounded-lg border-2 border-dashed px-3 py-2 text-center text-xs"
      :class="overUnassign ? 'border-red-400 bg-red-50 text-red-700' : 'border-slate-300 text-slate-500'"
      @dragover.prevent="overUnassign = true"
      @dragleave="overUnassign = false"
      @drop="onUnassignDrop"
    >
      <Icon name="x" :size="12" class="inline" /> Soltar aquí para sacar de {{ kind === 'supply' ? 'Suministro' : 'Comercial' }}
    </div>

    <div ref="listEl" class="min-h-0 flex-1 overflow-auto outline-none" tabindex="0" @keydown="onKey">
      <p v-if="!filtered.length" class="p-6 text-center text-sm text-slate-500">Ningún medidor coincide con los filtros</p>
      <div :style="{ height: virt.getTotalSize() + 'px', position: 'relative' }">
        <div
          v-for="row in virt.getVirtualItems()"
          :key="String(row.key)"
          class="absolute inset-x-0 top-0 flex cursor-grab items-center gap-2 border-b border-slate-100 px-3 select-none"
          :class="selected.has(filtered[row.index].id) ? 'bg-brand-50' : 'hover:bg-slate-50'"
          :style="{ height: row.size + 'px', transform: `translateY(${row.start}px)` }"
          draggable="true"
          @dragstart="onDragStart($event, filtered[row.index].id)"
          @dragend="drag.end()"
          @click="onRowClick(row.index, $event)"
          @dblclick="emit('locate', filtered[row.index].id)"
        >
          <input type="checkbox" class="checkbox shrink-0" :checked="selected.has(filtered[row.index].id)" tabindex="-1" @click.stop="onCheck(row.index, $event)" />
          <div class="min-w-0 flex-1 leading-tight">
            <div class="truncate text-sm font-medium text-slate-800" :title="filtered[row.index].name">{{ filtered[row.index].name }}</div>
            <div class="truncate text-[11px] text-slate-400">{{ filtered[row.index].type || 'Sin modelo' }}</div>
            <div v-if="where(filtered[row.index].id)" class="truncate text-xs text-sky-700" :title="where(filtered[row.index].id)!.title">
              <Icon :name="kind === 'supply' ? 'panel' : 'building'" :size="10" class="inline" /> {{ where(filtered[row.index].id)!.text }}
            </div>
            <div v-else class="truncate text-xs text-slate-400">{{ kind === 'supply' ? 'sin tablero' : 'sin espacio' }}</div>
          </div>
          <Icon name="grip" :size="14" class="shrink-0 text-slate-300" />
        </div>
      </div>
    </div>
    <footer class="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">Clic · Ctrl/Shift + clic · Ctrl + A · doble clic = ir a su nodo</footer>
  </section>
</template>
