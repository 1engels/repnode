<script setup lang="ts">
import { computed, ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type { QuantityDTO } from '@repnode/shared';
import Icon from './Icon.vue';
import { useCatalogStore } from '../stores/catalog';
import { useToastStore } from '../stores/toast';
import { makeMatcher, normalize, formatNumber } from '../lib/util';

const props = defineProps<{
  /** Medidores efectivos (para calcular la cobertura de cada medición) */
  meterIds: number[];
  issues: Map<number, { quantityId: number; errors: number; partial: number }>;
}>();
const quantityIds = defineModel<number[]>({ required: true });

const catalog = useCatalogStore();
const toast = useToastStore();

const query = ref('');
const showAll = ref(false);
const presetName = ref('');
const presetToApply = ref<number | ''>('');

/** Cuántos de los medidores elegidos tienen datos de cada medición (según SourceQuantity). */
const coverage = computed(() => {
  const m = new Map<number, number>();
  for (const sid of props.meterIds) {
    const qs = catalog.sourceQuantities.get(sid);
    if (!qs) continue;
    for (const q of qs) m.set(q, (m.get(q) ?? 0) + 1);
  }
  return m;
});

const selectedSet = computed(() => new Set(quantityIds.value));

const available = computed<QuantityDTO[]>(() => {
  const match = makeMatcher(query.value);
  const cov = coverage.value;
  const noMeters = props.meterIds.length === 0;
  return catalog.quantities
    .filter((q) => (showAll.value || noMeters || cov.has(q.id)) && match(normalize(`${q.name} ${q.unit ?? ''}`)))
    .sort((a, b) => (cov.get(b.id) ?? 0) - (cov.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'es', { numeric: true }));
});

const listEl = ref<HTMLElement | null>(null);
const virt = useVirtualizer(computed(() => ({ count: available.value.length, getScrollElement: () => listEl.value, estimateSize: () => 40, overscan: 12 })));

function toggle(id: number) {
  quantityIds.value = selectedSet.value.has(id) ? quantityIds.value.filter((q) => q !== id) : [...quantityIds.value, id];
}

function move(index: number, delta: number) {
  const arr = [...quantityIds.value];
  const j = index + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  quantityIds.value = arr;
}

function coverageClass(id: number): string {
  const c = coverage.value.get(id) ?? 0;
  const n = props.meterIds.length;
  if (!n) return 'border-slate-200 bg-slate-50 text-slate-500';
  if (c === n) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (c === 0) return 'border-red-200 bg-red-50 text-red-700';
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

function applyPreset(mode: 'replace' | 'add') {
  const p = catalog.presets.find((x) => x.id === presetToApply.value);
  if (!p) return;
  quantityIds.value = mode === 'replace' ? [...p.quantityIds] : [...new Set([...quantityIds.value, ...p.quantityIds])];
  toast.success(`Preset "${p.name}" aplicado`);
}

async function savePreset() {
  if (!presetName.value.trim() || !quantityIds.value.length) return;
  try {
    await catalog.savePreset(presetName.value.trim(), quantityIds.value);
    toast.success('Preset guardado');
    presetName.value = '';
  } catch (e) {
    toast.error(e);
  }
}

async function deletePreset() {
  const p = catalog.presets.find((x) => x.id === presetToApply.value);
  if (!p || !confirm(`¿Eliminar el preset "${p.name}"?`)) return;
  await catalog.deletePreset(p.id).catch((e) => toast.error(e));
  presetToApply.value = '';
}
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2">
    <section class="card flex flex-col">
      <header class="space-y-3 border-b border-slate-100 p-4">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">Mediciones disponibles</h3>
          <span class="text-xs text-slate-500">{{ formatNumber(available.length) }} de {{ formatNumber(catalog.quantities.length) }}</span>
        </div>
        <div class="relative">
          <Icon name="search" class="absolute top-2.5 left-3 text-slate-400" />
          <input v-model="query" class="input pl-9" placeholder="Buscar medición o unidad… (p. ej. «kwh del»)" />
        </div>
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input v-model="showAll" type="checkbox" class="checkbox" /> Mostrar también mediciones que ningún medidor elegido registra
        </label>
        <p v-if="meterIds.length" class="text-xs text-slate-500">
          La etiqueta indica cuántos de los {{ formatNumber(meterIds.length) }} medidores elegidos registran la medición.
        </p>
      </header>
      <div ref="listEl" class="h-[440px] overflow-auto">
        <p v-if="!available.length" class="p-6 text-center text-sm text-slate-500">Sin coincidencias</p>
        <div :style="{ height: virt.getTotalSize() + 'px', position: 'relative' }">
          <div
            v-for="row in virt.getVirtualItems()"
            :key="String(row.key)"
            class="absolute inset-x-0 top-0 flex cursor-pointer items-center gap-3 border-b border-slate-50 px-4 select-none hover:bg-slate-50"
            :class="selectedSet.has(available[row.index].id) && 'bg-brand-50/60'"
            :style="{ height: row.size + 'px', transform: `translateY(${row.start}px)` }"
            @click="toggle(available[row.index].id)"
          >
            <input type="checkbox" class="checkbox pointer-events-none" :checked="selectedSet.has(available[row.index].id)" tabindex="-1" />
            <span class="min-w-0 flex-1 truncate text-sm">{{ available[row.index].name }}</span>
            <span v-if="available[row.index].unit" class="text-xs text-slate-500">{{ available[row.index].unit }}</span>
            <span v-if="meterIds.length" class="chip" :class="coverageClass(available[row.index].id)">
              {{ coverage.get(available[row.index].id) ?? 0 }}/{{ meterIds.length }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <section class="card flex flex-col">
      <header class="space-y-3 border-b border-slate-100 p-4">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">Seleccionadas <span class="text-brand-700">({{ quantityIds.length }})</span></h3>
          <button class="btn btn-ghost btn-sm text-red-600" :disabled="!quantityIds.length" @click="quantityIds = []"><Icon name="trash" /> Quitar todas</button>
        </div>
        <div class="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2">
          <select v-model="presetToApply" class="input w-auto flex-1 py-1 text-xs">
            <option value="">Presets guardados…</option>
            <option v-for="p in catalog.presets" :key="p.id" :value="p.id">{{ p.name }} ({{ p.quantityIds.length }})</option>
          </select>
          <button class="btn btn-sm" :disabled="presetToApply === ''" @click="applyPreset('replace')">Usar</button>
          <button class="btn btn-sm" :disabled="presetToApply === ''" @click="applyPreset('add')">Sumar</button>
          <button class="btn btn-ghost btn-sm text-red-600" :disabled="presetToApply === ''" title="Eliminar preset" @click="deletePreset"><Icon name="trash" /></button>
        </div>
        <form class="flex gap-2" @submit.prevent="savePreset">
          <input v-model="presetName" class="input py-1 text-xs" placeholder="Guardar selección como preset… (p. ej. Energía 4 cuadrantes)" maxlength="80" />
          <button class="btn btn-sm" :disabled="!presetName.trim() || !quantityIds.length">Guardar</button>
        </form>
      </header>
      <div class="h-[440px] overflow-auto">
        <div v-if="!quantityIds.length" class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500">
          <Icon name="bolt" :size="28" class="text-slate-300" />
          Elige las mediciones a exportar. El orden de esta lista es el orden de las columnas del CSV.
        </div>
        <ol>
          <li
            v-for="(qid, i) in quantityIds"
            :key="qid"
            class="flex items-center gap-2 border-b border-slate-50 px-4 py-2"
            :class="{ 'bg-red-50/70': issues.get(qid)?.errors, 'bg-amber-50/60': !issues.get(qid)?.errors && issues.get(qid)?.partial }"
          >
            <span class="w-6 text-right text-xs text-slate-400">{{ i + 1 }}</span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ catalog.quantityById.get(qid)?.name ?? `Medición ${qid}` }}</div>
              <div v-if="issues.get(qid)" class="text-xs">
                <span v-if="issues.get(qid)!.errors" class="font-medium text-red-700">{{ issues.get(qid)!.errors }} medidor(es) sin datos</span>
                <span v-if="issues.get(qid)!.errors && issues.get(qid)!.partial"> · </span>
                <span v-if="issues.get(qid)!.partial" class="text-amber-700">{{ issues.get(qid)!.partial }} con datos parciales</span>
              </div>
            </div>
            <span v-if="catalog.quantityById.get(qid)?.unit" class="text-xs text-slate-500">{{ catalog.quantityById.get(qid)?.unit }}</span>
            <span v-if="meterIds.length" class="chip" :class="coverageClass(qid)">{{ coverage.get(qid) ?? 0 }}/{{ meterIds.length }}</span>
            <button class="btn btn-ghost btn-sm" :disabled="i === 0" title="Subir" @click="move(i, -1)"><Icon name="up" /></button>
            <button class="btn btn-ghost btn-sm" :disabled="i === quantityIds.length - 1" title="Bajar" @click="move(i, 1)"><Icon name="down" /></button>
            <button class="btn btn-ghost btn-sm text-slate-400 hover:text-red-600" title="Quitar" @click="toggle(qid)"><Icon name="x" /></button>
          </li>
        </ol>
      </div>
    </section>
  </div>
</template>
