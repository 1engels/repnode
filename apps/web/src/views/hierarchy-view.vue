<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MarkerType, useVueFlow, VueFlow, type Connection, type Edge, type Node } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import {
  MAX_PANEL_INPUTS, edgeLanes, planSpaceMembers, planSupply, spaceDescendants, spacePath, spacesCsvRows, supplyCsvRows, supplyDownstream, supplyUpstream,
  wouldCreateSpaceCycle, wouldCreateSupplyCycle,
  type BlockReason, type DesignIssue, type DropPlan, type HierarchyKind, type SupplySlot,
} from '@repnode/shared';
import FloatingMenu from '../components/FloatingMenu.vue';
import Icon from '../components/Icon.vue';
import HierarchyMeterList from '../components/hierarchy/hierarchy-meter-list.vue';
import PanelDetail from '../components/hierarchy/panel-detail.vue';
import PanelNode from '../components/hierarchy/panel-node.vue';
import SourceNode from '../components/hierarchy/source-node.vue';
import SpaceDetail from '../components/hierarchy/space-detail.vue';
import SpaceNode from '../components/hierarchy/space-node.vue';
import SupplyEdge from '../components/hierarchy/supply-edge.vue';
import {
  estimatePanelHeight, estimateSpaceHeight, hierarchyEditorKey, NODE_WIDTH,
  type DropState, type DropTarget, type HierarchyEditor, type LinkRole, type LinkState,
} from '../lib/hierarchy-editor';
import { layoutGraph, portX, type LayoutEdge, type LayoutNode } from '../lib/hierarchy-layout';
import { useMeterDrag } from '../lib/use-meter-drag';
import { downloadCsv, formatNumber } from '../lib/util';
import { useCatalogStore } from '../stores/catalog';
import { panelToSave, placeMeter, spaceToSave, useHierarchyStore } from '../stores/hierarchy';
import { useToastStore } from '../stores/toast';

const route = useRoute();
const router = useRouter();
const catalog = useCatalogStore();
const h = useHierarchyStore();
const toast = useToastStore();
const drag = useMeterDrag();
const flow = useVueFlow('hierarchy');

const loading = ref(true);
onMounted(async () => {
  try {
    await catalog.load();
  } catch (e) {
    toast.error(e);
  } finally {
    loading.value = false;
  }
});

// ---------------------------------------------------------------------------
// Pestaña activa (?tab=supply|commercial) y selección
// ---------------------------------------------------------------------------
const kind = computed<HierarchyKind>({
  get: () => (route.query.tab === 'commercial' ? 'commercial' : 'supply'),
  set: (v) => void router.replace({ query: { ...route.query, tab: v } }),
});
const kindRef = ref<HierarchyKind>(kind.value);
watch(kind, (v) => {
  kindRef.value = v;
  selected.value = null;
  selectedEdge.value = null;
  fitted = false;
});

const selected = ref<string | null>(null);
const selectedEdge = ref<string | null>(null);
const listSelected = shallowRef(new Set<number>());
const focusMeter = ref<number | null>(null);
const dropKey = ref<string | null>(null);

const parseId = (key: string) => Number(key.slice(key.indexOf(':') + 1));
const label = (id: number) => catalog.sourceById.get(id)?.name ?? `#${id}`;

