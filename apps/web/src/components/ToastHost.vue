<script setup lang="ts">
import { useToastStore } from '../stores/toast';
import Icon from './Icon.vue';

const toast = useToastStore();
</script>

<template>
  <div class="pointer-events-none fixed right-4 bottom-20 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
    <TransitionGroup enter-from-class="translate-y-2 opacity-0" enter-active-class="transition" leave-to-class="opacity-0" leave-active-class="transition">
      <div
        v-for="t in toast.toasts"
        :key="t.id"
        class="pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg"
        :class="{
          'border-emerald-200 bg-emerald-50 text-emerald-900': t.kind === 'success',
          'border-red-200 bg-red-50 text-red-900': t.kind === 'error',
          'border-slate-200 bg-white text-slate-800': t.kind === 'info',
        }"
      >
        <Icon :name="t.kind === 'success' ? 'ok' : t.kind === 'error' ? 'error' : 'alert'" :size="18" class="mt-0.5" />
        <p class="flex-1 break-words">{{ t.message }}</p>
        <button class="opacity-60 hover:opacity-100" aria-label="Cerrar" @click="toast.dismiss(t.id)"><Icon name="x" /></button>
      </div>
    </TransitionGroup>
  </div>
</template>
