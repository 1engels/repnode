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

type Listener = () => void;
const notConnectedListeners = new Set<Listener>();

/** Se notifica cuando el backend responde que no hay conexión activa (p. ej. tras reiniciarse). */
export function onNotConnected(fn: Listener): void {
  notConnectedListeners.add(fn);
}

export async function api<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
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
    if (err.code === 'not_connected') notConnectedListeners.forEach((fn) => fn());
    throw err;
  }
  return data as T;
}

export const get = <T>(url: string, signal?: AbortSignal) => api<T>('GET', url, undefined, signal);
export const post = <T>(url: string, body?: unknown, signal?: AbortSignal) => api<T>('POST', url, body ?? {}, signal);
export const put = <T>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);
