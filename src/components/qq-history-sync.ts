import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { OneBotClient, OneBotRetryLaterError } from './onebot'
import { NodeHandle, nodeKey } from '../loader/loader'
import { ServiceStateStore } from '../pipeline/service-state'
import { QqMessageStore, normalizeHistoryMessage, type QqMessageRow } from '../pipeline/qq-messages'
import type { OneBotDialect } from '../pipeline/onebot-semantics'

/**
 * History backfill (SnowLuma message-store): mirrors `get_group_msg_history` /
 * `get_friend_msg_history` into the local `qq_messages` table and heals gaps
 * left by disconnects / failed send windows.
 *
 * Semantics:
 *  - latest page first (anchor = 0 → newest), then anchor paging backwards
 *    (`reverse_order: true` → anchor and older) whenever a gap is detected
 *    between the cursor (last synced message time) and the newest message;
 *  - rows are deduped by (scope, message_id) — page overlap is harmless;
 *  - the cursor persists in service_state (`qq-history:<entry>:cursor`), so a
 *    fiber rebuild / restart resumes instead of re-pulling everything;
 *  - runs are bounded (count × max_pages per sync).
 *
 * This is a *mirror* for dedup/receipt reconciliation. kyestu consumes no
 * inbound QQ messages (docs/bus.md: the bus carries article pointers into the
 * article pipeline), so mirrored history is deliberately NOT fabricated into
 * articles/bus events — see docs/snowluma.md for the rationale.
 */

export interface QqHistorySyncConfig {
  group_id?: number | string
  friend_id?: number | string
  /** infra/onebot entry id (multi-UIN); defaults to the shared `onebot` key */
  onebot?: string
  /** poll interval; 0 disables the timer (manual `sync()` only) */
  interval_ms?: number
  /** messages per page (SnowLuma default 20) */
  count?: number
  /** gap threshold; defaults to 2× interval (min 60s) */
  gap_ms?: number
  /** anchor pages walked per backfill (bounds one run) */
  max_pages?: number
}

export interface QqHistorySyncApi {
  sync: () => Promise<{ inserted: number; backfilled: number; scope: string }>
  list: (since?: number, limit?: number) => QqMessageRow[]
  cursor: () => number
}

export const qqHistorySyncComponent: Component<QqHistorySyncConfig & { __id?: string }> = {
  inject: ['onebot', 'db'],
  knownWithKeys: ['group_id', 'friend_id', 'onebot', 'interval_ms', 'count', 'gap_ms', 'max_pages'],
  apply: (ctx, config) => {
    const db = ctx.get<KyestuDb>('db')!
    const client =
      (typeof config.onebot === 'string' ? ctx.get<NodeHandle>(nodeKey(config.onebot))?.api<OneBotClient>() : undefined) ??
      ctx.get<OneBotClient>('onebot')!
    const groupId = config.group_id
    const friendId = config.friend_id
    if (groupId === undefined && friendId === undefined) {
      throw new Error('qq-history-sync: one of group_id / friend_id is required')
    }
    const scope = groupId !== undefined ? `group:${groupId}` : `friend:${friendId}`
    const store = new QqMessageStore(db)
    const kv = new ServiceStateStore(db)
    const cursorKey = `qq-history:${String(config.__id ?? 'qq-history-sync')}:cursor`
    const intervalMs = Number(config.interval_ms ?? 5 * 60 * 1000)
    const count = Math.max(1, Number(config.count ?? 20))
    const gapMs = Math.max(60_000, Number(config.gap_ms ?? intervalMs * 2))
    const maxPages = Math.max(1, Number(config.max_pages ?? 20))

    const loadCursor = (): number => Number(kv.get(cursorKey) ?? 0) || 0

    const fetchPage = async (anchor: number): Promise<any[]> => {
      const res: any =
        groupId !== undefined
          ? await client.getGroupMsgHistory(groupId, anchor, count, true)
          : await client.getFriendMsgHistory(friendId!, anchor, count, true)
      const messages = res?.messages
      return Array.isArray(messages) ? messages : []
    }

    const normalize = (messages: any[]): QqMessageRow[] =>
      messages
        .map(normalizeHistoryMessage)
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .map((row) => ({
          scope,
          messageId: row.messageId,
          realId: row.realId,
          time: row.time,
          senderId: row.senderId,
          messageType: row.messageType,
          text: row.text,
          raw: row.raw,
        }))

    let running = false
    const sync = async (): Promise<{ inserted: number; backfilled: number; scope: string }> => {
      if (running) return { inserted: 0, backfilled: 0, scope }
      running = true
      try {
        const cursor = loadCursor()
        const latest = normalize(await fetchPage(0))
        const inserted = store.insert(latest)
        let backfilled = 0

        // gap healing: page backwards from the newest page's oldest message
        // until the cursor time is reached (or the run budget is spent)
        const newestTime = latest.reduce((max, row) => Math.max(max, row.time), 0)
        const oldest = latest.length ? latest.reduce((min, row) => (row.time < min.time ? row : min), latest[0]!) : null
        if (cursor > 0 && newestTime > 0 && oldest && oldest.time > cursor) {
          let anchor = oldest.messageId
          for (let page = 0; page < maxPages && anchor !== null; page++) {
            const older = normalize(await fetchPage(anchor))
            if (older.length === 0) break
            backfilled += store.insert(older)
            const oldestInPage = older.reduce((min, row) => (row.time < min.time ? row : min), older[0]!)
            if (oldestInPage.time <= cursor) break
            // anchor paging includes the anchor message; stop when no progress
            const nextAnchor = oldestInPage.messageId
            if (nextAnchor === anchor) break
            anchor = nextAnchor
          }
        }

        const newCursor = Math.max(cursor, store.latestTime(scope) ?? 0)
        if (newCursor > cursor) kv.set(cursorKey, String(newCursor))
        return { inserted, backfilled, scope }
      } finally {
        running = false
      }
    }

    let timer: ReturnType<typeof setInterval> | null = null
    if (intervalMs > 0) {
      timer = setInterval(() => {
        sync().catch((error) => {
          if (!(error instanceof OneBotRetryLaterError)) ctx.root.reportTaint(ctx.fiber, 'apply', error)
        })
      }, intervalMs)
    }
    // initial sync: an error is a taint (bridge may be down at boot), never fatal
    sync().catch((error) => ctx.root.reportTaint(ctx.fiber, 'apply', error))

    ctx.expose({
      sync,
      list: (since?: number, limit?: number) => store.list(scope, since ?? 0, limit ?? 500),
      cursor: () => loadCursor(),
    } satisfies QqHistorySyncApi)

    return () => {
      if (timer) clearInterval(timer)
    }
  },
}

/** dialect re-export for docs/tests that probe capabilities alongside history */
export type { OneBotDialect }
