import {
  compareNodeNames, diagnoseSpaces, diagnoseSupply, panelFeeds, primaryParent, spaceChildren, spacePath, spacePlacement, supplyPanelOrder,
  supplyPlacement, type DesignIssue,
} from './hierarchy.ts';
import type { PanelMode } from './schemas.ts';
import type { PanelDTO, SourceDTO, SpaceDTO } from './types.ts';

// Tablas para descargar las jerarquías como CSV: una fila por cada lugar donde aparece un medidor (un medidor puede
// repetirse, p. ej. una derivación da una fila por destino), más las conexiones y nodos sin medidor y, al final, los
// medidores sin ubicar. Devuelven las filas con el encabezado como primera fila.

export type ExportSource = Pick<SourceDTO, 'id' | 'name' | 'displayName' | 'group' | 'type'>;

export const SUPPLY_CSV_COLUMNS = [
  'Medidor', 'Nombre visible', 'Modelo', 'Grupo', 'Rol',
  'Tablero', 'Modo del tablero', 'Nivel', 'Tablero raíz', 'Ruta',
  'Tablero destino', 'Entrada destino', 'Etiqueta de la entrada', 'Entrada primaria', 'Modo del tablero destino',
  'Destinos', 'Origen externo', 'Espacio', 'Problemas', 'Problemas del tablero',
] as const;

export const SPACES_CSV_COLUMNS = [
  'Medidor', 'Nombre visible', 'Modelo', 'Grupo',
  'Espacio', 'Tipo de espacio', 'Nivel', 'Espacio raíz', 'Ruta',
  'Tablero', 'Rol en suministro', 'Problemas del espacio',
] as const;

/**
 * Rol de la fila en Suministro:
 * - Entrada externa: medidor de una entrada desde una fuente externa (está en el tablero que recibe).
 * - Totalizador: totalizador interno del tablero.
 * - Alimentador: salida del tablero que alimenta la entrada de otro (una fila por destino).
 * - Salida: salida que solo alimenta cargas.
 * - Tablero sin medidores: el tablero no tiene entradas externas, totalizador ni salidas propias.
 * - Sin ubicar: medidor que no está en Suministro.
 */
export type SupplyCsvRole = 'Entrada externa' | 'Totalizador' | 'Alimentador' | 'Salida' | 'Tablero sin medidores' | 'Sin ubicar';

const MODE: Record<PanelMode, string> = { sum: 'Suma', ats: 'ATS' };
const SEP = ' > ';

const issueText = (list: readonly DesignIssue[]): string =>
  list.map((i) => `${i.severity === 'error' ? 'Error' : 'Aviso'}: ${i.message}`).join(' | ');

const byName = (byId: Map<number, ExportSource>) => (a: number, b: number) =>
  compareNodeNames({ name: byId.get(a)?.name ?? `#${a}` }, { name: byId.get(b)?.name ?? `#${b}` });

function meterCells(byId: Map<number, ExportSource>, sid: number | null): string[] {
  if (sid == null) return ['', '', '', ''];
  const s = byId.get(sid);
  return s ? [s.name, s.displayName, s.type, s.group] : [`#${sid}`, '', '', ''];
}

/** Ruta de espacios del medidor ("Edificio A > Piso 2"), o vacío si no está en Comercial. */
function spaceLocator(spaces: readonly SpaceDTO[]): (sid: number) => string {
  const place = spacePlacement(spaces);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const cache = new Map<number, string>();
  const pathText = (id: number) => {
    let t = cache.get(id);
    if (t == null) cache.set(id, (t = spacePath(spaces, id).map((x) => byId.get(x)?.name ?? '').join(SEP)));
    return t;
  };
  return (sid) => {
    const id = place.get(sid);
    return id != null ? pathText(id) : '';
  };
}

/** Camino de tableros por el padre primario, desde la raíz hasta el tablero (incluido). */
function panelPath(panelById: Map<number, PanelDTO>, id: number): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (let p = panelById.get(id); p && !seen.has(p.id); ) {
    seen.add(p.id);
    out.unshift(p.name);
    const parent = primaryParent(p);
    p = parent != null ? panelById.get(parent) : undefined;
  }
  return out;
}

