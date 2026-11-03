import { panelIconSchema, type HierarchyDTO, type PanelDTO, type SpaceDTO } from '@repnode/shared';
import type { Session } from './mssql/session.ts';
import { panels, spaces } from './store/sqlite.ts';

/** Jerarquías del perfil con los medidores resueltos a IDs del catálogo actual. */
export function hierarchyDTO(session: Session): HierarchyDTO {
  const { catalog, profileId } = session;
  const resolve = (names: string[]) => {
    const sourceIds: number[] = [];
    let missing = 0;
    for (const name of names) {
      const src = catalog.sourceByName.get(name);
      if (src) sourceIds.push(src.id);
      else missing++;
    }
    return { sourceIds, missing };
  };

  const panelDTOs = panels.list(profileId).map((p): PanelDTO => {
    const loads = resolve(p.loads);
    const totalizerSourceId = p.totalizer ? (catalog.sourceByName.get(p.totalizer)?.id ?? null) : null;
    return {
      id: p.id,
      name: p.name,
      mode: p.mode,
      description: p.description,
      x: p.x,
      y: p.y,
      inputs: p.inputs.map((i) => {
        const sourceId = i.sourceName ? (catalog.sourceByName.get(i.sourceName)?.id ?? null) : null;
        return { id: i.id, fromPanelId: i.fromPanelId, origin: i.origin, label: i.label, sourceId, missingMeter: !!i.sourceName && sourceId == null };
      }),
      totalizerSourceId,
      missingTotalizer: !!p.totalizer && totalizerSourceId == null,
      color: p.color,
      icon: panelIconSchema.catch('other').parse(p.icon),
      loadSourceIds: loads.sourceIds,
      missing: loads.missing,
    };
  });

  const spaceDTOs = spaces.list(profileId).map((s): SpaceDTO => {
    const members = resolve(s.members);
    return { id: s.id, parentId: s.parentId, name: s.name, type: s.type, x: s.x, y: s.y, sourceIds: members.sourceIds, missing: members.missing };
  });

  return { panels: panelDTOs, spaces: spaceDTOs };
}
