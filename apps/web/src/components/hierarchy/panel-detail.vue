<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import {
  MAX_PANEL_INPUTS, PANEL_ICON_LABELS, PANEL_ICONS, PANEL_MODE_LABELS, TAG_PALETTE, panelOutputs, supplyDownstream,
  type DesignIssue, type PanelIcon, type PanelMode, type PanelSave, type SupplySlot,
} from '@repnode/shared';
import Icon from '../Icon.vue';
import MeterLabel from '../MeterLabel.vue';
import MeterPickerModal from '../meter-picker-modal.vue';
import { hierarchyEditorKey } from '../../lib/hierarchy-editor';
import { PANEL_ICON_COMPONENTS } from '../../lib/panel-icons';
import { formatNumber } from '../../lib/util';
import { useCatalogStore } from '../../stores/catalog';
import { panelToSave, placeMeter, useHierarchyStore } from '../../stores/hierarchy';
import { useToastStore } from '../../stores/toast';

// Configuración de un tablero. Nombre y descripción se guardan con su botón; ícono, color, totalizador, modo, entradas y
// salidas se guardan solos ante cada cambio (los textos de una entrada, al salir del campo).
const props = defineProps<{ panelId: number; issues: DesignIssue[] }>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();

const catalog = useCatalogStore();
const h = useHierarchyStore();
const toast = useToastStore();
const editor = inject(hierarchyEditorKey)!;

const panel = computed(() => h.panelById.get(props.panelId));

// ---------------------------------------------------------------------------
// Nombre y descripción (guardado manual)
// ---------------------------------------------------------------------------
const info = ref({ name: '', description: '' });
const infoDirty = computed(() => !!panel.value && (info.value.name !== panel.value.name || info.value.description !== (panel.value.description ?? '')));
watch(
  () => [props.panelId, panel.value?.name, panel.value?.description] as const,
  ([id], old) => {
    if (!panel.value || (infoDirty.value && old?.[0] === id)) return;
    info.value = { name: panel.value.name, description: panel.value.description ?? '' };
  },
  { immediate: true },
);

async function saveInfo() {
  const p = panel.value;
  if (!p || !info.value.name.trim()) return;
  await save((b) => {
    b.name = info.value.name.trim();
    b.description = info.value.description.trim() || null;
  }, 'Nombre y descripción guardados');
}

// ---------------------------------------------------------------------------
// Guardado automático: cada cambio parte de lo guardado y modifica solo lo suyo
// ---------------------------------------------------------------------------
const saving = ref(false);
const saved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

async function save(change: (body: PanelSave) => void, ok?: string): Promise<boolean> {
  const p = panel.value;
  if (!p) return false;
  const body = panelToSave(p);
  change(body);
  saving.value = true;
  try {
    await h.updatePanel(p.id, body);
    if (ok) toast.success(ok);
    saved.value = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.value = false), 1500);
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  } finally {
    saving.value = false;
  }
}

const setMode = (mode: PanelMode) => void save((b) => (b.mode = mode));
const setIcon = (icon: PanelIcon) => void save((b) => (b.icon = icon));
const setColor = (color: string | null) => void save((b) => (b.color = color));
/** Paleta base + colores personalizados del perfil (los mismos de los tags) */
const swatches = computed(() => {
    const all = [...new Set([...TAG_PALETTE, ...catalog.tagColors])];
    const current = panel.value?.color;
    const first = all.slice(0, 6);
    if (current && !first.includes(current)) first[5] = current;
    return first;
});
const addExternal = () => void save((b) => b.inputs.push({ fromPanelId: null, origin: null, label: null, sourceId: null }));
const removeInput = (i: number) => void save((b) => b.inputs.splice(i, 1));
const moveInput = (i: number, delta: number) =>
  void save((b) => {
    const [x] = b.inputs.splice(i, 1);
    b.inputs.splice(i + delta, 0, x);
  });

function setText(i: number, field: 'origin' | 'label', e: Event) {
  const value = (e.target as HTMLInputElement).value.trim() || null;
  if ((panel.value?.inputs[i]?.[field] ?? null) === value) return;
  void save((b) => (b.inputs[i][field] = value));
}

/**
 * Cambia el origen de una entrada. El medidor sigue si era de una fuente externa (pasa a ser salida del tablero de
 * origen) o si ya es salida del nuevo origen; si era salida del origen anterior, se queda en ese tablero.
 */
