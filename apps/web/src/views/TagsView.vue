<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { checkboxSelect, clickSelect, type ListSelection, type TagDTO } from '@repnode/shared';
import ColorPalette from '../components/ColorPalette.vue';
import FloatingMenu from '../components/FloatingMenu.vue';
import Icon from '../components/Icon.vue';
import MeterFilterBar from '../components/MeterFilterBar.vue';
import MeterLabel from '../components/MeterLabel.vue';
import TagChip from '../components/TagChip.vue';
import TagChooser, { type TagChoice } from '../components/TagChooser.vue';
import { useMeterFilters } from '../lib/useMeterFilters';
import { formatNumber, nextTagColor } from '../lib/util';
import { useCatalogStore } from '../stores/catalog';
import { useToastStore } from '../stores/toast';

const catalog = useCatalogStore();
const toast = useToastStore();
const loading = ref(true);

onMounted(async () => {
  try {
    await catalog.load();
    newColor.value = nextTagColor(catalog.tags);
  } catch (e) {
    toast.error(e);
  } finally {
    loading.value = false;
  }
});

// ---------------------------------------------------------------------------
// Crear / editar / eliminar tags
// ---------------------------------------------------------------------------
const newName = ref('');
const newColor = ref(nextTagColor([]));
const creating = ref(false);

async function create(assign: boolean) {
  const name = newName.value.trim();
  if (!name) return;
  creating.value = true;
  try {
    const ids = assign ? [...selected.value] : [];
    await catalog.createTag(name, newColor.value, ids);
    toast.success(ids.length ? `Tag «${name}» creado con ${formatNumber(ids.length)} medidores` : `Tag «${name}» creado`);
    newName.value = '';
    newColor.value = nextTagColor(catalog.tags);
  } catch (e) {
    toast.error(e);
  } finally {
    creating.value = false;
  }
}

const editing = ref<number | null>(null);
const editName = ref('');
const editColor = ref('');

function startEdit(t: TagDTO) {
  editing.value = t.id;
  editName.value = t.name;
  editColor.value = t.color;
}

async function saveEdit() {
  if (editing.value == null || !editName.value.trim()) return;
  try {
    await catalog.updateTag(editing.value, editName.value.trim(), editColor.value);
    editing.value = null;
  } catch (e) {
    toast.error(e);
  }
}

async function removeTag(t: TagDTO) {
  if (!confirm(`¿Eliminar el tag «${t.name}»? Los medidores no se borran, solo la agrupación.`)) return;
  try {
    await catalog.deleteTag(t.id);
    if (editing.value === t.id) editing.value = null;
  } catch (e) {
    toast.error(e);
  }
}

// Si otra ventana elimina el tag que se está editando, se cierra el editor
watch(
  () => catalog.tags,
  () => {
    if (editing.value != null && !catalog.tagById.has(editing.value)) editing.value = null;
  },
);

function filterByTag(id: number) {
  filters.state.tag = filters.state.tag === id ? '' : id;
}

// ---------------------------------------------------------------------------
// Lista de medidores: filtros y selección múltiple
// ---------------------------------------------------------------------------
const filters = useMeterFilters();
const filtered = filters.filtered;
const ids = computed(() => filtered.value.map((s) => s.id));

const selected = shallowRef(new Set<number>());
const anchor = ref<number | null>(null);

function apply(r: ListSelection) {
  selected.value = r.selected;
  anchor.value = r.anchor;
}

// Al filtrar, la selección se limita a lo visible: así las acciones nunca tocan medidores ocultos
watch(ids, (list) => {
  if (!selected.value.size) return;
  const visible = new Set(list);
  const kept = [...selected.value].filter((id) => visible.has(id));
  if (kept.length !== selected.value.size) selected.value = new Set(kept);
});

function onRowClick(index: number, e: MouseEvent) {
  apply(clickSelect(ids.value, { selected: selected.value, anchor: anchor.value }, index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
}

function onCheck(index: number, e: MouseEvent) {
  apply(checkboxSelect(ids.value, { selected: selected.value, anchor: anchor.value }, index, e.shiftKey));
}

function selectAllFiltered() {
  selected.value = new Set(ids.value);
}

function clearSelection() {
  selected.value = new Set();
  anchor.value = null;
}

function onListKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAllFiltered();
  } else if (e.key === 'Escape' && selected.value.size) clearSelection();
}

const allFilteredSelected = computed(() => !!ids.value.length && selected.value.size === ids.value.length);

