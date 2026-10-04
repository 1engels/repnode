<script lang="ts">
import type { TagDTO as Tag } from '@repnode/shared';

export interface TagChoice {
  tag: Tag;
  state: 'all' | 'some' | 'none';
  /** Medidores objetivo que ya tienen el tag (se muestra si hay más de un objetivo) */
  count?: number;
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { TagDTO } from '@repnode/shared';
import Icon from './Icon.vue';
import { makeMatcher, normalize } from '../lib/util';

// Lista de tags con estado por casilla (todos / algunos / ninguno de los medidores objetivo).
// Clic o Enter alterna; si lo escrito no existe, ofrece crear el tag.
const props = defineProps<{ items: TagChoice[]; total?: number; placeholder?: string; busy?: boolean }>();
const emit = defineEmits<{ toggle: [tag: TagDTO]; create: [name: string] }>();

const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);

const visible = computed(() => {
  const match = makeMatcher(query.value);
  return props.items.filter((i) => match(normalize(i.tag.name)));
});
const newName = computed(() => query.value.trim().replace(/\s+/g, ' '));
const canCreate = computed(() => !!newName.value && !props.items.some((i) => i.tag.name.toLowerCase() === newName.value.toLowerCase()));
const optionCount = computed(() => visible.value.length + (canCreate.value ? 1 : 0));
watch(query, () => (active.value = 0));

function choose(index: number) {
  if (props.busy) return;
  if (index < visible.value.length) emit('toggle', visible.value[index].tag);
  else if (canCreate.value) {
    emit('create', newName.value);
    query.value = '';
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') active.value = Math.min(optionCount.value - 1, active.value + 1);
  else if (e.key === 'ArrowUp') active.value = Math.max(0, active.value - 1);
  else if (e.key === 'Enter') choose(active.value);
  else return;
  e.preventDefault();
}

onMounted(() => input.value?.focus());
</script>

<template>
  <div>
    <div class="relative border-b border-slate-100 p-2">
      <Icon name="search" class="absolute top-4 left-4 text-slate-400" :size="14" />
      <input ref="input" v-model="query" class="input py-1.5 pl-8" :placeholder="placeholder ?? 'Buscar o crear tag…'" maxlength="60" @keydown="onKey" />
    </div>
    <ul class="max-h-64 overflow-y-auto py-1">
      <li v-if="!optionCount" class="px-3 py-3 text-center text-xs text-slate-500">
        {{ items.length ? 'Ningún tag coincide' : 'Aún no hay tags. Escribe un nombre para crear uno.' }}
      </li>
      <li
        v-for="(it, i) in visible"
        :key="it.tag.id"
        class="flex cursor-pointer items-center gap-2 px-3 py-1.5"
        :class="[i === active ? 'bg-slate-100' : 'hover:bg-slate-50', busy && 'opacity-60']"
        role="menuitemcheckbox"
        :aria-checked="it.state === 'all' ? 'true' : it.state === 'some' ? 'mixed' : 'false'"
        @mouseenter="active = i"
        @click="choose(i)"
      >
        <span
          class="flex size-4 shrink-0 items-center justify-center rounded border"
          :class="it.state === 'none' ? 'border-slate-300 bg-white' : 'border-transparent text-white'"
          :style="it.state !== 'none' ? { background: it.tag.color } : undefined"
        >
          <Icon v-if="it.state === 'all'" name="check" :size="12" />
          <span v-else-if="it.state === 'some'" class="h-0.5 w-2 rounded bg-white" />
        </span>
        <span class="size-2.5 shrink-0 rounded-full" :style="{ background: it.tag.color }" />
        <span class="min-w-0 flex-1 truncate">{{ it.tag.name }}</span>
        <span v-if="total && total > 1" class="text-xs text-slate-400">{{ it.count ?? 0 }}/{{ total }}</span>
      </li>
      <li
        v-if="canCreate"
        class="flex cursor-pointer items-center gap-2 border-t border-slate-100 px-3 py-2 text-brand-700"
        :class="active === visible.length ? 'bg-brand-50' : 'hover:bg-brand-50/60'"
        @mouseenter="active = visible.length"
        @click="choose(visible.length)"
      >
        <Icon name="plus" :size="14" /> Crear tag «<span class="truncate font-medium">{{ newName }}</span>»
      </li>
    </ul>
  </div>
</template>
