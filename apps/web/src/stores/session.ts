import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useLocalStorage, useSessionStorage } from '@vueuse/core';
import type { ConnectionParams, ProductionStatusDTO, ProfileDTO, SessionDTO } from '@repnode/shared';
import { del, get, post } from '../lib/api';
import { randomSecret } from '../lib/util';

/**
 * En localStorage solo se guardan datos no sensibles del perfil + su ID + el secreto de cliente
 * (la mitad de la clave de cifrado). La contraseña nunca se guarda en el navegador.
 */
export interface LocalProfile extends ConnectionParams {
  id: string;
  name: string;
  clientSecret: string;
  lastUsedAt: string;
}

/** Perfil que se está editando en el formulario: al conectar se actualiza conservando su ID. */
export interface ProfileEdit {
  id: string;
  name: string;
  /** Secreto de cliente de este navegador; null si el perfil no tiene la llave aquí (hay que escribir la contraseña). */
  clientSecret: string | null;
}

/** Con qué se conectó esta pestaña por última vez: se usa para reconectar sola si la sesión del servidor venció. */
type LastConnection = { kind: 'production' } | { kind: 'profile'; id: string } | null;

const disconnected = (prev?: SessionDTO): SessionDTO => ({
  mode: prev?.mode ?? 'none', user: prev?.user ?? null, idleMinutes: prev?.idleMinutes ?? 15,
  connected: false, profileId: null, server: null, database: null, username: null, serverVersion: null,
});

export const useSessionStore = defineStore('session', () => {
  const session = ref<SessionDTO>(disconnected());
  const checked = ref(false);
  const localProfiles = useLocalStorage<LocalProfile[]>('repnode.profiles', []);
  const serverProfiles = ref<ProfileDTO[]>([]);
  const lastConnection = useSessionStorage<LastConnection>('repnode.lastConnection', null);
  /** Modo pme: la sesión de PME terminó; hay que volver a iniciar sesión en PME (loginUrl). */
  const authLost = ref<string | null>(null);
  /** Modo pme: error de la conexión automática (se muestra en la pantalla de conexión). */
  const autoConnectError = ref<string | null>(null);

  const connected = computed(() => session.value.connected);
  /** RepNode embebido en PME: usuario de PME y conexión SQL del servidor. */
  const isPme = computed(() => session.value.mode === 'pme');

  async function check(): Promise<void> {
    try {
      session.value = await get<SessionDTO>('/api/session');
    } finally {
      checked.value = true;
    }
  }

  async function loadServerProfiles(): Promise<void> {
    serverProfiles.value = await get<ProfileDTO[]>('/api/profiles');
  }

  function rememberLocal(p: ProfileDTO, clientSecret: string): void {
    const entry: LocalProfile = {
      id: p.id, name: p.name, server: p.server, port: p.port, instance: p.instance, database: p.database,
      authType: p.authType, domain: p.domain, username: p.username, encrypt: p.encrypt,
      trustServerCertificate: p.trustServerCertificate, clientSecret, lastUsedAt: new Date().toISOString(),
    };
    localProfiles.value = [entry, ...localProfiles.value.filter((x) => x.id !== p.id)];
  }

  /** Modo pme: conecta con la cuenta del servidor sin pasar por la pantalla de conexión. */
  async function autoConnect(): Promise<boolean> {
    try {
      await connectProduction();
      autoConnectError.value = null;
      return true;
    } catch (e) {
      autoConnectError.value = (e as Error).message;
      return false;
    }
  }

  /** Reconecta con lo último que usó esta pestaña (lo llama api.ts al recibir not_connected). */
  async function reconnect(): Promise<boolean> {
    if (isPme.value) return autoConnect();
    const last = lastConnection.value;
    if (last?.kind === 'production') {
      await connectProduction();
      return true;
    }
    const p = last?.kind === 'profile' ? localProfiles.value.find((x) => x.id === last.id) : undefined;
    if (!p) return false;
    await connectProfile(p);
    return true;
  }

  async function connectNew(params: ConnectionParams, password: string, remember: boolean, edit: ProfileEdit | null = null): Promise<void> {
    // Al editar se reutiliza el secreto existente para poder dejar la contraseña en blanco (usa la guardada).
    const clientSecret = edit ? (edit.clientSecret ?? randomSecret()) : remember ? randomSecret() : undefined;
    const res = await post<{ session: SessionDTO; profile: ProfileDTO }>('/api/connection/connect', {
      params, password, remember: remember || !!edit, clientSecret, profileId: edit?.id,
    });
    session.value = res.session;
    if ((remember || edit) && clientSecret) {
      rememberLocal(res.profile, clientSecret);
      lastConnection.value = { kind: 'profile', id: res.profile.id };
    } else lastConnection.value = null;
  }

  async function connectProfile(p: LocalProfile): Promise<void> {
    const res = await post<{ session: SessionDTO; profile: ProfileDTO }>('/api/connection/connect', { profileId: p.id, clientSecret: p.clientSecret });
    session.value = res.session;
    rememberLocal(res.profile, p.clientSecret);
    lastConnection.value = { kind: 'profile', id: p.id };
  }

  /** Estado de la conexión a PME de producción (variables de entorno del servidor); refresh = volver a probarla. */
  async function productionStatus(refresh = false): Promise<ProductionStatusDTO> {
    return get<ProductionStatusDTO>('/api/connection/production' + (refresh ? '?refresh=1' : ''));
  }

  async function connectProduction(): Promise<void> {
    const res = await post<{ session: SessionDTO }>('/api/connection/production/connect');
    session.value = res.session;
    lastConnection.value = { kind: 'production' };
  }

  async function test(params: ConnectionParams, password: string, edit: ProfileEdit | null = null): Promise<string> {
    const r = await post<{ version: string }>('/api/connection/test', { params, password, profileId: edit?.id, clientSecret: edit?.clientSecret ?? undefined });
    return r.version;
  }

  async function forgetProfile(id: string): Promise<void> {
    localProfiles.value = localProfiles.value.filter((p) => p.id !== id);
    await del('/api/profiles/' + encodeURIComponent(id)).catch(() => {});
  }

  async function disconnect(): Promise<void> {
    lastConnection.value = null;
    session.value = await post<SessionDTO>('/api/connection/disconnect');
  }

  function markDisconnected(): void {
    session.value = disconnected(session.value);
  }

  function markAuthLost(loginUrl: string): void {
    authLost.value = loginUrl;
    // Solo el modo pme responde not_authenticated (también si falló la primera consulta de la sesión)
    session.value = { ...disconnected(session.value), mode: 'pme' };
  }

  return {
    session, checked, connected, isPme, authLost, autoConnectError, localProfiles, serverProfiles, check, loadServerProfiles,
    autoConnect, reconnect, connectNew, connectProfile, productionStatus, connectProduction, test, forgetProfile, disconnect,
    markDisconnected, markAuthLost,
  };
});