const listEl = ref<HTMLElement | null>(null);
const virt = useVirtualizer(
  computed(() => ({
    count: filtered.value.length,
    getScrollElement: () => listEl.value,
    estimateSize: () => 52,
    overscan: 10,
    getItemKey: (i: number) => filtered.value[i]?.id ?? i,
  })),
);
// Las filas crecen si los chips de tags no caben en una línea
function measure(el: unknown) {
  if (el instanceof Element) virt.value.measureElement(el);
}

// ---------------------------------------------------------------------------
// Menús: "+" de una fila, botón de la selección y clic derecho
// ---------------------------------------------------------------------------
type Menu = { kind: 'row'; sourceId: number; x: number; y: number } | { kind: 'selection'; context: boolean; x: number; y: number };
const menu = ref<Menu | null>(null);
const busy = ref(false);

function openRowMenu(sourceId: number, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { kind: 'row', sourceId, x: r.right - 288, y: r.bottom + 4 };
}

function openSelectionMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { kind: 'selection', context: false, x: r.left, y: r.bottom + 4 };
}

function onContextMenu(index: number, e: MouseEvent) {
  const id = ids.value[index];
  // Como en el explorador: clic derecho fuera de la selección selecciona solo esa fila
  if (!selected.value.has(id)) apply({ selected: new Set([id]), anchor: id });
  menu.value = { kind: 'selection', context: true, x: e.clientX, y: e.clientY };
}

const targets = computed<number[]>(() => {
  const m = menu.value;
  if (!m) return [];
  return m.kind === 'row' ? [m.sourceId] : [...selected.value];
});

const choices = computed<TagChoice[]>(() => {
  const t = targets.value;
  return catalog.tags.map((tag) => {
    const members = new Set(tag.sourceIds);
    const count = t.reduce((n, id) => n + (members.has(id) ? 1 : 0), 0);
    return { tag, count, state: count === 0 ? 'none' : count === t.length ? 'all' : 'some' };
  });
});

const targetLabel = computed(() => {
  const t = targets.value;
  if (t.length === 1) return catalog.sourceById.get(t[0])?.name ?? '';
  return `${formatNumber(t.length)} medidores seleccionados`;
});

async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    toast.error(e);
  } finally {
    busy.value = false;
  }
}

/** Ninguno o algunos → se agrega a todos; todos → se quita a todos. */
function toggleTag(tag: TagDTO) {
  const t = targets.value;
  if (!t.length) return;
  const members = new Set(tag.sourceIds);
  const all = t.every((id) => members.has(id));
  return run(async () => {
    if (all) {
      await catalog.setTagMembers(tag.id, t, 'remove');
      if (t.length > 1) toast.success(`«${tag.name}» quitado de ${formatNumber(t.length)} medidores`);
    } else {
      const add = t.filter((id) => !members.has(id));
      await catalog.setTagMembers(tag.id, add, 'add');
      if (t.length > 1) toast.success(`«${tag.name}» agregado a ${formatNumber(add.length)} medidores`);
    }
  });
}

function createAndAssign(name: string) {
  const t = targets.value;
  return run(async () => {
    await catalog.createTag(name, nextTagColor(catalog.tags), t);
    toast.success(`Tag «${name}» creado${t.length > 1 ? ` con ${formatNumber(t.length)} medidores` : ''}`);
  });
}

function removeMember(sourceId: number, tag: TagDTO) {
  return run(() => catalog.setTagMembers(tag.id, [sourceId], 'remove'));
}

function clearTagsOfSelection() {
  const t = targets.value;
  const present = choices.value.filter((c) => c.state !== 'none');
  if (!present.length) return;
  if (!confirm(`¿Quitar ${present.length} tag(s) de ${formatNumber(t.length)} medidor(es)?`)) return;
  menu.value = null;
  return run(async () => {
    for (const c of present) await catalog.setTagMembers(c.tag.id, t, 'remove');
    toast.success('Tags quitados de la selección');
  });
}

async function copyNames() {
  const names = targets.value.map((id) => catalog.sourceById.get(id)?.name).filter(Boolean);
  menu.value = null;
  try {
    await navigator.clipboard.writeText(names.join('\r\n'));
    toast.success(`${formatNumber(names.length)} nombres copiados`);
  } catch {
    toast.error('No se pudo copiar al portapapeles');
  }
}

function menuAction(fn: () => void) {
  fn();
  menu.value = null;
}
</script>

