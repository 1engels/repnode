// Sincronización de tags entre pestañas del mismo navegador (BroadcastChannel).
// Otra ventana que cambie tags avisa aquí; además se recarga al recuperar el foco
// para cubrir otros navegadores o pestañas que estaban dormidas.

type Listener = () => void;

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('repnode.tags') : null;
const listeners = new Set<Listener>();

channel?.addEventListener('message', () => listeners.forEach((fn) => fn()));

/** Avisa a las demás pestañas que los tags o la paleta cambiaron. */
export function notifyTagsChanged(): void {
  channel?.postMessage({ type: 'tags', at: Date.now() });
}

/** Ejecuta `fn` cuando otra pestaña cambia tags o cuando esta ventana vuelve a estar visible. */
export function onTagsChanged(fn: Listener): void {
  listeners.add(fn);
}

if (typeof window !== 'undefined') {
  let last = 0;
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < 2000) return;
    last = Date.now();
    listeners.forEach((fn) => fn());
  };
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
}
