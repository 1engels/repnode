<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Settings } from '@repnode/shared';
import Icon from '../components/Icon.vue';
import { get, put } from '../lib/api';
import { formatIsoDate, formatNumber } from '../lib/util';
import { useCatalogStore } from '../stores/catalog';
import { useToastStore } from '../stores/toast';

const catalog = useCatalogStore();
const toast = useToastStore();
const settings = ref<Settings | null>(null);
const saving = ref(false);
const refreshing = ref(false);

onMounted(async () => {
  try {
    settings.value = await get<Settings>('/api/settings');
    await catalog.load();
  } catch (e) {
    toast.error(e);
  }
});

const totalConnections = computed(() => (settings.value ? settings.value.workers * settings.value.concurrency : 0));

async function save() {
  if (!settings.value) return;
  saving.value = true;
  try {
    settings.value = await put<Settings>('/api/settings', settings.value);
    toast.success('Configuración guardada');
  } catch (e) {
    toast.error(e);
  } finally {
    saving.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  try {
    await catalog.load(true);
    toast.success('Catálogo actualizado');
  } catch (e) {
    toast.error(e);
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-2">
    <section class="card p-6">
      <h2 class="text-lg font-semibold">Rendimiento de extracción</h2>
      <p class="mt-1 text-sm text-slate-600">
        Los medidores se reparten entre varios hilos de trabajo (workers) y cada uno hace varias consultas en paralelo, con su propio pool de conexiones.
        Súbelo si el servidor SQL lo aguanta y bájalo si PME se pone lento durante la extracción.
      </p>
      <form v-if="settings" class="mt-5 grid gap-4 sm:grid-cols-2" @submit.prevent="save">
        <div>
          <label class="label" for="w">Workers (hilos)</label>
          <input id="w" v-model.number="settings.workers" type="number" min="1" max="16" class="input" />
        </div>
        <div>
          <label class="label" for="c">Consultas en paralelo por worker</label>
          <input id="c" v-model.number="settings.concurrency" type="number" min="1" max="32" class="input" />
        </div>
        <div class="rounded-lg bg-slate-50 p-3 text-sm sm:col-span-2">
          Conexiones simultáneas a SQL Server durante la extracción: <b>{{ totalConnections }}</b>
          <span v-if="totalConnections > 24" class="text-amber-700"> · Valor alto: vigila la carga del servidor.</span>
        </div>
        <div>
          <label class="label" for="t">Tiempo máximo por consulta (s)</label>
          <input id="t" v-model.number="settings.requestTimeoutSeconds" type="number" min="30" max="21600" class="input" />
        </div>
        <div>
          <label class="label" for="ttl">Conservar descargas (min)</label>
          <input id="ttl" v-model.number="settings.downloadTtlMinutes" type="number" min="5" max="1440" class="input" />
        </div>
        <label class="flex items-start gap-2 text-sm sm:col-span-2">
          <input v-model="settings.readUncommitted" type="checkbox" class="checkbox mt-0.5" />
          <span>
            <b>Lectura sin bloqueos (READ UNCOMMITTED)</b><br />
            <span class="text-slate-600">Evita bloquear la escritura de datos de PME mientras se extrae. Recomendado para datos históricos.</span>
          </span>
        </label>
        <div class="flex justify-end sm:col-span-2">
          <button class="btn btn-primary" :disabled="saving"><Icon name="check" /> Guardar</button>
        </div>
      </form>
    </section>

    <section class="card p-6">
      <h2 class="text-lg font-semibold">Catálogo de la base de datos</h2>
      <p class="mt-1 text-sm text-slate-600">
        Medidores (Source), mediciones (Quantity) y disponibilidad (SourceQuantity) se leen al conectar y quedan en memoria. Actualízalo si se agregaron
        medidores en PME.
      </p>
      <dl v-if="catalog.catalog" class="mt-5 grid grid-cols-3 gap-3 text-sm">
        <div class="rounded-lg bg-slate-50 p-3"><dt class="text-xs text-slate-500">Medidores</dt><dd class="text-lg font-semibold">{{ formatNumber(catalog.sources.length) }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-3"><dt class="text-xs text-slate-500">Mediciones con datos</dt><dd class="text-lg font-semibold">{{ formatNumber(catalog.quantities.length) }}</dd></div>
        <div class="rounded-lg bg-slate-50 p-3"><dt class="text-xs text-slate-500">Grupos</dt><dd class="text-lg font-semibold">{{ formatNumber(catalog.groups.length) }}</dd></div>
      </dl>
      <p v-if="catalog.catalog" class="mt-3 text-xs text-slate-500">Cargado: {{ formatIsoDate(catalog.catalog.loadedAt) }}</p>
      <button class="btn mt-4" :disabled="refreshing" @click="refresh"><Icon name="refresh" :class="refreshing && 'animate-spin'" /> Actualizar catálogo</button>
    </section>
  </div>
</template>
