/**
 * Inbound event ledger (table `qq_inbound_events`): one row per normalized QQ
 * event ever accepted, keyed by a stable dedupe key. It is the idempotency
 * backbone of the inbound channel — a webhook re-delivery (or a history
 * backfill replaying a message that already arrived live) inserts zero rows and
 * therefore re-triggers zero reactions — and the dispatch journal: `status`
 * walks received → dispatching → ok/error/skipped (`bad` for unparseable
 * payloads), so lost work is visible instead of silent.
 */
import type { KyestuDb } from '../components/db'
import type { QqInboundEvent } from './qq-events'

export type QqInboundStatus = 'received' | 'dispatching' | 'ok' | 'error' | 'skipped' | 'bad'

export interface QqInboundRow {
  id: number
  dedupeKey: string
  kind: string
  scope: string | null
  groupId: number | null
  userId: number | null
  selfId: number | null
  messageId: number | null
  eventTime: number
  text: string
  recovered: boolean
  status: QqInboundStatus
  detail: string | null
  raw: unknown
}

export interface QqInboundRecord {
  key: string
  kind: string
  scope?: string | null
  groupId?: number | null
  userId?: number | null
  selfId?: number | null
  messageId?: number | null
  eventTime?: number
  text?: string | null
  recovered?: boolean
  raw?: unknown
}

export function recordFromEvent(event: QqInboundEvent): QqInboundRecord {
  return {
    key: event.key,
    kind: event.kind,
    scope: event.scope,
    groupId: event.groupId,
    userId: event.userId,
    selfId: event.selfId,
    messageId: event.messageId,
    eventTime: event.time,
    text: event.text,
    recovered: event.recovered,
    raw: event.raw,
  }
}

export class QqInboundStore {
  constructor(private readonly store: KyestuDb) {}

  /** idempotent insert by dedupe_key; `inserted: false` means a re-delivery */
  record(record: QqInboundRecord, status: QqInboundStatus, detail?: string): { id: number; inserted: boolean } {
    const result = this.store.db
      .query(
        `INSERT OR IGNORE INTO qq_inbound_events
           (dedupe_key, kind, scope, group_id, user_id, self_id, message_id, event_time, text, recovered, status, detail, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.key,
        record.kind,
        record.scope ?? null,
        record.groupId ?? null,
        record.userId ?? null,
        record.selfId ?? null,
        record.messageId ?? null,
        record.eventTime ?? 0,
        record.text ?? null,
        record.recovered ? 1 : 0,
        status,
        detail ?? null,
        record.raw === undefined ? null : JSON.stringify(record.raw),
        Date.now(),
      )
    const inserted = Number(result.changes ?? 0) > 0
    const row = this.store.db.query('SELECT id FROM qq_inbound_events WHERE dedupe_key = ?').get(record.key) as { id: number } | null
    return { id: row?.id ?? 0, inserted }
  }

  mark(dedupeKey: string, status: QqInboundStatus, detail?: string): void {
    this.store.db.query('UPDATE qq_inbound_events SET status = ?, detail = ? WHERE dedupe_key = ?').run(status, detail ?? null, dedupeKey)
  }

  hasMessage(scope: string, messageId: number): boolean {
    return (
      this.store.db
        .query('SELECT 1 FROM qq_inbound_events WHERE scope = ? AND message_id = ? LIMIT 1')
        .get(scope, messageId) !== null
    )
  }

  /**
   * Rows whose dispatch never finished: brand-new `received` rows plus
   * `dispatching` rows older than the stale window (crash mid-dispatch —
   * mirrors the outbound `sending` stale-claim semantics).
   */
  pending(staleBefore: number, limit = 50): QqInboundRow[] {
    const rows = this.store.db
      .query(
        `SELECT id, dedupe_key, kind, scope, group_id, user_id, self_id, message_id, event_time, text, recovered, status, detail, raw
           FROM qq_inbound_events
          WHERE status = 'received' OR (status = 'dispatching' AND created_at <= ?)
          ORDER BY id ASC LIMIT ?`,
      )
      .all(staleBefore, limit) as any[]
    return rows.map(mapRow)
  }

  stats(): Record<string, number> {
    const rows = this.store.db.query('SELECT status, COUNT(*) AS n FROM qq_inbound_events GROUP BY status').all() as Array<{ status: string; n: number }>
    const out: Record<string, number> = {}
    for (const row of rows) out[row.status] = Number(row.n)
    return out
  }
}

function mapRow(row: any): QqInboundRow {
  let raw: unknown = null
  try {
    raw = row.raw ? JSON.parse(row.raw) : null
  } catch {
    raw = null
  }
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    scope: row.scope,
    groupId: row.group_id,
    userId: row.user_id,
    selfId: row.self_id,
    messageId: row.message_id,
    eventTime: row.event_time,
    text: row.text ?? '',
    recovered: Number(row.recovered) > 0,
    status: row.status,
    detail: row.detail,
    raw,
  }
}
