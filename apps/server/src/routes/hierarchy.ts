import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  hierarchyLayoutSchema, hierarchyMembersSchema, hierarchyUnassignSchema, panelCreateSchema, panelSaveSchema, planSupply,
  spaceCreateSchema, spaceSaveSchema, supplySaveConflicts, wouldCreateSpaceCycle, wouldCreateSupplyCycle,
  type HierarchyDTO, type PanelInput, type PanelSave, type SpaceSave, type SupplyConflict,
} from '@repnode/shared';
import { HttpError } from '../errors.ts';
import { hierarchyDTO } from '../hierarchy.ts';
import { requireSession, type Session } from '../mssql/session.ts';
import { hierarchyLayout, panels, spaces, transaction } from '../store/sqlite.ts';

const idParam = z.object({ id: z.coerce.number().int() });

const isUnique = (err: unknown) => err instanceof Error && /UNIQUE/i.test(err.message);

function namesOf(s: Session, ids: number[]): string[] {
  return ids.map((id) => s.catalog.sourceById.get(id)?.name).filter((n): n is string => !!n);
}

function meterName(s: Session, id: number): string {
  return s.catalog.sourceById.get(id)?.name ?? `#${id}`;
}

const REASON_TEXT: Record<SupplyConflict['reason'], string> = {
  duplicate: 'está repetido en el tablero',
  input: 'es el medidor de una entrada de',
  totalizer: 'es el totalizador de',
  feeder: 'ya alimenta una entrada de',
};

function conflictMessage(s: Session, h: HierarchyDTO, c: SupplyConflict): string {
  const panel = h.panels.find((p) => p.id === c.panelId)?.name ?? '¿?';
  const tail = c.reason === 'feeder' ? ': solo puede compartirse con entradas que vengan de su mismo tablero' : '';
  return `El medidor ${meterName(s, c.sourceId)} ${REASON_TEXT[c.reason]}${c.reason === 'duplicate' ? '' : ` «${panel}»`}${tail}`;
}

/**
 * Valida entradas y totalizador de un tablero: origen existente, sin ciclos y cada medidor en un solo lugar
 * (una entrada desde X puede usar una salida libre de X o de otro tablero, que pasa a ser salida de X, o una salida de
 * X que ya alimenta a otros tableros: derivación).
 */
function checkPanel(s: Session, h: HierarchyDTO, panelId: number | null, body: PanelSave): void {
  const byId = new Map(h.panels.map((p) => [p.id, p]));
  for (const i of body.inputs) {
    if (i.fromPanelId != null && !byId.has(i.fromPanelId)) throw new HttpError(400, 'El tablero de origen de una entrada no existe', 'invalid_input');
    if (i.sourceId != null && !s.catalog.sourceById.has(i.sourceId)) throw new HttpError(400, 'El medidor de una entrada no existe', 'invalid_input');
  }
  if (body.totalizerSourceId != null && !s.catalog.sourceById.has(body.totalizerSourceId)) throw new HttpError(400, 'El medidor totalizador no existe', 'invalid_input');
  if (panelId != null && wouldCreateSupplyCycle(h.panels, panelId, body.inputs.map((i) => i.fromPanelId))) {
    throw new HttpError(400, 'La conexión crearía un ciclo: un tablero no puede alimentarse desde su propio aguas abajo', 'cycle');
  }
  const conflicts = supplySaveConflicts(h.panels, panelId ?? -1, body);
  if (conflicts.length) throw new HttpError(409, conflicts.map((c) => conflictMessage(s, h, c)).join('. '), 'meter_in_use');
}

const inputRows = (s: Session, inputs: PanelInput[]) =>
  inputs.map((i) => ({ fromPanelId: i.fromPanelId, origin: i.origin, label: i.label, sourceName: i.sourceId != null ? meterName(s, i.sourceId) : null }));

/** Salidas a agregar; no se toca lo que es entrada o totalizador de otro tablero ni una salida que alimenta a otro. */
function loadNames(s: Session, h: HierarchyDTO, panelId: number, sourceIds: number[]): string[] {
  const plan = planSupply(h.panels, panelId, { kind: 'load' }, sourceIds.filter((id) => s.catalog.sourceById.has(id)));
  if (plan.blocked.length) {
    const msg = plan.blocked.map((b) => conflictMessage(s, h, { sourceId: b.sourceId, reason: b.reason ?? 'input', panelId: b.fromId })).join('. ');
    throw new HttpError(409, msg, 'meter_in_use');
  }
  return namesOf(s, plan.assign);
}

/** Padre existente, sin ciclos y nombre único entre hermanos. */
function checkSpace(h: HierarchyDTO, spaceId: number | null, body: SpaceSave): void {
  if (body.parentId != null && !h.spaces.some((x) => x.id === body.parentId)) throw new HttpError(400, 'El espacio padre no existe', 'invalid_input');
  if (spaceId != null && wouldCreateSpaceCycle(h.spaces, spaceId, body.parentId)) {
    throw new HttpError(400, 'Un espacio no puede quedar dentro de sí mismo ni de sus subespacios', 'cycle');
  }
  const key = body.name.toLocaleLowerCase('es');
  if (h.spaces.some((x) => x.id !== spaceId && x.parentId === body.parentId && x.name.toLocaleLowerCase('es') === key)) {
    throw new HttpError(409, `Ya existe un espacio llamado "${body.name}" en ese nivel`, 'duplicate');
  }
}

