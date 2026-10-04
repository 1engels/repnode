const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Nombre de archivo válido en Windows. */
export function sanitizeFileName(name: string, fallback = 'reporte'): string {
  let out = name.replace(INVALID, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!out || RESERVED.test(out)) out = fallback;
  return out.slice(0, 180);
}

function compact(local: string): string {
  // 'YYYY-MM-DDTHH:mm' -> 'YYYYMMDD' o 'YYYYMMDD-HHmm' si no es medianoche
  const date = local.slice(0, 10).replaceAll('-', '');
  const time = local.slice(11, 16).replace(':', '');
  return time && time !== '0000' ? `${date}-${time}` : date;
}

export interface FileNameContext {
  reportName: string;
  fromLocal: string;
  toLocal: string;
  generatedLocal: string;
}

/** Aplica la plantilla: {reporte} {desde} {hasta} {generado} */
export function renderFileName(template: string, ctx: FileNameContext, extension: 'csv' | 'zip'): string {
  const base = template
    .replaceAll('{reporte}', ctx.reportName)
    .replaceAll('{desde}', compact(ctx.fromLocal))
    .replaceAll('{hasta}', compact(ctx.toLocal))
    .replaceAll('{generado}', compact(ctx.generatedLocal));
  return `${sanitizeFileName(base)}.${extension}`;
}