export function supplyCsvRows(panels: readonly PanelDTO[], spaces: readonly SpaceDTO[], sources: readonly ExportSource[]): string[][] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const panelById = new Map(panels.map((p) => [p.id, p]));
  const issues = diagnoseSupply(panels, (id) => byId.get(id)?.name ?? `#${id}`);
  const spaceOf = spaceLocator(spaces);
  const sortMeters = byName(byId);
  const rows: string[][] = [[...SUPPLY_CSV_COLUMNS]];

  const inputIssues = (panelId: number, inputIndex: number) => issues.filter((i) => i.nodeId === panelId && i.inputIndex === inputIndex);
  const destCells = (dest: PanelDTO, k: number) => {
    const primary = dest.inputs.findIndex((i) => i.fromPanelId != null);
    return [dest.name, `E${k + 1}`, dest.inputs[k]?.label ?? '', primary === k ? 'Sí' : 'No', MODE[dest.mode]];
  };

  for (const { id } of supplyPanelOrder(panels)) {
    const p = panelById.get(id)!;
    const path = panelPath(panelById, id);
    const panelCells = [p.name, MODE[p.mode], String(path.length), path[0] ?? p.name, path.join(SEP)];
    // Problemas del tablero = los que no son de una entrada, del totalizador ni de un medidor
    const panelIssues = issueText(
      issues.filter((i) => i.nodeId === id && i.inputIndex == null && i.sourceId == null && i.kind !== 'missing_totalizer'),
    );
    let own = 0;
    const row = (
      role: SupplyCsvRole, sid: number | null, dest: string[] | null, destinos: string, origin: string, problems: readonly DesignIssue[],
    ) => {
      own++;
      rows.push([
        ...meterCells(byId, sid), role, ...panelCells, ...(dest ?? ['', '', '', '', '']),
        destinos, origin, sid != null ? spaceOf(sid) : '', issueText(problems), panelIssues,
      ]);
    };

    p.inputs.forEach((inp, k) => {
      if (inp.fromPanelId == null) row('Entrada externa', inp.sourceId, destCells(p, k), '', inp.origin ?? '', inputIssues(id, k));
    });
    if (p.totalizerSourceId != null || p.missingTotalizer) {
      row('Totalizador', p.totalizerSourceId, null, '', '', issues.filter((i) => i.nodeId === id && i.kind === 'missing_totalizer'));
    }

    // Salidas que alimentan a otros tableros: una fila por destino (varias = derivación)
    const feeders = new Map<number, { toPanelId: number; inputIndex: number }[]>();
    const unmetered: { toPanelId: number; inputIndex: number }[] = [];
    for (const f of panelFeeds(panels, id)) {
      if (f.sourceId == null) unmetered.push(f);
      else {
        let arr = feeders.get(f.sourceId);
        if (!arr) feeders.set(f.sourceId, (arr = []));
        arr.push(f);
      }
    }
    for (const sid of [...feeders.keys()].sort(sortMeters)) {
      const fs = feeders.get(sid)!;
      const shared = issues.filter((i) => i.kind === 'shared_feeder' && i.sourceId === sid);
      for (const f of fs) {
        const dest = panelById.get(f.toPanelId)!;
        row('Alimentador', sid, destCells(dest, f.inputIndex), String(fs.length), '', [...inputIssues(dest.id, f.inputIndex), ...shared]);
      }
    }
    for (const f of unmetered) {
      const dest = panelById.get(f.toPanelId)!;
      row('Alimentador', null, destCells(dest, f.inputIndex), '1', '', inputIssues(dest.id, f.inputIndex));
    }
    for (const sid of p.loadSourceIds.filter((s) => !feeders.has(s)).sort(sortMeters)) row('Salida', sid, null, '0', '', []);

    if (!own) row('Tablero sin medidores', null, null, '', '', []);
  }

  const placed = supplyPlacement(panels);
  for (const s of [...sources].sort(compareNodeNames)) {
    if (placed.has(s.id)) continue;
    rows.push([...meterCells(byId, s.id), 'Sin ubicar', '', '', '', '', '', '', '', '', '', '', '', '', spaceOf(s.id), '', '']);
  }
  return rows;
}

const SUPPLY_ROLE: Record<'input' | 'load' | 'totalizer', string> = { input: 'Entrada externa', load: 'Salida', totalizer: 'Totalizador' };

export function spacesCsvRows(spaces: readonly SpaceDTO[], panels: readonly PanelDTO[], sources: readonly ExportSource[]): string[][] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const panelById = new Map(panels.map((p) => [p.id, p]));
  const supply = supplyPlacement(panels);
  const issues = diagnoseSpaces(spaces);
  const children = spaceChildren(spaces);
  const sortMeters = byName(byId);
  const rows: string[][] = [[...SPACES_CSV_COLUMNS]];

  const supplyCells = (sid: number | null): string[] => {
    if (sid == null) return ['', ''];
    const pl = supply.get(sid);
    if (!pl) return ['', 'Sin ubicar'];
    return [panelById.get(pl.panelId)?.name ?? '', pl.feeds?.length ? 'Alimentador' : SUPPLY_ROLE[pl.role]];
  };

  const seen = new Set<number>();
  const visit = (parent: number | null): void => {
    const kids = (children.get(parent) ?? []).map((id) => spaceById.get(id)!).sort(compareNodeNames);
    for (const s of kids) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const path = spacePath(spaces, s.id).map((x) => spaceById.get(x)?.name ?? '');
      const cells = [s.name, s.type ?? '', String(path.length), path[0] ?? s.name, path.join(SEP)];
      const problems = issueText(issues.filter((i) => i.nodeId === s.id));
      const members = [...s.sourceIds].sort(sortMeters);
      for (const sid of members.length ? members : [null]) rows.push([...meterCells(byId, sid), ...cells, ...supplyCells(sid), problems]);
      visit(s.id);
    }
  };
  visit(null);

  const placed = spacePlacement(spaces);
  for (const s of [...sources].sort(compareNodeNames)) {
    if (!placed.has(s.id)) rows.push([...meterCells(byId, s.id), '', '', '', '', '', ...supplyCells(s.id), '']);
  }
  return rows;
}
