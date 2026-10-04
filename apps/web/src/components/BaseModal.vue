<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{ title: string; size?: 'sm' | 'md' | 'lg' | 'xl'; closable?: boolean; tone?: 'default' | 'danger' | 'warning' }>(), {
  size: 'md',
  closable: true,
  tone: 'default',
});
const emit = defineEmits<{ close: [] }>();

const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.closable) emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8" @mousedown.self="closable && emit('close')">
      <div class="card flex max-h-[calc(100vh-4rem)] w-full flex-col overflow-hidden" :class="widths[size]" role="dialog" aria-modal="true">
        <header
          class="flex items-center gap-3 border-b px-5 py-3"
          :class="tone === 'danger' ? 'border-red-100 bg-red-50' : tone === 'warning' ? 'border-amber-100 bg-amber-50' : 'border-slate-100'"
        >
          <Icon v-if="tone === 'danger'" name="error" :size="20" class="text-red-600" />
          <Icon v-else-if="tone === 'warning'" name="alert" :size="20" class="text-amber-600" />
          <h2 class="flex-1 text-base font-semibold" :class="tone === 'danger' ? 'text-red-800' : 'text-slate-800'">{{ title }}</h2>
          <button v-if="closable" class="btn btn-ghost btn-sm" aria-label="Cerrar" @click="emit('close')"><Icon name="x" /></button>
        </header>
        <div class="flex-1 overflow-y-auto px-5 py-4">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
