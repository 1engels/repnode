<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseModal from './BaseModal.vue';
import { useCatalogStore } from '../stores/catalog';
import { normalize } from '../lib/util';

const emit = defineEmits<{ close: []; add: [ids: number[]] }>();
const catalog = useCatalogStore();
const text = ref('');

const index = computed(() => {
  const m = new Map<string, number>();
  for (const s of catalog.sources) {
    m.set(normalize(s.name), s.id);
    m.set(normalize(s.displayName), s.id);
  }
  return m;
});

const parsed = computed(() => {
  const items = text.value.split(/[\r\n;\t]+/).map((s) => s.trim()).filter(Boolean);
  const found = new Set<number>();
  const notFound: string[] = [];
  for (const it of items) {
    const id = index.value.get(normalize(it));
    if (id != null) found.add(id);
    else notFound.push(it);
  }
  return { total: items.length, found: [...found], notFound };
});
</script>

<template>
  <BaseModal title="Pegar lista de medidores" size="lg" @close="emit('close')">
    <p class="text-sm text-slate-600">
      Pega nombres de medidores (uno por línea, o separados por <code>;</code> o tabulación), por ejemplo una columna copiada de Excel. Se buscan
      por nombre visible o por nombre interno, sin distinguir mayúsculas ni tildes.
    </p>
    <textarea v-model="text" class="input mt-3 h-56 font-mono text-xs" placeholder="OFFLINE.MAIN&#10;Tablero General&#10;..." autofocus />
    <div v-if="parsed.total" class="mt-3 grid gap-3 sm:grid-cols-2">
      <div class="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
        <b>{{ parsed.found.length }}</b> medidores encontrados de {{ parsed.total }} líneas
      </div>
      <div v-if="parsed.notFound.length" class="rounded-lg bg-red-50 p-3 text-sm text-red-800">
        <b>{{ parsed.notFound.length }}</b> no encontrados:
        <ul class="mt-1 max-h-28 overflow-auto font-mono text-xs">
          <li v-for="n in parsed.notFound.slice(0, 200)" :key="n">{{ n }}</li>
        </ul>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancelar</button>
      <button class="btn btn-primary" :disabled="!parsed.found.length" @click="emit('add', parsed.found)">Agregar {{ parsed.found.length }} medidores</button>
    </template>
  </BaseModal>
</template>
