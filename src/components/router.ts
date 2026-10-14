import type { Component } from '../core/types'
import type { RouteDef } from '../config/schema'
import type { KyestuDb } from './db'
import { ArticleStore } from '../pipeline/articles'
import { OutboundStore } from '../pipeline/outbound'
import { ServiceStateStore, routerQueueStore } from '../pipeline/service-state'
import { NodeHandle, nodeKey } from '../loader/loader'
import type { Bus, ArticleEvent } from './bus'
import type { FormatterApi, TargetApi } from '../types/api'

/** persistent backing for the pending queue (service_state); memory stays the runtime master copy */
export interface RouterQueueStore {
  load(): ArticleEvent[]
  save(events: ArticleEvent[]): void
}

interface QueuedEvent {
  event: ArticleEvent
  /** in-memory defer count while a matched route target fiber is not up yet */
  defers: number
  /** failed send attempts (bounded redrive); not persisted across restarts */
  attempts: number
  /** earliest ms timestamp the next dispatch attempt may run (backoff) */
  nextAt: number
}

/** ~1 minute at the default 1s sweep; then the event is dropped with a taint */
const MAX_QUEUE_DEFERS = 60

/** default send-redrive budget per article (matches the outbound 5-attempt cap) */
const DEFAULT_MAX_SEND_ATTEMPTS = 5