function setOrigin(i: number, value: string) {
  const from = value ? Number(value) : null;
  void save((b) => {
    const cur = b.inputs[i];
    const place = cur.sourceId != null ? h.supplyPlace.get(cur.sourceId) : undefined;
    const keep = cur.sourceId != null && (from != null ? cur.fromPanelId == null || place?.panelId === from : cur.fromPanelId == null);
    b.inputs[i] = { ...cur, fromPanelId: from, origin: from != null ? null : cur.origin, sourceId: keep ? cur.sourceId : null };
  });
}

const downstream = computed(() => supplyDownstream(h.panels, [props.panelId]));
const otherPanels = computed(() => h.panels.filter((p) => p.id !== props.panelId).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true })));
const terms = computed(() => (panel.value?.inputs ?? []).map((_, i) => `E${i + 1}`));
const modes = Object.entries(PANEL_MODE_LABELS) as [PanelMode, string][];
const meter = (id: number | null) => (id != null ? catalog.sourceById.get(id) : undefined);

// ---------------------------------------------------------------------------
// Salidas: alimentadores de otros tableros (con su destino) y cargas
// ---------------------------------------------------------------------------
const outputs = computed(() =>
  panelOutputs(h.panels, props.panelId).map((o) => ({ ...o, key: o.sourceId != null ? `m${o.sourceId}` : `f${o.feeds[0].panelId}:${o.feeds[0].inputIndex}` })),
);

async function removeLoad(sourceId: number) {
  try {
    await h.setPanelLoads(props.panelId, [sourceId], 'remove');
  } catch (e) {
    toast.error(e);
  }
}

// ---------------------------------------------------------------------------
// Selector de medidores (pantalla grande)
// ---------------------------------------------------------------------------
interface Picker {
  title: string;
  slot: SupplySlot;
  multiple: boolean;
  current: number | null;
  recommended: number[];
  recommendedLabel?: string;
}
const picker = ref<Picker | null>(null);

/** Nota por medidor para el lugar elegido: dónde está y si se moverá o no se puede usar */
function noteFor(slot: SupplySlot) {
  const target = slot.kind === 'input' ? panel.value?.inputs[slot.index] : undefined;
  return (sid: number) => {
    const p = h.supplyPlace.get(sid);
    if (!p) return null;
    const where = h.panelById.get(p.panelId)?.name ?? '¿?';
    const self = p.panelId === props.panelId;
    if (p.role !== 'load' && !self) return { text: `${p.role === 'input' ? 'Entrada' : 'Totalizador'} de ${where}`, blocked: true };
    if (p.feeds) {
      const fed = h.feedsText(p.feeds);
      if (slot.kind === 'input' && p.feeds.some((f) => f.panelId === props.panelId && f.inputIndex === slot.index)) return { text: 'Alimenta esta entrada' };
      // Derivación: se comparte con una entrada que viene de su mismo tablero
      if (slot.kind === 'input' && target?.fromPanelId === p.panelId && !p.feeds.some((f) => f.panelId === props.panelId)) return { text: `Salida de ${where}, se comparte (alimenta a ${fed})` };
      if (p.feeds.every((f) => f.panelId === props.panelId)) return { text: `Alimenta ${fed} (este tablero)` };
      return { text: `Alimenta a ${fed}`, blocked: true };
    }
    if (self) return { text: p.role === 'load' ? 'Salida de este tablero' : p.role === 'totalizer' ? 'Totalizador de este tablero' : `E${(p.inputIndex ?? 0) + 1} de este tablero` };
    if (slot.kind === 'input' && target?.fromPanelId === p.panelId) return { text: `Salida de ${where}` };
    return { text: `Salida de ${where}: se moverá` };
  };
}

function pickTotalizer() {
  const p = panel.value!;
  picker.value = { title: `Medidor totalizador de ${p.name}`, slot: { kind: 'totalizer' }, multiple: false, current: p.totalizerSourceId, recommended: [] };
}

