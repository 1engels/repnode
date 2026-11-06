import type { PanelDTO, SpaceDTO } from './types.ts';

// Lógica pura de las jerarquías (Suministro y Comercial), compartida por el servidor y la GUI.
// Suministro es un grafo: un tablero puede tener varias entradas desde distintos tableros.
// Comercial es un árbol: cada espacio tiene a lo sumo un padre.
//
// Lugares de un medidor en Suministro (uno solo por medidor):
// - salida (carga) de un tablero: está físicamente en ese tablero. Si alimenta a otro tablero, la entrada de ese otro
//   tablero solo lo *referencia* (la entrada desde X usa una salida de X); quitar la entrada no mueve el medidor.
//   Una misma salida puede alimentar entradas de varios tableros (derivación), siempre que vengan de X.
// - medidor de una entrada desde fuente externa (red pública, grupo…): está en el tablero que recibe.
// - totalizador interno del tablero.

type PanelLike = Pick<PanelDTO, 'id' | 'name' | 'mode' | 'inputs' | 'loadSourceIds' | 'missing' | 'totalizerSourceId' | 'missingTotalizer'>;
type SpaceLike = Pick<SpaceDTO, 'id' | 'parentId' | 'name' | 'sourceIds' | 'missing'>;

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
export const compareNodeNames = (a: { name: string }, b: { name: string }): number => collator.compare(a.name, b.name);

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  let arr = m.get(k);
  if (!arr) m.set(k, (arr = []));
  arr.push(v);
}

// ---------------------------------------------------------------------------
// Suministro
// ---------------------------------------------------------------------------

/** Tablero padre primario: el de la primera entrada que viene de otro tablero. */
export function primaryParent(panel: Pick<PanelDTO, 'inputs'>): number | null {
  for (const i of panel.inputs) if (i.fromPanelId != null) return i.fromPanelId;
  return null;
}

/** Tablero → tableros que alimenta (sin repetir aunque haya varias entradas desde el mismo padre). */
export function supplyChildren(panels: readonly PanelLike[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const p of panels) {
    const seen = new Set<number>();
    for (const i of p.inputs) {
      if (i.fromPanelId == null || seen.has(i.fromPanelId)) continue;
      seen.add(i.fromPanelId);
      push(m, i.fromPanelId, p.id);
    }
  }
  return m;
}

function walk(start: Iterable<number>, next: (id: number) => readonly number[] | undefined): Set<number> {
  const out = new Set<number>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const n of next(id) ?? []) stack.push(n);
  }
  return out;
}

/** Tableros alcanzados aguas abajo, incluidos los de partida. */
export function supplyDownstream(panels: readonly PanelLike[], ids: Iterable<number>): Set<number> {
  const children = supplyChildren(panels);
  return walk(ids, (id) => children.get(id));
}

/** Tableros aguas arriba (los que alimentan, directa o indirectamente), incluidos los de partida. */
export function supplyUpstream(panels: readonly PanelLike[], ids: Iterable<number>): Set<number> {
  const parents = new Map<number, number[]>();
  for (const p of panels) for (const i of p.inputs) if (i.fromPanelId != null) push(parents, p.id, i.fromPanelId);
  return walk(ids, (id) => parents.get(id));
}

/** ¿Conectar `panelId` desde estos tableros crearía un ciclo? */
export function wouldCreateSupplyCycle(panels: readonly PanelLike[], panelId: number, fromPanelIds: Iterable<number | null>): boolean {
  const down = supplyDownstream(panels, [panelId]);
  for (const f of fromPanelIds) if (f != null && down.has(f)) return true;
  return false;
}

/** Medidores de los tableros (entradas, totalizador y salidas) y, salvo `downstream: false`, de todo su aguas abajo. */
export function panelSourceIds(panels: readonly PanelLike[], ids: Iterable<number>, { downstream = true } = {}): number[] {
  const want = downstream ? supplyDownstream(panels, ids) : new Set(ids);
  const out = new Set<number>();
  for (const p of panels) {
    if (!want.has(p.id)) continue;
    for (const i of p.inputs) if (i.sourceId != null) out.add(i.sourceId);
    if (p.totalizerSourceId != null) out.add(p.totalizerSourceId);
    for (const s of p.loadSourceIds) out.add(s);
  }
  return [...out];
}