<template>
  <div v-if="loading" class="flex items-center justify-center gap-2 py-24 text-slate-500"><Icon name="refresh" class="animate-spin" /> Cargando catálogo…</div>
  <div v-else class="space-y-5">
    <div>
      <h1 class="text-2xl font-semibold text-slate-900">Tags de medidores</h1>
      <p class="mt-1 text-sm text-slate-600">
        Agrupa medidores libremente (por área, tablero, cliente…). Los cambios se reflejan al instante en las demás ventanas de RepNode.
      </p>
    </div>

    <div class="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <!-- Panel lateral: crear y administrar tags -->
      <aside class="space-y-4 lg:sticky lg:top-20">
        <section class="card p-4">
          <h2 class="font-semibold">Nuevo tag</h2>
          <form class="mt-3 space-y-3" @submit.prevent="create(false)">
            <div class="flex items-center gap-2">
              <span class="size-4 shrink-0 rounded-full" :style="{ background: newColor }" />
              <input v-model="newName" class="input" placeholder="Nombre del tag (p. ej. Tablero norte)" maxlength="60" />
            </div>
            <ColorPalette v-model="newColor" />
            <div v-if="newName.trim()" class="flex">
              <TagChip :name="newName.trim()" :color="newColor" />
            </div>
            <div class="flex flex-wrap gap-2">
              <button class="btn btn-primary btn-sm" :disabled="!newName.trim() || creating"><Icon name="plus" /> Crear</button>
              <button v-if="selected.size" type="button" class="btn btn-sm" :disabled="!newName.trim() || creating" @click="create(true)">
                Crear y asignar a {{ formatNumber(selected.size) }}
              </button>
            </div>
          </form>
        </section>

        <section class="card">
          <header class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 class="font-semibold">Tags <span class="text-slate-400">({{ catalog.tags.length }})</span></h2>
            <span class="text-xs text-slate-400">Clic para filtrar</span>
          </header>
          <ul class="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto">
            <li v-if="!catalog.tags.length" class="p-4 text-center text-sm text-slate-500">Sin tags todavía</li>
            <li v-for="t in catalog.tags" :key="t.id">
              <div v-if="editing === t.id" class="space-y-3 bg-slate-50 p-3">
                <input v-model="editName" class="input py-1.5" maxlength="60" @keydown.enter.prevent="saveEdit" @keydown.esc="editing = null" />
                <ColorPalette v-model="editColor" />
                <div class="flex gap-2">
                  <button class="btn btn-primary btn-sm" :disabled="!editName.trim()" @click="saveEdit">Guardar</button>
                  <button class="btn btn-sm" @click="editing = null">Cancelar</button>
                </div>
              </div>
              <div
                v-else
                class="group flex cursor-pointer items-center gap-2 px-4 py-2"
                :class="filters.state.tag === t.id ? 'bg-brand-50' : 'hover:bg-slate-50'"
                @click="filterByTag(t.id)"
              >
                <span class="size-3 shrink-0 rounded-full" :style="{ background: t.color }" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ t.name }}</span>
                  <span class="block text-xs text-slate-500">
                    {{ formatNumber(t.sourceIds.length) }} medidores<span v-if="t.missing" class="text-amber-600"> · {{ t.missing }} ya no existen</span>
                  </span>
                </span>
                <button class="btn btn-ghost btn-sm opacity-0 group-hover:opacity-100" title="Editar" @click.stop="startEdit(t)"><Icon name="edit" /></button>
                <button class="btn btn-ghost btn-sm text-red-600 opacity-0 group-hover:opacity-100" title="Eliminar" @click.stop="removeTag(t)"><Icon name="trash" /></button>
              </div>
            </li>
          </ul>
        </section>
      </aside>

      <!-- Lista de medidores -->
      <section class="card flex min-w-0 flex-col">
        <header class="space-y-3 border-b border-slate-100 p-4">
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">Medidores</h2>
            <span class="text-xs text-slate-500">{{ formatNumber(filtered.length) }} de {{ formatNumber(catalog.sources.length) }}</span>
          </div>
          <MeterFilterBar :state="filters.state" :active="filters.active.value" @clear="filters.clear()" />
          <div class="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
            <input
              type="checkbox"
              class="checkbox ml-2"
              :checked="allFilteredSelected"
              :indeterminate="!!selected.size && !allFilteredSelected"
              :disabled="!filtered.length"
              title="Seleccionar todos los filtrados"
              @change="allFilteredSelected ? clearSelection() : selectAllFiltered()"
            />
            <span class="text-xs font-medium text-slate-600">
              {{ selected.size ? `${formatNumber(selected.size)} seleccionados` : 'Sin selección' }}
            </span>
            <button class="btn btn-sm" :disabled="!filtered.length || allFilteredSelected" @click="selectAllFiltered">
              <Icon name="check" :size="12" /> Seleccionar filtrados ({{ formatNumber(filtered.length) }})
            </button>
            <button class="btn btn-sm" :disabled="!selected.size" @click="clearSelection">Limpiar selección</button>
            <button class="btn btn-sm btn-primary ml-auto" :disabled="!selected.size" @click="openSelectionMenu">
              <Icon name="tag" :size="12" /> Tags de la selección <Icon name="down" :size="12" />
            </button>
          </div>
        </header>

        <div ref="listEl" class="h-[calc(100vh-22rem)] min-h-[420px] overflow-auto outline-none" tabindex="0" @keydown="onListKey">
          <p v-if="!filtered.length" class="p-6 text-center text-sm text-slate-500">Ningún medidor coincide con los filtros</p>
          <div :style="{ height: virt.getTotalSize() + 'px', position: 'relative' }">
            <div
              v-for="row in virt.getVirtualItems()"
              :key="String(row.key)"
              :ref="measure"
              :data-index="row.index"
              class="absolute inset-x-0 top-0 flex cursor-default items-center gap-3 border-b border-slate-100 px-4 py-2 select-none"
              :class="selected.has(filtered[row.index].id) ? 'bg-brand-50' : 'hover:bg-slate-50'"
              :style="{ transform: `translateY(${row.start}px)` }"
              @click="onRowClick(row.index, $event)"
              @contextmenu.prevent="onContextMenu(row.index, $event)"
            >
              <input type="checkbox" class="checkbox shrink-0" :checked="selected.has(filtered[row.index].id)" tabindex="-1" @click.stop="onCheck(row.index, $event)" />
              <MeterLabel :source="filtered[row.index]" class="w-56 shrink-0 xl:w-72" />
              <div class="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                <TagChip
                  v-for="t in catalog.tagsBySource.get(filtered[row.index].id) ?? []"
                  :key="t.id"
                  :name="t.name"
                  :color="t.color"
                  removable
                  @remove="removeMember(filtered[row.index].id, t)"
                />
              </div>
              <button
                class="btn btn-ghost btn-sm shrink-0 text-slate-500 hover:text-brand-700"
                title="Agregar tag"
                @click.stop="openRowMenu(filtered[row.index].id, $event)"
              >
                <Icon name="plus" />
              </button>
            </div>
          </div>
        </div>
        <footer class="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Clic selecciona · Ctrl + clic suma o quita · Shift + clic selecciona un rango · Ctrl + A todos los filtrados · Clic derecho para el menú de la selección
        </footer>
      </section>
    </div>

    <FloatingMenu v-if="menu" :key="`${menu.kind}-${menu.x}-${menu.y}`" :x="menu.x" :y="menu.y" @close="menu = null">
      <div class="truncate border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">{{ targetLabel }}</div>
      <TagChooser
        :items="choices"
        :total="targets.length"
        :busy="busy"
        :placeholder="menu.kind === 'row' ? 'Buscar o crear tag…' : 'Agregar o quitar tag… (o crear uno)'"
        @toggle="toggleTag"
        @create="createAndAssign"
      />
      <div v-if="menu.kind === 'selection'" class="border-t border-slate-100 py-1">
        <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-700 hover:bg-red-50 disabled:opacity-40" :disabled="!choices.some((c) => c.state !== 'none')" @click="clearTagsOfSelection">
          <Icon name="x" :size="14" /> Quitar todos sus tags
        </button>
        <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50" @click="copyNames"><Icon name="copy" :size="14" /> Copiar nombres</button>
        <template v-if="menu.context">
          <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50" @click="menuAction(selectAllFiltered)">
            <Icon name="check" :size="14" /> Seleccionar todos los filtrados <span class="ml-auto text-xs text-slate-400">Ctrl+A</span>
          </button>
          <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50" @click="menuAction(clearSelection)">
            <Icon name="x" :size="14" /> Limpiar selección <span class="ml-auto text-xs text-slate-400">Esc</span>
          </button>
        </template>
      </div>
    </FloatingMenu>
  </div>
</template>
