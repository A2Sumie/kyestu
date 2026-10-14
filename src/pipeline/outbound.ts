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
  | 'recalled'

/** provider receipts recorded alongside a terminal status (message_id 回执) */
export interface OutboundReceipts {
  messageIds?: Array<number | string>
  segmentResults?: unknown
}

/** statuses after which the row must never be re-driven (content is gone or visible) */
const TERMINAL_STATUSES: ReadonlySet<OutboundStatus> = new Set(['sent', 'partial', 'skipped', 'recalled'])

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

  /**
   * Idempotency claim. Duplicate verdicts:
   *  - 'sent': the key is terminal (sent / partial / skipped / recalled) — never re-drive;
   *  - 'exhausted': the retry budget is spent — give up for good;
   *  - 'in_progress': another claim owns the row (crashed-mid-send window) —
   *    re-drive later (OneBotRetryLaterError), no retry budget consumed;
   *  - null: this caller owns the row and must send (or mark it).
   *
   * `failed` rows are reclaimable immediately (their attempt terminated; nobody
   * holds the claim) up to `maxAttempts`; `sending` rows only after the stale
   * window (production parity: 30min / 5 attempts).
   */
  claim(
    key: string,
    payload: unknown,
    meta: { route_key?: string; target_id?: string; task_kind?: string; article_key?: string } = {},
    opts: { staleMs?: number; maxAttempts?: number } = {},
  ): { id: number; duplicate: 'sent' | 'in_progress' | 'exhausted' | null } {
    const staleMs = opts.staleMs ?? 30 * 60 * 1000
    const maxAttempts = opts.maxAttempts ?? 5
    const existing = this.store.db
      .query('SELECT id, status, updated_at, attempt_count FROM outbound_messages WHERE idempotency_key = ?')
      .get(key) as { id: number; status: string; updated_at: number; attempt_count: number } | null
    if (existing) {
      const status = existing.status as OutboundStatus
      if (TERMINAL_STATUSES.has(status)) return { id: existing.id, duplicate: 'sent' }
      const attempts = Number(existing.attempt_count ?? 0)
      if (attempts >= maxAttempts) return { id: existing.id, duplicate: 'exhausted' }
      const stale = Date.now() - existing.updated_at > staleMs
      // 'failed' means the attempt terminated: the claim is free, reclaim now.
      // 'sending' may still be in flight elsewhere: wait for the stale window.
      const reclaimable = status === 'failed' || stale
      if (!reclaimable) return { id: existing.id, duplicate: 'in_progress' }
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

  mark(id: number, status: OutboundStatus, error?: string, receipts?: OutboundReceipts): void {
    const finished = ['sent', 'failed', 'skipped', 'partial', 'recalled'].includes(status)
    this.store.db
      .query(
        `UPDATE outbound_messages
         SET status = ?, last_error = ?, updated_at = ?, finished_at = ?,
             provider_message_ids = COALESCE(?, provider_message_ids),
             segment_results = COALESCE(?, segment_results)
         WHERE id = ?`,
      )
      .run(
        status,
        error ?? null,
        Date.now(),
        finished ? Date.now() : null,
        receipts?.messageIds ? JSON.stringify(receipts.messageIds) : null,
        receipts?.segmentResults !== undefined ? JSON.stringify(receipts.segmentResults) : null,
        id,
      )
  }

  /** row lookup for receipt checks / recall ops */
  get(id: number): {
    id: number
    status: OutboundStatus
    messageIds: Array<number | string>
    segmentResults: unknown
    lastError: string | null
  } | null {
    const row = this.store.db
      .query('SELECT id, status, provider_message_ids, segment_results, last_error FROM outbound_messages WHERE id = ?')
      .get(id) as
      | { id: number; status: string; provider_message_ids: string | null; segment_results: string | null; last_error: string | null }
      | null
    if (!row) return null
    let messageIds: Array<number | string> = []
    try {
      const parsed = row.provider_message_ids ? JSON.parse(row.provider_message_ids) : []
      if (Array.isArray(parsed)) messageIds = parsed
    } catch {
      // a corrupt receipt blob must not break ops paths
    }
    let segmentResults: unknown = null
    try {
      segmentResults = row.segment_results ? JSON.parse(row.segment_results) : null
    } catch {
      segmentResults = null
    }
    return { id: row.id, status: row.status as OutboundStatus, messageIds, segmentResults, lastError: row.last_error }
  }

  /** recently sent rows carrying receipts (message_id), oldest first */
  sentWithReceipts(targetId?: string, since = 0, limit = 200): Array<{ id: number; messageIds: Array<number | string> }> {
    const rows = (
      targetId
        ? this.store.db
            .query(
              `SELECT id, provider_message_ids FROM outbound_messages
               WHERE status = 'sent' AND target_id = ? AND updated_at >= ? AND provider_message_ids IS NOT NULL
               ORDER BY updated_at ASC LIMIT ?`,
            )
            .all(targetId, since, limit)
        : this.store.db
            .query(
              `SELECT id, provider_message_ids FROM outbound_messages
               WHERE status = 'sent' AND updated_at >= ? AND provider_message_ids IS NOT NULL
               ORDER BY updated_at ASC LIMIT ?`,
            )
            .all(since, limit)
    ) as Array<{ id: number; provider_message_ids: string }>
    const out: Array<{ id: number; messageIds: Array<number | string> }> = []
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.provider_message_ids)
        if (Array.isArray(parsed) && parsed.length) out.push({ id: row.id, messageIds: parsed })
      } catch {
        // skip corrupt rows
      }
    }
    return out
  }
}
