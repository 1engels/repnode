import { describe, expect, it } from 'vitest';
import {
  diagnoseSpaces, diagnoseSupply, edgeLanes, flattenSpaceTree, flattenSupplyTree, panelFeeds, panelOutputs, panelSourceIds, planSpaceMembers, planSupply,
  spacePath, spaceSourceIds, supplyDownstream, supplyPanelOrder, supplyPlacement, supplySaveConflicts, supplyUpstream, treeKey,
  wouldCreateSpaceCycle, wouldCreateSupplyCycle, type TreeRow,
} from './hierarchy.ts';
import type { PanelDTO, PanelInputDTO, SpaceDTO } from './types.ts';

let inputId = 1;
const input = (fromPanelId: number | null, sourceId: number | null, extra: Partial<PanelInputDTO> = {}): PanelInputDTO => ({
  id: inputId++, fromPanelId, origin: fromPanelId == null ? 'Red pública' : null, label: null, sourceId, missingMeter: false, ...extra,
});
const panel = (id: number, name: string, inputs: PanelInputDTO[] = [], loadSourceIds: number[] = [], extra: Partial<PanelDTO> = {}): PanelDTO => ({
  id, name, mode: 'sum', description: null, x: null, y: null, inputs, loadSourceIds, missing: 0, totalizerSourceId: null, missingTotalizer: false, color: null, icon: 'other', ...extra,
});
const space = (id: number, name: string, parentId: number | null, sourceIds: number[] = []): SpaceDTO => ({
  id, name, parentId, type: null, x: null, y: null, sourceIds, missing: 0,
});
const sorted = (a: Iterable<number>) => [...a].sort((x, y) => x - y);
const keys = (rows: TreeRow[]) => rows.map((r) => r.key);

// TGNA-1/2/3 alimentan a TGSN-A (ejemplo del diseño); TGSN-A alimenta a UMA-1.
// Los medidores de las entradas desde otro tablero son salidas de ese tablero (201, 202, 203, 301).
const supply = () => [
  panel(1, 'TGNA-1', [input(null, 101)], [111, 201]),
  panel(2, 'TGNA-2', [input(null, 102)], [202]),
  panel(3, 'TGNA-3', [input(null, 103)], [203]),
  panel(4, 'TGSN-A', [input(1, 201), input(2, 202), input(3, 203)], [210, 211, 301], { mode: 'ats', totalizerSourceId: 220 }),
  panel(5, 'UMA-1', [input(4, 301)], [310]),
];
const allMeters = [101, 102, 103, 111, 201, 202, 203, 210, 211, 220, 301, 310, 900, 901];