function pickInputMeter(i: number) {
  const p = panel.value!;
  const inp = p.inputs[i];
  const from = inp.fromPanelId != null ? h.panelById.get(inp.fromPanelId) : undefined;
  // Desde un tablero: sus salidas van primero (las que ya alimentan a otros se comparten), salvo las que ya alimentan
  // otra entrada de este tablero
  const recommended = from
    ? from.loadSourceIds.filter((id) => !h.supplyPlace.get(id)?.feeds?.some((f) => f.panelId === p.id && f.inputIndex !== i))
    : [];
  picker.value = {
    title: `Medidor de ${terms.value[i]} de ${p.name}${from ? ` (desde ${from.name})` : ''}`,
    slot: { kind: 'input', index: i },
    multiple: false,
    current: inp.sourceId,
    recommended,
    recommendedLabel: from ? `salida de ${from.name}` : undefined,
  };
}

function pickLoads() {
  const p = panel.value!;
  picker.value = { title: `Agregar salidas a ${p.name}`, slot: { kind: 'load' }, multiple: true, current: null, recommended: [] };
}

async function onPick(ids: number[]) {
  const pk = picker.value;
  if (!pk) return;
  const note = noteFor(pk.slot);
  const usable = ids.filter((id) => !note(id)?.blocked);
  picker.value = null;
  if (!usable.length) return;
  if (pk.slot.kind === 'load') {
    try {
      await h.setPanelLoads(props.panelId, usable, 'add');
      toast.success(`${formatNumber(usable.length)} salida(s) agregada(s)`);
    } catch (e) {
      toast.error(e);
    }
    return;
  }
  const slot = pk.slot;
  await save((b) => placeMeter(b, slot, usable[0]));
}

function onClearPick() {
  const pk = picker.value;
  picker.value = null;
  if (!pk || pk.current == null) return;
  const slot = pk.slot;
  void save((b) => {
    if (slot.kind === 'totalizer') b.totalizerSourceId = null;
    else if (slot.kind === 'input') b.inputs[slot.index].sourceId = null;
  });
}

async function remove() {
  const p = panel.value;
  if (!p) return;
  const kids = h.panels.filter((x) => x.id !== p.id && x.inputs.some((i) => i.fromPanelId === p.id));
  const extra = kids.length ? `\n\nLas entradas de ${kids.map((c) => c.name).join(', ')} que vienen de este tablero pasarán a ser una fuente externa llamada «${p.name}».` : '';
  if (!confirm(`¿Eliminar el tablero «${p.name}»? Sus medidores quedan sin ubicar en Suministro.${extra}`)) return;
  try {
    await h.deletePanel(p.id);
    emit('close');
  } catch (e) {
    toast.error(e);
  }
}
</script>

