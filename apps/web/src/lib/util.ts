import { TAG_PALETTE } from '@repnode/shared';

/** Normaliza para búsqueda: sin tildes, minúsculas. */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Coincidencia por varias palabras (todas deben aparecer, en cualquier orden). */
export function makeMatcher(query: string): (haystack: string) => boolean {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return () => true;
  return (h) => tokens.every((t) => h.includes(t));
}

export function formatNumber(n: number): string {
  return n.toLocaleString('es');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('es', { maximumFractionDigits: 1 })} ${units[i]}`;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** 'YYYY-MM-DDTHH:mm' -> 'DD/MM/YYYY HH:mm' */
export function formatLocal(local: string): string {
  const [d, t] = local.split('T');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}${t && t !== '00:00' ? ' ' + t : ''}`;
}

export function formatIsoDate(iso: string | null, timeZone?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es', { timeZone, dateStyle: 'short', timeStyle: 'short' });
}

export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

/** Descarga un archivo servido por el backend sin salir de la página. */
export function triggerDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Descarga un CSV generado en el navegador (UTF-8 con BOM, CRLF). */
export function downloadCsv(fileName: string, rows: string[][], sep = ';'): void {
  const esc = (v: string) => (/[";\r\n,\t]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const content = '﻿' + rows.map((r) => r.map(esc).join(sep)).join('\r\n') + '\r\n';
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Copia profunda de datos planos. structuredClone falla con los Proxy reactivos de Vue. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Color de la paleta base menos usado por los tags existentes (para tags creados al vuelo). */
export function nextTagColor(tags: readonly { color: string }[]): string {
  const used = new Map<string, number>();
  for (const t of tags) used.set(t.color.toLowerCase(), (used.get(t.color.toLowerCase()) ?? 0) + 1);
  let best: string = TAG_PALETTE[0];
  for (const c of TAG_PALETTE) if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  return best;
}
