import { DatabaseSync } from 'node:sqlite';
import { availableParallelism } from 'node:os';
import type { ConnectionParams, HistoryEntryDTO, JobStatus, ReportDefinition, Settings } from '@repnode/shared';
import { paths } from '../config.ts';
import type { EncryptedSecret } from '../security/secrets.ts';

export const db = new DatabaseSync(paths.db);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const migrations: string[] = [
  `
  CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    server TEXT NOT NULL,
    port INTEGER,
    instance TEXT,
    database TEXT NOT NULL,
    auth_type TEXT NOT NULL,
    domain TEXT,
    username TEXT NOT NULL,
    encrypt INTEGER NOT NULL,
    trust_cert INTEGER NOT NULL,
    pwd_cipher BLOB,
    pwd_iv BLOB,
    pwd_tag BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    UNIQUE (profile_id, name)
  );
  CREATE TABLE tag_members (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    PRIMARY KEY (tag_id, source_name)
  );
  CREATE TABLE measurement_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity_names_json TEXT NOT NULL,
    UNIQUE (profile_id, name)
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ix_reports_profile ON reports(profile_id);
  CREATE TABLE job_history (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    report_id INTEGER,
    report_name TEXT NOT NULL,
    status TEXT NOT NULL,
    file_name TEXT NOT NULL,
    meters INTEGER NOT NULL DEFAULT 0,
    rows INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    validation_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
  );
  CREATE INDEX ix_job_history_profile ON job_history(profile_id, started_at);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: colores personalizados de tags por perfil
  `
  CREATE TABLE tag_colors (
    profile_id TEXT NOT NULL,
    color TEXT NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, color)
  );
  `,
  // v3: ejecuciones forzadas pese a faltantes y filas fuera de la grilla
  `
  ALTER TABLE job_history ADD COLUMN forced INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE job_history ADD COLUMN off_grid_rows INTEGER NOT NULL DEFAULT 0;
  `,
];

function migrate(): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
migrate();

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const b = (v: boolean) => (v ? 1 : 0);

// ---------------------------------------------------------------------------
// Perfiles de conexión
// ---------------------------------------------------------------------------

interface ProfileRow {
  id: string;
  name: string;
  server: string;
  port: number | null;
  instance: string | null;
  database: string;
  auth_type: 'sql' | 'ntlm';
  domain: string | null;
  username: string;
  encrypt: number;
  trust_cert: number;
  pwd_cipher: Uint8Array | null;
  pwd_iv: Uint8Array | null;
  pwd_tag: Uint8Array | null;
  last_used_at: string | null;
}

export interface StoredProfile {
  id: string;
  name: string;
  params: ConnectionParams;
  secret: EncryptedSecret | null;
  lastUsedAt: string | null;
}

function toProfile(r: ProfileRow): StoredProfile {
  return {
    id: r.id,
    name: r.name,
    params: {
      name: r.name,
      server: r.server,
      port: r.port,
      instance: r.instance,
      database: r.database,
      authType: r.auth_type,
      domain: r.domain,
      username: r.username,
      encrypt: !!r.encrypt,
      trustServerCertificate: !!r.trust_cert,
    },
    secret:
      r.pwd_cipher && r.pwd_iv && r.pwd_tag
        ? { cipher: Buffer.from(r.pwd_cipher), iv: Buffer.from(r.pwd_iv), tag: Buffer.from(r.pwd_tag) }
        : null,
    lastUsedAt: r.last_used_at,
  };
}

export const profiles = {
  list(): StoredProfile[] {
    return (db.prepare('SELECT * FROM connection_profiles ORDER BY last_used_at DESC').all() as unknown as ProfileRow[]).map(toProfile);
  },
  get(id: string): StoredProfile | null {
    const r = db.prepare('SELECT * FROM connection_profiles WHERE id = ?').get(id) as unknown as ProfileRow | undefined;
    return r ? toProfile(r) : null;
  },
  upsert(id: string, name: string, p: ConnectionParams, secret: EncryptedSecret | null): void {
    db.prepare(
      `INSERT INTO connection_profiles (id, name, server, port, instance, database, auth_type, domain, username, encrypt, trust_cert, pwd_cipher, pwd_iv, pwd_tag, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, server = excluded.server, port = excluded.port, instance = excluded.instance,
         database = excluded.database, auth_type = excluded.auth_type, domain = excluded.domain,
         username = excluded.username, encrypt = excluded.encrypt, trust_cert = excluded.trust_cert,
         pwd_cipher = excluded.pwd_cipher, pwd_iv = excluded.pwd_iv, pwd_tag = excluded.pwd_tag,
         last_used_at = excluded.last_used_at`,
    ).run(
      id, name, p.server, p.port, p.instance, p.database, p.authType, p.domain, p.username,
      b(p.encrypt), b(p.trustServerCertificate),
      secret?.cipher ?? null, secret?.iv ?? null, secret?.tag ?? null,
    );
  },
  touch(id: string): void {
    db.prepare("UPDATE connection_profiles SET last_used_at = datetime('now') WHERE id = ?").run(id);
  },
  remove(id: string): void {
    db.prepare('DELETE FROM connection_profiles WHERE id = ?').run(id);
  },
};

// ---------------------------------------------------------------------------
// Tags (miembros guardados por Source.Name, que es estable)
// ---------------------------------------------------------------------------

export interface TagRow {
  id: number;
  name: string;
  color: string;
  members: string[];
}

export const tags = {
  list(profileId: string): TagRow[] {
    const rows = db.prepare('SELECT id, name, color FROM tags WHERE profile_id = ? ORDER BY name COLLATE NOCASE').all(profileId) as unknown as Omit<TagRow, 'members'>[];
    const members = db
      .prepare('SELECT m.tag_id, m.source_name FROM tag_members m JOIN tags t ON t.id = m.tag_id WHERE t.profile_id = ?')
      .all(profileId) as unknown as { tag_id: number; source_name: string }[];
    const byTag = new Map<number, string[]>();
    for (const m of members) {
      let arr = byTag.get(m.tag_id);
      if (!arr) byTag.set(m.tag_id, (arr = []));
      arr.push(m.source_name);
    }
    return rows.map((r) => ({ ...r, members: byTag.get(r.id) ?? [] }));
  },
  create(profileId: string, name: string, color: string): number {
    return Number(db.prepare('INSERT INTO tags (profile_id, name, color) VALUES (?, ?, ?)').run(profileId, name, color).lastInsertRowid);
  },
  update(profileId: string, id: number, name: string, color: string): boolean {
    return db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ? AND profile_id = ?').run(name, color, id, profileId).changes > 0;
  },
  remove(profileId: string, id: number): boolean {
    return db.prepare('DELETE FROM tags WHERE id = ? AND profile_id = ?').run(id, profileId).changes > 0;
  },
  owns(profileId: string, id: number): boolean {
    return !!db.prepare('SELECT 1 FROM tags WHERE id = ? AND profile_id = ?').get(id, profileId);
  },
  addMembers(id: number, sourceNames: string[]): void {
    const stmt = db.prepare('INSERT OR IGNORE INTO tag_members (tag_id, source_name) VALUES (?, ?)');
    transaction(() => sourceNames.forEach((n) => stmt.run(id, n)));
  },
  removeMembers(id: number, sourceNames: string[]): void {
    const stmt = db.prepare('DELETE FROM tag_members WHERE tag_id = ? AND source_name = ?');
    transaction(() => sourceNames.forEach((n) => stmt.run(id, n)));
  },
};

// ---------------------------------------------------------------------------
// Colores personalizados de tags (los más recientes primero, máximo MAX_TAG_COLORS)
// ---------------------------------------------------------------------------

const MAX_TAG_COLORS = 24;

export const tagColors = {
  list(profileId: string): string[] {
    const rows = db.prepare('SELECT color FROM tag_colors WHERE profile_id = ? ORDER BY used_at DESC, color').all(profileId) as unknown as { color: string }[];
    return rows.map((r) => r.color);
  },
  add(profileId: string, color: string): void {
    transaction(() => {
      db.prepare(
        `INSERT INTO tag_colors (profile_id, color, used_at) VALUES (?, ?, ?)
         ON CONFLICT(profile_id, color) DO UPDATE SET used_at = excluded.used_at`,
      ).run(profileId, color, new Date().toISOString());
      db.prepare(
        `DELETE FROM tag_colors WHERE profile_id = ? AND color NOT IN
           (SELECT color FROM tag_colors WHERE profile_id = ? ORDER BY used_at DESC LIMIT ?)`,
      ).run(profileId, profileId, MAX_TAG_COLORS);
    });
  },
  remove(profileId: string, color: string): void {
    db.prepare('DELETE FROM tag_colors WHERE profile_id = ? AND color = ?').run(profileId, color);
  },
};

// ---------------------------------------------------------------------------
// Presets de mediciones (guardados por Quantity.Name)
// ---------------------------------------------------------------------------

export const presets = {
  list(profileId: string): { id: number; name: string; quantityNames: string[] }[] {
    const rows = db.prepare('SELECT id, name, quantity_names_json FROM measurement_presets WHERE profile_id = ? ORDER BY name COLLATE NOCASE').all(profileId) as unknown as { id: number; name: string; quantity_names_json: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, quantityNames: JSON.parse(r.quantity_names_json) as string[] }));
  },
  upsert(profileId: string, name: string, quantityNames: string[]): number {
    db.prepare(
      `INSERT INTO measurement_presets (profile_id, name, quantity_names_json) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, name) DO UPDATE SET quantity_names_json = excluded.quantity_names_json`,
    ).run(profileId, name, JSON.stringify(quantityNames));
    const row = db.prepare('SELECT id FROM measurement_presets WHERE profile_id = ? AND name = ?').get(profileId, name) as { id: number };
    return row.id;
  },
  remove(profileId: string, id: number): boolean {
    return db.prepare('DELETE FROM measurement_presets WHERE id = ? AND profile_id = ?').run(id, profileId).changes > 0;
  },
};

// ---------------------------------------------------------------------------
// Reportes
// ---------------------------------------------------------------------------

interface ReportRow {
  id: number;
  name: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

export interface StoredReport {
  id: number;
  name: string;
  definition: ReportDefinition;
  createdAt: string;
  updatedAt: string;
}

const toReport = (r: ReportRow): StoredReport => ({
  id: r.id,
  name: r.name,
  definition: JSON.parse(r.definition_json) as ReportDefinition,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const reports = {
  list(profileId: string): StoredReport[] {
    return (db.prepare('SELECT * FROM reports WHERE profile_id = ? ORDER BY name COLLATE NOCASE').all(profileId) as unknown as ReportRow[]).map(toReport);
  },
  get(profileId: string, id: number): StoredReport | null {
    const r = db.prepare('SELECT * FROM reports WHERE id = ? AND profile_id = ?').get(id, profileId) as unknown as ReportRow | undefined;
    return r ? toReport(r) : null;
  },
  create(profileId: string, def: ReportDefinition): number {
    return Number(db.prepare('INSERT INTO reports (profile_id, name, definition_json) VALUES (?, ?, ?)').run(profileId, def.name, JSON.stringify(def)).lastInsertRowid);
  },
  update(profileId: string, id: number, def: ReportDefinition): boolean {
    return db.prepare("UPDATE reports SET name = ?, definition_json = ?, updated_at = datetime('now') WHERE id = ? AND profile_id = ?").run(def.name, JSON.stringify(def), id, profileId).changes > 0;
  },
  remove(profileId: string, id: number): boolean {
    return db.prepare('DELETE FROM reports WHERE id = ? AND profile_id = ?').run(id, profileId).changes > 0;
  },
};

// ---------------------------------------------------------------------------
// Historial de ejecuciones
// ---------------------------------------------------------------------------

export const history = {
  insert(e: { id: string; profileId: string; reportId: number | null; reportName: string; fileName: string; meters: number; validation: unknown; forced: boolean }): void {
    db.prepare(
      `INSERT INTO job_history (id, profile_id, report_id, report_name, status, file_name, meters, validation_json, started_at, forced)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(e.id, e.profileId, e.reportId, e.reportName, e.fileName, e.meters, e.validation ? JSON.stringify(e.validation) : null, new Date().toISOString(), b(e.forced));
  },
  finish(id: string, status: JobStatus, rows: number, bytes: number, error: string | null, offGridRows: number): void {
    db.prepare('UPDATE job_history SET status = ?, rows = ?, bytes = ?, error = ?, finished_at = ?, off_grid_rows = ? WHERE id = ?')
      .run(status, rows, bytes, error, new Date().toISOString(), offGridRows, id);
  },
  list(profileId: string, limit = 50): HistoryEntryDTO[] {
    const rows = db.prepare('SELECT * FROM job_history WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?').all(profileId, limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      reportId: (r.report_id as number | null) ?? null,
      reportName: r.report_name as string,
      status: r.status as JobStatus,
      fileName: r.file_name as string,
      meters: r.meters as number,
      rows: r.rows as number,
      bytes: r.bytes as number,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      forced: !!r.forced,
      offGridRows: (r.off_grid_rows as number) ?? 0,
    }));
  },
  /** Ejecuciones que quedaron a medias si el proceso se cerró. */
  markInterrupted(): void {
    db.prepare("UPDATE job_history SET status = 'error', error = 'Interrumpido (la aplicación se cerró)', finished_at = ? WHERE status IN ('queued', 'running', 'assembling')").run(new Date().toISOString());
  },
};

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export const defaultSettings: Settings = {
  workers: Math.max(1, Math.min(2, availableParallelism() - 1)),
  concurrency: 4,
  readUncommitted: true,
  downloadTtlMinutes: 60,
  requestTimeoutSeconds: 1800,
};

export const settings = {
  get(): Settings {
    const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as { key: string; value: string }[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    return { ...defaultSettings, ...stored };
  },
  set(s: Settings): void {
    const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    transaction(() => Object.entries(s).forEach(([k, v]) => stmt.run(k, JSON.stringify(v))));
  },
};
