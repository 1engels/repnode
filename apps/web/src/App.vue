<script setup lang="ts">
import { useRouter } from 'vue-router';
import Icon from './components/Icon.vue';
import ToastHost from './components/ToastHost.vue';
import { useCatalogStore } from './stores/catalog';
import { useReportsStore } from './stores/reports';
import { useSessionStore } from './stores/session';
import { useToastStore } from './stores/toast';

const session = useSessionStore();
const catalog = useCatalogStore();
const reports = useReportsStore();
const toast = useToastStore();
const router = useRouter();

async function disconnect() {
  try {
    await session.disconnect();
  } catch (e) {
    toast.error(e);
  }
  catalog.reset();
  reports.reset();
  router.push({ name: 'connect' });
}
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <RouterLink to="/reports" class="flex items-center gap-2 font-semibold text-slate-900">
          <img src="/favicon.svg" alt="" class="size-7" />
          <span>RepNode</span>
          <span class="hidden text-sm font-normal text-slate-500 sm:inline">· Extractor de mediciones</span>
        </RouterLink>
        <nav v-if="session.connected" class="ml-4 flex items-center gap-1 text-sm">
          <RouterLink to="/reports" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Reportes</RouterLink>
          <RouterLink to="/tags" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Tags</RouterLink>
          <RouterLink to="/settings" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Configuración</RouterLink>
        </nav>
        <div class="ml-auto flex items-center gap-3">
          <template v-if="session.connected">
            <div class="hidden text-right text-xs leading-tight md:block">
              <div class="flex items-center justify-end gap-1.5 font-medium text-slate-700">
                <span class="size-2 rounded-full bg-emerald-500" />{{ session.session.database }} @ {{ session.session.server }}
              </div>
              <div class="text-slate-500">{{ session.session.username }} · SQL Server {{ session.session.serverVersion }}</div>
            </div>
            <button class="btn btn-sm" title="Desconectar" @click="disconnect"><Icon name="logout" /> Desconectar</button>
          </template>
        </div>
      </div>
    </header>
    <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
      <RouterView />
    </main>
    <ToastHost />
  </div>
</template>
