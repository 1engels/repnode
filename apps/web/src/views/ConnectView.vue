<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ConnectionParams, ProductionStatusDTO, ProfileDTO } from '@repnode/shared';
import Icon from '../components/Icon.vue';
import { useCatalogStore } from '../stores/catalog';
import { useReportsStore } from '../stores/reports';
import { useSessionStore, type LocalProfile, type ProfileEdit } from '../stores/session';
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
/** Conexión recordada que se edita (p. ej. cambió la IP): se actualiza en lugar de crear otra. */
const editing = ref<ProfileEdit | null>(null);

/** Perfiles guardados en el servidor cuyo secreto ya no está en este navegador (requieren contraseña). */
const orphanProfiles = computed<ProfileDTO[]>(() => {
  const local = new Set(session.localProfiles.map((p) => p.id));
  return session.serverProfiles.filter((p) => !local.has(p.id));
});

/** Conexión a PME de producción (variables REPNODE_* del servidor): el botón solo se activa si se pudo establecer. */
const production = ref<ProductionStatusDTO | null>(null);
const productionChecking = ref(false);

async function checkProduction(refresh = false) {
  productionChecking.value = true;
  try {
    production.value = await session.productionStatus(refresh);
  } catch {
    production.value = null;
  } finally {
    productionChecking.value = false;
  }
}

onMounted(() => {
  session.loadServerProfiles().catch(() => {});
  checkProduction();
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

function fillFrom(p: ConnectionParams & { id: string; name: string; clientSecret?: string }) {
  editing.value = { id: p.id, name: p.name, clientSecret: p.clientSecret ?? null };
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
  testOk.value = null;
}

/** Deja de editar: el formulario vuelve a crear una conexión nueva. */
function newConnection() {
  editing.value = null;
  Object.assign(form, {
    name: '', server: '', port: '', instance: '', database: 'ION_Data', authType: 'sql', domain: '', username: '',
    password: '', encrypt: false, trustServerCertificate: true, remember: true,
  });
  formError.value = null;
  testOk.value = null;
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
    const v = await session.test(params(), form.password, editing.value);
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
    await session.connectNew(params(), form.password, form.remember, editing.value);
    form.password = '';
    editing.value = null;
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

async function connectProduction() {
  busy.value = 'production';
  try {
    await session.connectProduction();
    await afterConnect();
  } catch (e) {
    toast.error(e);
    checkProduction(true);
  } finally {
    busy.value = null;
  }
}

async function forget(p: { id: string; name: string }) {
  if (!confirm(`¿Olvidar la conexión "${p.name}"? Se borrará la contraseña guardada.`)) return;
  if (editing.value?.id === p.id) newConnection();
  await session.forgetProfile(p.id);
  await session.loadServerProfiles().catch(() => {});
}
</script>

<template>
  <div class="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_1.2fr]">
    <section>
      <h1 class="text-2xl font-semibold text-slate-900">Conectar a SQL Server</h1>
      <p class="mt-1 text-sm text-slate-600">Base de datos ION_Data de Power Monitoring Expert (SQL Server 2016 o superior).</p>

      <div class="mt-6">
        <button
          type="button"
          class="btn w-full justify-start gap-3 border-emerald-600 bg-emerald-600 px-4 py-3 text-left text-white hover:bg-emerald-700 disabled:hover:bg-emerald-600"
          :disabled="!!busy || productionChecking || !production?.available"
          @click="connectProduction"
        >
          <Icon :name="busy === 'production' || productionChecking ? 'refresh' : 'plug'" :size="20" :class="(busy === 'production' || productionChecking) && 'animate-spin'" />
          <span class="min-w-0 flex-1">
            <span class="block font-semibold">Conectar con PME de producción</span>
            <span v-if="production?.target" class="block truncate text-xs font-normal text-emerald-50">{{ production.username }} @ {{ production.target }}</span>
          </span>
        </button>
        <div v-if="productionChecking" class="mt-1.5 text-xs text-slate-500">Comprobando la conexión de producción…</div>
        <div v-else-if="!production?.available" class="mt-1.5 flex items-start gap-2 text-xs text-slate-500">
          <span class="min-w-0 flex-1">
            <template v-if="!production">No se pudo consultar el estado de la conexión de producción.</template>
            <template v-else-if="!production.configured">
              {{ production.error ?? `Deshabilitado: faltan las variables de entorno ${production.missing.join(', ')} en el servidor.` }}
            </template>
            <template v-else><span class="text-red-700">No se pudo conectar: {{ production.error }}</span></template>
          </span>
          <button type="button" class="btn btn-ghost btn-sm shrink-0" @click="checkProduction(true)"><Icon name="refresh" /> Reintentar</button>
        </div>
        <div v-else-if="production.serverVersion" class="mt-1.5 text-xs text-emerald-700">Disponible · SQL Server {{ production.serverVersion }}</div>
      </div>

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
      <div v-if="editing" class="mb-4 flex items-start gap-3 rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-slate-800">
        <Icon name="edit" :size="18" class="mt-0.5 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">Editando «{{ editing.name }}»</div>
          <div class="text-xs text-slate-600">Al conectar se actualiza esta conexión y se conservan sus reportes, tags y jerarquías.</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm shrink-0" @click="newConnection">Nueva conexión</button>
      </div>
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
          <input
            id="pwd"
            v-model="form.password"
            type="password"
            class="input"
            autocomplete="current-password"
            :placeholder="editing?.clientSecret ? 'En blanco = usar la guardada' : ''"
          />
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2 text-sm sm:col-span-6">
          <label class="flex items-center gap-2"><input v-model="form.encrypt" type="checkbox" class="checkbox" /> Cifrar conexión (TLS)</label>
          <label class="flex items-center gap-2"><input v-model="form.trustServerCertificate" type="checkbox" class="checkbox" /> Confiar en el certificado del servidor</label>
          <label v-if="!editing" class="flex items-center gap-2 font-medium"><input v-model="form.remember" type="checkbox" class="checkbox" /> Recordar conexión</label>
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
          <Icon :name="busy === 'connect' ? 'refresh' : 'plug'" :class="busy === 'connect' && 'animate-spin'" /> {{ editing ? 'Guardar y conectar' : 'Conectar' }}
        </button>
      </div>
    </form>
  </div>
</template>
