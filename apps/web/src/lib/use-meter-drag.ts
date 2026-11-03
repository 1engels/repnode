import { shallowRef } from 'vue';

// Arrastrar y soltar medidores (HTML5 nativo). El contenido de dataTransfer no se puede leer
// durante `dragover`, así que los IDs arrastrados también quedan en `dragging`.

export const METER_MIME = 'application/x-repnode-meters';

const dragging = shallowRef<number[] | null>(null);

function dragImage(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;top:-100px;left:-100px;padding:4px 10px;border-radius:9999px;background:#1d4ed8;color:#fff;font:600 12px system-ui;white-space:nowrap';
  document.body.appendChild(el);
  setTimeout(() => el.remove());
  return el;
}

export function useMeterDrag() {
  function start(e: DragEvent, ids: number[], names: string[]) {
    if (!e.dataTransfer || !ids.length) return;
    dragging.value = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(METER_MIME, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', names.join('\r\n'));
    e.dataTransfer.setDragImage(dragImage(ids.length === 1 ? names[0] : `${ids.length} medidores`), -12, -12);
  }

  function end() {
    dragging.value = null;
  }

  /** ¿El arrastre en curso trae medidores? */
  const accepts = (e: DragEvent) => !!e.dataTransfer?.types.includes(METER_MIME);

  function read(e: DragEvent): number[] {
    try {
      const raw = e.dataTransfer?.getData(METER_MIME);
      if (raw) return (JSON.parse(raw) as unknown[]).filter((x): x is number => typeof x === 'number');
    } catch {
      // datos ajenos: se usa el estado local
    }
    return dragging.value ?? [];
  }

  return { dragging, start, end, accepts, read };
}
