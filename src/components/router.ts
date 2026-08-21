import type { Component } from '../core/types'
import type { RouteDef } from '../config/schema'
import type { KyestuDb } from './db'
import { ArticleStore } from '../pipeline/articles'
import { OutboundStore } from '../pipeline/outbound'
import { ServiceStateStore, routerQueueStore } from '../pipeline/service-state'
import { NodeHandle, nodeKey } from '../loader/loader'
import type { Bus, ArticleEvent } from './bus'
import type { FormatterApi } from './formatter'
import type { TargetApi } from './target-qq'

/** persistent backing for the pending queue (service_state); memory stays the runtime master copy */
export interface RouterQueueStore {
  load(): ArticleEvent[]
  save(events: ArticleEvent[]): void
}

interface QueuedEvent {
  event: ArticleEvent
  /** in-memory defer count while a matched route target fiber is not up yet */
  defers: number
}

/** ~1 minute at the default 1s sweep; then the event is dropped with a taint */
const MAX_QUEUE_DEFERS = 60

/** drives crawler -> formatter -> target flows for every new article */
export const routerComponent: Component<{ routes?: RouteDef[]; retry_interval_ms?: number }> = {
  inject: ['bus', 'db'],
  apply: (ctx, config) => {
    const bus = ctx.get<Bus>('bus')!
    const db = ctx.get<KyestuDb>('db')!
    const articles = new ArticleStore(db)
    const outbound = new OutboundStore(db)
    const routes = config.routes ?? []
    const queueStore = routerQueueStore(new ServiceStateStore(db), String((config as { __id?: unknown }).__id ?? 'router'))
    const queue: QueuedEvent[] = []
    let draining = false

    const persistQueue = (): void => queueStore.save(queue.map((item) => item.event))

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
      if (undelivered) queue.push({ event, defers: 0 })
    }
    persistQueue() // reconcile the stored copy with the hydrated one

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
          let deferred = false
          try {
            deferred = await dispatch(item.event)
          } catch (error) {
            ctx.root.reportTaint(ctx.fiber, 'apply', error)
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
          queue.push({ event: item.event, defers: item.defers + 1 })
          persistQueue()
        }
      } finally {
        draining = false
      }
    }

    const off = bus.on('article', (event) => {
      queue.push({ event, defers: 0 })
      persistQueue()
      void drain()
    })
    // deferred events retry on a sweep so they do not wait for the next crawl
    const sweep = setInterval(() => {
      if (queue.length) void drain()
    }, Math.max(50, config.retry_interval_ms ?? 1000))
    if (queue.length) void drain()
    return () => {
      off()
      clearInterval(sweep)
    }
  },
}
