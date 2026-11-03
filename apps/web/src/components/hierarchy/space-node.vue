<script setup lang="ts">
import { computed, inject } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import Icon from '../Icon.vue';
import { hierarchyEditorKey, MAX_NODE_METERS, NODE_WIDTH, useDropZones } from '../../lib/hierarchy-editor';
import { useMeterDrag } from '../../lib/use-meter-drag';
import { useCatalogStore } from '../../stores/catalog';
import { useHierarchyStore } from '../../stores/hierarchy';

// Caja de un espacio físico: padre arriba, subespacios abajo, medidores dentro. Acepta medidores arrastrados.
const props = defineProps<NodeProps<{ id: number }>>();
const editor = inject(hierarchyEditorKey)!;
const zones = useDropZones(editor);
const drag = useMeterDrag();
const catalog = useCatalogStore();
const h = useHierarchyStore();

const space = computed(() => h.spaceById.get(props.data.id));
const key = computed(() => `s:${props.data.id}`);
const target = computed(() => ({ kind: 'space' as const, spaceId: props.data.id }));
const childCount = computed(() => h.spaces.filter((s) => s.parentId === props.data.id).length);
const members = computed(() => (space.value?.sourceIds ?? []).map((id) => catalog.sourceById.get(id)).filter((s) => !!s));
const issues = computed(() => editor.issuesByNode.value.get(props.data.id) ?? []);
const hasError = computed(() => issues.value.some((i) => i.severity === 'error'));
const dimmed = computed(() => !!editor.chain.value && !editor.chain.value.has(key.value));

function startDrag(e: DragEvent, sourceId: number) {
  const ids = editor.dragIds(sourceId);
  drag.start(e, ids, ids.map((id) => catalog.sourceById.get(id)?.name ?? ''));
}
</script>

<template>
  <div
    v-if="space"
    class="rounded-xl border-2 bg-white text-left shadow-sm transition-opacity"
    :class="[
      editor.selected.value === key ? 'border-teal-600 shadow-lg' : hasError ? 'border-red-400' : issues.length ? 'border-amber-300' : 'border-slate-300',
      editor.meterNode.value === key && 'ring-4 ring-sky-300',
      dimmed && 'opacity-35',
      zones.cls(target),
    ]"
    :style="{ width: NODE_WIDTH.space + 'px' }"
    @dragover="zones.over($event, target)"
    @dragleave="zones.leave($event, target)"
    @drop="zones.drop($event, target)"
  >
    <Handle id="in" type="target" :position="Position.Top" :is-valid-connection="editor.isValidConnection" class="!size-3 !border-2 !border-white !bg-teal-600" title="Conecta aquí la salida del espacio padre" />
    <header class="flex items-center gap-2 rounded-t-[10px] border-b border-slate-200 bg-teal-50/60 px-3 py-2">
      <Icon name="building" :size="16" class="text-teal-700" />
      <span class="min-w-0 flex-1 truncate font-semibold text-slate-900">{{ space.name }}</span>
      <span v-if="space.type" class="shrink-0 text-[11px] text-slate-500">{{ space.type }}</span>
      <span v-if="issues.length" :title="issues.map((i) => i.message).join('\n')"><Icon :name="hasError ? 'error' : 'alert'" :size="15" :class="hasError ? 'text-red-600' : 'text-amber-500'" /></span>
    </header>
    <div class="nodrag px-2 py-1.5">
      <div v-if="childCount" class="px-1 text-[11px] text-slate-500">{{ childCount }} subespacio(s)</div>
      <div
        v-for="s in members.slice(0, MAX_NODE_METERS)"
        :key="s.id"
        class="group flex h-6 cursor-grab items-center gap-1.5 rounded px-1 text-xs hover:bg-slate-100"
        draggable="true"
        @dragstart="startDrag($event, s.id)"
        @dragend="drag.end()"
      >
        <Icon name="bolt" :size="11" class="shrink-0 text-slate-400" />
        <span class="min-w-0 flex-1 truncate">{{ s.name }}</span>
        <button type="button" class="hidden text-slate-400 group-hover:block hover:text-red-600" title="Quitar del espacio" @click.stop="editor.removeMember(space.id, s.id)">
          <Icon name="x" :size="12" />
        </button>
      </div>
      <div v-if="members.length > MAX_NODE_METERS" class="px-1 text-[11px] text-slate-500">+{{ members.length - MAX_NODE_METERS }} medidores más (ver detalle)</div>
      <div v-if="!members.length" class="rounded border border-dashed border-slate-300 py-1.5 text-center text-[11px] text-slate-400">Suelta medidores aquí</div>
    </div>
    <Handle id="out" type="source" :position="Position.Bottom" :is-valid-connection="editor.isValidConnection" class="!size-3 !border-2 !border-white !bg-slate-700" title="Arrastra hasta otro espacio para hacerlo subespacio" />
  </div>
</template>