async function run(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  try {
    await fn();
    if (ok) toast.success(ok);
    return true;
  } catch (e) {
    toast.error(e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Descarga de la jerarquía como CSV (una fila por lugar de cada medidor)
// ---------------------------------------------------------------------------
function downloadHierarchyCsv(): void {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  if (kind.value === 'supply') downloadCsv(`suministro-${stamp}.csv`, supplyCsvRows(h.panels, h.spaces, catalog.sources));
  else downloadCsv(`comercial-${stamp}.csv`, spacesCsvRows(h.spaces, h.panels, catalog.sources));
}

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------
const issues = computed<DesignIssue[]>(() => (kind.value === 'supply' ? h.supplyIssues : h.spaceIssues));
const issuesByNode = computed(() => {
  const m = new Map<number, DesignIssue[]>();
  for (const i of issues.value) {
    let arr = m.get(i.nodeId);
    if (!arr) m.set(i.nodeId, (arr = []));
    arr.push(i);
  }
  return m;
});
const errorCount = (k: HierarchyKind) => (k === 'supply' ? h.supplyIssues : h.spaceIssues).filter((i) => i.severity === 'error').length;
const warnCount = (k: HierarchyKind) => (k === 'supply' ? h.supplyIssues : h.spaceIssues).filter((i) => i.severity === 'warning').length;
const nodeName = (k: HierarchyKind, id: number) => (k === 'supply' ? h.panelById.get(id)?.name : h.spaceById.get(id)?.name) ?? '';

// ---------------------------------------------------------------------------
// Resaltado: cadena aguas arriba/abajo del nodo elegido y nodo del medidor elegido
// ---------------------------------------------------------------------------
const chain = computed<Set<string> | null>(() => {
  const key = selected.value;
  if (!key) return null;
  const id = parseId(key);
  if (key.startsWith('p:')) {
    const ids = new Set([...supplyUpstream(h.panels, [id]), ...supplyDownstream(h.panels, [id])]);
    return new Set([...ids].map((x) => `p:${x}`));
  }
  const ids = new Set([...spacePath(h.spaces, id), ...spaceDescendants(h.spaces, [id])]);
  return new Set([...ids].map((x) => `s:${x}`));
});

const meterNode = computed(() => {
  const id = focusMeter.value;
  if (id == null) return null;
  if (kind.value === 'supply') {
    const p = h.supplyPlace.get(id);
    return p ? `p:${p.panelId}` : null;
  }
  const s = h.spacePlace.get(id);
  return s != null ? `s:${s}` : null;
});

// ---------------------------------------------------------------------------
// Soltar medidores sobre nodos
// ---------------------------------------------------------------------------
function slotOf(t: Exclude<DropTarget, { kind: 'space' }>): SupplySlot {
  return t.kind === 'loads' ? { kind: 'load' } : t.kind === 'input' ? { kind: 'input', index: t.index } : { kind: t.kind };
}

function planFor(t: DropTarget, ids: number[]): DropPlan {
  if (t.kind === 'space') return planSpaceMembers(h.spaces, t.spaceId, ids);
  return planSupply(h.panels, t.panelId, slotOf(t), ids);
}

/** Entradas y totalizador aceptan un solo medidor */
const singleSlot = (t: DropTarget) => t.kind === 'input' || t.kind === 'totalizer';

function dropState(t: DropTarget): DropState {
  const ids = drag.dragging.value;
  if (!ids?.length) return 'none';
  if (singleSlot(t) && ids.length !== 1) return 'blocked';
  const plan = planFor(t, ids);
  return plan.assign.length ? 'ok' : 'blocked';
}

function summarize(plan: DropPlan, target: string): string {
  const fromNames = [...new Set(plan.moved.map((m) => nodeName(kind.value, m.fromId)))];
  const parts = [`${formatNumber(plan.assign.length)} asignado(s) a ${target}`];
  if (plan.moved.length) parts.push(`${formatNumber(plan.moved.length)} movido(s) desde ${fromNames.slice(0, 3).join(', ')}${fromNames.length > 3 ? '…' : ''}`);
  if (plan.unchanged.length) parts.push(`${formatNumber(plan.unchanged.length)} ya estaban`);
  return parts.join(' · ');
}

const BLOCK_TEXT: Record<BlockReason, string> = { input: 'entrada de', totalizer: 'totalizador de', feeder: 'alimenta a' };

function blockedMessage(plan: DropPlan): string {
  const b = plan.blocked.slice(0, 3).map((x) => `${label(x.sourceId)} (${BLOCK_TEXT[x.reason ?? 'input']} ${nodeName('supply', x.fromId)})`);
  return `${formatNumber(plan.blocked.length)} no se pueden mover: ${b.join(', ')}${plan.blocked.length > 3 ? '…' : ''}`;
}

async function drop(t: DropTarget, ids: number[]) {
  drag.end();
  if (!ids.length) return;
  const plan = planFor(t, ids);
  if (t.kind === 'space') {
    if (!plan.assign.length) return toast.info('Esos medidores ya están en el espacio');
    await run(() => h.setSpaceMembers(t.spaceId, plan.assign, 'add'), summarize(plan, nodeName('commercial', t.spaceId)));
    return;
  }
  const panel = h.panelById.get(t.panelId);
  if (!panel) return;
  if (singleSlot(t) && ids.length !== 1) {
    return toast.info(t.kind === 'totalizer' ? 'El totalizador es un solo medidor' : 'Suelta un solo medidor sobre una entrada; para crear varias entradas, suéltalos sobre «+ entrada»');
  }
  if (plan.blocked.length && !plan.assign.length) return toast.error(blockedMessage(plan));
  if (!plan.assign.length) return toast.info('Ya estaban ahí');
  const note = plan.blocked.length ? ` · ${blockedMessage(plan)}` : '';

  if (t.kind === 'loads') {
    await run(() => h.setPanelLoads(panel.id, plan.assign, 'add'), summarize(plan, panel.name) + note);
    return;
  }

  const body = panelToSave(panel);
  const slot = slotOf(t);
  if (t.kind === 'new-input') {
    const add = plan.assign.slice(0, MAX_PANEL_INPUTS - body.inputs.length);
    if (!add.length) return toast.error(`Un tablero admite como máximo ${MAX_PANEL_INPUTS} entradas`);
    for (const sourceId of add) placeMeter(body, slot, sourceId);
    await run(() => h.updatePanel(panel.id, body), `${add.length} entrada(s) nueva(s) en ${panel.name}: indica su origen` + note);
    return;
  }
  const sourceId = plan.assign[0];
  placeMeter(body, slot, sourceId);
  const where = t.kind === 'totalizer' ? 'totalizador' : `E${t.index + 1}`;
  await run(() => h.updatePanel(panel.id, body), `${label(sourceId)} es ahora ${where} de ${panel.name}`);
}

const removeLoad = (panelId: number, sourceId: number) => void run(() => h.setPanelLoads(panelId, [sourceId], 'remove'));
const removeMember = (spaceId: number, sourceId: number) => void run(() => h.setSpaceMembers(spaceId, [sourceId], 'remove'));

function clearTotalizer(panelId: number) {
  const panel = h.panelById.get(panelId);
  if (!panel) return;
  void run(() => h.updatePanel(panelId, { ...panelToSave(panel), totalizerSourceId: null }));
}

async function unassign(ids: number[]) {
  if (!ids.length) return;
  const placed = ids.filter((id) => (kind.value === 'supply' ? h.supplyPlace.has(id) : h.spacePlace.has(id)));
  if (!placed.length) return toast.info('Esos medidores ya estaban sin ubicar');
  await run(() => h.unassign(kind.value, placed), `${formatNumber(placed.length)} medidor(es) sin ubicar`);
}

function dragIds(sourceId: number): number[] {
  return listSelected.value.has(sourceId) ? [...listSelected.value] : [sourceId];
}

// ---------------------------------------------------------------------------
// Vínculo entre tableros (arrastrando entre handles o por clics: "+ entrada" y luego el tablero de origen)
// ---------------------------------------------------------------------------
/**
 * Conecta la entrada `index` (null = nueva) de `to` desde `from`. El medidor de la entrada se conserva si es una salida
 * de `from` o si era una entrada externa (pasa a ser la salida de `from` que la alimenta); si era la salida de otro
 * tablero, ese medidor se queda allá. Con `outSourceId` (una salida de `from`), ese es el medidor de la entrada.
 */
async function connectPanels(from: number, to: number, index: number | null, outSourceId: number | null = null) {
  const p = h.panelById.get(to);
  if (!p) return;
  const body = panelToSave(p);
  if (index == null) {
    if (body.inputs.length >= MAX_PANEL_INPUTS) return toast.error(`Un tablero admite como máximo ${MAX_PANEL_INPUTS} entradas`);
    body.inputs.push({ fromPanelId: from, origin: null, label: null, sourceId: outSourceId });
    index = body.inputs.length - 1;
  } else {
    const cur = body.inputs[index];
    const place = cur.sourceId != null ? h.supplyPlace.get(cur.sourceId) : undefined;
    const keep = cur.sourceId != null && (cur.fromPanelId == null || (place?.role === 'load' && place.panelId === from));
    body.inputs[index] = { ...cur, fromPanelId: from, origin: null, sourceId: outSourceId ?? (keep ? cur.sourceId : null) };
  }
  const noMeter = body.inputs[index].sourceId == null ? ': elige su medidor (una salida de ese tablero)' : '';
  if (await run(() => h.updatePanel(to, body), `${nodeName('supply', from)} → ${p.name} (E${index + 1})${noMeter}`)) selected.value = `p:${to}`;
}

const link = ref<LinkState | null>(null);
const linkBlocked = computed(() => (link.value ? supplyDownstream(h.panels, [link.value.panelId]) : new Set<number>()));

function linkRole(panelId: number): LinkRole {
  if (!link.value) return null;
  if (panelId === link.value.panelId) return 'target';
  return linkBlocked.value.has(panelId) ? 'invalid' : 'ok';
}

function startLink(panelId: number, index: number | null) {
  if (kind.value !== 'supply') return;
  selectedEdge.value = null;
  link.value = { panelId, index };
  linkLoop();
}

function cancelLink() {
  link.value = null;
}

async function completeLink(from: number, sourceId: number | null = null) {
  const l = link.value;
  if (!l) return;
  if (from === l.panelId) return cancelLink();
  if (linkBlocked.value.has(from)) return toast.error(`${nodeName('supply', from)} está aguas abajo de ${nodeName('supply', l.panelId)}: crearía un ciclo`);
  // Una salida puede alimentar a varios tableros (derivación), pero no dos entradas del mismo tablero
  const other = sourceId != null ? h.supplyPlace.get(sourceId)?.feeds?.find((f) => f.panelId === l.panelId && f.inputIndex !== l.index) : undefined;
  if (other) {
    const name = catalog.sourceById.get(sourceId!)?.name ?? '';
    return toast.error(`${name} ya alimenta E${other.inputIndex + 1} de ${nodeName('supply', l.panelId)}: elige otra salida`);
  }
  link.value = null;
  await connectPanels(from, l.panelId, l.index, sourceId);
}

// Línea del vínculo: del terminal de entrada al puntero, recalculada en cada cuadro (sigue el pan y el zoom)
const linkLine = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
const pointer = { x: 0, y: 0 };
function onCanvasMove(e: MouseEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
}
function linkLoop() {
  const l = link.value;
  const box = canvasEl.value?.getBoundingClientRect();
  if (!l || !box) {
    linkLine.value = null;
    return;
  }
  const handle = document.querySelector(`.vue-flow__node[data-id="p:${l.panelId}"] .vue-flow__handle[data-handleid="${l.index == null ? 'in-new' : `in-${l.index}`}"]`);
  const r = handle?.getBoundingClientRect();
  if (r) {
    const px = pointer.x || r.left + r.width / 2;
    const py = pointer.y || r.top - 60;
    linkLine.value = { x1: r.left + r.width / 2 - box.left, y1: r.top + r.height / 2 - box.top, x2: px - box.left, y2: py - box.top };
  }
  requestAnimationFrame(linkLoop);
}

const linkTitle = computed(() => {
  const l = link.value;
  if (!l) return '';
  const p = h.panelById.get(l.panelId);
  return `${p?.name ?? ''} · ${l.index == null ? 'nueva entrada' : `E${l.index + 1}`}`;
});

const editor: HierarchyEditor = {
  kind: kindRef,
  selected,
  chain,
  meterNode,
  issuesByNode,
  dropKey,
  dropState,
  drop: (t, ids) => void drop(t, ids),
  removeLoad,
  clearTotalizer,
  removeMember,
  link,
  startLink,
  linkRole,
  completeLink: (from, sourceId) => void completeLink(from, sourceId),
  select: (key) => focusNode(key),
  dragIds,
  isValidConnection: (c) => isValidConnection(c),
};
provide(hierarchyEditorKey, editor);

// El estado del arrastre se limpia aunque la fila de origen ya no exista (lista virtualizada)
const endDrag = () => {
  drag.end();
  dropKey.value = null;
};
onMounted(() => {
  document.addEventListener('dragend', endDrag);
  document.addEventListener('drop', endDrag);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('dragend', endDrag);
  document.removeEventListener('drop', endDrag);
  window.removeEventListener('keydown', onKey);
});

// ---------------------------------------------------------------------------
// Nodos y aristas del diagrama
// ---------------------------------------------------------------------------
/** Posiciones del layout automático; las de fuentes externas ('x:') son relativas a su tablero */
const auto = shallowRef(new Map<string, { x: number; y: number }>());
const SOURCE_GAP = 90;
const SOURCE_HEIGHT = 36;

const nodes = computed<Node[]>(() => {
  const out: Node[] = [];
  if (kind.value === 'supply') {
    for (const p of h.panels) {
      const key = `p:${p.id}`;
      const position = p.x != null && p.y != null ? { x: p.x, y: p.y } : (auto.value.get(key) ?? { x: 0, y: 0 });
      out.push({ id: key, type: 'panel', position, data: { id: p.id } });
      p.inputs.forEach((i, idx) => {
        if (i.fromPanelId != null) return;
        // Fuente externa: hija del tablero (posición relativa), se mueve con él
        out.push({
          id: `x:${i.id}`,
          type: 'source',
          parentNode: key,
          position: auto.value.get(`x:${i.id}`) ?? { x: portX(NODE_WIDTH.panel, idx, p.inputs.length) - NODE_WIDTH.source / 2, y: -SOURCE_GAP },
          data: { panelId: p.id, origin: i.origin },
          draggable: false,
          selectable: false,
          connectable: false,
        });
      });
    }
  } else {
    for (const s of h.spaces) {
      const key = `s:${s.id}`;
      const position = s.x != null && s.y != null ? { x: s.x, y: s.y } : (auto.value.get(key) ?? { x: 0, y: 0 });
      out.push({ id: key, type: 'space', position, data: { id: s.id } });
    }
  }
  return out;
});

const edges = computed<Edge[]>(() => {
  const out: Edge[] = [];
  const dim = (a: string, b: string) => !!chain.value && !(chain.value.has(a) && chain.value.has(b));
  if (kind.value === 'supply') {
    // Carriles: las aristas que salen del mismo tablero doblan a distinta altura (ver supply-edge)
    const pos = new Map(nodes.value.filter((n) => n.type === 'panel').map((n) => [n.id, n.position]));
    const lanes = edgeLanes(
      h.panels.flatMap((p) =>
        p.inputs.flatMap((i, idx) => {
          const from = i.fromPanelId != null ? pos.get(`p:${i.fromPanelId}`) : undefined;
          const to = pos.get(`p:${p.id}`);
          if (!from || !to) return [];
          return [{ id: `e:${i.id}`, source: `p:${i.fromPanelId}`, sourceX: from.x + NODE_WIDTH.panel / 2, targetX: to.x + portX(NODE_WIDTH.panel, idx, p.inputs.length) }];
        }),
      ),
    );
    for (const p of h.panels) {
      const target = `p:${p.id}`;
      p.inputs.forEach((i, idx) => {
        const source = i.fromPanelId != null ? `p:${i.fromPanelId}` : `x:${i.id}`;
        const id = `e:${i.id}`;
        const meter = i.sourceId != null ? label(i.sourceId) : i.missingMeter ? 'medidor eliminado' : 'sin medidor';
        out.push({
          id,
          source,
          sourceHandle: 'out',
          target,
          targetHandle: `in-${idx}`,
          type: 'supply',
          data: lanes.get(id) ?? { lane: 0, lanes: 1 },
          label: meter,
          selectable: i.fromPanelId != null,
          markerEnd: MarkerType.ArrowClosed,
          class: [selectedEdge.value === id && 'selected-edge', dim(i.fromPanelId != null ? source : target, target) && 'opacity-25'].filter(Boolean).join(' '),
          style: { strokeWidth: 2, stroke: i.sourceId == null ? '#d97706' : '#0369a1', strokeDasharray: p.mode === 'ats' ? '6 4' : undefined },
          labelStyle: { fontSize: '10px', fill: i.sourceId == null ? '#b45309' : '#334155' },
          labelBgStyle: { fill: '#fff' },
        });
      });
    }
  } else {
    for (const s of h.spaces) {
      if (s.parentId == null || !h.spaceById.has(s.parentId)) continue;
      const id = `e:s:${s.id}`;
      const source = `s:${s.parentId}`;
      const target = `s:${s.id}`;
      out.push({
        id,
        source,
        sourceHandle: 'out',
        target,
        targetHandle: 'in',
        type: 'smoothstep',
        markerEnd: MarkerType.ArrowClosed,
        class: [selectedEdge.value === id && 'selected-edge', dim(source, target) && 'opacity-25'].filter(Boolean).join(' '),
        style: { strokeWidth: 2, stroke: '#0f766e' },
      });
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// Layout automático (elkjs). Los nodos con posición guardada no se mueven.
// ---------------------------------------------------------------------------
const structureKey = computed(() =>
  kind.value === 'supply'
    ? JSON.stringify(h.panels.map((p) => [p.id, p.inputs.map((i) => i.fromPanelId), p.loadSourceIds.length > 8 ? 8 : p.loadSourceIds.length]))
    : JSON.stringify(h.spaces.map((s) => [s.id, s.parentId, Math.min(s.sourceIds.length, 8)])),
);
const layingOut = ref(false);
let layoutSeq = 0;
let fitted = false;

async function runLayout() {
  const seq = ++layoutSeq;
  const lNodes: LayoutNode[] = [];
  const lEdges: LayoutEdge[] = [];
  if (kind.value === 'supply') {
    // Alimentadores sin medidor: ocupan una fila en las salidas del tablero de origen
    const feedsNoMeter = new Map<number, number>();
    for (const p of h.panels) for (const i of p.inputs) if (i.fromPanelId != null && i.sourceId == null) feedsNoMeter.set(i.fromPanelId, (feedsNoMeter.get(i.fromPanelId) ?? 0) + 1);
    for (const p of h.panels) {
      const key = `p:${p.id}`;
      const measured = flow.findNode(key)?.dimensions.height;
      lNodes.push({
        id: key,
        width: NODE_WIDTH.panel,
        height: measured || estimatePanelHeight(p.inputs.length, p.loadSourceIds.length + (feedsNoMeter.get(p.id) ?? 0)),
        inPorts: p.inputs.map((_, i) => `${key}:in-${i}`),
        outPort: `${key}:out`,
      });
      p.inputs.forEach((i, idx) => {
        const target = { target: key, targetPort: `${key}:in-${idx}` };
        if (i.fromPanelId != null && h.panelById.has(i.fromPanelId)) {
          lEdges.push({ id: `e:${i.id}`, source: `p:${i.fromPanelId}`, sourcePort: `p:${i.fromPanelId}:out`, ...target });
        } else if (i.fromPanelId == null) {
          // Las fuentes externas también entran al layout para no cruzarse con las demás aristas
          lNodes.push({ id: `x:${i.id}`, width: NODE_WIDTH.source, height: SOURCE_HEIGHT, outPort: `x:${i.id}:out` });
          lEdges.push({ id: `e:${i.id}`, source: `x:${i.id}`, sourcePort: `x:${i.id}:out`, ...target });
        }
      });
    }
  } else {
    for (const s of h.spaces) {
      const key = `s:${s.id}`;
      const measured = flow.findNode(key)?.dimensions.height;
      lNodes.push({ id: key, width: NODE_WIDTH.space, height: measured || estimateSpaceHeight(h.spaces.filter((x) => x.parentId === s.id).length, s.sourceIds.length) });
      if (s.parentId != null && h.spaceById.has(s.parentId)) lEdges.push({ id: `e:s:${s.id}`, source: `s:${s.parentId}`, target: key });
    }
  }
  if (!lNodes.length) {
    auto.value = new Map();
    return;
  }
  layingOut.value = true;
  try {
    const pos = await layoutGraph(lNodes, lEdges);
    if (seq !== layoutSeq) return;
    if (kind.value === 'supply') {
      // Las fuentes externas son hijas de su tablero en Vue Flow: posición relativa a él
      for (const p of h.panels) {
        const at = pos.get(`p:${p.id}`);
        for (const i of p.inputs) {
          const src = pos.get(`x:${i.id}`);
          if (at && src) pos.set(`x:${i.id}`, { x: src.x - at.x, y: src.y - at.y });
        }
      }
    }
    auto.value = pos;
    if (!fitted) {
      fitted = true;
      fitWhenMeasured();
    }
  } catch (e) {
    toast.error(e);
  } finally {
    if (seq === layoutSeq) layingOut.value = false;
  }
}

/** Encuadra todo cuando Vue Flow ya midió los nodos (si no, fitView los ignora). */
function fitWhenMeasured(tries = 20, duration = 0) {
  const list = flow.getNodes.value;
  if (!tries || (list.length && list.every((n) => n.dimensions.width > 0))) {
    void flow.fitView({ padding: 0.15, maxZoom: 1, duration });
    return;
  }
  setTimeout(() => fitWhenMeasured(tries - 1, duration), 50);
}

let layoutTimer: ReturnType<typeof setTimeout> | undefined;
watch([structureKey, kind, () => loading.value], () => {
  if (loading.value) return;
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => void runLayout(), 60);
}, { immediate: true });

async function reorganize() {
  if (!confirm('¿Reorganizar el diagrama automáticamente? Se pierden las posiciones ajustadas a mano.')) return;
  if (await run(() => h.saveLayout(kind.value, [], true))) {
    await runLayout();
    await nextTick();
    fitWhenMeasured(20, 300);
  }
}

// ---------------------------------------------------------------------------
// Interacción con el diagrama
// ---------------------------------------------------------------------------
flow.onNodeDragStop(({ nodes: moved }) => {
  const positions = moved
    .filter((n) => n.id.startsWith(kind.value === 'supply' ? 'p:' : 's:'))
    .map((n) => ({ id: parseId(n.id), x: Math.round(n.position.x), y: Math.round(n.position.y) }));
  if (positions.length) void run(() => h.saveLayout(kind.value, positions));
});

flow.onNodeClick(({ node }) => {
  if (node.id.startsWith('x:')) return;
  selected.value = node.id;
  selectedEdge.value = null;
});

flow.onEdgeClick(({ edge }) => {
  if (edge.selectable === false) return;
  selectedEdge.value = edge.id;
});

flow.onPaneClick(() => {
  if (link.value) return cancelLink();
  selected.value = null;
  selectedEdge.value = null;
  focusMeter.value = null;
});

/** Conexión válida: de la salida de un nodo a la entrada de otro, sin ciclos. */
function isValidConnection(c: Connection): boolean {
  if (c.source === c.target) return false;
  if (kind.value === 'supply') {
    if (!c.source.startsWith('p:') || !c.target.startsWith('p:')) return false;
    return !wouldCreateSupplyCycle(h.panels, parseId(c.target), [parseId(c.source)]);
  }
  return !wouldCreateSpaceCycle(h.spaces, parseId(c.target), parseId(c.source));
}

flow.onConnect(async (c) => {
  if (!isValidConnection(c)) return toast.error('Esa conexión crearía un ciclo');
  const from = parseId(c.source);
  const to = parseId(c.target);
  if (kind.value === 'commercial') {
    const s = h.spaceById.get(to);
    if (!s) return;
    await run(() => h.updateSpace(to, { ...spaceToSave(s), parentId: from }), `${s.name} ahora está dentro de ${nodeName('commercial', from)}`);
    return;
  }
  await connectPanels(from, to, !c.targetHandle || c.targetHandle === 'in-new' ? null : Number(c.targetHandle.slice(3)));
});

const edgeLabel = computed(() => {
  const id = selectedEdge.value;
  const e = id ? edges.value.find((x) => x.id === id) : undefined;
  return e ? `${nodeName(kind.value, parseId(e.source))} → ${nodeName(kind.value, parseId(e.target))}` : '';
});

async function disconnect() {
  const id = selectedEdge.value;
  if (!id) return;
  selectedEdge.value = null;
  if (id.startsWith('e:s:')) {
    const s = h.spaceById.get(Number(id.slice(4)));
    if (s) await run(() => h.updateSpace(s.id, { ...spaceToSave(s), parentId: null }), `${s.name} pasó al nivel superior`);
    return;
  }
  const inputId = Number(id.slice(2));
  const p = h.panels.find((x) => x.inputs.some((i) => i.id === inputId));
  if (!p) return;
  const body = panelToSave(p);
  const idx = p.inputs.findIndex((i) => i.id === inputId);
  // El medidor era una salida del tablero de origen: se queda allá
  body.inputs[idx] = { ...body.inputs[idx], fromPanelId: null, origin: null, sourceId: null };
  await run(() => h.updatePanel(p.id, body), `E${idx + 1} de ${p.name} desconectada: indica su origen`);
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
  // Con un modal abierto, Esc solo lo cierra (lo maneja BaseModal): no se toca la selección del diagrama
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEdge.value) {
    e.preventDefault();
    void disconnect();
  } else if (e.key === 'Escape') {
    if (link.value) return cancelLink();
    selected.value = null;
    selectedEdge.value = null;
  }
}

/** Selecciona el nodo y lo centra en el lienzo. */
function focusNode(key: string) {
  selected.value = key;
  selectedEdge.value = null;
  const n = flow.findNode(key);
  if (!n) return;
  const { width = NODE_WIDTH.panel, height = 200 } = n.dimensions ?? {};
  void flow.setCenter(n.computedPosition.x + width / 2, n.computedPosition.y + height / 2, { zoom: Math.max(flow.getViewport().zoom, 0.85), duration: 350 });
}

function locateMeter(id: number) {
  focusMeter.value = id;
  const key = meterNode.value;
  if (key) focusNode(key);
  else toast.info(`${label(id)} no está ubicado en ${kind.value === 'supply' ? 'Suministro' : 'Comercial'}`);
}

const search = ref('');
const nodeOptions = computed(() =>
  (kind.value === 'supply' ? h.panels.map((p) => ({ key: `p:${p.id}`, name: p.name })) : h.spaces.map((s) => ({ key: `s:${s.id}`, name: s.name }))).sort((a, b) =>
    a.name.localeCompare(b.name, 'es', { numeric: true }),
  ),
);
function goSearch() {
  const q = search.value.trim().toLocaleLowerCase('es');
  const hit = nodeOptions.value.find((o) => o.name.toLocaleLowerCase('es') === q) ?? nodeOptions.value.find((o) => o.name.toLocaleLowerCase('es').includes(q));
  if (hit) {
    focusNode(hit.key);
    search.value = '';
  } else toast.info('Ningún nodo coincide');
}

// ---------------------------------------------------------------------------
// Creación rápida: soltar medidores en el lienzo vacío o botón "Nuevo"
// ---------------------------------------------------------------------------
interface QuickCreate {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
  ids: number[];
}
const quick = ref<QuickCreate | null>(null);
const quickName = ref('');
const canvasEl = ref<HTMLElement | null>(null);

function onPaneDragOver(e: DragEvent) {
  if (!drag.accepts(e)) return;
  e.preventDefault();
  dropKey.value = 'pane';
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onPaneDrop(e: DragEvent) {
  if (!drag.accepts(e)) return;
  e.preventDefault();
  const ids = drag.read(e);
  drag.end();
  dropKey.value = null;
  openQuick(e.clientX, e.clientY, ids);
}

function openQuick(clientX: number, clientY: number, ids: number[]) {
  const p = flow.screenToFlowCoordinate({ x: clientX, y: clientY });
  quick.value = { x: clientX, y: clientY, flowX: p.x, flowY: p.y, ids };
  quickName.value = '';
}

function newNode() {
  const r = canvasEl.value?.getBoundingClientRect();
  if (!r) return;
  openQuick(r.left + r.width / 2, r.top + r.height / 3, []);
}

const quickPlan = computed(() => (quick.value && kind.value === 'supply' ? planSupply(h.panels, -1, { kind: 'load' }, quick.value.ids) : null));

async function createQuick() {
  const q = quick.value;
  const name = quickName.value.trim();
  if (!q || !name) return;
  const x = Math.round(q.flowX - (kind.value === 'supply' ? NODE_WIDTH.panel : NODE_WIDTH.space) / 2);
  const y = Math.round(q.flowY - 20);
  await run(async () => {
    const created =
      kind.value === 'supply'
        ? await h.createPanel({ name, mode: 'sum', description: null, inputs: [], totalizerSourceId: null, color: null, icon: 'other' }, { sourceIds: quickPlan.value?.assign ?? [], x, y })
        : await h.createSpace({ name, type: null, parentId: null }, { sourceIds: q.ids, x, y });
    quick.value = null;
    if (created) selected.value = `${kind.value === 'supply' ? 'p' : 's'}:${created.id}`;
  }, `${kind.value === 'supply' ? 'Tablero' : 'Espacio'} «${name}» creado${q.ids.length ? ` con ${formatNumber(quickPlan.value?.assign.length ?? q.ids.length)} medidor(es)` : ''}`);
}

const selectedIssues = computed(() => (selected.value ? (issuesByNode.value.get(parseId(selected.value)) ?? []) : []));
</script>

<template>
  <div v-if="loading" class="flex items-center justify-center gap-2 py-24 text-slate-500"><Icon name="refresh" class="animate-spin" /> Cargando catálogo…</div>
  <div v-else class="flex h-[calc(100vh-7.5rem)] min-h-[560px] flex-col gap-3">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-slate-900">Jerarquías</h1>
        <p class="mt-0.5 text-sm text-slate-600">
          {{ kind === 'supply'
            ? 'Tableros, sus fuentes de entrada y sus cargas. Conecta la salida de un tablero con la entrada de otro y arrastra medidores a las cajas.'
            : 'Espacios físicos (edificio, piso, zona…). Conecta un espacio con otro para anidarlo y arrastra medidores a las cajas.' }}
        </p>
      </div>
      <div class="flex overflow-hidden rounded-lg border border-slate-300 text-sm" role="tablist">
        <button
          v-for="t in (['supply', 'commercial'] as const)"
          :key="t"
          role="tab"
          class="flex items-center gap-1.5 px-3 py-1.5"
          :class="[kind === t ? 'bg-slate-800 text-white' : 'bg-white hover:bg-slate-50', t === 'commercial' && 'border-l border-slate-300']"
          :aria-selected="kind === t"
          @click="kind = t"
        >
          <Icon :name="t === 'supply' ? 'panel' : 'building'" :size="14" /> {{ t === 'supply' ? 'Suministro' : 'Comercial' }}
          <span v-if="errorCount(t)" class="rounded-full bg-red-600 px-1.5 text-[10px] text-white">{{ errorCount(t) }}</span>
          <span v-else-if="warnCount(t)" class="rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{{ warnCount(t) }}</span>
        </button>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)_420px]">
      <HierarchyMeterList v-model:selected="listSelected" :kind="kind" @focus="focusMeter = $event" @locate="locateMeter" @unassign="unassign" />

      <!-- Lienzo -->
      <section class="card relative flex min-h-[420px] flex-col overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
          <button class="btn btn-primary btn-sm" @click="newNode"><Icon name="plus" :size="12" /> {{ kind === 'supply' ? 'Nuevo tablero' : 'Nuevo espacio' }}</button>
          <form class="flex items-center gap-1" @submit.prevent="goSearch">
            <input v-model="search" class="input w-44 py-1 text-xs" list="hierarchy-nodes" :placeholder="kind === 'supply' ? 'Ir a tablero…' : 'Ir a espacio…'" />
            <datalist id="hierarchy-nodes"><option v-for="o in nodeOptions" :key="o.key" :value="o.name" /></datalist>
            <button class="btn btn-sm" title="Ir"><Icon name="target" :size="12" /></button>
          </form>
          <button class="btn btn-sm" :disabled="!nodes.length" title="Recalcula la posición de todas las cajas" @click="reorganize"><Icon name="grid" :size="12" /> Reorganizar</button>
          <button
            class="btn btn-sm"
            :title="kind === 'supply'
              ? 'Tabla con una fila por cada lugar de cada medidor: entradas, totalizadores, salidas y alimentadores (una fila por destino), más los sin ubicar'
              : 'Tabla con una fila por medidor de cada espacio, los espacios vacíos y los medidores sin ubicar'"
            @click="downloadHierarchyCsv"
          ><Icon name="download" :size="12" /> Descargar CSV</button>
          <span v-if="layingOut" class="flex items-center gap-1 text-xs text-slate-400"><Icon name="refresh" :size="12" class="animate-spin" /> Ordenando…</span>
          <template v-if="selectedEdge">
            <span class="ml-auto truncate text-xs text-slate-600">{{ edgeLabel }}</span>
            <button class="btn btn-danger btn-sm" title="Supr" @click="disconnect"><Icon name="x" :size="12" /> Desconectar</button>
          </template>
        </div>

        <div
          ref="canvasEl"
          @mousemove="onCanvasMove"
          @contextmenu="link && ($event.preventDefault(), cancelLink())"
          class="relative min-h-0 flex-1"
          :class="dropKey === 'pane' && 'bg-brand-50/40'"
          @dragover="onPaneDragOver"
          @dragleave="dropKey === 'pane' && (dropKey = null)"
          @drop="onPaneDrop"
        >
          <VueFlow
            id="hierarchy"
            :nodes="nodes"
            :edges="edges"
            :min-zoom="0.15"
            :max-zoom="1.6"
            :delete-key-code="null"
            :nodes-connectable="true"
            :default-edge-options="{ type: 'smoothstep' }"
            :elevate-edges-on-select="true"
            class="h-full"
          >
            <template #node-panel="p"><PanelNode v-bind="p" /></template>
            <template #node-source="p"><SourceNode v-bind="p" /></template>
            <template #node-space="p"><SpaceNode v-bind="p" /></template>
            <template #edge-supply="e"><SupplyEdge v-bind="e" /></template>
            <Background :gap="18" pattern-color="#cbd5e1" />
            <Controls position="bottom-left" :show-interactive="false" />
            <MiniMap position="bottom-right" pannable zoomable :width="150" :height="100" :node-color="(n: Node) => (n.type === 'source' ? '#6ee7b7' : n.type === 'space' ? '#99f6e4' : '#cbd5e1')" />
          </VueFlow>

          <div v-if="!nodes.length" class="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-500">
            <div>
              <Icon :name="kind === 'supply' ? 'panel' : 'building'" :size="32" class="mx-auto mb-2 text-slate-300" />
              Arrastra medidores desde la lista y suéltalos aquí para crear el primer {{ kind === 'supply' ? 'tablero' : 'espacio' }},<br />o usa «{{ kind === 'supply' ? 'Nuevo tablero' : 'Nuevo espacio' }}».
            </div>
          </div>
          <div v-else-if="drag.dragging.value" class="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-slate-800/85 px-3 py-1 text-xs text-white">
            Suelta sobre una caja para asignar · en el lienzo vacío para crear {{ kind === 'supply' ? 'un tablero' : 'un espacio' }}
          </div>

          <!-- Vínculo por clics: línea desde el terminal de entrada hasta el puntero -->
          <template v-if="link">
            <svg class="pointer-events-none absolute inset-0 z-10 h-full w-full">
              <line
                v-if="linkLine"
                :x1="linkLine.x1"
                :y1="linkLine.y1"
                :x2="linkLine.x2"
                :y2="linkLine.y2"
                stroke="#0284c7"
                stroke-width="2.5"
                stroke-dasharray="7 5"
              />
              <circle v-if="linkLine" :cx="linkLine.x1" :cy="linkLine.y1" r="5" fill="#0284c7" />
            </svg>
            <div class="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-sky-700 px-3 py-1 text-xs whitespace-nowrap text-white shadow">
              <Icon name="link" :size="12" /> {{ linkTitle }}: haz clic en la salida (medidor) del tablero que la alimenta
              <button type="button" class="rounded-full bg-white/20 px-2 hover:bg-white/30" @click="cancelLink">Esc · cancelar</button>
            </div>
          </template>
        </div>
      </section>

      <!-- Detalle y problemas -->
      <aside class="flex min-h-0 flex-col gap-3">
        <section class="card min-h-0 flex-1 overflow-auto p-4">
          <PanelDetail
            v-if="selected?.startsWith('p:') && h.panelById.has(parseId(selected))"
            :panel-id="parseId(selected)"
            :issues="selectedIssues"
            @select="focusNode"
            @close="selected = null"
          />
          <SpaceDetail
            v-else-if="selected?.startsWith('s:') && h.spaceById.has(parseId(selected))"
            :space-id="parseId(selected)"
            :issues="selectedIssues"
            @select="focusNode"
            @close="selected = null"
          />
          <div v-else class="space-y-2 text-sm text-slate-600">
            <h3 class="font-semibold text-slate-800">Cómo se usa</h3>
            <ul class="list-disc space-y-1 pl-5 text-xs">
              <template v-if="kind === 'supply'">
                <li>Cada tablero tiene <b>terminales de entrada</b> arriba (E1, E2…) y una <b>salida</b> abajo.</li>
                <li>Arrastra desde la salida de un tablero hasta un terminal (o hasta «+») de otro para alimentarlo.</li>
                <li>Suelta medidores sobre una entrada para asociarlos, sobre «+ entrada» para crear entradas, o sobre la caja para asignarlos como cargas.</li>
                <li>Las aristas punteadas son entradas de un tablero en modo <b>ATS</b> (una activa a la vez).</li>
              </template>
              <template v-else>
                <li>Arrastra desde la salida (abajo) de un espacio hasta otro para anidarlo.</li>
                <li>Suelta medidores sobre la caja de un espacio para ubicarlos ahí.</li>
              </template>
              <li>Suelta medidores en el lienzo vacío para crear un nodo nuevo con ellos.</li>
              <li>Clic en un nodo para editarlo y resaltar su cadena; doble clic en un medidor de la lista para ir a su nodo.</li>
              <li>Clic en una conexión y Supr para desconectarla.</li>
            </ul>
          </div>
        </section>

        <section class="card max-h-[38%] min-h-0 overflow-auto">
          <header class="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <h3 class="text-sm font-semibold">Problemas del diseño</h3>
            <span class="text-xs text-slate-500">{{ issues.length }}</span>
          </header>
          <p v-if="!issues.length" class="flex items-center gap-1.5 px-4 py-3 text-xs text-emerald-700"><Icon name="ok" :size="14" /> Sin problemas detectados</p>
          <ul v-else class="divide-y divide-slate-100">
            <li v-for="(i, k) in issues" :key="k">
              <button type="button" class="flex w-full items-start gap-2 px-4 py-1.5 text-left text-xs hover:bg-slate-50" @click="focusNode(`${kind === 'supply' ? 'p' : 's'}:${i.nodeId}`)">
                <Icon :name="i.severity === 'error' ? 'error' : 'alert'" :size="13" class="mt-px" :class="i.severity === 'error' ? 'text-red-600' : 'text-amber-500'" />
                <span><b class="font-semibold">{{ nodeName(kind, i.nodeId) }}</b>: {{ i.message }}</span>
              </button>
            </li>
          </ul>
        </section>
      </aside>
    </div>

    <FloatingMenu v-if="quick" :key="`${quick.x}-${quick.y}`" :x="quick.x" :y="quick.y" @close="quick = null">
      <form class="space-y-2 p-3" @submit.prevent="createQuick">
        <div class="text-xs font-semibold text-slate-600">{{ kind === 'supply' ? 'Nuevo tablero' : 'Nuevo espacio' }}</div>
        <input v-model="quickName" class="input py-1.5" maxlength="80" autofocus :placeholder="kind === 'supply' ? 'Nombre (p. ej. TGSN-A)' : 'Nombre (p. ej. Piso 3)'" />
        <p v-if="quick.ids.length" class="text-xs text-slate-500">
          {{ formatNumber(quickPlan ? quickPlan.assign.length : quick.ids.length) }} medidor(es) {{ kind === 'supply' ? 'como cargas' : 'dentro' }}
          <span v-if="quickPlan?.moved.length"> · {{ quickPlan.moved.length }} se moverán desde otro tablero</span>
          <span v-if="quickPlan?.blocked.length" class="text-red-600"> · {{ quickPlan.blocked.length }} están en uso en otro tablero y no se mueven</span>
        </p>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" :disabled="!quickName.trim()"><Icon name="plus" :size="12" /> Crear</button>
          <button type="button" class="btn btn-sm" @click="quick = null">Cancelar</button>
        </div>
      </form>
    </FloatingMenu>
  </div>
</template>

<style>
.vue-flow__edge.selected-edge .vue-flow__edge-path {
  stroke: #dc2626 !important;
  stroke-width: 3 !important;
}
.vue-flow__handle.connectingfrom,
.vue-flow__handle.valid {
  box-shadow: 0 0 0 4px rgb(59 130 246 / 0.35);
}
.vue-flow__connection-path {
  stroke: #2563eb;
  stroke-width: 2;
}
</style>