export default async function hierarchyRoutes(app: FastifyInstance) {
  const current = (req: FastifyRequest) => hierarchyDTO(requireSession(req));

  app.get('/api/hierarchy', async (req) => current(req));

  // -------------------------------------------------------------------------
  // Suministro: tableros
  // -------------------------------------------------------------------------
  app.post('/api/panels', async (req) => {
    const s = requireSession(req);
    const body = panelCreateSchema.parse(req.body);
    const h = hierarchyDTO(s);
    checkPanel(s, h, null, body);
    // -1: un tablero nuevo, todavía sin cargas
    const loads = loadNames(s, h, -1, body.sourceIds);
    try {
      transaction(() => {
        const id = panels.create(s.profileId, body, body.x, body.y);
        panels.setInputs(s.profileId, id, inputRows(s, body.inputs), body.totalizerSourceId != null ? meterName(s, body.totalizerSourceId) : null);
        panels.addLoads(s.profileId, id, loads);
      });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `Ya existe un tablero llamado "${body.name}"`, 'duplicate');
      throw err;
    }
    return current(req);
  });

  app.put('/api/panels/:id', async (req) => {
    const s = requireSession(req);
    const { id } = idParam.parse(req.params);
    const body = panelSaveSchema.parse(req.body);
    if (!panels.owns(s.profileId, id)) throw new HttpError(404, 'Tablero no encontrado', 'not_found');
    checkPanel(s, hierarchyDTO(s), id, body);
    try {
      transaction(() => {
        panels.update(s.profileId, id, body);
        panels.setInputs(s.profileId, id, inputRows(s, body.inputs), body.totalizerSourceId != null ? meterName(s, body.totalizerSourceId) : null);
      });
    } catch (err) {
      if (isUnique(err)) throw new HttpError(409, `Ya existe un tablero llamado "${body.name}"`, 'duplicate');
      throw err;
    }
    return current(req);
  });

  app.delete('/api/panels/:id', async (req) => {
    const s = requireSession(req);
    const { id } = idParam.parse(req.params);
    panels.remove(s.profileId, id);
    return current(req);
  });

  app.post('/api/panels/:id/loads', async (req) => {
    const s = requireSession(req);
    const { id } = idParam.parse(req.params);
    if (!panels.owns(s.profileId, id)) throw new HttpError(404, 'Tablero no encontrado', 'not_found');
    const body = hierarchyMembersSchema.parse(req.body);
    if (body.action === 'add') {
      const names = loadNames(s, hierarchyDTO(s), id, body.sourceIds);
      transaction(() => panels.addLoads(s.profileId, id, names));
    } else {
      transaction(() => panels.removeLoads(id, namesOf(s, body.sourceIds)));
    }
    return current(req);
  });

  // -------------------------------------------------------------------------
  // Comercial: espacios
  // -------------------------------------------------------------------------
  app.post('/api/spaces', async (req) => {
    const s = requireSession(req);
    const body = spaceCreateSchema.parse(req.body);
    checkSpace(hierarchyDTO(s), null, body);
    transaction(() => {
      const id = spaces.create(s.profileId, body, body.x, body.y);
      spaces.addMembers(s.profileId, id, namesOf(s, body.sourceIds));
    });
    return current(req);
  });

  app.put('/api/spaces/:id', async (req) => {
    const s = requireSession(req);
    const { id } = idParam.parse(req.params);
    const body = spaceSaveSchema.parse(req.body);
    if (!spaces.owns(s.profileId, id)) throw new HttpError(404, 'Espacio no encontrado', 'not_found');
    checkSpace(hierarchyDTO(s), id, body);
    spaces.update(s.profileId, id, body);
    return current(req);
  });

  app.delete('/api/spaces/:id', async (req) => {
    const s = requireSession(req);
    const { id } = idParam.parse(req.params);
    spaces.remove(s.profileId, id);
    return current(req);
  });

  app.post('/api/spaces/:id/members', async (req) => {
    const s = requireSession(req);
    const { id } = idParam.parse(req.params);
    if (!spaces.owns(s.profileId, id)) throw new HttpError(404, 'Espacio no encontrado', 'not_found');
    const body = hierarchyMembersSchema.parse(req.body);
    const names = namesOf(s, body.sourceIds);
    transaction(() => (body.action === 'add' ? spaces.addMembers(s.profileId, id, names) : spaces.removeMembers(id, names)));
    return current(req);
  });

  // -------------------------------------------------------------------------
  // Comunes
  // -------------------------------------------------------------------------
  app.post('/api/hierarchy/unassign', async (req) => {
    const s = requireSession(req);
    const body = hierarchyUnassignSchema.parse(req.body);
    const names = namesOf(s, body.sourceIds);
    transaction(() => (body.kind === 'supply' ? panels.unassign(s.profileId, names) : spaces.unassign(s.profileId, names)));
    return current(req);
  });

  app.put('/api/hierarchy/layout', async (req) => {
    const s = requireSession(req);
    const body = hierarchyLayoutSchema.parse(req.body);
    if (body.reset) hierarchyLayout.reset(s.profileId, body.kind);
    if (body.positions.length) hierarchyLayout.set(s.profileId, body.kind, body.positions);
    return current(req);
  });
}
