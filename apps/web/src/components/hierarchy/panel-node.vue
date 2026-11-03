<script setup lang="ts">
import { computed, inject } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import { PANEL_ICON_LABELS, panelOutputs, type FeedRef } from '@repnode/shared';
import Icon from '../Icon.vue';
import { hierarchyEditorKey, MAX_NODE_METERS, NODE_WIDTH, useDropZones } from '../../lib/hierarchy-editor';
import { portX } from '../../lib/hierarchy-layout';
import { PANEL_ICON_COMPONENTS } from '../../lib/panel-icons';
import { useMeterDrag } from '../../lib/use-meter-drag';
import { useCatalogStore } from '../../stores/catalog';
import { useHierarchyStore } from '../../stores/hierarchy';

// Caja de un tablero: terminales de entrada arriba (uno por entrada + "+"), totalizador interno y salidas abajo
// (cada medidor con los tableros a los que alimenta). Acepta medidores arrastrados y el vínculo por clics.
const props = defineProps<NodeProps<{ id: number }>>();
const editor = inject(hierarchyEditorKey)!;
const zones = useDropZones(editor);
const drag = useMeterDrag();
const catalog = useCatalogStore();
const h = useHierarchyStore();

const panel = computed(() => h.panelById.get(props.data.id));
const key = computed(() => `p:${props.data.id}`);
/** Soltar sobre cualquier parte del tablero (fuera de entradas y totalizador) = salidas */
const loadsTarget = computed(() => ({ kind: 'loads' as const, panelId: props.data.id }));
const totalizerTarget = computed(() => ({ kind: 'totalizer' as const, panelId: props.data.id }));
const W = NODE_WIDTH.panel;

interface Output {
  key: string;
  sourceId: number | null;
  name: string;
  /** Entradas que alimenta (varias = derivación) */
  feeds: FeedRef[];
}

/** Salidas: alimentadores de otros tableros primero (con o sin medidor) y luego las cargas */
const outputs = computed<Output[]>(() =>
  panelOutputs(h.panels, props.data.id)
    .filter((o) => o.sourceId == null || catalog.sourceById.has(o.sourceId))
    .map((o) => ({
      ...o,
      key: o.sourceId != null ? `m${o.sourceId}` : `f${o.feeds[0].panelId}:${o.feeds[0].inputIndex}`,
      name: o.sourceId != null ? catalog.sourceById.get(o.sourceId)!.name : 'sin medidor',
    })),
);

/** En modo vínculo: ¿se puede usar esta salida para la entrada que se está conectando? */
function linkable(o: Output): boolean {
  const l = editor.link.value;
  return !!l && o.sourceId != null && !o.feeds.some((f) => f.panelId === l.panelId && f.inputIndex !== l.index);
}
function linkTitle(o: Output): string {
  if (!linkable(o)) return `Ya alimenta a ${h.feedsText(o.feeds)}`;
  return o.feeds.length ? `Clic para compartir esta salida (derivación); ya alimenta a ${h.feedsText(o.feeds)}` : 'Clic para usar esta salida como medidor de la entrada';
}

const issues = computed(() => editor.issuesByNode.value.get(props.data.id) ?? []);
const hasError = computed(() => issues.value.some((i) => i.severity === 'error'));
const inputIssue = (i: number) => issues.value.find((x) => x.inputIndex === i);

const terms = computed(() => (panel.value?.inputs ?? []).map((_, i) => `E${i + 1}`));
const formula = computed(() => {
  const t = terms.value;
  if (!t.length) return 'sin entradas';
  return panel.value?.mode === 'ats' ? `activa: ${t.join(' | ')}` : `= ${t.join(' + ')}`;
});

function origin(i: number): string {
  const inp = panel.value!.inputs[i];
  if (inp.fromPanelId != null) return h.panelById.get(inp.fromPanelId)?.name ?? '¿?';
  return inp.origin ?? 'origen sin definir';
}
const meterName = (id: number | null) => (id != null ? catalog.sourceById.get(id)?.name : undefined);

