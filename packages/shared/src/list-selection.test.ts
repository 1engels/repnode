import { describe, expect, it } from 'vitest';
import { checkboxSelect, clickSelect } from './list-selection.ts';

const ids = [10, 20, 30, 40, 50];
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('clickSelect', () => {
  it('clic simple deja solo esa fila y fija el ancla', () => {
    const r = clickSelect(ids, { selected: new Set([10, 20]), anchor: 10 }, 2);
    expect(sorted(r.selected)).toEqual([30]);
    expect(r.anchor).toBe(30);
  });

  it('Ctrl+clic agrega y quita sin tocar el resto', () => {
    let r = clickSelect(ids, { selected: new Set([10]), anchor: 10 }, 3, { ctrl: true });
    expect(sorted(r.selected)).toEqual([10, 40]);
    expect(r.anchor).toBe(40);
    r = clickSelect(ids, r, 0, { ctrl: true });
    expect(sorted(r.selected)).toEqual([40]);
  });

  it('Shift+clic reemplaza por el rango desde el ancla, en ambos sentidos', () => {
    let r = clickSelect(ids, { selected: new Set([50]), anchor: 20 }, 3, { shift: true });
    expect(sorted(r.selected)).toEqual([20, 30, 40]);
    expect(r.anchor).toBe(20);
    r = clickSelect(ids, r, 0, { shift: true });
    expect(sorted(r.selected)).toEqual([10, 20]);
  });

  it('Ctrl+Shift+clic suma el rango a la selección', () => {
    const r = clickSelect(ids, { selected: new Set([50]), anchor: 10 }, 1, { shift: true, ctrl: true });
    expect(sorted(r.selected)).toEqual([10, 20, 50]);
  });

  it('Shift sin ancla visible se comporta como clic simple', () => {
    const r = clickSelect(ids, { selected: new Set([10]), anchor: 99 }, 2, { shift: true });
    expect(sorted(r.selected)).toEqual([30]);
    expect(r.anchor).toBe(30);
  });

  it('índice fuera de rango no cambia nada', () => {
    const r = clickSelect(ids, { selected: new Set([10]), anchor: 10 }, 9);
    expect(sorted(r.selected)).toEqual([10]);
  });
});

describe('checkboxSelect', () => {
  it('alterna una fila y conserva las demás', () => {
    let r = checkboxSelect(ids, { selected: new Set([10]), anchor: null }, 2);
    expect(sorted(r.selected)).toEqual([10, 30]);
    r = checkboxSelect(ids, r, 0);
    expect(sorted(r.selected)).toEqual([30]);
  });

  it('Shift aplica el nuevo estado de la fila a todo el rango', () => {
    let r = checkboxSelect(ids, { selected: new Set(), anchor: 10 }, 3, true);
    expect(sorted(r.selected)).toEqual([10, 20, 30, 40]);
    // Desmarcar con Shift: el rango toma el estado nuevo de la fila clicada (desmarcada)
    r =checkboxSelect(ids, { selected: new Set([10, 20, 30, 40]), anchor: 20 }, 1, true);
    expect(sorted(r.selected)).toEqual([10, 30, 40]);
    r = checkboxSelect(ids, { selected: new Set([10, 20, 30, 40]), anchor: 40 }, 1, true);
    expect(sorted(r.selected)).toEqual([10]);
  });
});
