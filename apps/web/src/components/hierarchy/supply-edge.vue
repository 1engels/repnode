<script setup lang="ts">
import { computed } from 'vue';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@vue-flow/core';
import type { EdgeLane } from '@repnode/shared';

// Arista de Suministro: el tramo horizontal va por su carril (`edgeLanes` de shared), centrado entre los dos tableros.
// Así las aristas que salen del mismo tablero no se enciman y la etiqueta (el medidor), que va en ese tramo, no se
// superpone con la de las demás.
const props = defineProps<EdgeProps<EdgeLane>>();

/** Separación entre carriles (más que el alto de la etiqueta) y distancia mínima a cada caja */
const LANE = 24;
const MARGIN = 26;

const path = computed(() => {
  const { sourceX, sourceY, targetX, targetY } = props;
  const top = sourceY + MARGIN;
  const bottom = targetY - MARGIN;
  const lanes = props.data?.lanes ?? 1;
  const lane = props.data?.lane ?? 0;
  let centerY: number | undefined;
  // Destino por encima del origen o muy cerca: el recorrido por defecto
  if (bottom > top) {
    const step = lanes > 1 ? Math.min(LANE, (bottom - top) / (lanes - 1)) : 0;
    const first = (top + bottom) / 2 - ((lanes - 1) * step) / 2;
    centerY = Math.min(Math.max(first + lane * step, top), bottom);
  }
  return getSmoothStepPath({ sourceX, sourceY, sourcePosition: props.sourcePosition, targetX, targetY, targetPosition: props.targetPosition, centerY, borderRadius: 8 });
});
</script>

<template>
  <BaseEdge
    :id="id"
    :path="path[0]"
    :label-x="path[1]"
    :label-y="path[2]"
    :label="label"
    :label-style="labelStyle"
    :label-show-bg="true"
    :label-bg-style="labelBgStyle"
    :label-bg-padding="[4, 2]"
    :label-bg-border-radius="3"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
    :style="style"
  />
</template>
