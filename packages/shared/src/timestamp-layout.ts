// Formato "por estampa de tiempo": una fila por timestamp y una columna por par medidor × medición.
// Las columnas se indexan en orden medidor-mayor: índice = medidor · Q + medición.

/** Máximo de columnas de datos por archivo (Excel admite 16.384 en total). Por encima se entregan varios archivos. */
export const MAX_FILE_COLUMNS = 16_000;

/** Orden de columnas: por medidor (M1.q1, M1.q2, M2.q1…) o por medición (M1.q1, M2.q1…, M1.q2…). */
export function timestampColumnOrder(meters: number, quantities: number, byQuantity: boolean): number[] {
  const order: number[] = [];
  if (byQuantity) {
    for (let q = 0; q < quantities; q++) for (let m = 0; m < meters; m++) order.push(m * quantities + q);
  } else {
    for (let i = 0; i < meters * quantities; i++) order.push(i);
  }
  return order;
}

export interface ColumnChunk {
  /** Rango [start, end) sobre el orden de columnas */
  start: number;
  end: number;
}

/**
 * Reparte las columnas (ya ordenadas) en archivos de hasta `limit` columnas.
 * No parte una unidad (todas las columnas de un medidor, o de una medición) salvo que ella sola supere el límite.
 */
export function splitColumns(meters: number, quantities: number, byQuantity: boolean, limit = MAX_FILE_COLUMNS): ColumnChunk[] {
  const unitSize = byQuantity ? meters : quantities;
  const units = byQuantity ? quantities : meters;
  const chunks: ColumnChunk[] = [];
  let start = 0;
  let size = 0;
  for (let u = 0; u < units; u++) {
    if (size > 0 && size + unitSize > limit) {
      chunks.push({ start, end: start + size });
      start += size;
      size = 0;
    }
    size += unitSize;
    // Una unidad más grande que el límite se corta en trozos exactos
    while (size > limit) {
      chunks.push({ start, end: start + limit });
      start += limit;
      size -= limit;
    }
  }
  if (size > 0) chunks.push({ start, end: start + size });
  return chunks;
}
