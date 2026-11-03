<script setup lang="ts">
import { computed } from 'vue';
import { TAG_PALETTE } from '@repnode/shared';
import Icon from './Icon.vue';
import { useCatalogStore } from '../stores/catalog';
import { useToastStore } from '../stores/toast';

// 8 colores base + un 9.º círculo con el selector libre + colores personalizados del perfil (guardados en el servidor;
// un tag creado o editado con un color fuera de la base lo agrega solo).
const color = defineModel<string>({ required: true });
const catalog = useCatalogStore();
const toast = useToastStore();

const current = computed(() => color.value.toLowerCase());
const isBase = computed(() => (TAG_PALETTE as readonly string[]).includes(current.value));
// El 9.º círculo muestra el color elegido con el selector mientras no sea uno de la base ni de los guardados
const pickerColor = computed(() => (isBase.value || catalog.tagColors.includes(current.value) ? null : current.value));

async function forget(c: string) {
  try {
    await catalog.deleteTagColor(c);
  } catch (e) {
    toast.error(e);
  }
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap gap-2">
      <button
        v-for="c in TAG_PALETTE"
        :key="c"
        type="button"
        class="size-6 rounded-full ring-offset-2 transition hover:scale-110"
        :class="current === c && 'ring-2 ring-slate-500'"
        :style="{ background: c }"
        :title="c"
        @click="color = c"
      />
      <label
        class="relative size-6 cursor-pointer overflow-hidden rounded-full ring-offset-2 transition hover:scale-110"
        :class="pickerColor && 'ring-2 ring-slate-500'"
        :style="{ background: pickerColor ?? 'conic-gradient(#ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)' }"
        :title="pickerColor ? `${pickerColor} · elegir otro color` : 'Elegir otro color'"
      >
        <input v-model="color" type="color" class="absolute -inset-2 size-10 cursor-pointer opacity-0" />
      </label>
    </div>
    <div v-if="catalog.tagColors.length" class="flex flex-wrap items-center gap-2">
      <span class="w-full text-[11px] font-medium text-slate-500">Personalizados</span>
      <span v-for="c in catalog.tagColors" :key="c" class="group relative">
        <button
          type="button"
          class="size-6 rounded-full ring-offset-2 transition hover:scale-110"
          :class="current === c && 'ring-2 ring-slate-500'"
          :style="{ background: c }"
          :title="c"
          @click="color = c"
        />
        <button
          type="button"
          class="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm group-hover:flex hover:text-red-600"
          title="Quitar de la paleta"
          @click="forget(c)"
        >
          <Icon name="x" :size="10" />
        </button>
      </span>
    </div>
  </div>
</template>
