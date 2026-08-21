import type { KyestuDb } from '../components/db'
import type { SessionHealthSnapshot, SessionHealthStore } from './session-health'
import type { CooldownStore, PersistedCooldown } from './cooldown'

/**
 * Minimal namespaced KV on the `service_state` table (migration
 * 20260813030000_add_service_state.sql — the table existed with zero code
 * references; this is the wiring the schema was planned for).
 *
 * Role in the runtime: the in-memory risk-control structures
 * (SessionHealthBoard, CooldownMap) stay the runtime master copies; this
 * store is the persistent backing. Writes are write-through and happen only
 * on state transitions (never in the per-round hot path); reads happen once,
 * at component apply time, to rehydrate after a fiber rebuild or a process
 * restart (paper p76: in-memory state survives reloads only when backed by a
 * longer-lived dependency).
 */
export class ServiceStateStore {
  constructor(private readonly store: KyestuDb) {}

  get(key: string): string | null {
    const row = this.store.db.query('SELECT value FROM service_state WHERE key = ?').get(key) as { value: string } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.store.db
      .query(
        `INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now())
  }

  delete(key: string): void {
    this.store.db.query('DELETE FROM service_state WHERE key = ?').run(key)
  }

  /** all rows whose key carries the given namespace prefix */
  list(prefix: string): Array<{ key: string; value: string }> {
    // LIKE metacharacters in the prefix (entry ids, urls) must be literals
    const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    return this.store.db
      .query("SELECT key, value FROM service_state WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
      .all(`${escaped}%`) as Array<{ key: string; value: string }>
  }
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    // a corrupt row must never block boot; the in-memory default wins
    return null
  }
}

/** board persistence adapter: one row per session key at `session-health:<key>` */
export function sessionHealthStore(kv: ServiceStateStore): SessionHealthStore {
  const PREFIX = 'session-health:'
  return {
    load(): SessionHealthSnapshot[] {
      const out: SessionHealthSnapshot[] = []
      for (const row of kv.list(PREFIX)) {
        const value = parseJson<Omit<SessionHealthSnapshot, 'key'>>(row.value)
        if (!value || typeof value !== 'object') continue
        out.push({ key: row.key.slice(PREFIX.length), ...value })
      }
      return out
    },
    save(snapshot: SessionHealthSnapshot): void {
      const { key, ...slot } = snapshot
      kv.set(`${PREFIX}${key}`, JSON.stringify(slot))
    },
  }
}

/**
 * Cooldown persistence adapter: one row per target key at
 * `cooldown:<scope>:<key>` — scope is the crawler entry id, so per-target
 * isolation (2026-08-20 incident, cooldown-isolation.test.ts) is preserved
 * across restarts exactly as in memory.
 */
export function cooldownStore(kv: ServiceStateStore, scope: string): CooldownStore {
  const prefix = `cooldown:${scope}:`
  return {
    load(): Array<{ key: string } & PersistedCooldown> {
      const out: Array<{ key: string } & PersistedCooldown> = []
      for (const row of kv.list(prefix)) {
        const value = parseJson<PersistedCooldown>(row.value)
        if (!value || typeof value !== 'object' || typeof value.expiresAt !== 'number') continue
        out.push({ key: row.key.slice(prefix.length), ...value })
      }
      return out
    },
    save(key: string, entry: PersistedCooldown): void {
      kv.set(`${prefix}${key}`, JSON.stringify(entry))
    },
    remove(key: string): void {
      kv.delete(`${prefix}${key}`)
    },
  }
}