/**
 * Tableros en orden de árbol (cada uno bajo su padre primario, hermanos por nombre) con su profundidad, para listas
 * indentadas como un select. Un tablero cuyo padre primario no existe queda como raíz.
 */
export function supplyPanelOrder(panels: readonly PanelLike[]): { id: number; name: string; depth: number }[] {
  const ids = new Set(panels.map((p) => p.id));
  const children = new Map<number | null, PanelLike[]>();
  for (const p of panels) {
    const parent = primaryParent(p);
    push(children, parent != null && ids.has(parent) ? parent : null, p);
  }
  const out: { id: number; name: string; depth: number }[] = [];
  const seen = new Set<number>();
  const visit = (parent: number | null, depth: number): void => {
    for (const p of [...(children.get(parent) ?? [])].sort(compareNodeNames)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name, depth });
      visit(p.id, depth + 1);
    }
  };
  visit(null, 0);
  // Por si un ciclo dejara tableros sin raíz
  for (const p of [...panels].sort(compareNodeNames)) if (!seen.has(p.id)) out.push({ id: p.id, name: p.name, depth: 0 });
  return out;
}

export interface SupplyPlace {
  panelId: number;
  /** load = salida del tablero; input = medidor de una entrada desde fuente externa; totalizer = totalizador interno */
  role: 'input' | 'load' | 'totalizer';
  /** Índice de la entrada (si role = 'input') */
  inputIndex?: number;
  /** Entradas que alimenta esta salida (varias = derivación); ausente si no alimenta a ninguna */
  feeds?: FeedRef[];
}

export interface FeedRef {
  panelId: number;
  inputIndex: number;
}

/** Dónde está cada medidor en Suministro. */
export function supplyPlacement(panels: readonly PanelLike[]): Map<number, SupplyPlace> {
  const m = new Map<number, SupplyPlace>();
  for (const p of panels) {
    for (const s of p.loadSourceIds) m.set(s, { panelId: p.id, role: 'load' });
    if (p.totalizerSourceId != null) m.set(p.totalizerSourceId, { panelId: p.id, role: 'totalizer' });
  }
  for (const p of panels) {
    p.inputs.forEach((i, inputIndex) => {
      if (i.sourceId == null) return;
      if (i.fromPanelId == null) m.set(i.sourceId, { panelId: p.id, role: 'input', inputIndex });
      else {
        // La entrada referencia una salida del tablero de origen
        const cur = m.get(i.sourceId);
        const feeds = [...(cur?.feeds ?? []), { panelId: p.id, inputIndex }];
        m.set(i.sourceId, { panelId: cur?.role === 'load' ? cur.panelId : i.fromPanelId, role: 'load', feeds });
      }
    });
  }
  return m;
}

/** Entradas de otros tableros que vienen del tablero `panelId`, con el medidor de salida que las alimenta. */
export function panelFeeds(panels: readonly PanelLike[], panelId: number): { sourceId: number | null; toPanelId: number; inputIndex: number }[] {
  const out: { sourceId: number | null; toPanelId: number; inputIndex: number }[] = [];
  for (const p of panels) {
    p.inputs.forEach((i, inputIndex) => {
      if (i.fromPanelId === panelId) out.push({ sourceId: i.sourceId, toPanelId: p.id, inputIndex });
    });
  }
  return out;
}

export interface PanelOutput {
  /** null = entrada de otro tablero que viene de aquí pero aún sin medidor */
  sourceId: number | null;
  /** Entradas que alimenta (varias = derivación) */
  feeds: FeedRef[];
}

/**
 * Salidas de un tablero para mostrar: primero las que alimentan a otros tableros (una fila por medidor con todos sus
 * destinos; las entradas sin medidor, una fila cada una) y luego las cargas.
 */
