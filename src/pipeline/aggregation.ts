import type { KyestuDb } from '../components/db'

/**
 * Summary-card / digest aggregation, DB-backed so queues survive reloads.
 * Ported semantics: hourly-style windows with threshold flushes, threshold
 * digests, and per-window item caps.
 */

export interface AggregationConfig {
  enabled?: boolean
  interval_seconds?: number
  threshold?: number
  max_items?: number
  send_first_immediately?: boolean
  send_first_native?: boolean
  align_to_hour?: boolean
  flush_on_threshold?: boolean
}

export interface WindowRow {
  id: number
  itemCount: number
}

export class Aggregator {
  constructor(private readonly store: KyestuDb) {}

  private configOf(config: AggregationConfig) {
    return {
      intervalSeconds: Math.max(60, Math.floor(config.interval_seconds ?? 1800)),
      threshold: Math.max(2, Math.floor(config.threshold ?? 8)),
      maxItems: Math.min(30, Math.max(3, Math.floor(config.max_items ?? 14))),
      sendFirstImmediately: config.send_first_immediately !== false,
      flushOnThreshold: config.flush_on_threshold !== false,
      alignToHour: config.align_to_hour === true,
    }
  }

  windowStart(config: AggregationConfig, now = Date.now()): number {
    const { intervalSeconds, alignToHour } = this.configOf(config)
    const seconds = Math.floor(now / 1000)
    if (alignToHour) return Math.floor(seconds / 3600) * 3600
    return Math.floor(seconds / intervalSeconds) * intervalSeconds
  }

  /** enqueue an article into the target's current window; returns the window id */
  enqueue(targetId: string, routeKey: string, article: { key: string; rowId: number; platform: string; payload: unknown }, config: AggregationConfig): number {
    const { maxItems } = this.configOf(config)
    const windowId = this.ensureWindow(targetId, routeKey, config)
    const countRow = this.store.db
      .query('SELECT COUNT(*) AS c FROM aggregation_items WHERE window_id = ?')
      .get(windowId) as { c: number }
    if (Number(countRow.c) >= maxItems) return windowId // over cap: drop deliberately
    this.store.db
      .query('INSERT INTO aggregation_items (window_id, article_key, article_row_id, platform, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(windowId, article.key, article.rowId, article.platform, JSON.stringify(article.payload ?? null), Date.now())
    this.store.db.query('UPDATE aggregation_windows SET updated_at = ? WHERE id = ?').run(Date.now(), windowId)
    return windowId
  }

  /** find or create the target's current open window */
  ensureWindow(targetId: string, routeKey: string, config: AggregationConfig): number {
    const start = this.windowStart(config)
    const end = start + this.configOf(config).intervalSeconds
    const now = Date.now()
    // a closed (sent/dropped) window must never be reused: reopen under a fresh
    // key, mirroring idol-bbq's `:reopen:` idempotency suffix, or its queued
    // items would be stranded forever (due() only scans open windows)
    let window = this.store.db
      .query("SELECT id FROM aggregation_windows WHERE idempotency_key = ? AND status = 'open'")
      .get(`summary:${targetId}:${start}`) as { id: number } | undefined
    if (!window) {
      this.store.db
        .query(
          `INSERT INTO aggregation_windows (idempotency_key, route_key, target_id, mode, window_start, window_end, status, created_at, updated_at)
           VALUES (?, ?, ?, 'summary_card', ?, ?, 'open', ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(`summary:${targetId}:${start}`, routeKey, targetId, start, end, now, now)
      window = this.store.db
        .query("SELECT id FROM aggregation_windows WHERE idempotency_key = ? AND status = 'open'")
        .get(`summary:${targetId}:${start}`) as { id: number } | undefined
    }
    if (!window) {
      this.store.db
        .query(
          `INSERT INTO aggregation_windows (idempotency_key, route_key, target_id, mode, window_start, window_end, status, created_at, updated_at)
           VALUES (?, ?, ?, 'summary_card', ?, ?, 'open', ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(`summary:${targetId}:${start}:reopen:${now}`, routeKey, targetId, start, end, now, now)
      window = this.store.db
        .query("SELECT id FROM aggregation_windows WHERE idempotency_key = ? AND status = 'open'")
        .get(`summary:${targetId}:${start}:reopen:${now}`) as { id: number }
    }
    return window.id
  }

  /** windows due for flush: open, window ended (or threshold reached) */
  due(targetId: string, now = Date.now()): WindowRow[] {
    const rows = this.store.db
      .query(
        `SELECT w.id AS id, COUNT(i.id) AS itemCount FROM aggregation_windows w
         LEFT JOIN aggregation_items i ON i.window_id = w.id
         WHERE w.target_id = ? AND w.status = 'open' AND w.window_end * 1000 <= ?
         GROUP BY w.id`,
      )
      .all(targetId, now) as Array<{ id: number; itemCount: number }>
    return rows
  }

  items(windowId: number): Array<{ article_key: string; article_row_id: number; platform: string; payload: any }> {
    const rows = this.store.db
      .query('SELECT article_key, article_row_id, platform, payload FROM aggregation_items WHERE window_id = ? ORDER BY id')
      .all(windowId) as any[]
    for (const row of rows) {
      if (typeof row.payload === 'string') {
        try {
          row.payload = JSON.parse(row.payload)
        } catch {
          row.payload = null
        }
      }
    }
    return rows
  }

  itemCount(windowId: number): number {
    const row = this.store.db.query('SELECT COUNT(*) AS c FROM aggregation_items WHERE window_id = ?').get(windowId) as { c: number }
    return Number(row.c)
  }

  close(windowId: number, status: 'sent' | 'dropped' = 'sent'): void {
    this.store.db
      .query('UPDATE aggregation_windows SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), Date.now(), windowId)
  }
}
