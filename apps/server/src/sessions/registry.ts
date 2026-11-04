import { randomBytes } from 'node:crypto';
import { closeSqlSession, type Session } from '../mssql/session.ts';

/**
 * Sesiones de usuario en memoria. Cada navegador (cookie repnode.sid) tiene su sesión y, al conectarse, su propio
 * pool de SQL. Se cierran tras un tiempo sin actividad (15 min por defecto) o al cumplir la duración máxima; un job
 * en curso cuenta como actividad. Si el backend se reinicia, las sesiones se pierden y la GUI se reconecta.
 */
export interface UserSession {
  id: string;
  /** Usuario de PME (modo pme); null en modo local. */
  user: string | null;
  createdAt: number;
  lastSeen: number;
  /** Hash de las cookies de PME con las que se validó y cuándo se confirmó con PME por última vez. */
  pmeCookieHash: string | null;
  pmeCheckedAt: number;
  sql: Session | null;
}

export interface ExpiryPolicy {
  idleMs: number;
  maxMs: number;
}

export type ExpiryReason = 'idle' | 'max_age' | null;

/** `busy` = tiene jobs en curso: no vence por inactividad, pero sí por duración máxima. */
export function expiryReason(s: Pick<UserSession, 'createdAt' | 'lastSeen'>, now: number, policy: ExpiryPolicy, busy: boolean): ExpiryReason {
  if (now - s.createdAt >= policy.maxMs) return 'max_age';
  if (!busy && now - s.lastSeen >= policy.idleMs) return 'idle';
  return null;
}

/**
 * Sesión a desalojar cuando se llegó al tope: la que lleva más tiempo sin actividad entre las que no tienen conexión
 * SQL ni jobs (p. ej. pestañas que solo cargaron la pantalla de conexión). null = no se puede desalojar ninguna.
 */
export function pickEviction<T extends Pick<UserSession, 'id' | 'lastSeen' | 'sql'>>(sessions: Iterable<T>, isBusy: (s: T) => boolean): T | null {
  let best: T | null = null;
  for (const s of sessions) {
    if (s.sql || isBusy(s)) continue;
    if (!best || s.lastSeen < best.lastSeen) best = s;
  }
  return best;
}

export interface RegistryOptions extends ExpiryPolicy {
  maxSessions: number;
  /** La sesión tiene jobs en cola o en curso (ver ownerKey). */
  isBusy: (s: UserSession) => boolean;
  onExpire?: (s: UserSession, reason: Exclude<ExpiryReason, null>) => void;
}

export class SessionLimitError extends Error {}

export function createRegistry(opts: RegistryOptions) {
  const sessions = new Map<string, UserSession>();

  async function destroy(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    const sql = s.sql;
    s.sql = null;
    if (sql) await closeSqlSession(sql);
  }

  function get(id: string | undefined, now = Date.now()): UserSession | null {
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    const reason = expiryReason(s, now, opts, opts.isBusy(s));
    if (reason) {
      opts.onExpire?.(s, reason);
      void destroy(id);
      return null;
    }
    return s;
  }

  function create(user: string | null, pmeCookieHash: string | null, now = Date.now()): UserSession {
    if (sessions.size >= opts.maxSessions) {
      const victim = pickEviction(sessions.values(), opts.isBusy);
      if (!victim) throw new SessionLimitError('Se alcanzó el máximo de sesiones simultáneas de RepNode. Intenta de nuevo en unos minutos.');
      void destroy(victim.id);
    }
    const s: UserSession = {
      id: randomBytes(32).toString('base64url'),
      user,
      createdAt: now,
      lastSeen: now,
      pmeCookieHash,
      pmeCheckedAt: pmeCookieHash ? now : 0,
      sql: null,
    };
    sessions.set(s.id, s);
    return s;
  }

  /** Reemplaza la conexión SQL de la sesión y cierra la anterior. */
  async function setSql(s: UserSession, sql: Session | null): Promise<void> {
    const old = s.sql;
    s.sql = sql;
    if (old && old !== sql) await closeSqlSession(old);
  }

  function sweep(now = Date.now()): void {
    for (const s of sessions.values()) get(s.id, now);
  }

  let timer: NodeJS.Timeout | null = null;
  function start(): void {
    timer = setInterval(sweep, 60_000);
    timer.unref();
  }

  async function closeAll(): Promise<void> {
    if (timer) clearInterval(timer);
    await Promise.all([...sessions.keys()].map(destroy));
  }

  return {
    get,
    create,
    destroy,
    setSql,
    sweep,
    start,
    closeAll,
    size: () => sessions.size,
    stats: () => ({ sessions: sessions.size, connected: [...sessions.values()].filter((s) => s.sql).length }),
  };
}

export type SessionRegistry = ReturnType<typeof createRegistry>;

/**
 * Dueño de los jobs. En modo pme es el usuario de PME (sus pestañas y sesiones sucesivas ven sus jobs); en modo
 * local la app solo es accesible desde este equipo, así que todo pertenece al mismo usuario.
 */
export function ownerKey(s: Pick<UserSession, 'user'>): string {
  return s.user ? `pme:${s.user.toLowerCase()}` : 'local';
}