describe('suministro: grafo', () => {
  it('aguas abajo y aguas arriba', () => {
    expect(sorted(supplyDownstream(supply(), [2]))).toEqual([2, 4, 5]);
    expect(sorted(supplyUpstream(supply(), [5]))).toEqual([1, 2, 3, 4, 5]);
  });

  it('detecta ciclos, incluido conectarse a sí mismo', () => {
    expect(wouldCreateSupplyCycle(supply(), 1, [5])).toBe(true);
    expect(wouldCreateSupplyCycle(supply(), 4, [4])).toBe(true);
    expect(wouldCreateSupplyCycle(supply(), 5, [1, 2, null])).toBe(false);
  });

  it('medidores de un tablero: entradas + totalizador + salidas + aguas abajo, sin duplicar en diamantes', () => {
    expect(sorted(panelSourceIds(supply(), [4]))).toEqual([201, 202, 203, 210, 211, 220, 301, 310]);
    // Diamante: 1 → 2, 1 → 3, 2 → 4, 3 → 4
    const diamond = [panel(1, 'A', [], [1, 2, 3]), panel(2, 'B', [input(1, 2)], [4]), panel(3, 'C', [input(1, 3)], [5]), panel(4, 'D', [input(2, 4), input(3, 5)], [6])];
    expect(sorted(panelSourceIds(diamond, [1]))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('medidores solo del tablero (sin aguas abajo)', () => {
    expect(sorted(panelSourceIds(supply(), [4], { downstream: false }))).toEqual([201, 202, 203, 210, 211, 220, 301]);
    expect(sorted(panelSourceIds(supply(), [5], { downstream: false }))).toEqual([301, 310]);
  });

  it('orden de árbol de los tableros: bajo su padre primario, hermanos por nombre', () => {
    const list = [...supply(), panel(6, 'A-SUELTO'), panel(7, 'UMA-0', [input(4, null)])];
    expect(supplyPanelOrder(list).map((p) => `${p.depth}:${p.name}`)).toEqual([
      '0:A-SUELTO', '0:TGNA-1', '1:TGSN-A', '2:UMA-0', '2:UMA-1', '0:TGNA-2', '0:TGNA-3',
    ]);
  });

  it('ubicación: la entrada desde otro tablero referencia una salida de ese tablero', () => {
    const place = supplyPlacement(supply());
    expect(place.get(202)).toEqual({ panelId: 2, role: 'load', feeds: [{ panelId: 4, inputIndex: 1 }] });
    expect(place.get(101)).toEqual({ panelId: 1, role: 'input', inputIndex: 0 });
    expect(place.get(220)).toEqual({ panelId: 4, role: 'totalizer' });
    expect(place.get(310)).toEqual({ panelId: 5, role: 'load' });
    expect(place.has(900)).toBe(false);
    expect(panelFeeds(supply(), 4)).toEqual([{ sourceId: 301, toPanelId: 5, inputIndex: 0 }]);
  });
});

describe('comercial: árbol', () => {
  const spaces = () => [
    space(1, 'Edificio A', null, [1]),
    space(2, 'Piso 1', 1, [2, 3]),
    space(3, 'Zona Norte', 2, [4]),
    space(4, 'Piso 2', 1),
  ];

  it('subárbol, camino y ciclos', () => {
    expect(sorted(spaceSourceIds(spaces(), [2]))).toEqual([2, 3, 4]);
    expect(spacePath(spaces(), 3)).toEqual([1, 2, 3]);
    expect(wouldCreateSpaceCycle(spaces(), 1, 3)).toBe(true);
    expect(wouldCreateSpaceCycle(spaces(), 2, 2)).toBe(true);
    expect(wouldCreateSpaceCycle(spaces(), 3, 4)).toBe(false);
    expect(wouldCreateSpaceCycle(spaces(), 3, null)).toBe(false);
  });

  it('aplana con carpetas primero y grupo "Sin ubicar"', () => {
    const rows = flattenSpaceTree(spaces(), { sourceIds: [1, 2, 3, 4, 5], expanded: new Set(['s:1', 's:2', treeKey.unassigned]) });
    expect(keys(rows)).toEqual(['s:1', 's:2', 's:3', 'm:2', 'm:3', 's:4', 'm:1', 'u', 'm:5']);
    expect(rows[0]).toMatchObject({ kind: 'space', count: 4, depth: 0 });
    expect(rows[2]).toMatchObject({ kind: 'space', expanded: false, depth: 2 });
  });

  it('con búsqueda: poda y expande', () => {
    const rows = flattenSpaceTree(spaces(), { sourceIds: [1, 2, 3, 4, 5], expanded: new Set(), match: (s) => s === 4, prune: true, expandAll: true });
    expect(keys(rows)).toEqual(['s:1', 's:2', 's:3', 'm:4']);
  });
});

describe('flattenSupplyTree', () => {
  it('primaria + vínculos; la salida que alimenta aparece en su tablero y como entrada del otro', () => {
    const expanded = new Set(['p:1', 'p:2', 'p:3', 'p:4']);
    const rows = flattenSupplyTree(supply(), { sourceIds: allMeters, expanded });
    expect(keys(rows)).toEqual([
      'p:1', 'm:101', 'p:4', 'f:4:0', 'f:4:1', 'f:4:2', 'm:220', 'p:5', 'm:210', 'm:211', 'm:301', 'm:111', 'm:201',
      'p:2', 'm:102', 'l:2:4', 'm:202',
      'p:3', 'm:103', 'l:3:4', 'm:203',
      'u',
    ]);
    expect(rows.find((r) => r.key === 'l:2:4')).toMatchObject({ kind: 'link', id: 4, parentId: 2, count: 8 });
    expect(rows.find((r) => r.key === 'f:4:1')).toMatchObject({ role: 'input', sourceId: 202, nodeId: 4, inputIndex: 1 });
    expect(rows.find((r) => r.key === 'm:220')).toMatchObject({ role: 'totalizer', nodeId: 4 });
    expect(rows.at(-1)).toMatchObject({ kind: 'unassigned', count: 2, expanded: false });
  });

  it('colapsado no repite los hijos como raíces', () => {
    const rows = flattenSupplyTree(supply(), { sourceIds: allMeters, expanded: new Set() });
    expect(keys(rows)).toEqual(['p:1', 'p:2', 'p:3', 'u']);
  });

  it('un ciclo (dato corrupto) no se cuelga y muestra los tableros como raíces', () => {
    const cyc = [panel(1, 'A', [input(2, 1)]), panel(2, 'B', [input(1, 2)])];
    const rows = flattenSupplyTree(cyc, { sourceIds: [1, 2], expanded: new Set(['p:1', 'p:2']) });
    expect(rows.filter((r) => r.kind === 'panel').map((r) => r.key).sort()).toEqual(['p:1', 'p:2']);
  });

  it('poda los tableros sin medidores visibles', () => {
    const rows = flattenSupplyTree(supply(), { sourceIds: allMeters, expanded: new Set(), match: (s) => s === 310, prune: true, expandAll: true });
    expect(keys(rows)).toEqual(['p:1', 'p:4', 'p:5', 'm:310', 'p:2', 'l:2:4', 'p:3', 'l:3:4']);
  });
});

describe('planes al asignar medidores (planSupply)', () => {
  it('salidas: nuevas, movidas, sin cambio y bloqueadas (entrada de otro tablero o salida que alimenta a otro)', () => {
    const plan = planSupply(supply(), 1, { kind: 'load' }, [900, 310, 111, 102, 301, 900]);
    expect(plan.assign).toEqual([900, 310]);
    expect(plan.moved).toEqual([{ sourceId: 310, fromId: 5 }]);
    expect(plan.unchanged).toEqual([111]);
    expect(plan.blocked).toEqual([
      { sourceId: 102, fromId: 2, reason: 'input' },
      { sourceId: 301, fromId: 5, reason: 'feeder' },
    ]);
  });

  it('entrada desde un tablero: una salida de ese tablero no se mueve; la de otro sí', () => {
    expect(planSupply(supply(), 5, { kind: 'input', index: 0 }, [301]).unchanged).toEqual([301]);
    const same = planSupply(supply(), 4, { kind: 'input', index: 0 }, [111]);
    expect(same.assign).toEqual([111]);
    expect(same.moved).toEqual([]);
    expect(planSupply(supply(), 4, { kind: 'input', index: 0 }, [310]).moved).toEqual([{ sourceId: 310, fromId: 5 }]);
  });

  it('entradas nuevas y totalizador', () => {
    const plan = planSupply(supply(), 5, { kind: 'new-input' }, [900, 220, 210]);
    expect(plan.assign).toEqual([900, 210]);
    expect(plan.blocked).toEqual([{ sourceId: 220, fromId: 4, reason: 'totalizer' }]);
    expect(planSupply(supply(), 5, { kind: 'totalizer' }, [101]).blocked).toEqual([{ sourceId: 101, fromId: 1, reason: 'input' }]);
    // Dentro del mismo tablero, un medidor puede cambiar de lugar
    expect(planSupply(supply(), 4, { kind: 'load' }, [220]).assign).toEqual([220]);
  });

  it('espacios: mueve desde el espacio anterior', () => {
    const spaces = [space(1, 'A', null, [1]), space(2, 'B', null, [2])];
    const plan = planSpaceMembers(spaces, 2, [1, 2, 3]);
    expect(plan.assign).toEqual([1, 3]);
    expect(plan.moved).toEqual([{ sourceId: 1, fromId: 1 }]);
    expect(plan.unchanged).toEqual([2]);
  });
});

describe('supplySaveConflicts', () => {
  it('no cuenta lo que el propio tablero ya tenía', () => {
    expect(supplySaveConflicts(supply(), 4, { inputs: [{ sourceId: 201 }, { sourceId: 202 }, { sourceId: 203 }], totalizerSourceId: 220 })).toEqual([]);
  });

  it('salida que ya alimenta a otro tablero, repetidos y medidores de entrada ajenos', () => {
    expect(supplySaveConflicts(supply(), 5, { inputs: [{ sourceId: 201 }], totalizerSourceId: null })).toEqual([{ sourceId: 201, reason: 'feeder', panelId: 4 }]);
    expect(supplySaveConflicts(supply(), 5, { inputs: [{ sourceId: 201, fromPanelId: 2 }], totalizerSourceId: null })).toEqual([{ sourceId: 201, reason: 'feeder', panelId: 4 }]);
    expect(supplySaveConflicts(supply(), 5, { inputs: [{ sourceId: 310 }, { sourceId: 310 }], totalizerSourceId: 102 })).toEqual([
      { sourceId: 310, reason: 'duplicate', panelId: 5 },
      { sourceId: 102, reason: 'input', panelId: 2 },
    ]);
  });
});

// TGNA-1 deriva su salida 201 a TGSN-A (E1), TGSN-B (E1) y TGSN-C (E2)
const derivation = () => [
  ...supply(),
  panel(6, 'TGSN-B', [input(1, 201)], [600]),
  panel(7, 'TGSN-C', [input(null, 700), input(1, 201)], [701]),
];

describe('derivación: una salida alimenta a varios tableros', () => {
  it('la ubicación lista todos los destinos y la salida sigue en su tablero', () => {
    expect(supplyPlacement(derivation()).get(201)).toEqual({
      panelId: 1,
      role: 'load',
      feeds: [{ panelId: 4, inputIndex: 0 }, { panelId: 6, inputIndex: 0 }, { panelId: 7, inputIndex: 1 }],
    });
    expect(panelFeeds(derivation(), 1).map((f) => f.toPanelId)).toEqual([4, 6, 7]);
  });

  it('salidas para mostrar: una fila por medidor con todos sus destinos, luego entradas sin medidor y cargas', () => {
    const p = [...derivation(), panel(8, 'TGSN-D', [input(1, null)])];
    expect(panelOutputs(p, 1)).toEqual([
      { sourceId: 201, feeds: [{ panelId: 4, inputIndex: 0 }, { panelId: 6, inputIndex: 0 }, { panelId: 7, inputIndex: 1 }] },
      { sourceId: null, feeds: [{ panelId: 8, inputIndex: 0 }] },
      { sourceId: 111, feeds: [] },
    ]);
  });

  it('se comparte en una entrada desde su mismo tablero, sin moverla', () => {
    const p = [...supply(), panel(6, 'TGSN-B', [input(1, null)])];
    const plan = planSupply(p, 6, { kind: 'input', index: 0 }, [201]);
    expect(plan.assign).toEqual([201]);
    expect(plan.moved).toEqual([]);
    expect(plan.blocked).toEqual([]);
    expect(supplySaveConflicts(p, 6, { inputs: [{ sourceId: 201, fromPanelId: 1 }], totalizerSourceId: null })).toEqual([]);
    expect(supplySaveConflicts(derivation(), 7, { inputs: [{ sourceId: 700, fromPanelId: null }, { sourceId: 201, fromPanelId: 1 }], totalizerSourceId: null })).toEqual([]);
  });

  it('se bloquea en una entrada desde otro tablero, como totalizador, entrada externa o salida de otro', () => {
    const p = [...supply(), panel(6, 'TGSN-B', [input(2, null)])];
    expect(planSupply(p, 6, { kind: 'input', index: 0 }, [201]).blocked).toEqual([{ sourceId: 201, fromId: 4, reason: 'feeder' }]);
    expect(planSupply(p, 6, { kind: 'totalizer' }, [201]).blocked).toEqual([{ sourceId: 201, fromId: 4, reason: 'feeder' }]);
    expect(planSupply(p, 6, { kind: 'new-input' }, [201]).blocked).toEqual([{ sourceId: 201, fromId: 4, reason: 'feeder' }]);
    expect(planSupply(derivation(), 5, { kind: 'load' }, [201]).blocked).toEqual([{ sourceId: 201, fromId: 4, reason: 'feeder' }]);
    expect(supplySaveConflicts(p, 6, { inputs: [{ sourceId: 201, fromPanelId: 2 }], totalizerSourceId: null })).toEqual([{ sourceId: 201, reason: 'feeder', panelId: 4 }]);
    expect(supplySaveConflicts(p, 6, { inputs: [], totalizerSourceId: 201 })).toEqual([{ sourceId: 201, reason: 'feeder', panelId: 4 }]);
  });

  it('un tablero no usa la misma salida en dos entradas', () => {
    const p = [...supply(), panel(6, 'TGSN-B', [input(1, null), input(1, null)])];
    const save = { inputs: [{ sourceId: 201, fromPanelId: 1 }, { sourceId: 201, fromPanelId: 1 }], totalizerSourceId: null };
    expect(supplySaveConflicts(p, 6, save)).toEqual([{ sourceId: 201, reason: 'duplicate', panelId: 6 }]);
    // Ya alimenta a TGSN-B (E2): no se comparte con la E1 del mismo tablero
    expect(planSupply(derivation(), 6, { kind: 'input', index: 0 }, [201]).unchanged).toEqual([201]);
  });

  it('el tablero de origen avisa la derivación con sus destinos', () => {
    const issues = diagnoseSupply(derivation(), (id) => `M${id}`).filter((i) => i.kind === 'shared_feeder');
    expect(issues).toEqual([
      { severity: 'warning', kind: 'shared_feeder', nodeId: 1, message: 'M201 alimenta una derivación (TGSN-A · E1, TGSN-B · E1, TGSN-C · E2): mide la suma, no cada entrada por separado' },
    ]);
  });

  it('los nodos dinámicos de cada destino incluyen la salida compartida', () => {
    expect(panelSourceIds(derivation(), [6])).toContain(201);
    expect(panelSourceIds(derivation(), [7])).toContain(201);
  });
});

describe('carriles de aristas (edgeLanes)', () => {
  it('desde un mismo origen, la del destino más lejano dobla primero; cada lado por separado', () => {
    const lanes = edgeLanes([
      { id: 'a', source: 'p:1', sourceX: 500, targetX: 300 },
      { id: 'b', source: 'p:1', sourceX: 500, targetX: 100 },
      { id: 'c', source: 'p:1', sourceX: 500, targetX: 450 },
      { id: 'd', source: 'p:1', sourceX: 500, targetX: 700 },
      { id: 'e', source: 'p:2', sourceX: 500, targetX: 300 },
    ]);
    expect(lanes.get('b')).toEqual({ lane: 0, lanes: 3 });
    expect(lanes.get('a')).toEqual({ lane: 1, lanes: 3 });
    expect(lanes.get('c')).toEqual({ lane: 2, lanes: 3 });
    expect(lanes.get('d')).toEqual({ lane: 0, lanes: 1 });
    expect(lanes.get('e')).toEqual({ lane: 0, lanes: 1 });
  });

  it('dos entradas del mismo tablero desde un mismo origen quedan en carriles distintos', () => {
    const lanes = edgeLanes([
      { id: 'e1', source: 'p:1', sourceX: 400, targetX: 420 },
      { id: 'e2', source: 'p:1', sourceX: 400, targetX: 510 },
    ]);
    expect(lanes.get('e2')!.lane).toBe(0);
    expect(lanes.get('e1')!.lane).toBe(1);
  });
});

describe('diagnóstico', () => {
  it('suministro: cada tipo de problema', () => {
    const panels = [
      panel(1, 'Vacío'),
      panel(2, 'Sin entradas', [], [1]),
      panel(3, 'ATS solo', [input(null, null, { origin: null })], [2], { mode: 'ats', missing: 1, missingTotalizer: true }),
      panel(4, 'Medidor borrado', [input(2, null, { missingMeter: true })]),
    ];
    const kinds = diagnoseSupply(panels).map((i) => `${i.nodeId}:${i.kind}`);
    expect(kinds).toEqual([
      '3:missing_loads', '3:missing_totalizer', '3:input_without_meter', '3:input_without_origin', '3:ats_single_input',
      '4:missing_input_meter', '4:no_outputs',
      '2:no_inputs',
      '1:empty_panel',
    ]);
    expect(diagnoseSupply(supply())).toEqual([]);
  });

  it('comercial: vacíos y medidores borrados', () => {
    const issues = diagnoseSpaces([space(1, 'A', null), space(2, 'B', null, [1]), { ...space(3, 'C', 2), missing: 2 }]);
    expect(issues.map((i) => `${i.nodeId}:${i.kind}`)).toEqual(['1:empty_space', '3:missing_members', '3:empty_space']);
  });
});
