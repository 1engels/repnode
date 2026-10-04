<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { TAG_PALETTE } from '@repnode/shared';
import Icon from './Icon.vue';
import { useCatalogStore } from '../stores/catalog';
import { useToastStore } from '../stores/toast';

// Paleta base + colores personalizados del perfil (guardados en el servidor) + selector libre.
const color = defineModel<string>({ required: true });
const catalog = useCatalogStore();
const toast = useToastStore();

const hex = ref(color.value);
watch(color, (c) => (hex.value = c));
const hexValid = computed(() => /^#[0-9a-fA-F]{6}$/.test(hex.value));
const isCustom = computed(() => !(TAG_PALETTE as readonly string[]).includes(color.value.toLowerCase()));
const saved = computed(() => catalog.tagColors.includes(color.value.toLowerCase()));

function applyHex() {
  if (hexValid.value) color.value = hex.value.toLowerCase();
}

async function save() {
  try {
    await catalog.addTagColor(color.value);
  } catch (e) {
    toast.error(e);
  }
}

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
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="c in TAG_PALETTE"
        :key="c"
        type="button"
        class="size-6 rounded-full ring-offset-2 transition hover:scale-110"
        :class="color === c && 'ring-2 ring-slate-500'"
        :style="{ background: c }"
        :title="c"
        @click="color = c"
      />
    </div>
    <div v-if="catalog.tagColors.length" class="flex flex-wrap items-center gap-1.5">
      <span class="w-full text-[11px] font-medium text-slate-500">Personalizados</span>
      <span v-for="c in catalog.tagColors" :key="c" class="group relative">
        <button
          type="button"
          class="size-6 rounded-full ring-offset-2 transition hover:scale-110"
          :class="color === c && 'ring-2 ring-slate-500'"
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
    <div class="flex items-center gap-2">
      <label class="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-slate-300" title="Elegir otro color">
        <input v-model="color" type="color" class="absolute -inset-2 size-12 cursor-pointer" />
      </label>
      <input v-model="hex" class="input py-1.5 font-mono text-xs uppercase" :class="!hexValid && 'border-red-300'" maxlength="7" @change="applyHex" @keydown.enter.prevent="applyHex" />
      <button v-if="isCustom && !saved" type="button" class="btn btn-sm shrink-0" title="Guardar en la paleta personalizada" @click="save">
        <Icon name="plus" :size="12" /> Guardar
      </button>
    </div>
  </div>
</template>