const dimmed = computed(() => !!editor.chain.value && !editor.chain.value.has(key.value));
const linkRole = computed(() => editor.linkRole(props.data.id));

function startDrag(e: DragEvent, sourceId: number) {
  const ids = editor.dragIds(sourceId);
  drag.start(e, ids, ids.map((id) => catalog.sourceById.get(id)?.name ?? ''));
}

// Mientras se elige el origen de un vínculo, un clic en el tablero lo completa; si fue sobre una de sus salidas,
// ese medidor queda como el de la entrada (si no, la entrada queda sin medidor)
function onClickCapture(e: MouseEvent) {
  if (!editor.link.value) return;
  e.stopPropagation();
  e.preventDefault();
  const row = (e.target as Element | null)?.closest<HTMLElement>('[data-out-source]');
  editor.completeLink(props.data.id, row ? Number(row.dataset.outSource) : null);
}
</script>

<template>
  <div
    v-if="panel"
    class="relative rounded-xl border-2 bg-white text-left shadow-sm transition-opacity"
    :class="[
      editor.selected.value === key ? 'border-brand-600 shadow-lg' : hasError ? 'border-red-400' : issues.length ? 'border-amber-300' : 'border-slate-300',
      editor.meterNode.value === key && 'ring-4 ring-sky-300',
      dimmed && !linkRole && 'opacity-35',
      linkRole === 'ok' && 'cursor-pointer ring-4 ring-emerald-300 hover:ring-emerald-500',
      linkRole === 'invalid' && 'cursor-not-allowed opacity-40',
      linkRole === 'target' && 'ring-4 ring-sky-400',
      zones.cls(loadsTarget),
    ]"
    :style="{ width: W + 'px' }"
    @click.capture="onClickCapture"
    @dragover="zones.over($event, loadsTarget)"
    @dragleave="zones.leave($event, loadsTarget)"
    @drop="zones.drop($event, loadsTarget)"
  >
    <!-- Terminales de entrada -->
    <Handle
      v-for="(t, i) in terms"
      :id="`in-${i}`"
      :key="t"
      type="target"
      :position="Position.Top"
      :is-valid-connection="editor.isValidConnection"
      class="!size-3 !border-2 !border-white !bg-sky-600"
      :style="{ left: portX(W, i, terms.length) + 'px' }"
      :title="`${t}: desde ${origin(i)}`"
    />
    <Handle
      id="in-new"
      type="target"
      :position="Position.Top"
      :is-valid-connection="editor.isValidConnection"
      class="!size-3 !border-2 !border-dashed !border-sky-500 !bg-white"
      :style="{ left: portX(W, terms.length, terms.length) + 'px' }"
      title="Conecta aquí la salida de un tablero para agregar una entrada"
    />
    <div class="pointer-events-none absolute inset-x-0 -top-5 h-4 text-[10px] font-semibold text-sky-700">
      <span v-for="(t, i) in terms" :key="t" class="absolute -translate-x-1/2" :style="{ left: portX(W, i, terms.length) + 'px' }">{{ t }}</span>
      <span class="absolute -translate-x-1/2 text-sky-500" :style="{ left: portX(W, terms.length, terms.length) + 'px' }">+</span>
    </div>

    <!-- Encabezado -->
    <!-- Color elegido al 50 % (sufijo alfa 80) para que el nombre se lea -->
    <header
      class="flex items-center gap-2 rounded-t-[10px] border-b border-slate-200 px-3 py-2"
      :class="!panel.color && 'bg-slate-50'"
      :style="panel.color ? { backgroundColor: `${panel.color}80` } : undefined"
    >
      <component :is="PANEL_ICON_COMPONENTS[panel.icon]" :size="16" class="shrink-0 text-slate-700" :title="PANEL_ICON_LABELS[panel.icon]" />
      <span class="min-w-0 flex-1 truncate font-semibold text-slate-900" :title="panel.description ?? panel.name">{{ panel.name }}</span>
      <span v-if="panel.mode === 'ats'" class="chip border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-700" title="Conmutación / respaldo (ATS)">ATS</span>
      <span v-else class="chip border-slate-200 bg-white px-1.5 py-0 text-[10px] text-slate-600" title="Cargas concurrentes (suma)">Σ</span>
      <span v-if="issues.length" :title="issues.map((i) => i.message).join('\n')"><Icon :name="hasError ? 'error' : 'alert'" :size="15" :class="hasError ? 'text-red-600' : 'text-amber-500'" /></span>
    </header>

    <!-- Entradas -->
    <section class="px-3 pt-2">
      <div class="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">Fuentes de entrada</div>
      <div
        v-for="(inp, i) in panel.inputs"
        :key="inp.id"
        class="nodrag mt-1 flex h-[22px] items-center gap-1.5 rounded px-1 text-xs"
        :class="[zones.cls({ kind: 'input', panelId: panel.id, index: i }), editor.link.value?.panelId === panel.id && editor.link.value.index === i && 'bg-sky-100']"
        :title="inputIssue(i)?.message ?? 'Suelta un medidor aquí para asociarlo a esta entrada'"
        @dragover="zones.over($event, { kind: 'input', panelId: panel.id, index: i })"
        @dragleave="zones.leave($event, { kind: 'input', panelId: panel.id, index: i })"
        @drop="zones.drop($event, { kind: 'input', panelId: panel.id, index: i })"
      >
        <span class="w-6 shrink-0 font-semibold text-sky-700">{{ terms[i] }}</span>
        <button
          type="button"
          class="max-w-[40%] shrink-0 truncate rounded px-0.5 text-slate-500 hover:bg-sky-50 hover:text-sky-700"
          :class="inp.fromPanelId == null && 'italic'"
          title="Clic y luego clic en otro tablero para cambiar el origen de esta entrada"
          @click.stop="editor.startLink(panel.id, i)"
        >{{ origin(i) }}</button>
        <Icon name="right" :size="10" class="shrink-0 text-slate-300" />
        <span
          v-if="meterName(inp.sourceId)"
          class="min-w-0 flex-1 cursor-grab truncate font-medium text-slate-800"
          draggable="true"
          @dragstart="startDrag($event, inp.sourceId!)"
          @dragend="drag.end()"
        >{{ meterName(inp.sourceId) }}</span>
        <span v-else class="min-w-0 flex-1 truncate" :class="inp.missingMeter ? 'text-red-600' : 'text-amber-600'">{{ inp.missingMeter ? 'medidor eliminado' : 'sin medidor' }}</span>
      </div>
      <button
        type="button"
        class="nodrag mt-1 flex h-[22px] w-full items-center justify-center gap-1 rounded border border-dashed border-sky-300 text-[11px] text-sky-700 hover:bg-sky-50"
        :class="[zones.cls({ kind: 'new-input', panelId: panel.id }), editor.link.value?.panelId === panel.id && editor.link.value.index == null && 'bg-sky-100']"
        title="Clic y luego clic en el tablero que alimenta a este. También puedes soltar medidores aquí para crear entradas externas"
        @click.stop="editor.startLink(panel.id, null)"
        @dragover="zones.over($event, { kind: 'new-input', panelId: panel.id })"
        @dragleave="zones.leave($event, { kind: 'new-input', panelId: panel.id })"
        @drop="zones.drop($event, { kind: 'new-input', panelId: panel.id })"
      >
        <Icon name="plus" :size="11" /> entrada
      </button>
    </section>

    <!-- Totalizador interno -->
    <div
      class="nodrag mx-3 mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px]"
      :class="zones.cls(totalizerTarget)"
      title="Suelta aquí el medidor totalizador interno del tablero"
      @dragover="zones.over($event, totalizerTarget)"
      @dragleave="zones.leave($event, totalizerTarget)"
      @drop="zones.drop($event, totalizerTarget)"
    >
      <div class="group flex items-center gap-1.5">
        <span class="font-semibold text-slate-600">Σ Totalizador:</span>
        <span
          v-if="meterName(panel.totalizerSourceId)"
          class="min-w-0 flex-1 cursor-grab truncate font-medium text-slate-800"
          draggable="true"
          @dragstart="startDrag($event, panel.totalizerSourceId!)"
          @dragend="drag.end()"
        >{{ meterName(panel.totalizerSourceId) }}</span>
        <span v-else class="min-w-0 flex-1 truncate italic" :class="panel.missingTotalizer ? 'text-red-600' : 'text-slate-400'">
          {{ panel.missingTotalizer ? 'medidor eliminado' : 'sin medidor (suelta uno aquí)' }}
        </span>
        <button
          v-if="panel.totalizerSourceId != null || panel.missingTotalizer"
          type="button"
          class="hidden text-slate-400 group-hover:block hover:text-red-600"
          title="Quitar totalizador"
          @click.stop="editor.clearTotalizer(panel.id)"
        >
          <Icon name="x" :size="12" />
        </button>
      </div>
      <div class="font-mono text-[10px] text-slate-500">{{ formula }}</div>
    </div>

    <!-- Salidas -->
    <section class="nodrag m-2 rounded-lg px-1 pt-1 pb-1.5" title="Suelta medidores en el tablero para asignarlos como salidas">
      <div class="px-1 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">Salidas</div>
      <div
        v-for="o in outputs.slice(0, MAX_NODE_METERS)"
        :key="o.key"
        class="group flex h-6 items-center gap-1.5 rounded px-1 text-xs"
        :class="
          linkRole === 'ok' && o.sourceId != null
            ? linkable(o)
              ? 'cursor-pointer ring-1 ring-emerald-300 hover:bg-emerald-100'
              : 'cursor-not-allowed'
            : ['hover:bg-slate-100', o.sourceId != null && 'cursor-grab']
        "
        :title="linkRole === 'ok' && o.sourceId != null ? linkTitle(o) : undefined"
        :data-out-source="o.sourceId ?? undefined"
        :draggable="o.sourceId != null"
        @dragstart="o.sourceId != null && startDrag($event, o.sourceId)"
        @dragend="drag.end()"
      >
        <Icon
          :name="o.feeds.length > 1 ? 'link' : o.feeds.length ? 'panel' : 'bolt'"
          :size="11"
          class="shrink-0"
          :class="o.feeds.length > 1 ? 'text-amber-500' : 'text-slate-400'"
          :title="o.feeds.length > 1 ? 'Derivación: alimenta a varios tableros' : undefined"
        />
        <span class="min-w-0 truncate" :class="o.sourceId == null ? 'text-amber-600 italic' : 'text-slate-800'">{{ o.name }}</span>
        <span v-if="o.feeds.length" class="min-w-0 shrink truncate text-[11px] text-sky-700" :title="`Alimenta a ${h.feedsText(o.feeds)}`">
          (<template v-for="(f, k) in o.feeds" :key="k"><span v-if="k">, </span><button type="button" class="hover:underline" @click.stop="editor.select(`p:${f.panelId}`)">{{ h.feedsText([f]) }}</button></template>)
        </span>
        <span class="flex-1" />
        <button
          v-if="o.sourceId != null"
          type="button"
          class="hidden shrink-0 text-slate-400 group-hover:block hover:text-red-600"
          title="Quitar salida"
          @click.stop="editor.removeLoad(panel.id, o.sourceId)"
        >
          <Icon name="x" :size="12" />
        </button>
      </div>
      <div v-if="outputs.length > MAX_NODE_METERS" class="px-1 text-[11px] text-slate-500">+{{ outputs.length - MAX_NODE_METERS }} salidas más (ver detalle)</div>
      <div v-if="!outputs.length" class="rounded border border-dashed border-slate-300 py-1 text-center text-[11px] text-slate-400">Suelta medidores aquí</div>
    </section>

    <Handle id="out" type="source" :position="Position.Bottom" :is-valid-connection="editor.isValidConnection" class="!size-3 !border-2 !border-white !bg-slate-700" title="Arrastra desde aquí hasta la entrada de otro tablero" />
  </div>
</template>
