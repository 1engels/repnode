// Selección múltiple en listas (lógica pura, sin DOM).
// `ids` es la lista visible en orden; el ancla se guarda por id para sobrevivir a cambios de filtro.

export interface ListSelection {
  selected: Set<number>;
  anchor: number | null;
}

export interface SelectionInput {
  selected: ReadonlySet<number>;
  anchor: number | null;
}

export interface ClickModifiers {
  ctrl?: boolean;
  shift?: boolean;
}

function rangeBounds(ids: readonly number[], anchor: number | null, index: number): [number, number] | null {
  const a = anchor == null ? -1 : ids.indexOf(anchor);
  if (a < 0) return null;
  return a < index ? [a, index] : [index, a];
}

/**
 * Clic estilo explorador de archivos:
 * - clic: solo esa fila
 * - Ctrl+clic: agrega o quita la fila
 * - Shift+clic: rango desde el ancla (reemplaza la selección; con Ctrl se suma)
 */
export function clickSelect(ids: readonly number[], state: SelectionInput, index: number, mods: ClickModifiers = {}): ListSelection {
  const id = ids[index];
  if (id === undefined) return { selected: new Set(state.selected), anchor: state.anchor };
  const bounds = mods.shift ? rangeBounds(ids, state.anchor, index) : null;
  if (bounds) {
    const selected = mods.ctrl ? new Set(state.selected) : new Set<number>();
    for (let i = bounds[0]; i <= bounds[1]; i++) selected.add(ids[i]);
    return { selected, anchor: state.anchor };
  }
  if (mods.ctrl) {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

/**
 * Clic en casilla: alterna la fila sin tocar las demás.
 * Con Shift aplica el nuevo estado de la fila a todo el rango desde el ancla.
 */
export function checkboxSelect(ids: readonly number[], state: SelectionInput, index: number, shift = false): ListSelection {
  const id = ids[index];
  if (id === undefined) return { selected: new Set(state.selected), anchor: state.anchor };
  const selected = new Set(state.selected);
  const willSelect = !selected.has(id);
  const [a, b] = (shift && rangeBounds(ids, state.anchor, index)) || [index, index];
  for (let i = a; i <= b; i++) {
    if (willSelect) selected.add(ids[i]);
    else selected.delete(ids[i]);
  }
  return { selected, anchor: id };
}
