<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ConnectionParams, ProfileDTO } from '@repnode/shared';
import Icon from '../components/Icon.vue';
import { useCatalogStore } from '../stores/catalog';
import { useReportsStore } from '../stores/reports';
import { useSessionStore, type LocalProfile } from '../stores/session';
import { useToastStore } from '../stores/toast';
import { formatIsoDate } from '../lib/util';

const session = useSessionStore();
const catalog = useCatalogStore();
const reports = useReportsStore();
const toast = useToastStore();
const router = useRouter();
const route = useRoute();

const form = reactive({
  name: '',
  server: '',
  port: '' as string,
  instance: '',
  database: 'ION_Data',
  authType: 'sql' as 'sql' | 'ntlm',
  domain: '',
  username: '',
  password: '',
  encrypt: false,
  trustServerCertificate: true,
  remember: true,
});
const busy = ref<'test' | 'connect' | string | null>(null);
const formError = ref<string | null>(null);
const testOk = ref<string | null>(null);

/** Perfiles guardados en el servidor cuyo secreto ya no está en este navegador (requieren contraseña). */
const orphanProfiles = computed<ProfileDTO[]>(() => {
  const local = new Set(session.localProfiles.map((p) => p.id));
  return session.serverProfiles.filter((p) => !local.has(p.id));
});

onMounted(() => {
  session.loadServerProfiles().catch(() => {});
});

function params(): ConnectionParams {
  return {
    name: form.name.trim() || undefined,
    server: form.server.trim(),
    port: form.port ? Number(form.port) : null,
    instance: form.instance.trim() || null,
    database: form.database.trim() || 'ION_Data',
    authType: form.authType,
    domain: form.authType === 'ntlm' ? form.domain.trim() || null : null,
    username: form.username.trim(),
    encrypt: form.encrypt,
    trustServerCertificate: form.trustServerCertificate,
  };
}

function fillFrom(p: ConnectionParams & { name?: string }) {
  Object.assign(form, {
    name: p.name ?? '',
    server: p.server,
    port: p.port ? String(p.port) : '',
    instance: p.instance ?? '',
    database: p.database,
    authType: p.authType,
    domain: p.domain ?? '',
    username: p.username,
    password: '',
    encrypt: p.encrypt,
    trustServerCertificate: p.trustServerCertificate,
  });
  formError.value = null;
}

async function afterConnect() {
  catalog.reset();
  reports.reset();
  await catalog.load();
  toast.success(`Conectado: ${catalog.sources.length} medidores, ${catalog.quantities.length} mediciones con datos`);
  router.push(typeof route.query.next === 'string' ? route.query.next : '/reports');
}

