import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  presetInputSchema, settingsSchema, TAG_PALETTE, tagColorSchema, tagCreateSchema, tagInputSchema, tagMembersSchema,
  type PresetDTO, type TagDTO,
} from '@repnode/shared';
import { HttpError } from '../errors.ts';
import { catalogToDTO } from '../mssql/catalog.ts';
import { refreshCatalog, requireSession } from '../mssql/session.ts';
import { presets, settings, tagColors, tags } from '../store/sqlite.ts';
import { clearValidationCache } from '../validate.ts';

const idParam = z.object({ id: z.coerce.number().int() });
const colorParam = z.object({ color: z.string().regex(/^[0-9a-fA-F]{6}$/).transform((c) => `#${c.toLowerCase()}`) });
const palette = new Set<string>(TAG_PALETTE);

export default async function catalogRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Catálogo
  // -------------------------------------------------------------------------
  app.get('/api/catalog', async () => catalogToDTO(requireSession().catalog));

  app.post('/api/catalog/refresh', async () => {
    const c = await refreshCatalog();
    clearValidationCache();
    return catalogToDTO(c);
  });

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  function listTags(): TagDTO[] {
    const s = requireSession();
    return tags.list(s.profileId).map((t) => {
      const sourceIds: number[] = [];
      let missing = 0;
      for (const name of t.members) {
        const src = s.catalog.sourceByName.get(name);
        if (src) sourceIds.push(src.id);
        else missing++;
      }
      return { id: t.id, name: t.name, color: t.color, sourceIds, missing };
    });
  }

  app.get('/api/tags', async () => listTags());

  /** Un color fuera de la paleta base pasa a la paleta personalizada del perfil. */
  function rememberColor(profileId: string, color: string): void {
    if (!palette.has(color)) tagColors.add(profileId, color);
  }

  app.post('/api/tags', async (req) => {
    const s = requireSession();
    const body = tagCreateSchema.parse(req.body);
    let id: number;
    try {
      id = tags.create(s.profileId, body.name, body.color);
    } catch {
      throw new HttpError(409, `Ya existe un tag llamado "${body.name}"`, 'duplicate');
    }
    const names = body.sourceIds.map((sid) => s.catalog.sourceById.get(sid)?.name).filter((n): n is string => !!n);
    if (names.length) tags.addMembers(id, names);
    rememberColor(s.profileId, body.color);
    return listTags();
  });

  app.put('/api/tags/:id', async (req) => {
    const s = requireSession();
    const { id } = idParam.parse(req.params);
    const body = tagInputSchema.parse(req.body);
    try {
      if (!tags.update(s.profileId, id, body.name, body.color)) throw new HttpError(404, 'Tag no encontrado', 'not_found');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, `Ya existe un tag llamado "${body.name}"`, 'duplicate');
    }
    rememberColor(s.profileId, body.color);
    return listTags();
  });

  app.delete('/api/tags/:id', async (req) => {
    const s = requireSession();
    const { id } = idParam.parse(req.params);
    tags.remove(s.profileId, id);
    return listTags();
  });

  app.post('/api/tags/:id/members', async (req) => {
    const s = requireSession();
    const { id } = idParam.parse(req.params);
    if (!tags.owns(s.profileId, id)) throw new HttpError(404, 'Tag no encontrado', 'not_found');
    const body = tagMembersSchema.parse(req.body);
    const names = body.sourceIds.map((sid) => s.catalog.sourceById.get(sid)?.name).filter((n): n is string => !!n);
    if (body.action === 'add') tags.addMembers(id, names);
    else tags.removeMembers(id, names);
    return listTags();
  });

  // Paleta personalizada de colores (por perfil)
  app.get('/api/tag-colors', async () => tagColors.list(requireSession().profileId));

  app.post('/api/tag-colors', async (req) => {
    const s = requireSession();
    const { color } = tagColorSchema.parse(req.body);
    rememberColor(s.profileId, color);
    return tagColors.list(s.profileId);
  });

  app.delete('/api/tag-colors/:color', async (req) => {
    const s = requireSession();
    const { color } = colorParam.parse(req.params);
    tagColors.remove(s.profileId, color);
    return tagColors.list(s.profileId);
  });

  // -------------------------------------------------------------------------
  // Presets de mediciones
  // -------------------------------------------------------------------------
  function listPresets(): PresetDTO[] {
    const s = requireSession();
    return presets.list(s.profileId).map((p) => ({
      id: p.id,
      name: p.name,
      quantityIds: p.quantityNames.map((n) => s.catalog.quantityByName.get(n)?.id).filter((id): id is number => id != null),
    }));
  }

  app.get('/api/presets', async () => listPresets());

  app.post('/api/presets', async (req) => {
    const s = requireSession();
    const body = presetInputSchema.parse(req.body);
    const names = body.quantityIds.map((q) => s.catalog.quantityById.get(q)?.name).filter((n): n is string => !!n);
    presets.upsert(s.profileId, body.name, names);
    return listPresets();
  });

  app.delete('/api/presets/:id', async (req) => {
    const s = requireSession();
    const { id } = idParam.parse(req.params);
    presets.remove(s.profileId, id);
    return listPresets();
  });

  // -------------------------------------------------------------------------
  // Configuración de rendimiento
  // -------------------------------------------------------------------------
  app.get('/api/settings', async () => settings.get());

  app.put('/api/settings', async (req) => {
    const body = settingsSchema.parse(req.body);
    settings.set(body);
    return settings.get();
  });
}
