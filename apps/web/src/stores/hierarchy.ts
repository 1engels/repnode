import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  diagnoseSpaces, diagnoseSupply, panelSourceIds, spacePlacement, spaceSourceIds, supplyPlacement,
  type FeedRef, type HierarchyDTO, type HierarchyKind, type PanelDTO, type PanelSave, type SpaceDTO, type SpaceSave, type SupplySlot,
} from '@repnode/shared';
import { del, get, post, put } from '../lib/api';
import { createCrossTabSync } from '../lib/cross-tab-sync';
import { useCatalogStore } from './catalog';

const sync = createCrossTabSync('repnode.hierarchy');

/** Cuerpo de PUT /api/panels/:id a partir del DTO (para editar un campo y guardar). */
export function panelToSave(p: PanelDTO): PanelSave {
  return {
    name: p.name,
    mode: p.mode,
    description: p.description,
    inputs: p.inputs.map((i) => ({ fromPanelId: i.fromPanelId, origin: i.origin, label: i.label, sourceId: i.sourceId })),
    totalizerSourceId: p.totalizerSourceId,
    color: p.color,
    icon: p.icon,
  };
}

/** Pone el medidor en un lugar del tablero (sale de cualquier otro lugar del mismo tablero). */
export function placeMeter(body: PanelSave, slot: SupplySlot, sourceId: number): void {
  for (const i of body.inputs) if (i.sourceId === sourceId) i.sourceId = null;
  if (body.totalizerSourceId === sourceId) body.totalizerSourceId = null;
  if (slot.kind === 'input') body.inputs[slot.index].sourceId = sourceId;
  else if (slot.kind === 'totalizer') body.totalizerSourceId = sourceId;
  else if (slot.kind === 'new-input') body.inputs.push({ fromPanelId: null, origin: null, label: null, sourceId });
}

export function spaceToSave(s: SpaceDTO): SpaceSave {
  return { name: s.name, type: s.type, parentId: s.parentId };
}

export interface CreateExtra {
  sourceIds?: number[];
  x?: number | null;
  y?: number | null;
}

export const useHierarchyStore = defineStore('hierarchy', () => {
  const panels = ref<PanelDTO[]>([]);
  const spaces = ref<SpaceDTO[]>([]);
  const loaded = ref(false);

  const panelById = computed(() => new Map(panels.value.map((p) => [p.id, p])));
  const spaceById = computed(() => new Map(spaces.value.map((s) => [s.id, s])));
  const supplyPlace = computed(() => supplyPlacement(panels.value));
  const spacePlace = computed(() => spacePlacement(spaces.value));
  const supplyIssues = computed(() => {
    const catalog = useCatalogStore();
    return diagnoseSupply(panels.value, (id) => catalog.sourceById.get(id)?.name ?? `#${id}`);
  });

  /** "B · E1, C · E2" (con `max`, el resto como "+N") */
  function feedsText(feeds: readonly FeedRef[], max = Infinity): string {
    const list = feeds.map((f) => `${panelById.value.get(f.panelId)?.name ?? '¿?'} · E${f.inputIndex + 1}`);
    return list.length > max ? `${list.slice(0, max).join(', ')} +${list.length - max}` : list.join(', ');
  }
  const spaceIssues = computed(() => diagnoseSpaces(spaces.value));

  // `seq` evita que una recarga lenta pise el resultado de un cambio posterior
  let seq = 0;
  function set(h: HierarchyDTO): void {
    seq++;
    panels.value = h.panels;
    spaces.value = h.spaces;
    loaded.value = true;
  }

  async function load(): Promise<void> {
    set(await get<HierarchyDTO>('/api/hierarchy'));
  }

  async function reload(): Promise<void> {
    if (!loaded.value) return;
    const s = seq;
    const h = await get<HierarchyDTO>('/api/hierarchy');
    if (s === seq) set(h);
  }
  sync.listen(() => void reload().catch(() => {}));

  function reset(): void {
    seq++;
    panels.value = [];
    spaces.value = [];
    loaded.value = false;
  }

  async function mutate(req: Promise<HierarchyDTO>): Promise<void> {
    set(await req);
    sync.notify();
  }

  /** Crea y devuelve el nodo nuevo (el de mayor id que no existía). */
  function newest<T extends { id: number }>(before: Set<number>, list: T[]): T | undefined {
    return list.filter((x) => !before.has(x.id)).sort((a, b) => b.id - a.id)[0];
  }

  async function createPanel(body: PanelSave, extra: CreateExtra = {}): Promise<PanelDTO | undefined> {
    const before = new Set(panels.value.map((p) => p.id));
    await mutate(post<HierarchyDTO>('/api/panels', { ...body, ...extra }));
    return newest(before, panels.value);
  }
  const updatePanel = (id: number, body: PanelSave) => mutate(put<HierarchyDTO>(`/api/panels/${id}`, body));
  const deletePanel = (id: number) => mutate(del<HierarchyDTO>(`/api/panels/${id}`));
  const setPanelLoads = (id: number, sourceIds: number[], action: 'add' | 'remove') =>
    mutate(post<HierarchyDTO>(`/api/panels/${id}/loads`, { sourceIds, action }));

  async function createSpace(body: SpaceSave, extra: CreateExtra = {}): Promise<SpaceDTO | undefined> {
    const before = new Set(spaces.value.map((s) => s.id));
    await mutate(post<HierarchyDTO>('/api/spaces', { ...body, ...extra }));
    return newest(before, spaces.value);
  }
  const updateSpace = (id: number, body: SpaceSave) => mutate(put<HierarchyDTO>(`/api/spaces/${id}`, body));
  const deleteSpace = (id: number) => mutate(del<HierarchyDTO>(`/api/spaces/${id}`));
  const setSpaceMembers = (id: number, sourceIds: number[], action: 'add' | 'remove') =>
    mutate(post<HierarchyDTO>(`/api/spaces/${id}/members`, { sourceIds, action }));

  const unassign = (kind: HierarchyKind, sourceIds: number[]) => mutate(post<HierarchyDTO>('/api/hierarchy/unassign', { kind, sourceIds }));

  /** Guarda posiciones del diagrama; `reset` vuelve todas al layout automático. */
  const saveLayout = (kind: HierarchyKind, positions: { id: number; x: number; y: number }[], reset = false) =>
    mutate(put<HierarchyDTO>('/api/hierarchy/layout', { kind, positions, reset }));

  const panelSources = (ids: number[]) => panelSourceIds(panels.value, ids);
  const spaceSources = (ids: number[]) => spaceSourceIds(spaces.value, ids);

  return {
    panels, spaces, loaded, panelById, spaceById, supplyPlace, spacePlace, supplyIssues, spaceIssues,
    load, reload, reset, createPanel, updatePanel, deletePanel, setPanelLoads, createSpace, updateSpace, deleteSpace,
    setSpaceMembers, unassign, saveLayout, panelSources, spaceSources, feedsText,
  };
});