async function test() {
  formError.value = null;
  testOk.value = null;
  busy.value = 'test';
  try {
    const v = await session.test(params(), form.password);
    testOk.value = `Conexión correcta · SQL Server ${v}`;
  } catch (e) {
    formError.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

async function connect() {
  formError.value = null;
  busy.value = 'connect';
  try {
    await session.connectNew(params(), form.password, form.remember);
    form.password = '';
    await afterConnect();
  } catch (e) {
    formError.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}

async function connectSaved(p: LocalProfile) {
  busy.value = p.id;
  try {
    await session.connectProfile(p);
    await afterConnect();
  } catch (e) {
    toast.error(e);
    fillFrom(p);
  } finally {
    busy.value = null;
  }
}

async function forget(p: { id: string; name: string }) {
  if (!confirm(`¿Olvidar la conexión "${p.name}"? Se borrará la contraseña guardada.`)) return;
  await session.forgetProfile(p.id);
  await session.loadServerProfiles().catch(() => {});
}
</script>

<template>
  <div class="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_1.2fr]">
    <section>
      <h1 class="text-2xl font-semibold text-slate-900">Conectar a SQL Server</h1>
      <p class="mt-1 text-sm text-slate-600">Base de datos ION_Data de Power Monitoring Expert (SQL Server 2016 o superior).</p>

      <div class="mt-6 space-y-3">
        <h2 class="label">Conexiones recordadas</h2>
        <p v-if="!session.localProfiles.length && !orphanProfiles.length" class="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
          Aún no hay conexiones guardadas. Marca «Recordar» al conectarte.
        </p>
        <div v-for="p in session.localProfiles" :key="p.id" class="card flex items-center gap-3 p-3">
          <div class="flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name="database" :size="20" /></div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">{{ p.name }}</div>
            <div class="truncate text-xs text-slate-500">
              {{ p.authType === 'ntlm' && p.domain ? p.domain + '\\' : '' }}{{ p.username }} · usado {{ formatIsoDate(p.lastUsedAt) }}
            </div>
          </div>
          <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="connectSaved(p)">
            <Icon :name="busy === p.id ? 'refresh' : 'plug'" :class="busy === p.id && 'animate-spin'" /> Conectar
          </button>
          <button class="btn btn-ghost btn-sm" title="Editar" @click="fillFrom(p)"><Icon name="edit" /></button>
          <button class="btn btn-ghost btn-sm text-red-600" title="Olvidar" @click="forget(p)"><Icon name="trash" /></button>
        </div>
        <div v-for="p in orphanProfiles" :key="p.id" class="card flex items-center gap-3 p-3 opacity-80">
          <div class="flex size-10 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Icon name="database" :size="20" /></div>
          <div class="min-w-0 flex-1">
            <div class="truncate font-medium">{{ p.name }}</div>
            <div class="text-xs text-amber-700">Este navegador no tiene la llave: ingresa la contraseña de nuevo</div>
          </div>
          <button class="btn btn-sm" @click="fillFrom(p)">Usar</button>
          <button class="btn btn-ghost btn-sm text-red-600" title="Olvidar" @click="forget(p)"><Icon name="trash" /></button>
        </div>
      </div>

      <div class="mt-6 rounded-lg bg-slate-100 p-4 text-xs leading-relaxed text-slate-600">
        <p class="font-semibold text-slate-700">¿Cómo se protegen las credenciales?</p>
        <p class="mt-1">
          La contraseña se cifra con AES-256-GCM. La clave se deriva de una llave del servidor local y de un secreto aleatorio que solo guarda este
          navegador, así que ninguno de los dos por sí solo permite recuperarla. La contraseña nunca se guarda en el navegador.
        </p>
      </div>
    </section>

    <form class="card p-6" @submit.prevent="connect">
      <div class="grid gap-4 sm:grid-cols-6">
        <div class="sm:col-span-6">
          <label class="label" for="name">Nombre de la conexión (opcional)</label>
          <input id="name" v-model="form.name" class="input" placeholder="p. ej. PME Planta Norte" />
        </div>
        <div class="sm:col-span-3">
          <label class="label" for="server">Servidor</label>
          <input id="server" v-model="form.server" class="input" placeholder="192.168.1.10 o NOMBRE-PC" required autocomplete="off" />
        </div>
        <div class="sm:col-span-2">
          <label class="label" for="instance">Instancia</label>
          <input id="instance" v-model="form.instance" class="input" placeholder="ION" :disabled="!!form.port" />
        </div>
        <div class="sm:col-span-1">
          <label class="label" for="port">Puerto</label>
          <input id="port" v-model="form.port" class="input" inputmode="numeric" placeholder="1433" :disabled="!!form.instance" />
        </div>
        <div class="sm:col-span-6">
          <label class="label" for="db">Base de datos</label>
          <input id="db" v-model="form.database" class="input" required />
        </div>
        <div class="sm:col-span-6">
          <span class="label">Autenticación</span>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm" :class="form.authType === 'sql' ? 'border-brand-500 bg-brand-50' : 'border-slate-300'">
              <input v-model="form.authType" type="radio" value="sql" class="accent-brand-600" /> SQL Server
            </label>
            <label class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm" :class="form.authType === 'ntlm' ? 'border-brand-500 bg-brand-50' : 'border-slate-300'">
              <input v-model="form.authType" type="radio" value="ntlm" class="accent-brand-600" /> Windows (NTLM)
            </label>
          </div>
        </div>
        <div v-if="form.authType === 'ntlm'" class="sm:col-span-2">
          <label class="label" for="domain">Dominio</label>
          <input id="domain" v-model="form.domain" class="input" placeholder="EMPRESA" />
        </div>
        <div :class="form.authType === 'ntlm' ? 'sm:col-span-4' : 'sm:col-span-3'">
          <label class="label" for="user">Usuario</label>
          <input id="user" v-model="form.username" class="input" required autocomplete="username" />
        </div>
        <div :class="form.authType === 'ntlm' ? 'sm:col-span-6' : 'sm:col-span-3'">
          <label class="label" for="pwd">Contraseña</label>
          <input id="pwd" v-model="form.password" type="password" class="input" autocomplete="current-password" />
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2 text-sm sm:col-span-6">
          <label class="flex items-center gap-2"><input v-model="form.encrypt" type="checkbox" class="checkbox" /> Cifrar conexión (TLS)</label>
          <label class="flex items-center gap-2"><input v-model="form.trustServerCertificate" type="checkbox" class="checkbox" /> Confiar en el certificado del servidor</label>
          <label class="flex items-center gap-2 font-medium"><input v-model="form.remember" type="checkbox" class="checkbox" /> Recordar conexión</label>
        </div>
      </div>

      <div v-if="formError" class="mt-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <Icon name="error" :size="18" class="mt-0.5" /> <span>{{ formError }}</span>
      </div>
      <div v-else-if="testOk" class="mt-4 flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        <Icon name="ok" :size="18" class="mt-0.5" /> <span>{{ testOk }}</span>
      </div>

      <div class="mt-6 flex justify-end gap-2">
        <button type="button" class="btn" :disabled="!!busy || !form.server || !form.username" @click="test">
          <Icon :name="busy === 'test' ? 'refresh' : 'bolt'" :class="busy === 'test' && 'animate-spin'" /> Probar conexión
        </button>
        <button type="submit" class="btn btn-primary" :disabled="!!busy || !form.server || !form.username">
          <Icon :name="busy === 'connect' ? 'refresh' : 'plug'" :class="busy === 'connect' && 'animate-spin'" /> Conectar
        </button>
      </div>
    </form>
  </div>
</template>
