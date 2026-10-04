import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useLocalStorage } from '@vueuse/core';
import type { ConnectionParams, ProfileDTO, SessionDTO } from '@repnode/shared';
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

export const useSessionStore = defineStore('session', () => {
  const session = ref<SessionDTO>({ connected: false, profileId: null, server: null, database: null, username: null, serverVersion: null });
  const checked = ref(false);
  const localProfiles = useLocalStorage<LocalProfile[]>('repnode.profiles', []);
  const serverProfiles = ref<ProfileDTO[]>([]);

  const connected = computed(() => session.value.connected);

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

  async function connectNew(params: ConnectionParams, password: string, remember: boolean): Promise<void> {
    const clientSecret = remember ? randomSecret() : undefined;
    const res = await post<{ session: SessionDTO; profile: ProfileDTO }>('/api/connection/connect', { params, password, remember, clientSecret });
    session.value = res.session;
    if (remember && clientSecret) rememberLocal(res.profile, clientSecret);
  }

  async function connectProfile(p: LocalProfile): Promise<void> {
    const res = await post<{ session: SessionDTO; profile: ProfileDTO }>('/api/connection/connect', { profileId: p.id, clientSecret: p.clientSecret });
    session.value = res.session;
    rememberLocal(res.profile, p.clientSecret);
  }

  async function test(params: ConnectionParams, password: string): Promise<string> {
    const r = await post<{ version: string }>('/api/connection/test', { params, password });
    return r.version;
  }

  async function forgetProfile(id: string): Promise<void> {
    localProfiles.value = localProfiles.value.filter((p) => p.id !== id);
    await del('/api/profiles/' + encodeURIComponent(id)).catch(() => {});
  }

  async function disconnect(): Promise<void> {
    session.value = await post<SessionDTO>('/api/connection/disconnect');
  }

  function markDisconnected(): void {
    session.value = { connected: false, profileId: null, server: null, database: null, username: null, serverVersion: null };
  }

  return { session, checked, connected, localProfiles, serverProfiles, check, loadServerProfiles, connectNew, connectProfile, test, forgetProfile, disconnect, markDisconnected };
});
