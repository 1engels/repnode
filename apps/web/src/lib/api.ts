export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Ruta base de la app (BASE_PATH, p. ej. "/repnode"), sin barra final. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/** URL absoluta de un endpoint: "/api/x" → "/repnode/api/x". También para EventSource y descargas. */
export function apiUrl(path: string): string {
  return path.startsWith('/api/') ? BASE + path : path;
}

type Listener = () => void;
const notConnectedListeners = new Set<Listener>();
const notAuthenticatedListeners = new Set<(loginUrl: string) => void>();

/** Se notifica cuando el backend responde que no hay conexión activa y no se pudo reconectar. */
export function onNotConnected(fn: Listener): void {
  notConnectedListeners.add(fn);
}

/** Modo pme: la sesión de PME terminó (hay que volver a iniciar sesión en PME). */
export function onNotAuthenticated(fn: (loginUrl: string) => void): void {
  notAuthenticatedListeners.add(fn);
}

/**
 * Reconexión transparente: la sesión del servidor vence tras unos minutos sin actividad. Antes de mandar al usuario
 * a la pantalla de conexión se intenta reconectar con lo último que usó en esta pestaña y se repite la petición,
 * así no se pierde lo que estaba editando. Devuelve true si se reconectó.
 */
let reconnectHandler: (() => Promise<boolean>) | null = null;
let reconnecting: Promise<boolean> | null = null;

export function setReconnectHandler(fn: () => Promise<boolean>): void {
  reconnectHandler = fn;
}

function reconnect(): Promise<boolean> {
  if (!reconnectHandler) return Promise.resolve(false);
  reconnecting ??= reconnectHandler()
    .catch(() => false)
    .finally(() => {
      reconnecting = null;
    });
  return reconnecting;
}

/** Peticiones de conexión: no se reintentan (son las que usa la propia reconexión). */
const NO_RETRY = /^\/api\/(session|connection\/)/;

export async function api<T>(method: string, url: string, body?: unknown, signal?: AbortSignal, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(url), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'No se pudo contactar al servidor local de RepNode. ¿Está en ejecución?');
  }
  const text = await res.text();
  let data: { error?: string; message?: string; details?: unknown } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok && !data && (res.status === 502 || res.status === 503 || res.status === 504)) {
    throw new ApiError(res.status, 'network', 'El servidor local de RepNode no responde (¿se está reiniciando?). Intenta de nuevo en unos segundos.');
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details);
    if (err.code === 'not_authenticated') {
      const loginUrl = (err.details as { loginUrl?: string } | undefined)?.loginUrl ?? '/';
      notAuthenticatedListeners.forEach((fn) => fn(loginUrl));
    }
    if (err.code === 'not_connected') {
      if (!retried && !NO_RETRY.test(url) && (await reconnect())) return api<T>(method, url, body, signal, true);
      notConnectedListeners.forEach((fn) => fn());
    }
    throw err;
  }
  return data as T;
}

export const get = <T>(url: string, signal?: AbortSignal) => api<T>('GET', url, undefined, signal);
export const post = <T>(url: string, body?: unknown, signal?: AbortSignal) => api<T>('POST', url, body ?? {}, signal);
export const put = <T>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);
