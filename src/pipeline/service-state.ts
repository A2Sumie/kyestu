import type { KyestuDb } from '../components/db'
import type { SessionHealthSnapshot, SessionHealthStore } from './session-health'
import type { CooldownStore, PersistedCooldown } from './cooldown'
import type { CircuitStore, PersistedCircuit } from '../components/llm-openai'
import type { ArticleEvent } from '../components/bus'
import type { RouterQueueStore } from '../components/router'
import type { DigestStateStore, PersistedDigestItem } from './target-runtime'

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

/**
 * LLM circuit-breaker persistence adapter: one row per provider client at
 * `llm-circuit:<scope>` — scope is the processor entry id (the fallback
 * endpoint's client uses `<entry-id>:fallback`). Same convention as
 * cooldowns: the open state carries an absolute timestamp and an expired
 * open never revives the circuit, while the failure counter survives until
 * the next success (matching the in-memory semantics).
 */
export function llmCircuitStore(kv: ServiceStateStore, scope: string): CircuitStore {
  const key = `llm-circuit:${scope}`
  return {
    load(): PersistedCircuit | null {
      const raw = kv.get(key)
      if (!raw) return null
      const value = parseJson<PersistedCircuit>(raw)
      if (!value || typeof value !== 'object') return null
      if (typeof value.consecutiveFailures !== 'number' || typeof value.openUntil !== 'number') return null
      return {
        consecutiveFailures: value.consecutiveFailures,
        openUntil: value.openUntil,
        lastError: typeof value.lastError === 'string' ? value.lastError : null,
      }
    },
    save(state: PersistedCircuit): void {
      kv.set(key, JSON.stringify(state))
    },
    remove(): void {
      kv.delete(key)
    },
  }
}

/**
 * Router pending-queue persistence adapter: the whole queue as one JSON row
 * at `router:<entry-id>:queue`. Events are bus article carriers (DB primary
 * keys), so the row stays tiny; an empty queue deletes the row. Write-through
 * happens on push/remove (state transitions), and the component reconciles
 * against outbound before replaying (see components/router.ts).
 */
export function routerQueueStore(kv: ServiceStateStore, entryId: string): RouterQueueStore {
  const key = `router:${entryId}:queue`
  return {
    load(): ArticleEvent[] {
      const raw = kv.get(key)
      if (!raw) return []
      const value = parseJson<unknown>(raw)
      if (!Array.isArray(value)) return []
      return value.filter(
        (event): event is ArticleEvent =>
          !!event &&
          typeof event === 'object' &&
          typeof (event as ArticleEvent).platform === 'string' &&
          typeof (event as ArticleEvent).id === 'number' &&
          typeof (event as ArticleEvent).a_id === 'string' &&
          typeof (event as ArticleEvent).crawlerId === 'string',
      )
    },
    save(events: ArticleEvent[]): void {
      if (events.length === 0) {
        kv.delete(key)
        return
      }
      kv.set(key, JSON.stringify(events))
    },
  }
}

/**
 * Digest persistence adapter: the target's digest buffer at
 * `digest:<target-entry-id>:buffer` and the first-sent window marks at
 * `digest:<target-entry-id>:first-sent-windows` (window ids are
 * aggregation_windows rowids, stable across restarts because ensureWindow
 * reopens the open window by idempotency key). No expiry: the buffer is a
 * batching accumulator, not a time-based state; invalid rows never load.
 */
export function digestStateStore(kv: ServiceStateStore, targetId: string): DigestStateStore {
  const bufferKey = `digest:${targetId}:buffer`
  const firstSentKey = `digest:${targetId}:first-sent-windows`
  return {
    loadBuffer(): PersistedDigestItem[] {
      const raw = kv.get(bufferKey)
      if (!raw) return []
      const value = parseJson<unknown>(raw)
      if (!Array.isArray(value)) return []
      return value.filter(
        (item): item is PersistedDigestItem =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as PersistedDigestItem).text === 'string' &&
          !!(item as PersistedDigestItem).input &&
          typeof (item as PersistedDigestItem).input === 'object' &&
          typeof (item as PersistedDigestItem).input.article?.platform === 'string' &&
          typeof (item as PersistedDigestItem).input.article?.a_id === 'string' &&
          !!(item as PersistedDigestItem).input.rendered &&
          !!(item as PersistedDigestItem).input.route,
      )
    },
    saveBuffer(items: PersistedDigestItem[]): void {
      if (items.length === 0) {
        kv.delete(bufferKey)
        return
      }
      kv.set(bufferKey, JSON.stringify(items))
    },
    loadFirstSentWindows(): number[] {
      const raw = kv.get(firstSentKey)
      if (!raw) return []
      const value = parseJson<unknown>(raw)
      if (!Array.isArray(value)) return []
      return value.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
    },
    saveFirstSentWindows(ids: number[]): void {
      if (ids.length === 0) {
        kv.delete(firstSentKey)
        return
      }
      kv.set(firstSentKey, JSON.stringify(ids))
    },
  }
}
