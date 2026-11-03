import type { Component } from 'vue';
import {
  IconAirConditioning, IconBuildingStore, IconBulbFilled, IconCarTurbine, IconLayoutDistributeVertical, IconNotes, IconPlug,
} from '@tabler/icons-vue';
import type { PanelIcon } from '@repnode/shared';

// Íconos de los tableros (@tabler/icons-vue, importados uno a uno para no cargar todo el paquete)
export const PANEL_ICON_COMPONENTS: Record<PanelIcon, Component> = {
  other: IconNotes,
  hvac: IconAirConditioning,
  plug: IconPlug,
  lighting: IconBulbFilled,
  store: IconBuildingStore,
  elevator: IconLayoutDistributeVertical,
  motor: IconCarTurbine,
};