export function panelOutputs(panels: readonly PanelLike[], panelId: number): PanelOutput[] {
  const p = panels.find((x) => x.id === panelId);
  if (!p) return [];
  const loads = new Set(p.loadSourceIds);
  const bySource = new Map<number, PanelOutput>();
  const out: PanelOutput[] = [];
  for (const f of panelFeeds(panels, panelId)) {
    const ref = { panelId: f.toPanelId, inputIndex: f.inputIndex };
    if (f.sourceId == null || !loads.has(f.sourceId)) out.push({ sourceId: null, feeds: [ref] });
    else {
      let row = bySource.get(f.sourceId);
      if (!row) {
        bySource.set(f.sourceId, (row = { sourceId: f.sourceId, feeds: [] }));
        out.push(row);
      }
      row.feeds.push(ref);
    }
  }
  for (const s of p.loadSourceIds) if (!bySource.has(s)) out.push({ sourceId: s, feeds: [] });
  return out;
}

// ---------------------------------------------------------------------------
// Diagrama: carriles de las aristas que salen de un mismo tablero
// ---------------------------------------------------------------------------

export interface LaneEdge {
  id: string;
  source: string;
  /** X del punto de salida y del terminal de destino */
  sourceX: number;
  targetX: number;
}

export interface EdgeLane {
  /** 0 = el tramo horizontal más cercano al origen */
  lane: number;
  /** Carriles del grupo (aristas del mismo origen hacia el mismo lado) */
  lanes: number;
}

/**
 * Las aristas de un mismo origen bajan juntas y cada una dobla en su propio carril. Hacia cada lado, la del destino
 * más lejano dobla primero: así no se cruzan y sus etiquetas (que van en el tramo horizontal) no se superponen.
 */
