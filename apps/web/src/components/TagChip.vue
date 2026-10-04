<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{ name: string; color: string; count?: number; removable?: boolean; small?: boolean }>();
const emit = defineEmits<{ remove: [] }>();
</script>

<template>
  <span class="chip max-w-full border-slate-200 bg-white" :class="small && 'px-1.5 py-0 text-[11px]'" :style="{ color }">
    <span class="size-2 shrink-0 rounded-full" :style="{ background: color }" />
    <span class="truncate">{{ name }}</span>
    <span v-if="count != null" class="text-slate-400">({{ count }})</span>
    <button v-if="removable" type="button" class="-mr-0.5 rounded-full text-slate-400 hover:text-red-600" :title="`Quitar «${name}»`" @click.stop="emit('remove')">
      <Icon name="x" :size="12" />
    </button>
  </span>
</template>
