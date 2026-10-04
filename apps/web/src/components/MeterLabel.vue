<script setup lang="ts">
import type { SourceDTO } from '@repnode/shared';

// Nombre GRUPO.MEDIDOR con el modelo (SourceType) al lado en gris claro.
// La segunda línea muestra el slot o, si difiere, el DisplayName.
defineProps<{ source: SourceDTO }>();
</script>

<template>
  <div class="min-w-0">
    <div class="flex min-w-0 items-baseline gap-2">
      <span class="truncate text-sm font-medium text-slate-800">{{ source.name }}</span>
      <span v-if="source.type" class="shrink-0 truncate text-xs text-slate-400">{{ source.type }}</span>
    </div>
    <div v-if="$slots.default || source.displayName !== source.name" class="truncate text-xs text-slate-500">
      <slot>{{ source.displayName }}</slot>
    </div>
  </div>
</template>
