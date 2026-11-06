import { describe, expect, it } from 'vitest';
import { SPACES_CSV_COLUMNS, SUPPLY_CSV_COLUMNS, spacesCsvRows, supplyCsvRows, type ExportSource } from './hierarchy-export.ts';
import type { PanelDTO, PanelInputDTO, SpaceDTO } from './types.ts';

let inputId = 1;
const input = (fromPanelId: number | null, sourceId: number | null, extra: Partial<PanelInputDTO> = {}): PanelInputDTO => ({
  id: inputId++, fromPanelId, origin: fromPanelId == null ? 'Red pública' : null, label: null, sourceId, missingMeter: false, ...extra,
});
const panel = (id: number, name: string, inputs: PanelInputDTO[] = [], loadSourceIds: number[] = [], extra: Partial<PanelDTO> = {}): PanelDTO => ({
  id, name, mode: 'sum', description: null, x: null, y: null, inputs, loadSourceIds, missing: 0, totalizerSourceId: null, missingTotalizer: false, color: null, icon: 'other', ...extra,
});
const space = (id: number, name: string, parentId: number | null, sourceIds: number[] = [], type: string | null = null): SpaceDTO => ({
  id, name, parentId, type, x: null, y: null, sourceIds, missing: 0,
});
const src = (id: number, name: string): ExportSource => ({ id, name, displayName: `D-${name}`, group: name.split('.')[0], type: 'PM8000' });

const sources = [
  src(101, 'G.ACOMETIDA'), src(201, 'G.ALIM-A'), src(202, 'G.ALIM-B'), src(210, 'G.CARGA-1'), src(220, 'G.TOTAL-A'), src(301, 'G.CARGA-B'),
  src(900, 'G.SUELTO'),
];

// TG (acometida 101) alimenta a A por 201 y, con derivación por 202, a B (E1) y C (E2).
// A tiene totalizador y una carga; C tiene una entrada externa sin medidor; Z está vacío.
const supply = () => [
  panel(1, 'TG', [input(null, 101, { label: 'Red' })], [201, 202]),
  panel(2, 'A', [input(1, 201)], [210], { totalizerSourceId: 220, mode: 'ats' }),
  panel(3, 'B', [input(1, 202)], [301]),
  panel(4, 'C', [input(null, null, { origin: 'Grupo' }), input(1, 202), input(1, null)]),
  panel(5, 'Z'),
];
const spaces = () => [space(1, 'Edificio', null, [101], 'Edificio'), space(2, 'Piso 1', 1, [210, 301], 'Piso'), space(3, 'Vacío', 1)];

const col = (row: string[], name: (typeof SUPPLY_CSV_COLUMNS)[number]) => row[SUPPLY_CSV_COLUMNS.indexOf(name)];
const scol = (row: string[], name: (typeof SPACES_CSV_COLUMNS)[number]) => row[SPACES_CSV_COLUMNS.indexOf(name)];