export function edgeLanes(edges: readonly LaneEdge[]): Map<string, EdgeLane> {
  const groups = new Map<string, LaneEdge[]>();
  for (const e of edges) push(groups, `${e.source}|${e.targetX < e.sourceX ? 'L' : 'R'}`, e);
  const out = new Map<string, EdgeLane>();
  for (const g of groups.values()) {
    g.sort((a, b) => Math.abs(b.targetX - b.sourceX) - Math.abs(a.targetX - a.sourceX) || a.id.localeCompare(b.id));
    g.forEach((e, lane) => out.set(e.id, { lane, lanes: g.length }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comercial
// ---------------------------------------------------------------------------

/** Espacio → hijos. Los espacios sin padre (o con un padre inexistente) cuelgan de `null`. */
export function spaceChildren(spaces: readonly SpaceLike[]): Map<number | null, number[]> {
  const ids = new Set(spaces.map((s) => s.id));
  const m = new Map<number | null, number[]>();
  for (const s of spaces) push(m, s.parentId != null && ids.has(s.parentId) ? s.parentId : null, s.id);
  return m;
}

/** Espacios del subárbol, incluidos los de partida. */
export function spaceDescendants(spaces: readonly SpaceLike[], ids: Iterable<number>): Set<number> {
  const children = spaceChildren(spaces);
  return walk(ids, (id) => children.get(id));
}

/** Camino desde la raíz hasta el espacio (incluido). */
export function spacePath(spaces: readonly SpaceLike[], id: number): number[] {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const path: number[] = [];
  const seen = new Set<number>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId != null ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    path.unshift(cur.id);
  }
  return path;
}

/** ¿Mover `spaceId` bajo `newParentId` crearía un ciclo? */
export function wouldCreateSpaceCycle(spaces: readonly SpaceLike[], spaceId: number, newParentId: number | null): boolean {
  return newParentId != null && spaceDescendants(spaces, [spaceId]).has(newParentId);
}

/** Medidores de los espacios y de sus subespacios. */
export function spaceSourceIds(spaces: readonly SpaceLike[], ids: Iterable<number>): number[] {
  const want = spaceDescendants(spaces, ids);
  const out = new Set<number>();
  for (const s of spaces) if (want.has(s.id)) s.sourceIds.forEach((id) => out.add(id));
  return [...out];
}

/** Medidor → espacio. */
export function spacePlacement(spaces: readonly SpaceLike[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of spaces) for (const id of s.sourceIds) if (!m.has(id)) m.set(id, s.id);
  return m;
}

// ---------------------------------------------------------------------------
// Soltar medidores sobre un nodo
// ---------------------------------------------------------------------------

/**
 * Por qué no se puede asignar un medidor: es medidor de entrada externa o totalizador de otro tablero, o es una salida
 * que alimenta la entrada de otro tablero (moverla rompería esa conexión; solo puede usarse en otra entrada desde su
 * mismo tablero).
 */
export type BlockReason = 'input' | 'totalizer' | 'feeder';

export interface DropPlan {
  /** Medidores a enviar (nuevos + movidos desde otro lugar) */
  assign: number[];
  moved: { sourceId: number; fromId: number }[];
  /** No se pueden asignar; `fromId` = tablero donde están (o al que alimentan, si reason = 'feeder') */
  blocked: { sourceId: number; fromId: number; reason?: BlockReason }[];
  /** Ya estaban en el destino */
  unchanged: number[];
}

const emptyPlan = (): DropPlan => ({ assign: [], moved: [], blocked: [], unchanged: [] });

/** Lugar de un tablero donde se asignan medidores */
export type SupplySlot = { kind: 'load' } | { kind: 'new-input' } | { kind: 'input'; index: number } | { kind: 'totalizer' };

/**
 * Qué pasa al asignar medidores a un lugar del tablero `panelId`. Un medidor puede cambiar de lugar dentro del mismo
 * tablero o venir de una salida libre de otro; no se toca lo que es entrada o totalizador de otro tablero ni una salida
 * que ya alimenta a otro tablero. La entrada desde X usa una salida de X: si el medidor no lo es, pasa a serlo; si ya
 * alimenta a otros tableros, se comparte (derivación).
 */
export function planSupply(panels: readonly PanelLike[], panelId: number, slot: SupplySlot, sourceIds: Iterable<number>): DropPlan {
  const place = supplyPlacement(panels);
  const target = slot.kind === 'input' ? panels.find((p) => p.id === panelId)?.inputs[slot.index] : undefined;
  const plan = emptyPlan();
  for (const sid of new Set(sourceIds)) {
    const p = place.get(sid);
    if (!p) {
      plan.assign.push(sid);
      continue;
    }
    const here =
      (slot.kind === 'load' && p.role === 'load' && p.panelId === panelId) ||
      (slot.kind === 'totalizer' && p.role === 'totalizer' && p.panelId === panelId) ||
      (slot.kind === 'new-input' && p.role === 'input' && p.panelId === panelId) ||
      (slot.kind === 'input' &&
        ((p.role === 'input' && p.panelId === panelId && p.inputIndex === slot.index) ||
          !!p.feeds?.some((f) => f.panelId === panelId && f.inputIndex === slot.index)));
    // Derivación: la entrada viene del tablero donde está la salida y este tablero aún no la usa
    const shared = slot.kind === 'input' && target?.fromPanelId === p.panelId && !p.feeds?.some((f) => f.panelId === panelId);
    const feedsOther = !shared && p.feeds?.find((f) => f.panelId !== panelId);
    if (here) plan.unchanged.push(sid);
    else if (p.role !== 'load' && p.panelId !== panelId) plan.blocked.push({ sourceId: sid, fromId: p.panelId, reason: p.role });
    else if (feedsOther) plan.blocked.push({ sourceId: sid, fromId: feedsOther.panelId, reason: 'feeder' });
    else {
      plan.assign.push(sid);
      // Usar una salida del tablero de origen como medidor de la entrada no la mueve
      const sameSource = slot.kind === 'input' && target?.fromPanelId != null && p.role === 'load' && p.panelId === target.fromPanelId;
      if (!sameSource) plan.moved.push({ sourceId: sid, fromId: p.panelId });
    }
  }
  return plan;
}

export interface SupplyConflict {
  sourceId: number;
  reason: BlockReason | 'duplicate';
  /** Tablero donde está el medidor (o al que alimenta, si reason = 'feeder') */
  panelId: number;
}

/**
 * Conflictos al guardar las entradas y el totalizador de un tablero (se ignora lo que ese tablero tenía antes). Una
 * salida que ya alimenta a otros tableros solo se acepta en una entrada que venga de su mismo tablero (derivación).
 */
export function supplySaveConflicts(
  panels: readonly PanelLike[],
  panelId: number,
  save: { inputs: { sourceId: number | null; fromPanelId?: number | null }[]; totalizerSourceId: number | null },
): SupplyConflict[] {
  const others = panels.map((p) => (p.id === panelId ? { ...p, inputs: [], totalizerSourceId: null } : p));
  const place = supplyPlacement(others);
  const seen = new Set<number>();
  const out: SupplyConflict[] = [];
  const slots = [...save.inputs.map((i) => ({ sid: i.sourceId, from: i.fromPanelId ?? null })), { sid: save.totalizerSourceId, from: null }];
  for (const { sid, from } of slots) {
    if (sid == null) continue;
    if (seen.has(sid)) {
      out.push({ sourceId: sid, reason: 'duplicate', panelId });
      continue;
    }
    seen.add(sid);
    const p = place.get(sid);
    if (!p) continue;
    if (p.role !== 'load') out.push({ sourceId: sid, reason: p.role, panelId: p.panelId });
    else if (p.feeds?.length && !(from != null && from === p.panelId)) out.push({ sourceId: sid, reason: 'feeder', panelId: p.feeds[0].panelId });
  }
  return out;
}

/** Medidores soltados en un espacio: se mueven desde su espacio anterior. */
export function planSpaceMembers(spaces: readonly SpaceLike[], spaceId: number, sourceIds: Iterable<number>): DropPlan {
  const place = spacePlacement(spaces);
  const plan = emptyPlan();
  for (const sid of new Set(sourceIds)) {
    const from = place.get(sid);
    if (from === spaceId) plan.unchanged.push(sid);
    else {
      plan.assign.push(sid);
      if (from != null) plan.moved.push({ sourceId: sid, fromId: from });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Diagnóstico del diseño
// ---------------------------------------------------------------------------

export type DesignIssueKind =
  | 'missing_loads'
  | 'missing_totalizer'
  | 'missing_input_meter'
  | 'input_without_meter'
  | 'input_without_origin'
  | 'no_inputs'
  | 'ats_single_input'
  | 'shared_feeder'
  | 'no_outputs'
  | 'empty_panel'
  | 'missing_members'
  | 'empty_space';

export interface DesignIssue {
  severity: 'error' | 'warning';
  kind: DesignIssueKind;
  nodeId: number;
  /** Índice de la entrada, si el problema es de una entrada */
  inputIndex?: number;
  /** Medidor, si el problema es de un medidor (derivación) */
  sourceId?: number;
  message: string;
}

const entrada = (p: { inputs: { label: string | null }[] }, i: number) => `Entrada ${i + 1}${p.inputs[i].label ? ` (${p.inputs[i].label})` : ''}`;

/** `meterName` da el nombre de los medidores para los mensajes (sin él se usa el ID). */
export function diagnoseSupply(panels: readonly PanelLike[], meterName: (sourceId: number) => string = (id) => `#${id}`): DesignIssue[] {
  const out: DesignIssue[] = [];
  const children = supplyChildren(panels);
  const byId = new Map(panels.map((p) => [p.id, p]));
  const shared = [...supplyPlacement(panels)].filter(([, pl]) => (pl.feeds?.length ?? 0) > 1);
  for (const p of [...panels].sort(compareNodeNames)) {
    const issue = (severity: DesignIssue['severity'], kind: DesignIssueKind, message: string, inputIndex?: number) =>
      out.push({ severity, kind, nodeId: p.id, message, ...(inputIndex != null ? { inputIndex } : {}) });
    const hasOutputs = p.loadSourceIds.length > 0 || (children.get(p.id)?.length ?? 0) > 0;
    if (p.missing) issue('error', 'missing_loads', `${p.missing} salida(s) ya no existen en la base de datos`);
    if (p.missingTotalizer) issue('error', 'missing_totalizer', 'El medidor totalizador guardado ya no existe en la base de datos');
    if (!p.inputs.length && !hasOutputs) {
      issue('warning', 'empty_panel', 'Tablero vacío: sin entradas, cargas ni tableros aguas abajo');
      continue;
    }
    if (!p.inputs.length) issue('warning', 'no_inputs', 'Sin fuente de alimentación: agrega una entrada desde otro tablero o una fuente externa');
    p.inputs.forEach((inp, i) => {
      if (inp.missingMeter) issue('error', 'missing_input_meter', `${entrada(p, i)}: el medidor guardado ya no existe en la base de datos`, i);
      else if (inp.sourceId == null) issue('warning', 'input_without_meter', `${entrada(p, i)} sin medidor asociado`, i);
      if (inp.fromPanelId == null && !inp.origin) issue('warning', 'input_without_origin', `${entrada(p, i)}: indica el tablero de origen o la fuente externa`, i);
    });
    if (p.mode === 'ats' && p.inputs.length < 2) issue('warning', 'ats_single_input', 'Modo ATS con una sola entrada: agrega la fuente de respaldo o usa el modo suma');
    if (!hasOutputs) issue('warning', 'no_outputs', 'Sin cargas ni tableros aguas abajo');
    for (const [sid, pl] of shared) {
      if (pl.panelId !== p.id) continue;
      const to = pl.feeds!.map((f) => `${byId.get(f.panelId)?.name ?? '¿?'} · E${f.inputIndex + 1}`).join(', ');
      out.push({
        severity: 'warning', kind: 'shared_feeder', nodeId: p.id, sourceId: sid,
        message: `${meterName(sid)} alimenta una derivación (${to}): mide la suma, no cada entrada por separado`,
      });
    }
  }
  return out;
}

export function diagnoseSpaces(spaces: readonly SpaceLike[]): DesignIssue[] {
  const out: DesignIssue[] = [];
  const children = spaceChildren(spaces);
  for (const s of [...spaces].sort(compareNodeNames)) {
    if (s.missing) out.push({ severity: 'error', kind: 'missing_members', nodeId: s.id, message: `${s.missing} medidor(es) ya no existen en la base de datos` });
    if (!s.sourceIds.length && !children.get(s.id)?.length) out.push({ severity: 'warning', kind: 'empty_space', nodeId: s.id, message: 'Espacio vacío: sin medidores ni subespacios' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Árbol aplanado para listas virtualizadas (selector de medidores)
// ---------------------------------------------------------------------------

/** input = medidor de una entrada del tablero (externa o referencia a la salida del tablero de origen) */
export type MeterRole = 'input' | 'load' | 'totalizer' | 'member' | 'unassigned';

export type TreeRow =
  | { kind: 'panel'; key: string; depth: number; id: number; count: number; hasChildren: boolean; expanded: boolean }
  /** Tablero alimentado también desde este padre: acceso directo a la instancia real */
  | { kind: 'link'; key: string; depth: number; id: number; parentId: number; count: number }
  | { kind: 'space'; key: string; depth: number; id: number; count: number; hasChildren: boolean; expanded: boolean }
  | { kind: 'meter'; key: string; depth: number; sourceId: number; role: MeterRole; nodeId: number | null; inputIndex?: number }
  | { kind: 'unassigned'; key: string; depth: number; count: number; expanded: boolean };

export const treeKey = {
  panel: (id: number) => `p:${id}`,
  space: (id: number) => `s:${id}`,
  unassigned: 'u',
};

export interface FlattenOptions {
  /** Medidores existentes en orden de presentación: define el orden y el grupo "Sin ubicar" */
  sourceIds: readonly number[];
  /** Claves (`treeKey`) de los nodos expandidos */
  expanded: ReadonlySet<string>;
  /** Solo se muestran los medidores que cumplen */
  match?: ((sourceId: number) => boolean) | null;
  /** Oculta los nodos sin medidores visibles en su subárbol */
  prune?: boolean;
  /** Expande todo (p. ej. mientras hay una búsqueda) */
  expandAll?: boolean;
}

function meterHelpers(opts: FlattenOptions) {
  const order = new Map(opts.sourceIds.map((id, i) => [id, i]));
  const match = opts.match ?? (() => true);
  const visible = (sid: number | null): sid is number => sid != null && order.has(sid) && match(sid);
  const ordered = (ids: readonly number[]) => ids.filter(visible).sort((a, b) => order.get(a)! - order.get(b)!);
  return { visible, ordered, match };
}

export function flattenSupplyTree(panels: readonly PanelLike[], opts: FlattenOptions): TreeRow[] {
  const { visible, ordered, match } = meterHelpers(opts);
  const byId = new Map(panels.map((p) => [p.id, p]));
  const primaryKids = new Map<number | null, number[]>();
  const linkKids = new Map<number, number[]>();
  for (const p of [...panels].sort(compareNodeNames)) {
    const prim = primaryParent(p);
    const parent = prim != null && byId.has(prim) && prim !== p.id ? prim : null;
    push(primaryKids, parent, p.id);
    const seen = new Set<number | null>([parent]);
    for (const i of p.inputs) {
      if (i.fromPanelId == null || seen.has(i.fromPanelId) || !byId.has(i.fromPanelId)) continue;
      seen.add(i.fromPanelId);
      push(linkKids, i.fromPanelId, p.id);
    }
  }

  // Medidores visibles por tablero, con su aguas abajo (lo que selecciona marcar el nodo)
  const children = supplyChildren(panels);
  const own = (p: PanelLike) => [...p.inputs.map((i) => i.sourceId).filter(visible), ...[p.totalizerSourceId].filter(visible), ...p.loadSourceIds.filter(visible)];
  const countMemo = new Map<number, number>();
  const count = (id: number) => {
    let n = countMemo.get(id);
    if (n == null) {
      const set = new Set<number>();
      for (const d of walk([id], (x) => children.get(x))) {
        const p = byId.get(d);
        if (p) own(p).forEach((s) => set.add(s));
      }
      countMemo.set(id, (n = set.size));
    }
    return n;
  };

  // Tableros en un ciclo (no debería haber) no son alcanzables desde las raíces: se muestran como raíces
  const reachable = walk(primaryKids.get(null) ?? [], (id) => primaryKids.get(id));
  const roots = [...(primaryKids.get(null) ?? []), ...[...panels].sort(compareNodeNames).filter((p) => !reachable.has(p.id)).map((p) => p.id)];

  const rows: TreeRow[] = [];
  const done = new Set<number>();
  const emit = (id: number, depth: number) => {
    if (done.has(id)) return;
    done.add(id);
    const p = byId.get(id)!;
    const c = count(id);
    if (opts.prune && !c) return;
    const key = treeKey.panel(id);
    const inputs = p.inputs.map((i, idx) => ({ sid: i.sourceId, idx, ref: i.fromPanelId != null })).filter((x) => visible(x.sid));
    const totalizer = visible(p.totalizerSourceId) ? p.totalizerSourceId : null;
    const loads = ordered(p.loadSourceIds);
    const kids = primaryKids.get(id) ?? [];
    const links = (linkKids.get(id) ?? []).filter((l) => !opts.prune || count(l));
    const expanded = !!opts.expandAll || opts.expanded.has(key);
    rows.push({ kind: 'panel', key, depth, id, count: c, hasChildren: inputs.length + loads.length + kids.length + links.length + (totalizer != null ? 1 : 0) > 0, expanded });
    if (!expanded) {
      // Igual se marcan como recorridos para que no reaparezcan como raíces
      walk(kids, (x) => primaryKids.get(x)).forEach((x) => done.add(x));
      return;
    }
    // Una entrada desde otro tablero referencia una salida de ese tablero: aparece en ambos (clave propia)
    for (const x of inputs) {
      rows.push({ kind: 'meter', key: x.ref ? `f:${id}:${x.idx}` : `m:${x.sid}`, depth: depth + 1, sourceId: x.sid!, role: 'input', nodeId: id, inputIndex: x.idx });
    }
    if (totalizer != null) rows.push({ kind: 'meter', key: `m:${totalizer}`, depth: depth + 1, sourceId: totalizer, role: 'totalizer', nodeId: id });
    for (const k of kids) emit(k, depth + 1);
    for (const l of links) rows.push({ kind: 'link', key: `l:${id}:${l}`, depth: depth + 1, id: l, parentId: id, count: count(l) });
    for (const s of loads) rows.push({ kind: 'meter', key: `m:${s}`, depth: depth + 1, sourceId: s, role: 'load', nodeId: id });
  };
  for (const r of roots) emit(r, 0);

  const placed = supplyPlacement(panels);
  pushUnassigned(rows, opts.sourceIds.filter((s) => !placed.has(s) && match(s)), opts);
  return rows;
}

export function flattenSpaceTree(spaces: readonly SpaceLike[], opts: FlattenOptions): TreeRow[] {
  const { visible, ordered, match } = meterHelpers(opts);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const children = spaceChildren(spaces);
  for (const arr of children.values()) arr.sort((a, b) => compareNodeNames(byId.get(a)!, byId.get(b)!));

  const countMemo = new Map<number, number>();
  const count = (id: number) => {
    let n = countMemo.get(id);
    if (n == null) {
      n = 0;
      for (const d of walk([id], (x) => children.get(x))) n += byId.get(d)!.sourceIds.filter(visible).length;
      countMemo.set(id, n);
    }
    return n;
  };

  const reachable = walk(children.get(null) ?? [], (id) => children.get(id));
  const roots = [...(children.get(null) ?? []), ...[...spaces].sort(compareNodeNames).filter((s) => !reachable.has(s.id)).map((s) => s.id)];

  const rows: TreeRow[] = [];
  const done = new Set<number>();
  const emit = (id: number, depth: number) => {
    if (done.has(id)) return;
    done.add(id);
    const s = byId.get(id)!;
    const c = count(id);
    if (opts.prune && !c) return;
    const key = treeKey.space(id);
    const kids = children.get(id) ?? [];
    const members = ordered(s.sourceIds);
    const expanded = !!opts.expandAll || opts.expanded.has(key);
    rows.push({ kind: 'space', key, depth, id, count: c, hasChildren: kids.length + members.length > 0, expanded });
    if (!expanded) {
      walk(kids, (x) => children.get(x)).forEach((x) => done.add(x));
      return;
    }
    for (const k of kids) emit(k, depth + 1);
    for (const m of members) rows.push({ kind: 'meter', key: `m:${m}`, depth: depth + 1, sourceId: m, role: 'member', nodeId: id });
  };
  for (const r of roots) emit(r, 0);

  const placed = spacePlacement(spaces);
  pushUnassigned(rows, opts.sourceIds.filter((s) => !placed.has(s) && match(s)), opts);
  return rows;
}

function pushUnassigned(rows: TreeRow[], ids: number[], opts: FlattenOptions): void {
  if (!ids.length) return;
  const expanded = !!opts.expandAll || opts.expanded.has(treeKey.unassigned);
  rows.push({ kind: 'unassigned', key: treeKey.unassigned, depth: 0, count: ids.length, expanded });
  if (expanded) for (const s of ids) rows.push({ kind: 'meter', key: `m:${s}`, depth: 1, sourceId: s, role: 'unassigned', nodeId: null });
}
