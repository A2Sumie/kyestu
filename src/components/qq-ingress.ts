import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import type { Bus } from './bus'
import { NodeHandle, nodeKey } from '../loader/loader'
import {
  eventScopeKey,
  junkDedupeKey,
  normalizeQqEvent,
  parseMessageField,
  verifyEventSignature,
  type QqInboundEvent,
} from '../pipeline/qq-events'
import { QqInboundStore, recordFromEvent } from '../pipeline/qq-inbound-store'
import { QqMessageStore } from '../pipeline/qq-messages'
import {
  compileRules,
  dispatchActions,
  QqQuotaGate,
  type QqRule,
} from '../pipeline/qq-reactions'
import type { QqTargetApi } from '../types/api'
import type { QqHistorySyncApi } from './qq-history-sync'

/**
 * Inbound QQ event source (`app/qq-ingress`): the receiving counterpart of the
 * OneBot send layer. Owns an HTTP webhook endpoint that SnowLuma / NapCat
 * `httpClients` POST events to (HMAC `X-Signature` over the raw body, or a
 * Bearer token — both compared against the same shared secret), normalizes the
 * payloads (both bridge dialects), dedupes them through the
 * `qq_inbound_events` ledger, mirrors messages into `qq_messages`, publishes
 * the normalized event on the `qq` bus channel, feeds bridge/bot availability
 * signals into the qq-health board, and runs the config-driven reaction rules
 * (pipeline/qq-reactions.ts).
 *
 * Reliability (docs/snowluma.md §9):
 *  - a webhook re-delivery never re-triggers a reaction (ledger unique key);
 *  - events missed during a disconnect window are recovered through
 *    `app/qq-history-sync` backfill (`recover` config): history rows without a
 *    ledger row are replayed as `recovered: true` events;
 *  - rows stuck in `received` / stale `dispatching` (crash mid-dispatch) are
 *    re-dispatched on the next recovery pass; already-sent actions dedupe on
 *    the outbound claim, so a re-run only sends what is missing;
 *  - bad payloads are recorded and skipped (never crash the endpoint).
 */

export interface QqIngressRecoverConfig {
  enabled?: boolean
  /** app/qq-history-sync entry whose scope is backfilled */
  history_sync: string
  /** periodic recovery pass interval (0 = only explicit / POST-triggered) */
  interval_ms?: number
  /** never replay history older than this (default 1h) */
  max_age_ms?: number
  /** replay budget per pass (default 200) */
  max_events?: number
  /** `dispatching` rows older than this are considered crashed (default 5min) */
  stale_dispatch_ms?: number
}

export interface QqIngressConfig {
  port?: number
  /** webhook path (default `/qq/events`) */
  path?: string
  /** shared secret: HMAC key for X-Signature and the Bearer token (required) */
  secret?: string
  rules?: QqRule[]
  /** admin UIN whitelist (`admins_only` rules + the `recall` command) */
  admins?: Array<number | string>
  /** known bot UINs (echo suppression; live events teach their own self_id too) */
  self_ids?: Array<number | string>
  /** react to the bot's own messages / message_sent echoes (default false) */
  include_self_messages?: boolean
  /** target/qq entry used by actions without an explicit `target` */
  default_target?: string
  /** target whose health board receives bot_offline / account notifications */
  health_target?: string
  recover?: QqIngressRecoverConfig
}

export interface QqIngressStats {
  received: number
  duplicates: number
  skipped: number
  bad: number
  recovered: number
  reactions: number
  actionErrors: number
  ledger: Record<string, number>
}

export interface QqIngressApi {
  stats: () => QqIngressStats
  /** run one history-recovery pass on demand */
  recover: () => Promise<{ dispatched: number; backfilled: number }>
}

const DEFAULT_PORT = 3200
const DEFAULT_PATH = '/qq/events'

