/**
 * Local mirror of the bridge's message-store (SnowLuma `get_msg` /
 * `get_group_msg_history` / `get_friend_msg_history`), used for history
 * backfill (gap healing after an outage) and send-side dedup/receipt checks.
 *
 * This is deliberately a *mirror*, not a new inbound pipeline: kyestu consumes
 * no inbound QQ messages today (docs/bus.md — the bus only carries article
 * pointers), so history rows feed dedup/receipt reconciliation instead of
 * being fabricated into articles.
 */
import type { KyestuDb } from '../components/db'

export interface QqMessageRow {
  scope: string // 'group:<id>' | 'friend:<id>'
  messageId: number
  realId?: number | null
  time: number
  senderId?: number | null
  messageType?: string | null
  text: string
  raw: unknown
}

export interface NormalizedQqMessage {
  messageId: number
  realId: number | null
  time: number
  senderId: number | null
  messageType: string | null
  text: string
  raw: unknown
}

function intOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** flatten a OneBot message field (segment array | CQ string) into plain text */
export function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    return message
      .map((segment: any) => {
        const type = String(segment?.type ?? '')
        const data = segment?.data ?? segment
        if (type === 'text') return String(data?.text ?? '')
        if (type === 'at') return String(data?.text ?? `@${data?.qq ?? data?.user_id ?? ''}`)
        return ''
      })
      .join('')
  }
  return ''
}

/** normalize a OneBot message event object (history / get_msg payload) */
export function normalizeHistoryMessage(raw: any): NormalizedQqMessage | null {
  const messageId = intOrNull(raw?.message_id)
  if (messageId === null) return null
  return {
    messageId,
    realId: intOrNull(raw?.real_id),
    time: intOrNull(raw?.time) ?? 0,
    senderId: intOrNull(raw?.sender?.user_id ?? raw?.user_id),
    messageType: raw?.message_type ? String(raw.message_type) : null,
    text: messageText(raw?.message),
    raw,
  }
}

export class QqMessageStore {
  constructor(private readonly store: KyestuDb) {}

  /** idempotent upsert keyed by (scope, message_id); returns rows actually inserted */
  insert(rows: QqMessageRow[]): number {
    let inserted = 0
    const stmt = this.store.db.query(
      `INSERT OR IGNORE INTO qq_messages (scope, message_id, real_id, sent_at, sender_id, message_type, text, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      const result = stmt.run(
        row.scope,
        row.messageId,
        row.realId ?? null,
        row.time,
        row.senderId ?? null,
        row.messageType ?? null,
        row.text,
        row.raw === undefined ? null : JSON.stringify(row.raw),
        Date.now(),
      )
      inserted += Number(result.changes ?? 0)
    }
    return inserted
  }

  has(scope: string, messageId: number): boolean {
    return this.store.db.query('SELECT 1 FROM qq_messages WHERE scope = ? AND message_id = ? LIMIT 1').get(scope, messageId) !== null
  }

  list(scope: string, since = 0, limit = 500): QqMessageRow[] {
    const rows = this.store.db
      .query('SELECT scope, message_id, real_id, sent_at, sender_id, message_type, text, raw FROM qq_messages WHERE scope = ? AND sent_at >= ? ORDER BY sent_at ASC, message_id ASC LIMIT ?')
      .all(scope, since, limit) as any[]
    return rows.map((row) => ({
      scope: row.scope,
      messageId: row.message_id,
      realId: row.real_id,
      time: row.sent_at,
      senderId: row.sender_id,
      messageType: row.message_type,
      text: row.text ?? '',
      raw: row.raw ?? null,
    }))
  }

  latestTime(scope: string): number | null {
    const row = this.store.db.query('SELECT MAX(sent_at) AS t FROM qq_messages WHERE scope = ?').get(scope) as { t: number | null } | null
    return row?.t ?? null
  }

  oldestMessageId(scope: string): number | null {
    const row = this.store.db
      .query('SELECT message_id FROM qq_messages WHERE scope = ? ORDER BY sent_at ASC, message_id ASC LIMIT 1')
      .get(scope) as { message_id: number } | null
    return row?.message_id ?? null
  }

  count(scope: string): number {
    const row = this.store.db.query('SELECT COUNT(*) AS n FROM qq_messages WHERE scope = ?').get(scope) as { n: number } | null
    return Number(row?.n ?? 0)
  }
}