/** drives crawler -> formatter -> target flows for every new article */
export const routerComponent: Component<{ routes?: RouteDef[]; retry_interval_ms?: number; max_send_attempts?: number; send_backoff_ms?: number }> = {
  inject: ['bus', 'db'],
  knownWithKeys: ['routes', 'retry_interval_ms', 'max_send_attempts', 'send_backoff_ms'],
  apply: (ctx, config) => {
    const bus = ctx.get<Bus>('bus')!
    const db = ctx.get<KyestuDb>('db')!
    const articles = new ArticleStore(db)
    const outbound = new OutboundStore(db)
    const routes = config.routes ?? []
    const queueStore = routerQueueStore(new ServiceStateStore(db), String((config as { __id?: unknown }).__id ?? 'router'))
    const queue: QueuedEvent[] = []
    let draining = false
    // witness discipline (D18 §1): the inverse must truly stop this fiber's
    // side effects. An in-flight drain may outlive the inverse and otherwise
    // persist through a closed db (ghost write past the runtime's generation
    // guard — the raw db handle bypasses it). Skipping post-teardown persists
    // loses nothing: every queue mutation persists synchronously, so the last
    // pre-teardown persist already captured the final state.
    let alive = true

    const persistQueue = (): void => {
      if (alive) queueStore.save(queue.map((item) => item.event))
    }

    /** returns true when a matched target fiber is not up yet (boot/reload window) and the event must stay queued */
    const dispatch = async (event: ArticleEvent): Promise<boolean> => {
      let deferred = false
      for (const route of routes) {
        if (route.from !== event.crawlerId) continue
        const formatterId = route.via?.length ? route.via[route.via.length - 1]! : null
        const formatter = formatterId ? ctx.get<NodeHandle>(nodeKey(formatterId))?.api<FormatterApi>() : null
        for (const targetId of route.to ?? []) {
          if (outbound.forwarded(event.platform as any, event.a_id, targetId)) continue
          const target = ctx.get<NodeHandle>(nodeKey(targetId))?.api<TargetApi>()
          if (!target) {
            deferred = true
            continue
          }
          const article = articles.getWithRefs(event.platform as any, event.id)
          if (!article) continue
          const rendered = formatter
            ? await formatter.render(article)
            : { text: article.content ?? '', media: [] }
          await target.send({ article, rendered, route: { crawler: event.crawlerId, formatter: formatterId, target: targetId } })
        }
      }
      return deferred
    }

    // rehydrate the pending queue after a fiber rebuild / process restart,
    // reconciling against outbound first: an event already delivered to every
    // route target is dropped instead of replayed — the outbound claim is the
    // backstop, not the primary dedup mechanism on the recovery path
    for (const event of queueStore.load()) {
      const undelivered = routes.some(
        (route) =>
          route.from === event.crawlerId &&
          (route.to ?? []).some((targetId) => !outbound.forwarded(event.platform as any, event.a_id, targetId)),
      )
      if (undelivered) queue.push({ event, defers: 0, attempts: 0, nextAt: 0 })
    }
    persistQueue() // reconcile the stored copy with the hydrated one

    const maxSendAttempts = Math.max(1, Number(config.max_send_attempts ?? DEFAULT_MAX_SEND_ATTEMPTS))
    const sendBackoffBase = Math.max(0, Number(config.send_backoff_ms ?? 2000))
    /** exponential backoff for a failed send (base × 2^n, capped at 60s) */
    const sendBackoff = (attempts: number): number => Math.min(sendBackoffBase * 2 ** Math.max(0, attempts - 1), 60_000)
    /** slower backoff for "re-drive later" (claim owned elsewhere / target cooled down) */
    const laterBackoff = (defers: number): number => Math.min(5000 * 2 ** Math.min(defers, 6), 5 * 60 * 1000)

    const drain = async () => {
      if (draining) return
      draining = true
      try {
        // one pass over the current backlog; deferred events rotate to the
        // back so a missing target cannot head-of-line block later events
        let budget = queue.length
        while (budget > 0 && queue.length) {
          budget--
          const item = queue.shift()!
          if (item.nextAt > Date.now()) {
            queue.push(item) // backoff not elapsed yet: rotate, try again next pass
            continue
          }
          let deferred = false
          try {
            deferred = await dispatch(item.event)
          } catch (error) {
            ctx.root.reportTaint(ctx.fiber, 'apply', error)
            // failure redrive (P1-5): a failed send goes back to the queue with
            // backoff instead of being silently dropped. Three exits:
            //  - `retryLater` (claim owned elsewhere / target circuit open):
            //    defer without consuming the send budget, bounded by MAX_QUEUE_DEFERS;
            //  - `redrivable === false` (config/param errors): give up now;
            //  - otherwise: bounded attempts (default 5, matches outbound cap).
            const retryLater = (error as any)?.retryLater === true
            const redrivable = (error as any)?.redrivable !== false
            if (!redrivable) {
              ctx.root.reportTaint(
                ctx.fiber,
                'apply',
                new Error(`router: dropping article ${item.event.platform}:${item.event.a_id}, non-redrivable send failure: ${error instanceof Error ? error.message : String(error)}`),
              )
              persistQueue()
              continue
            }
            if (retryLater) {
              if (item.defers + 1 >= MAX_QUEUE_DEFERS) {
                ctx.root.reportTaint(
                  ctx.fiber,
                  'apply',
                  new Error(`router: dropping article ${item.event.platform}:${item.event.a_id}, target unavailable after ${item.defers + 1} attempts`),
                )
                persistQueue()
                continue
              }
              queue.push({ event: item.event, defers: item.defers + 1, attempts: item.attempts, nextAt: Date.now() + laterBackoff(item.defers) })
              persistQueue()
              continue
            }
            const attempts = item.attempts + 1
            if (attempts >= maxSendAttempts) {
              ctx.root.reportTaint(
                ctx.fiber,
                'apply',
                new Error(`router: dropping article ${item.event.platform}:${item.event.a_id} after ${attempts} send attempts: ${error instanceof Error ? error.message : String(error)}`),
              )
              persistQueue()
              continue
            }
            queue.push({ event: item.event, defers: item.defers, attempts, nextAt: Date.now() + sendBackoff(attempts) })
            persistQueue()
            continue
          }
          if (!deferred) {
            persistQueue()
            continue
          }
          if (item.defers + 1 >= MAX_QUEUE_DEFERS) {
            ctx.root.reportTaint(
              ctx.fiber,
              'apply',
              new Error(`router: dropping article ${item.event.platform}:${item.event.a_id}, target unavailable after ${item.defers + 1} attempts`),
            )
            persistQueue()
            continue
          }
          queue.push({ event: item.event, defers: item.defers + 1, attempts: item.attempts, nextAt: 0 })
          persistQueue()
        }
      } finally {
        draining = false
      }
    }

    const off = bus.on('article', (event) => {
      queue.push({ event, defers: 0, attempts: 0, nextAt: 0 })
      persistQueue()
      void drain()
    })
    // deferred events retry on a sweep so they do not wait for the next crawl
    const sweep = setInterval(() => {
      if (queue.length) void drain()
    }, Math.max(50, config.retry_interval_ms ?? 1000))
    if (queue.length) void drain()
    return () => {
      alive = false
      off()
      clearInterval(sweep)
    }
  },
}