export const qqIngressComponent: Component<QqIngressConfig & { __id?: string }> = {
  inject: ['db', 'bus'],
  knownWithKeys: [
    'port',
    'path',
    'secret',
    'rules',
    'admins',
    'self_ids',
    'include_self_messages',
    'default_target',
    'health_target',
    'recover',
  ],
  apply: (ctx, config) => {
    const secret = typeof config.secret === 'string' ? config.secret.trim() : ''
    // fail closed (same policy as app/api): an unauthenticated event endpoint
    // would let anyone drive reactions and read the ops view
    if (!secret) {
      throw new Error('qq-ingress: `secret` is empty (webhook HMAC key / bearer token) — refusing to start an unauthenticated event endpoint')
    }
    const rules = compileRules(config.rules ?? [])
    for (const rule of rules) {
      for (const action of rule.actions) {
        if ((action.type === 'reply' || action.type === 'forward' || action.type === 'command') && !action.target && !config.default_target) {
          throw new Error(`qq-ingress: rule '${rule.id}' (${action.type}) has no target and no default_target is configured`)
        }
      }
    }

    const db = ctx.get<KyestuDb>('db')!
    const bus = ctx.get<Bus>('bus')!
    const ledger = new QqInboundStore(db)
    const mirror = new QqMessageStore(db)
    const quota = new QqQuotaGate()
    const admins = (config.admins ?? []).map(Number)
    const selfIds = new Set((config.self_ids ?? []).map(Number))
    const includeSelf = config.include_self_messages === true
    const defaultTarget = config.default_target
    const healthTarget = config.health_target ?? config.default_target
    const path = config.path ?? DEFAULT_PATH
    const recoverCfg = config.recover

    const counters = { received: 0, duplicates: 0, skipped: 0, bad: 0, recovered: 0, reactions: 0, actionErrors: 0 }
    const statsOf = (): QqIngressStats => ({ ...counters, ledger: ledger.stats() })

    // lazy target resolution (same pattern as api.ts hooks): no needs edge, so
    // a target rebuild never cascades into this fiber (J1)
    const resolveTarget = (id?: string): QqTargetApi | undefined => {
      const targetId = id ?? defaultTarget
      if (!targetId) return undefined
      return ctx.get<NodeHandle>(nodeKey(targetId))?.api<QqTargetApi>()
    }

    /** bridge/bot availability signals feed the qq-health send gate */
    const noteHealth = (event: QqInboundEvent): void => {
      const offline =
        (event.kind === 'notice' && event.noticeType === 'bot_offline') ||
        (event.kind === 'notification' && event.noticeSubType === 'offline')
      const online = event.kind === 'notification' && event.noticeSubType === 'online'
      if (!offline && !online) return
      try {
        resolveTarget(healthTarget)?.noteBridgeEvent(online ? 'online' : 'offline', `qq-ingress: ${event.kind}/${event.noticeType ?? event.noticeSubType ?? ''}`)
      } catch (error) {
        ctx.root.reportTaint(ctx.fiber, 'apply', error)
      }
    }

    /** mirror → health → bus → reactions; ends by writing the ledger verdict */
    const process = async (event: QqInboundEvent): Promise<{ quickOperation: Record<string, unknown> | null }> => {
      if (event.selfId !== null) selfIds.add(Number(event.selfId))
      const isSelfEcho =
        event.kind === 'message_sent' ||
        (event.kind === 'message' &&
          event.userId !== null &&
          (event.userId === event.selfId || selfIds.has(Number(event.userId))))
      if (isSelfEcho && !includeSelf) {
        ledger.mark(event.key, 'skipped', 'self echo')
        counters.skipped++
        return { quickOperation: null }
      }

      const scopeKey = eventScopeKey(event)
      if (scopeKey && event.messageId !== null && (event.kind === 'message' || event.kind === 'message_sent')) {
        mirror.insert([
          {
            scope: scopeKey,
            messageId: event.messageId,
            realId: null,
            time: event.time,
            senderId: event.userId,
            messageType: event.scope === 'group' ? 'group' : 'private',
            text: event.text,
            raw: event.raw,
          },
        ])
      }

      noteHealth(event)
      bus.emit('qq', event)

      ledger.mark(event.key, 'dispatching')
      const { results, quickOperation } = await dispatchActions(event, rules, { resolveTarget, defaultTarget, admins }, quota)
      const failed = results.filter((result) => !result.ok)
      counters.reactions += results.filter((result) => result.ok && result.action !== 'quota').length
      counters.actionErrors += failed.length
      for (const failure of failed) {
        ctx.root.reportTaint(ctx.fiber, 'apply', new Error(`qq reaction ${failure.rule}/${failure.action}: ${failure.detail ?? 'failed'}`))
      }
      ledger.mark(
        event.key,
        failed.length ? 'error' : 'ok',
        failed.length ? failed.map((f) => `${f.rule}/${f.action}: ${f.detail ?? ''}`).join('; ').slice(0, 500) : undefined,
      )
      return { quickOperation }
    }

    /** one webhook POST / recovery item */
    const ingest = async (rawBody: string, recovered = false): Promise<{ status: number; body: unknown }> => {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch (error) {
        ledger.record({ key: junkDedupeKey(rawBody), kind: 'bad', raw: rawBody }, 'bad', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
        counters.bad++
        return { status: 400, body: { error: 'invalid JSON' } }
      }
      const event = normalizeQqEvent(parsed)
      if (!event) {
        ledger.record({ key: junkDedupeKey(rawBody), kind: 'bad', raw: parsed }, 'bad', 'unrecognized event payload')
        counters.bad++
        return { status: 400, body: { error: 'unrecognized event payload' } }
      }
      const { inserted } = ledger.record(recordFromEvent(event), 'received')
      if (!inserted) {
        counters.duplicates++
        return { status: 200, body: {} }
      }
      counters.received++
      if (recovered) counters.recovered++
      const { quickOperation } = await process(event)
      return { status: 200, body: quickOperation ?? {} }
    }

    /**
     * History-recovery pass: backfill through app/qq-history-sync, then replay
     * history rows the live channel never delivered (no ledger row) as
     * `recovered: true` events, and re-dispatch rows whose dispatch died.
     */
    const recover = async (): Promise<{ dispatched: number; backfilled: number }> => {
      let dispatched = 0
      let backfilled = 0
      if (recoverCfg?.enabled && recoverCfg.history_sync) {
        const history = ctx.get<NodeHandle>(nodeKey(recoverCfg.history_sync))?.api<QqHistorySyncApi>()
        if (history) {
          const result = await history.sync()
          backfilled = result.inserted + result.backfilled
          const maxAgeMs = Math.max(60_000, Number(recoverCfg.max_age_ms ?? 60 * 60 * 1000))
          const since = Math.floor(Date.now() / 1000) - Math.floor(maxAgeMs / 1000)
          const budget = Math.max(1, Number(recoverCfg.max_events ?? 200))
          for (const row of history.list(since, budget)) {
            if (row.messageId === null || row.messageId === undefined) continue
            if (row.senderId !== null && selfIds.has(Number(row.senderId))) continue
            if (ledger.hasMessage(result.scope, row.messageId)) continue
            const isGroup = result.scope.startsWith('group:')
            const event: QqInboundEvent = {
              key: `msg:${result.scope}:${row.messageId}`,
              kind: 'message',
              scope: isGroup ? 'group' : 'friend',
              groupId: isGroup ? Number(result.scope.slice('group:'.length)) : null,
              userId: row.senderId ?? null,
              selfId: null,
              senderName: null,
              senderRole: null,
              messageId: row.messageId,
              time: row.time,
              text: row.text,
              mentions: parseMessageField((row.raw as any)?.message).mentions,
              noticeType: null,
              noticeSubType: null,
              requestType: null,
              metaEventType: null,
              recovered: true,
              raw: row.raw,
            }
            const { inserted } = ledger.record(recordFromEvent(event), 'received')
            if (!inserted) continue
            counters.received++
            counters.recovered++
            await process(event)
            dispatched++
          }
        }
      }
      const staleBefore = Date.now() - Math.max(1000, Number(recoverCfg?.stale_dispatch_ms ?? 5 * 60 * 1000))
      for (const row of ledger.pending(staleBefore)) {
        const event = row.raw ? normalizeQqEvent(row.raw) : null
        if (!event) {
          ledger.mark(row.dedupeKey, 'bad', 'unparseable stored payload')
          continue
        }
        event.recovered = row.recovered
        await process(event)
        dispatched++
      }
      return { dispatched, backfilled }
    }

    const server = Bun.serve({
      port: config.port ?? DEFAULT_PORT,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== path) return Response.json({ error: 'not found' }, { status: 404 })
        if (req.method === 'GET') {
          // ops view: Bearer only (a GET carries no body to sign)
          if (req.headers.get('authorization') !== `Bearer ${secret}`) {
            return Response.json({ error: 'unauthorized' }, { status: 401 })
          }
          return Response.json(statsOf())
        }
        if (req.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 })
        const rawBody = await req.text()
        // dual auth: SnowLuma httpClients sign the raw body (`X-Signature:
        // sha1=<hmac>`); NapCat / operators may use a plain Bearer token
        const signed = verifyEventSignature(secret, rawBody, req.headers.get('x-signature'))
        const bearer = req.headers.get('authorization') === `Bearer ${secret}`
        if (!signed && !bearer) return Response.json({ error: 'unauthorized' }, { status: 401 })
        try {
          const result = await ingest(rawBody)
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          // handler failures never take the endpoint down (bad events skip)
          ctx.root.reportTaint(ctx.fiber, 'apply', error)
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    })

    if (recoverCfg?.enabled && Number(recoverCfg.interval_ms ?? 0) > 0) {
      const timer = setInterval(() => {
        recover().catch((error) => ctx.root.reportTaint(ctx.fiber, 'apply', error))
      }, Number(recoverCfg.interval_ms))
      ctx.effect(() => () => clearInterval(timer))
    }
    // one recovery pass at boot: an outage that preceded the restart is healed
    // without waiting for the first tick (errors are taints, never fatal)
    if (recoverCfg?.enabled) {
      recover().catch((error) => ctx.root.reportTaint(ctx.fiber, 'apply', error))
    }

    ctx.expose({
      stats: () => statsOf(),
      recover: () => recover(),
    } satisfies QqIngressApi)

    return () => server.stop(true)
  },
}