<template>
  <div v-if="panel" class="space-y-4">
    <div class="flex items-center gap-2">
      <component :is="PANEL_ICON_COMPONENTS[panel.icon]" :size="18" class="text-slate-600" />
      <h3 class="min-w-0 flex-1 truncate font-semibold">{{ panel.name }}</h3>
      <span v-if="saving" class="flex items-center gap-1 text-xs text-slate-400"><Icon name="refresh" :size="12" class="animate-spin" /> Guardando…</span>
      <span v-else-if="saved" class="flex items-center gap-1 text-xs text-emerald-600"><Icon name="check" :size="12" /> Guardado</span>
      <button class="btn btn-ghost btn-sm" title="Cerrar" @click="emit('close')"><Icon name="x" /></button>
    </div>

    <ul v-if="issues.length" class="space-y-1">
      <li v-for="(i, k) in issues" :key="k" class="flex gap-1.5 rounded-lg px-2 py-1 text-xs" :class="i.severity === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'">
        <Icon :name="i.severity === 'error' ? 'error' : 'alert'" :size="13" class="mt-px" /> {{ i.message }}
      </li>
    </ul>

    <!-- Nombre y descripción: único bloque con botón Guardar -->
    <form class="space-y-2" @submit.prevent="saveInfo">
      <div>
        <label class="label">Nombre</label>
        <input v-model="info.name" class="input py-1.5" maxlength="80" required />
      </div>
      <div>
        <label class="label">Descripción</label>
        <input v-model="info.description" class="input py-1.5" maxlength="500" placeholder="Ubicación, sala eléctrica…" />
      </div>
      <div v-if="infoDirty" class="flex gap-2">
        <button class="btn btn-primary btn-sm" :disabled="saving || !info.name.trim()"><Icon name="check" :size="12" /> Guardar cambios</button>
        <button type="button" class="btn btn-sm" @click="info = { name: panel.name, description: panel.description ?? '' }">Descartar</button>
      </div>
    </form>

    <!-- Apariencia en el diagrama -->
    <section class="space-y-2">
      <div>
        <h4 class="label">Ícono</h4>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="ic in PANEL_ICONS"
            :key="ic"
            type="button"
            class="flex size-9 items-center justify-center rounded-lg border transition"
            :class="panel.icon === ic ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-200' : 'border-slate-300 text-slate-600 hover:border-brand-400 hover:bg-slate-50'"
            :title="PANEL_ICON_LABELS[ic]"
            :aria-label="PANEL_ICON_LABELS[ic]"
            :aria-pressed="panel.icon === ic"
            @click="setIcon(ic)"
          >
            <component :is="PANEL_ICON_COMPONENTS[ic]" :size="18" />
          </button>
        </div>
      </div>
      <div>
        <h4 class="label">Color del encabezado</h4>
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="flex size-6 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-400 ring-offset-2 transition hover:scale-110"
            :class="!panel.color && 'ring-2 ring-slate-500'"
            title="Sin color"
            @click="setColor(null)"
          >
            <Icon name="x" :size="12" />
          </button>
          <button
            v-for="c in swatches"
            :key="c"
            type="button"
            class="size-6 rounded-full ring-offset-2 transition hover:scale-110"
            :class="panel.color === c && 'ring-2 ring-slate-500'"
            :style="{ background: c }"
            :title="c"
            @click="setColor(c)"
          />
          <label class="relative size-6 cursor-pointer overflow-hidden rounded-full border border-slate-300" title="Elegir otro color">
            <input type="color" class="absolute -inset-2 size-10 cursor-pointer" :value="panel.color ?? '#94a3b8'" @change="setColor(($event.target as HTMLInputElement).value)" />
          </label>
        </div>
      </div>
    </section>

    <!-- Totalizador interno -->
    <section>
      <h4 class="label">Medidor totalizador</h4>
      <button type="button" class="flex w-full items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-left hover:border-brand-500 hover:bg-brand-50" @click="pickTotalizer">
        <MeterLabel v-if="meter(panel.totalizerSourceId)" :source="meter(panel.totalizerSourceId)!" class="flex-1" />
        <span v-else class="flex-1 text-sm" :class="panel.missingTotalizer ? 'text-red-600' : 'text-slate-400'">
          {{ panel.missingTotalizer ? 'El medidor guardado ya no existe' : 'Sin totalizador (elegir medidor…)' }}
        </span>
        <Icon name="edit" :size="14" class="text-slate-400" />
      </button>
    </section>

    <!-- Modo -->
    <fieldset>
      <legend class="label">Modo de operación</legend>
      <label v-for="[value, label] in modes" :key="value" class="flex items-center gap-2 py-0.5 text-sm">
        <input type="radio" :checked="panel.mode === value" :value="value" class="accent-brand-600" @change="setMode(value)" /> {{ label }}
      </label>
      <p class="mt-1 rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
        {{ !terms.length ? 'Sin entradas' : panel.mode === 'ats' ? `Una entrada activa a la vez: ${terms.join(' | ')}` : `Entradas = ${terms.join(' + ')}` }}
      </p>
    </fieldset>

    <!-- Entradas -->
    <section>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h4 class="label mb-0 flex-1">Fuentes de entrada ({{ panel.inputs.length }})</h4>
        <button type="button" class="btn btn-sm" :disabled="panel.inputs.length >= MAX_PANEL_INPUTS" title="Clic y luego clic en el tablero que alimenta a este" @click="editor.startLink(panel.id, null)">
          <Icon name="link" :size="12" /> Desde tablero
        </button>
        <button type="button" class="btn btn-sm" :disabled="panel.inputs.length >= MAX_PANEL_INPUTS" @click="addExternal"><Icon name="plug" :size="12" /> Fuente externa</button>
      </div>
      <p v-if="!panel.inputs.length" class="text-xs text-slate-500">Sin entradas. Usa «Desde tablero» o conecta en el diagrama la salida de otro tablero.</p>
      <div v-for="(inp, i) in panel.inputs" :key="inp.id" class="mb-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
        <div class="flex items-center gap-1.5">
          <span class="w-7 shrink-0 text-sm font-semibold text-sky-700">{{ terms[i] }}</span>
          <select class="input min-w-0 flex-1 py-1.5" :value="inp.fromPanelId ?? ''" :aria-label="`Origen de ${terms[i]}`" @change="setOrigin(i, ($event.target as HTMLSelectElement).value)">
            <option value="">Desde fuente externa</option>
            <option v-for="p in otherPanels" :key="p.id" :value="p.id" :disabled="downstream.has(p.id)">
              Desde {{ p.name }}{{ downstream.has(p.id) ? ' (aguas abajo: crearía un ciclo)' : '' }}
            </option>
          </select>
          <button type="button" class="btn btn-ghost btn-sm px-1" :disabled="i === 0" title="Subir" @click="moveInput(i, -1)"><Icon name="up" :size="12" /></button>
          <button type="button" class="btn btn-ghost btn-sm px-1" :disabled="i === panel.inputs.length - 1" title="Bajar" @click="moveInput(i, 1)"><Icon name="down" :size="12" /></button>
          <button type="button" class="btn btn-ghost btn-sm px-1 text-red-600" title="Quitar entrada (el medidor del tablero de origen se queda allá)" @click="removeInput(i)"><Icon name="trash" :size="12" /></button>
        </div>
        <input
          v-if="inp.fromPanelId == null"
          :value="inp.origin ?? ''"
          class="input py-1.5"
          maxlength="80"
          placeholder="Origen: Red pública, Grupo electrógeno…"
          @change="setText(i, 'origin', $event)"
        />
        <input :value="inp.label ?? ''" class="input py-1.5" maxlength="60" placeholder="Etiqueta (opcional)" @change="setText(i, 'label', $event)" />
        <button type="button" class="flex w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left hover:border-brand-500 hover:bg-brand-50" @click="pickInputMeter(i)">
          <MeterLabel v-if="meter(inp.sourceId)" :source="meter(inp.sourceId)!" class="flex-1" />
          <span v-else class="flex-1 text-sm" :class="inp.missingMeter ? 'text-red-600' : 'text-amber-600'">
            {{ inp.missingMeter ? 'El medidor guardado ya no existe' : inp.fromPanelId != null ? 'Sin medidor (elegir salida del tablero de origen…)' : 'Sin medidor (elegir…)' }}
          </span>
          <Icon name="edit" :size="14" class="text-slate-400" />
        </button>
      </div>
    </section>

    <!-- Salidas -->
    <section>
      <div class="mb-1 flex items-center gap-2">
        <h4 class="label mb-0 flex-1">Salidas ({{ outputs.length }})</h4>
        <button type="button" class="btn btn-sm" @click="pickLoads"><Icon name="plus" :size="12" /> Agregar salidas</button>
      </div>
      <p v-if="!outputs.length" class="text-xs text-slate-500">Arrastra medidores hasta la caja del tablero o usa «Agregar salidas».</p>
      <div v-for="o in outputs" :key="o.key" class="group flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
        <MeterLabel v-if="meter(o.sourceId)" :source="meter(o.sourceId)!" class="min-w-0 flex-1" />
        <span v-else class="flex-1 text-sm text-amber-600 italic">sin medidor</span>
        <span v-if="o.feeds.length" class="flex min-w-0 shrink flex-wrap justify-end gap-x-1 text-xs text-sky-700">
          <span v-if="o.feeds.length > 1" class="chip border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-700" title="Esta salida alimenta a varios tableros: mide la suma de todos">derivación</span>
          <button v-for="(f, k) in o.feeds" :key="k" type="button" class="hover:underline" @click="emit('select', `p:${f.panelId}`)">({{ h.feedsText([f]) }})</button>
        </span>
        <button v-if="o.sourceId != null" type="button" class="shrink-0 text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-600" title="Quitar salida" @click="removeLoad(o.sourceId)">
          <Icon name="x" :size="13" />
        </button>
      </div>
    </section>

    <button type="button" class="btn btn-danger btn-sm" @click="remove"><Icon name="trash" :size="12" /> Eliminar tablero</button>

    <MeterPickerModal
      v-if="picker"
      :title="picker.title"
      :multiple="picker.multiple"
      :current="picker.current"
      :recommended="picker.recommended"
      :recommended-label="picker.recommendedLabel"
      :note="noteFor(picker.slot)"
      @pick="onPick"
      @clear="onClearPick"
      @close="picker = null"
    />
  </div>
</template>