describe('CSV de Suministro', () => {
  const rows = supplyCsvRows(supply(), spaces(), sources);
  const body = rows.slice(1);
  const brief = body.map((r) => [col(r, 'Tablero'), col(r, 'Rol'), col(r, 'Medidor'), col(r, 'Tablero destino'), col(r, 'Entrada destino')]);

  it('encabezado y mismo número de columnas en todas las filas', () => {
    expect(rows[0]).toEqual([...SUPPLY_CSV_COLUMNS]);
    for (const r of rows) expect(r).toHaveLength(SUPPLY_CSV_COLUMNS.length);
  });

  it('una fila por lugar del medidor, con derivación, conexiones sin medidor y sin ubicar', () => {
    expect(brief).toEqual([
      ['TG', 'Entrada externa', 'G.ACOMETIDA', 'TG', 'E1'],
      ['TG', 'Alimentador', 'G.ALIM-A', 'A', 'E1'],
      ['TG', 'Alimentador', 'G.ALIM-B', 'B', 'E1'],
      ['TG', 'Alimentador', 'G.ALIM-B', 'C', 'E2'],
      ['TG', 'Alimentador', '', 'C', 'E3'],
      ['A', 'Totalizador', 'G.TOTAL-A', '', ''],
      ['A', 'Salida', 'G.CARGA-1', '', ''],
      ['B', 'Salida', 'G.CARGA-B', '', ''],
      ['C', 'Entrada externa', '', 'C', 'E1'],
      ['Z', 'Tablero sin medidores', '', '', ''],
      ['', 'Sin ubicar', 'G.SUELTO', '', ''],
    ]);
  });

  it('datos del medidor, ruta, nivel, modo y destinos', () => {
    const a = body.find((r) => col(r, 'Medidor') === 'G.CARGA-1')!;
    expect([col(a, 'Nombre visible'), col(a, 'Modelo'), col(a, 'Grupo')]).toEqual(['D-G.CARGA-1', 'PM8000', 'G']);
    expect([col(a, 'Modo del tablero'), col(a, 'Nivel'), col(a, 'Tablero raíz'), col(a, 'Ruta')]).toEqual(['ATS', '2', 'TG', 'TG > A']);
    expect([col(a, 'Destinos'), col(a, 'Espacio')]).toEqual(['0', 'Edificio > Piso 1']);

    const ext = body[0];
    expect([col(ext, 'Origen externo'), col(ext, 'Etiqueta de la entrada'), col(ext, 'Entrada primaria'), col(ext, 'Espacio')]).toEqual(['Red pública', 'Red', 'No', 'Edificio']);

    const [toB, toC] = body.filter((r) => col(r, 'Medidor') === 'G.ALIM-B');
    expect([col(toB, 'Destinos'), col(toB, 'Entrada primaria'), col(toC, 'Entrada primaria')]).toEqual(['2', 'Sí', 'Sí']);
    expect(col(toB, 'Problemas')).toContain('derivación');
    expect(col(body[1], 'Problemas')).toBe('');
  });

  it('problemas de la entrada en su fila y del tablero en todas las suyas', () => {
    const noMeter = body.find((r) => col(r, 'Rol') === 'Alimentador' && !col(r, 'Medidor'))!;
    expect(col(noMeter, 'Problemas')).toBe('Aviso: Entrada 3 sin medidor asociado');
    const ats = body.filter((r) => col(r, 'Tablero') === 'A');
    for (const r of ats) expect(col(r, 'Problemas del tablero')).toContain('Modo ATS con una sola entrada');
    expect(col(body.find((r) => col(r, 'Tablero') === 'Z')!, 'Problemas del tablero')).toContain('Tablero vacío');
  });

  it('totalizador guardado que ya no existe', () => {
    const rows = supplyCsvRows([panel(1, 'X', [input(null, 101)], [], { missingTotalizer: true })], [], sources).slice(1);
    const t = rows.find((r) => col(r, 'Rol') === 'Totalizador')!;
    expect(col(t, 'Medidor')).toBe('');
    expect(col(t, 'Problemas')).toContain('totalizador');
    expect(col(t, 'Problemas del tablero')).not.toContain('totalizador');
  });
});

describe('CSV de Comercial', () => {
  const rows = spacesCsvRows(spaces(), supply(), sources);
  const body = rows.slice(1);

  it('una fila por medidor de cada espacio, espacios vacíos y sin ubicar', () => {
    for (const r of rows) expect(r).toHaveLength(SPACES_CSV_COLUMNS.length);
    expect(body.map((r) => [scol(r, 'Ruta'), scol(r, 'Medidor'), scol(r, 'Tablero'), scol(r, 'Rol en suministro')])).toEqual([
      ['Edificio', 'G.ACOMETIDA', 'TG', 'Entrada externa'],
      ['Edificio > Piso 1', 'G.CARGA-1', 'A', 'Salida'],
      ['Edificio > Piso 1', 'G.CARGA-B', 'B', 'Salida'],
      ['Edificio > Vacío', '', '', ''],
      ['', 'G.ALIM-A', 'TG', 'Alimentador'],
      ['', 'G.ALIM-B', 'TG', 'Alimentador'],
      ['', 'G.SUELTO', '', 'Sin ubicar'],
      ['', 'G.TOTAL-A', 'A', 'Totalizador'],
    ]);
  });

  it('tipo, nivel, raíz y problemas del espacio', () => {
    const r = body.find((x) => scol(x, 'Medidor') === 'G.CARGA-1')!;
    expect([scol(r, 'Espacio'), scol(r, 'Tipo de espacio'), scol(r, 'Nivel'), scol(r, 'Espacio raíz')]).toEqual(['Piso 1', 'Piso', '2', 'Edificio']);
    expect(scol(body[3], 'Problemas del espacio')).toContain('Espacio vacío');
  });
});
