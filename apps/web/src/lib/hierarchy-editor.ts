import type { ComputedRef, InjectionKey, Ref } from 'vue';
import type { Connection } from '@vue-flow/core';
import type { DesignIssue, HierarchyKind } from '@repnode/shared';
import { useMeterDrag } from './use-meter-drag';

// Contexto que el editor de jerarquías comparte con los nodos del diagrama (provide/inject).

/** Dónde se sueltan medidores */
export type DropTarget =
  | { kind: 'loads'; panelId: number }
  | { kind: 'input'; panelId: number; index: number }
  | { kind: 'new-input'; panelId: number }
  | { kind: 'totalizer'; panelId: number }
  | { kind: 'space'; spaceId: number };

/** Vínculo en curso: el usuario hizo clic en "+ entrada" (index = null) o en el origen de la entrada `index` */
export interface LinkState {
  panelId: number;
  index: number | null;
}

/** Estado de un tablero mientras se elige el origen de un vínculo */
export type LinkRole = 'target' | 'ok' | 'invalid' | null;

/** ok = se puede soltar; blocked = ninguno de los medidores puede ir ahí; none = no hay arrastre */
export type DropState = 'ok' | 'blocked' | 'none';

export interface HierarchyEditor {
  kind: Ref<HierarchyKind>;
  /** Nodo seleccionado (clave 'p:1' / 's:1') */
  selected: Ref<string | null>;
  /** Nodos de la cadena aguas arriba/abajo del seleccionado; null = no atenuar */
  chain: ComputedRef<Set<string> | null>;
  /** Nodo donde está el medidor elegido en la lista */
  meterNode: ComputedRef<string | null>;
  issuesByNode: ComputedRef<Map<number, DesignIssue[]>>;
  dropKey: Ref<string | null>;
  dropState(target: DropTarget): DropState;
  drop(target: DropTarget, sourceIds: number[]): void;
  removeLoad(panelId: number, sourceId: number): void;
  clearTotalizer(panelId: number): void;
  removeMember(spaceId: number, sourceId: number): void;
  /** Vínculo por clics: "+ entrada" (o el origen de una entrada) y luego clic en el tablero que la alimenta */
  link: Ref<LinkState | null>;
  startLink(panelId: number, index: number | null): void;
  linkRole(panelId: number): LinkRole;
  /** `sourceId` = salida de `fromPanelId` en la que se hizo clic (será el medidor de la entrada) */
  completeLink(fromPanelId: number, sourceId?: number | null): void;
  select(key: string): void;
  /** Medidores a arrastrar desde un nodo: la selección de la lista si lo incluye, si no solo ese */
  dragIds(sourceId: number): number[];
  /**
   * Valida una conexión que el usuario arrastra. Va en los handles y no como prop global de VueFlow, porque la
   * global también se aplica a las aristas existentes y descartaría las de las fuentes externas.
   */
  isValidConnection(c: Connection): boolean;
}

export const hierarchyEditorKey: InjectionKey<HierarchyEditor> = Symbol('hierarchy-editor');

export const dropKeyOf = (t: DropTarget): string =>
  t.kind === 'space' ? `s:${t.spaceId}` : t.kind === 'input' ? `p:${t.panelId}:in:${t.index}` : `p:${t.panelId}:${t.kind}`;

/** Manejadores de las zonas donde se sueltan medidores dentro de un nodo; la más interna gana. */
export function useDropZones(editor: HierarchyEditor) {
  const { accepts, read } = useMeterDrag();

  function over(e: DragEvent, t: DropTarget) {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    editor.dropKey.value = dropKeyOf(t);
    if (e.dataTransfer) e.dataTransfer.dropEffect = editor.dropState(t) === 'blocked' ? 'none' : 'move';
  }
  function leave(e: DragEvent, t: DropTarget) {
    if ((e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return;
    if (editor.dropKey.value === dropKeyOf(t)) editor.dropKey.value = null;
  }
  function drop(e: DragEvent, t: DropTarget) {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    editor.dropKey.value = null;
    editor.drop(t, read(e));
  }
  /** Clases de resaltado mientras se arrastra sobre la zona */
  function cls(t: DropTarget): string {
    if (editor.dropKey.value !== dropKeyOf(t)) return '';
    return editor.dropState(t) === 'blocked' ? 'ring-2 ring-red-400 bg-red-50' : 'ring-2 ring-brand-500 bg-brand-50';
  }
  return { over, leave, drop, cls };
}

/** Tamaños estimados de las cajas (se usan para el layout antes de medir el DOM). */
export const NODE_WIDTH = { panel: 300, space: 240, source: 170 } as const;
export const MAX_NODE_METERS = 8;

/** `outputs` = salidas (medidores) + alimentadores de otros tableros sin medidor */
export function estimatePanelHeight(inputs: number, outputs: number): number {
  const shown = Math.min(outputs, MAX_NODE_METERS);
  return 46 + 22 + inputs * 26 + 30 + 52 + 22 + shown * 24 + (outputs > shown ? 20 : 0) + (outputs ? 0 : 26) + 12;
}

export function estimateSpaceHeight(children: number, members: number): number {
  const shown = Math.min(members, MAX_NODE_METERS);
  return 46 + (children ? 22 : 0) + shown * 24 + (members > shown ? 20 : 0) + (members ? 0 : 30) + 12;
}
