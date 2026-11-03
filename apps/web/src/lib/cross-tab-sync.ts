// Sincronización entre pestañas del mismo navegador (BroadcastChannel).
// Otra ventana que cambie datos avisa por el canal; además se recarga al recuperar el foco
// para cubrir otros navegadores o pestañas que estaban dormidas.

type Listener = () => void;

export interface CrossTabSync {
  /** Avisa a las demás pestañas que los datos cambiaron. */
  notify(): void;
  /** Ejecuta `fn` cuando otra pestaña avisa o cuando esta ventana vuelve a estar visible. */
  listen(fn: Listener): void;
}

export function createCrossTabSync(name: string): CrossTabSync {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(name) : null;
  const listeners = new Set<Listener>();
  channel?.addEventListener('message', () => listeners.forEach((fn) => fn()));

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

  return {
    notify: () => channel?.postMessage({ type: name, at: Date.now() }),
    listen: (fn) => void listeners.add(fn),
  };
}
