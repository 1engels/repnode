<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import BaseModal from './BaseModal.vue';
import Icon from './Icon.vue';
import MeterFilterBar from './MeterFilterBar.vue';
import MeterLabel from './MeterLabel.vue';
import { useMeterFilters } from '../lib/useMeterFilters';
import { formatNumber } from '../lib/util';
import { useCatalogStore, type IndexedSource } from '../stores/catalog';

// Selector de medidores a pantalla grande (pensado para cientos de medidores): filtros comunes, lista virtualizada,
// medidores recomendados primero y una nota por medidor (dónde está, si se moverá o si no se puede elegir).
interface MeterNote {
  text: string;
  /** No se puede elegir */
  blocked?: boolean;
}

const props = defineProps<{
  title: string;
  multiple?: boolean;
  note?: (sourceId: number) => MeterNote | null;
  /** Se muestran primero, marcados como recomendados */
  recommended?: readonly number[];
  recommendedLabel?: string;
  /** Medidor actual (selección simple): permite quitarlo */
  current?: number | null;
}>();
const emit = defineEmits<{ pick: [sourceIds: number[]]; clear: []; close: [] }>();

const catalog = useCatalogStore();
const onlyFree = ref(false);
const rec = computed(() => new Set(props.recommended ?? []));

const filters = useMeterFilters({}, () => (onlyFree.value ? (s: IndexedSource) => !props.note?.(s.id) || rec.value.has(s.id) : null));
const list = computed(() => {
  const all = filters.filtered.value;
  if (!rec.value.size) return all;
  return [...all.filter((s) => rec.value.has(s.id)), ...all.filter((s) => !rec.value.has(s.id))];
});

const chosen = shallowRef(new Set<number>());
function onRow(s: IndexedSource) {
  if (props.note?.(s.id)?.blocked) return;
  if (!props.multiple) {
    emit('pick', [s.id]);
    return;
  }
  const next = new Set(chosen.value);
  if (next.has(s.id)) next.delete(s.id);
  else next.add(s.id);
  chosen.value = next;
}

const listEl = ref<HTMLElement | null>(null);
const virt = useVirtualizer(
  computed(() => ({ count: list.value.length, getScrollElement: () => listEl.value, estimateSize: () => 52, overscan: 12, getItemKey: (i: number) => list.value[i]?.id ?? i })),
);
</script>

<template>
  <BaseModal :title="title" size="xl" @close="emit('close')">
    <div class="space-y-3">
      <MeterFilterBar :state="filters.state" :active="filters.active.value || onlyFree" @clear="filters.clear(); onlyFree = false">
        <label class="flex items-center gap-1.5 text-xs text-slate-600"><input v-model="onlyFree" type="checkbox" class="checkbox" /> Solo libres</label>
      </MeterFilterBar>
      <div class="flex items-center justify-between text-xs text-slate-500">
        <span>{{ formatNumber(list.length) }} de {{ formatNumber(catalog.sources.length) }} medidores</span>
        <span v-if="recommended?.length">{{ recommendedLabel ?? 'Recomendados' }} primero</span>
      </div>
      <div ref="listEl" class="h-[55vh] overflow-auto rounded-lg border border-slate-200">
        <p v-if="!list.length" class="p-6 text-center text-sm text-slate-500">Ningún medidor coincide con los filtros</p>
        <div :style="{ height: virt.getTotalSize() + 'px', position: 'relative' }">
          <div
            v-for="row in virt.getVirtualItems()"
            :key="String(row.key)"
            class="absolute inset-x-0 top-0 flex items-center gap-3 border-b border-slate-100 px-3 select-none"
            :class="[
              note?.(list[row.index].id)?.blocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-brand-50',
              (chosen.has(list[row.index].id) || current === list[row.index].id) && 'bg-brand-50',
            ]"
            :style="{ height: row.size + 'px', transform: `translateY(${row.start}px)` }"
            @click="onRow(list[row.index])"
          >
            <input
              v-if="multiple"
              type="checkbox"
              class="checkbox pointer-events-none shrink-0"
              :checked="chosen.has(list[row.index].id)"
              :disabled="!!note?.(list[row.index].id)?.blocked"
              tabindex="-1"
            />
            <Icon v-else-if="current === list[row.index].id" name="check" :size="16" class="shrink-0 text-brand-600" />
            <span v-else class="size-4 shrink-0" />
            <MeterLabel :source="list[row.index]" class="flex-1" />
            <span v-if="rec.has(list[row.index].id)" class="chip shrink-0 border-emerald-200 bg-emerald-50 text-emerald-700">{{ recommendedLabel ?? 'recomendado' }}</span>
            <span
              v-if="note?.(list[row.index].id)"
              class="max-w-[45%] shrink-0 truncate text-right text-xs"
              :class="note(list[row.index].id)!.blocked ? 'text-red-600' : 'text-amber-700'"
              :title="note(list[row.index].id)!.text"
            >{{ note(list[row.index].id)!.text }}</span>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <button v-if="!multiple && current != null" type="button" class="btn btn-danger mr-auto" @click="emit('clear')"><Icon name="x" :size="14" /> Quitar medidor</button>
      <button type="button" class="btn" @click="emit('close')">Cancelar</button>
      <button v-if="multiple" type="button" class="btn btn-primary" :disabled="!chosen.size" @click="emit('pick', [...chosen])">
        <Icon name="plus" :size="14" /> Agregar {{ chosen.size ? formatNumber(chosen.size) : '' }}
      </button>
    </template>
  </BaseModal>
</template>
