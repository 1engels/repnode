<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
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
const route = useRoute();
const logo = `${import.meta.env.BASE_URL}favicon.svg`;

/** Abre el inicio de sesión de PME en la ventana principal (RepNode está dentro de un iframe de PME). */
function goToPmeLogin() {
  const target = (() => {
    try {
      return window.top ?? window;
    } catch {
      return window;
    }
  })();
  let returnUrl = '/';
  try {
    returnUrl = target.location.pathname + target.location.search;
  } catch {
    // Otro origen: se vuelve al inicio de PME
  }
  const url = `${session.authLost ?? '/'}${session.authLost?.includes('?') ? '&' : '?'}ReturnUrl=${encodeURIComponent(returnUrl)}`;
  try {
    target.location.href = url;
  } catch {
    window.location.href = url;
  }
}

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
          <img :src="logo" alt="" class="size-7" />
          <span>RepNode</span>
          <span class="hidden text-sm font-normal text-slate-500 sm:inline"></span>
        </RouterLink>
        <nav v-if="session.connected" class="ml-4 flex items-center gap-1 text-sm">
          <RouterLink to="/reports" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Reportes</RouterLink>
          <RouterLink to="/tags" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Tags</RouterLink>
          <RouterLink to="/hierarchy" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Jerarquías</RouterLink>
          <RouterLink to="/settings" class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100" active-class="!bg-brand-50 !text-brand-700 font-medium">Configuración</RouterLink>
        </nav>
        <div class="ml-auto flex items-center gap-3">
          <template v-if="session.connected">
            <div class="hidden text-right text-xs leading-tight md:block">
              <div class="flex items-center justify-end gap-1.5 font-medium text-slate-700">
                <span class="size-2 rounded-full bg-emerald-500" />{{ session.session.database }} @ {{ session.session.server }}
              </div>
              <div class="text-slate-500">
                <template v-if="session.session.user">{{ session.session.user }} (PME)</template>
                <template v-else>{{ session.session.username }}</template>
                · SQL Server {{ session.session.serverVersion }}
              </div>
            </div>
            <!-- Embebido en PME la conexión es la del servidor: desconectar solo la volvería a abrir -->
            <button v-if="!session.isPme" class="btn btn-sm" title="Desconectar" @click="disconnect"><Icon name="logout" /> Desconectar</button>
          </template>
        </div>
      </div>
    </header>
    <main class="mx-auto w-full flex-1 px-4 py-6" :class="route.meta.wide ? 'max-w-[1920px] py-4' : 'max-w-7xl'">
      <RouterView />
    </main>
    <ToastHost />
    <div v-if="session.authLost" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="auth-lost-title">
      <div class="card max-w-md p-6">
        <h2 id="auth-lost-title" class="text-lg font-semibold text-slate-900">Sesión de PME terminada</h2>
        <p class="mt-2 text-sm text-slate-600">Para seguir usando RepNode vuelve a iniciar sesión en Power Monitoring Expert.</p>
        <div class="mt-5 flex justify-end">
          <button class="btn btn-primary" @click="goToPmeLogin"><Icon name="plug" /> Iniciar sesión en PME</button>
        </div>
      </div>
    </div>
  </div>
</template>
