import { createHash } from 'crypto'
import type { KyestuDb } from '../components/db'
import type { Platform } from './articles'

/**
 * Outbound persistence + dedup. Key formats are kyestu-native (the schema is
 * production-compatible, but key strings differ from idol-bbq; start kyestu
 * with a fresh database or accept a one-time dedup reset).
 */

export type OutboundStatus =
  | 'planned'
  | 'sending'
  | 'queued'
  | 'dry_run'
  | 'skipped'
  | 'sent'
  | 'partial'
  | 'failed'

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize((value as Record<string, unknown>)[k])}`).join(',')}}`
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(stableSerialize(payload)).digest('hex')
}

export function articleKey(platform: Platform, aId: string): string {
  return `${platform}:${aId}`
}

export function outboundKey(parts: { crawler: string; formatter?: string | null; target: string; article: string }): string {
  return [parts.crawler, parts.formatter ?? '-', parts.target, parts.article].join('|')
}

export class OutboundStore {
  constructor(private readonly store: KyestuDb) {}

  /** article-level dedup: has this article already gone to this target? */
  forwarded(platform: Platform, aId: string, targetId: string): boolean {
    const row = this.store.db
      .query('SELECT ref_id FROM forward_by WHERE ref_id = ? AND platform = ? AND bot_id = ? LIMIT 1')
      .get(aId, platform, targetId)
    return row !== null
  }

  markForwarded(platform: Platform, aId: string, targetId: string, taskType = 'article'): void {
    this.store.db
      .query('INSERT OR IGNORE INTO forward_by (ref_id, platform, bot_id, task_type) VALUES (?, ?, ?, ?)')
      .run(aId, platform, targetId, taskType)
  }

  /** idempotency claim: returns null if the key is already terminal (sent) */
  claim(
    key: string,
    payload: unknown,
    meta: { route_key?: string; target_id?: string; task_kind?: string; article_key?: string } = {},
  ): { id: number; duplicate: 'sent' | 'in_progress' | null } {
    const existing = this.store.db.query('SELECT id, status FROM outbound_messages WHERE idempotency_key = ?').get(key) as
      | { id: number; status: string }
      | null
    if (existing) {
      if (existing.status === 'sent') return { id: existing.id, duplicate: 'sent' }
      if (['sending', 'queued'].includes(existing.status)) return { id: existing.id, duplicate: 'in_progress' }
      this.store.db
        .query(`UPDATE outbound_messages SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`)
        .run(Date.now(), existing.id)
      return { id: existing.id, duplicate: null }
    }
    const now = Date.now()
    const result = this.store.db
      .query(
        `INSERT INTO outbound_messages
         (idempotency_key, route_key, target_id, task_kind, article_key, payload_hash, status, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?)`,
      )
      .run(
        key,
        meta.route_key ?? key,
        meta.target_id ?? '',
        meta.task_kind ?? 'article',
        meta.article_key ?? null,
        payloadHash(payload),
        now,
        now,
      )
    return { id: Number(result.lastInsertRowid), duplicate: null }
  }

  mark(id: number, status: OutboundStatus, error?: string): void {
    this.store.db
      .query('UPDATE outbound_messages SET status = ?, last_error = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(status, error ?? null, Date.now(), ['sent', 'failed', 'skipped', 'partial'].includes(status) ? Date.now() : null, id)
  }
}
