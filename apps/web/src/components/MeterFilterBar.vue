<script setup lang="ts">
import Icon from './Icon.vue';
import type { MeterFilterState } from '../lib/useMeterFilters';
import { useCatalogStore } from '../stores/catalog';

// `state` es el objeto reactivo de useMeterFilters: se modifica directamente.
const props = defineProps<{ state: MeterFilterState; active: boolean }>();
const emit = defineEmits<{ clear: [] }>();
const catalog = useCatalogStore();
const f = props.state;
</script>

<template>
  <div class="space-y-2">
    <div class="relative">
      <Icon name="search" class="absolute top-2.5 left-3 text-slate-400" />
      <input v-model="f.query" class="input pl-9" placeholder="Buscar por nombre, grupo o modelo… (varias palabras)" />
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <select v-model="f.group" class="input w-auto py-1.5" :class="f.group && 'border-brand-500'">
        <option value="">Todos los grupos</option>
        <option v-for="g in catalog.groups" :key="g.name" :value="g.name">{{ g.name }} ({{ g.count }})</option>
      </select>
      <select v-model="f.model" class="input w-auto py-1.5" :class="f.model && 'border-brand-500'">
        <option value="">Todos los modelos</option>
        <option v-for="m in catalog.models" :key="m.name" :value="m.name">{{ m.name }} ({{ m.count }})</option>
      </select>
      <select v-model="f.tag" class="input w-auto py-1.5" :class="f.tag !== '' && 'border-brand-500'">
        <option value="">Todos los tags</option>
        <option value="none">Sin tags</option>
        <option v-for="t in catalog.tags" :key="t.id" :value="t.id">{{ t.name }} ({{ t.sourceIds.length }})</option>
      </select>
      <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="f.onlyWithData" type="checkbox" class="checkbox" /> Solo con datos</label>
      <slot />
      <button v-if="active" type="button" class="btn btn-ghost btn-sm ml-auto text-slate-500" @click="emit('clear')"><Icon name="x" :size="12" /> Limpiar filtros</button>
    </div>
  </div>
</template>
