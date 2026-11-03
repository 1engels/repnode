// Sincronización de tags entre pestañas (ver cross-tab-sync.ts).
import { createCrossTabSync } from './cross-tab-sync';

const sync = createCrossTabSync('repnode.tags');

/** Avisa a las demás pestañas que los tags o la paleta cambiaron. */
export const notifyTagsChanged = (): void => sync.notify();

/** Ejecuta `fn` cuando otra pestaña cambia tags o cuando esta ventana vuelve a estar visible. */
export const onTagsChanged = (fn: () => void): void => sync.listen(fn);
