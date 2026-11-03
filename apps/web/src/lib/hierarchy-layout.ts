import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

// Layout automático por capas (fuentes arriba, cargas abajo) con elkjs en un web worker.
// Los terminales de entrada de cada tablero son puertos con orden fijo en el borde superior.

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Puertos de entrada en el borde superior, en orden */
  inPorts?: string[];
  /** Puerto de salida en el borde inferior */
  outPort?: string;
}

export interface LayoutEdge {
  id: string;
  source: string;
  sourcePort?: string;
  target: string;
  targetPort?: string;
}

let elk: InstanceType<typeof ELK> | null = null;

/** Posición (esquina superior izquierda) de cada nodo. */
export async function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[]): Promise<Map<string, { x: number; y: number }>> {
  elk ??= new ELK({ workerUrl });
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '150',
      'elk.spacing.nodeNode': '60',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '80',
    },
    children: nodes.map((n) => {
      const ins = n.inPorts ?? [];
      return {
        id: n.id,
        width: n.width,
        height: n.height,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [
          ...ins.map((p, i) => ({ id: p, x: portX(n.width, i, ins.length) - 4, y: -4, width: 8, height: 8, layoutOptions: { 'elk.port.side': 'NORTH' } })),
          ...(n.outPort ? [{ id: n.outPort, x: n.width / 2 - 4, y: n.height - 4, width: 8, height: 8, layoutOptions: { 'elk.port.side': 'SOUTH' } }] : []),
        ],
      };
    }),
    edges: edges.map((e) => ({ id: e.id, sources: [e.sourcePort ?? e.source], targets: [e.targetPort ?? e.target] })),
  };
  const out = await elk.layout(graph);
  return new Map((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/**
 * Posición horizontal del terminal `i` de `count` en una caja de ancho `width`. Deja un hueco
 * extra a la derecha para el terminal "+" (nueva entrada).
 */
export function portX(width: number, i: number, count: number): number {
  return (width * (i + 1)) / (count + 2);
}
