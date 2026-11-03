<script setup lang="ts">
import { computed, inject } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import Icon from '../Icon.vue';
import { hierarchyEditorKey, NODE_WIDTH } from '../../lib/hierarchy-editor';

// Fuente externa (red pública, grupo electrógeno…) de una entrada que no viene de otro tablero.
const props = defineProps<NodeProps<{ panelId: number; origin: string | null }>>();
const editor = inject(hierarchyEditorKey)!;
const dimmed = computed(() => !!editor.chain.value && !editor.chain.value.has(`p:${props.data.panelId}`));
</script>

<template>
  <div
    class="flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs shadow-sm transition-opacity"
    :class="[data.origin ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-dashed border-amber-400 bg-amber-50 text-amber-700', dimmed && 'opacity-35']"
    :style="{ width: NODE_WIDTH.source + 'px' }"
    :title="data.origin ? `Fuente externa: ${data.origin}` : 'Entrada sin origen: indica el tablero o la fuente externa'"
  >
    <Icon name="plug" :size="13" />
    <span class="truncate font-medium">{{ data.origin ?? 'Origen sin definir' }}</span>
    <Handle id="out" type="source" :position="Position.Bottom" :connectable="false" class="!size-2 !bg-emerald-600" />
  </div>
</template>
