<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { SPACE_TYPES, spaceDescendants, spacePath, type DesignIssue, type SpaceSave } from '@repnode/shared';
import Icon from '../Icon.vue';
import MeterLabel from '../MeterLabel.vue';
import { useCatalogStore } from '../../stores/catalog';
import { spaceToSave, useHierarchyStore } from '../../stores/hierarchy';
import { useToastStore } from '../../stores/toast';

// Configuración de un espacio físico: nombre, tipo, ubicación en el árbol y medidores.
const props = defineProps<{ spaceId: number; issues: DesignIssue[] }>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();

const catalog = useCatalogStore();
const h = useHierarchyStore();
const toast = useToastStore();

const space = computed(() => h.spaceById.get(props.spaceId));
const form = ref<SpaceSave>(space.value ? spaceToSave(space.value) : { name: '', type: null, parentId: null });
const baseline = ref(JSON.stringify(form.value));
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value);

watch(
  () => [props.spaceId, space.value ? JSON.stringify(spaceToSave(space.value)) : ''] as const,
  ([id, json], old) => {
    if (!json || (dirty.value && old?.[0] === id)) return;
    form.value = JSON.parse(json) as SpaceSave;
    baseline.value = json;
  },
);

const path = computed(() => spacePath(h.spaces, props.spaceId).slice(0, -1).map((id) => h.spaceById.get(id)!.name));
const descendants = computed(() => spaceDescendants(h.spaces, [props.spaceId]));
const parents = computed(() =>
  h.spaces.filter((s) => !descendants.value.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true })),
);
const children = computed(() => h.spaces.filter((s) => s.parentId === props.spaceId).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true })));
const members = computed(() => (space.value?.sourceIds ?? []).map((id) => catalog.sourceById.get(id)).filter((s) => !!s));

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error(e);
  }
}

const save = () =>
  run(async () => {
    await h.updateSpace(props.spaceId, { ...form.value });
    discard();
  }, 'Espacio guardado');

function discard() {
  if (!space.value) return;
  form.value = spaceToSave(space.value);
  baseline.value = JSON.stringify(form.value);
}

const newChild = ref('');
const addChild = () =>
  run(async () => {
    const name = newChild.value.trim();
    if (!name) return;
    await h.createSpace({ name, type: null, parentId: props.spaceId });
    newChild.value = '';
  });

const removeMember = (sourceId: number) => run(() => h.setSpaceMembers(props.spaceId, [sourceId], 'remove'));

async function remove() {
  const s = space.value;
  if (!s) return;
  const where = s.parentId != null ? `«${h.spaceById.get(s.parentId)?.name}»` : 'el nivel superior';
  if (!confirm(`¿Eliminar el espacio «${s.name}»? Sus subespacios pasan a ${where}${s.parentId != null ? ' y sus medidores también' : ' y sus medidores quedan sin ubicar'}.`)) return;
  await run(async () => {
    await h.deleteSpace(s.id);
    emit('close');
  });
}
</script>

<template>
  <div v-if="space" class="space-y-4">
    <div class="flex items-center gap-2">
      <Icon name="building" :size="18" class="text-teal-700" />
      <div class="min-w-0 flex-1">
        <div v-if="path.length" class="truncate text-[11px] text-slate-500">{{ path.join(' › ') }}</div>
        <h3 class="truncate font-semibold">{{ space.name }}</h3>
      </div>
      <button class="btn btn-ghost btn-sm" title="Cerrar" @click="emit('close')"><Icon name="x" /></button>
    </div>

    <ul v-if="issues.length" class="space-y-1">
      <li v-for="(i, k) in issues" :key="k" class="flex gap-1.5 rounded-lg px-2 py-1 text-xs" :class="i.severity === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'">
        <Icon :name="i.severity === 'error' ? 'error' : 'alert'" :size="13" class="mt-px" /> {{ i.message }}
      </li>
    </ul>

    <form class="space-y-3" @submit.prevent="save">
      <div>
        <label class="label">Nombre</label>
        <input v-model="form.name" class="input py-1.5" maxlength="80" required />
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="label">Tipo</label>
          <input v-model="form.type" class="input py-1.5" list="space-types" maxlength="40" placeholder="Edificio, Piso…" />
          <datalist id="space-types"><option v-for="t in SPACE_TYPES" :key="t" :value="t" /></datalist>
        </div>
        <div>
          <label class="label">Dentro de</label>
          <select v-model="form.parentId" class="input py-1.5">
            <option :value="null">(nivel superior)</option>
            <option v-for="p in parents" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary btn-sm" :disabled="!dirty || !form.name.trim()"><Icon name="check" :size="12" /> Guardar cambios</button>
        <button type="button" class="btn btn-sm" :disabled="!dirty" @click="discard">Descartar</button>
      </div>
    </form>

    <section>
      <h4 class="mb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">Subespacios ({{ children.length }})</h4>
      <button v-for="c in children" :key="c.id" type="button" class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-slate-50" @click="emit('select', `s:${c.id}`)">
        <Icon name="building" :size="13" class="text-slate-400" /> {{ c.name }} <span v-if="c.type" class="ml-auto text-[11px] text-slate-400">{{ c.type }}</span>
      </button>
      <form class="mt-1 flex gap-2" @submit.prevent="addChild">
        <input v-model="newChild" class="input py-1 text-xs" maxlength="80" placeholder="Nuevo subespacio…" />
        <button class="btn btn-sm" :disabled="!newChild.trim()"><Icon name="plus" :size="12" /></button>
      </form>
    </section>

    <section>
      <h4 class="mb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">Medidores ({{ members.length }})</h4>
      <p v-if="!members.length" class="text-xs text-slate-500">Arrastra medidores desde la lista hasta la caja del espacio.</p>
      <div v-for="s in members" :key="s.id" class="group flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
        <MeterLabel :source="s" class="flex-1" />
        <button type="button" class="text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-600" title="Quitar del espacio" @click="removeMember(s.id)"><Icon name="x" :size="13" /></button>
      </div>
    </section>

    <button type="button" class="btn btn-danger btn-sm" @click="remove"><Icon name="trash" :size="12" /> Eliminar espacio</button>
  </div>
</template>
