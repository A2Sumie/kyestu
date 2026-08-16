import type { Component } from '../core/types'
import type { RouteDef } from '../config/schema'
import type { KyestuDb } from './db'
import { ArticleStore } from '../pipeline/articles'
import { OutboundStore } from '../pipeline/outbound'
import { NodeHandle, nodeKey } from '../loader/loader'
import type { Bus, ArticleEvent } from './bus'
import type { FormatterApi } from './formatter'
import type { TargetApi } from './target-qq'

/** drives crawler -> formatter -> target flows for every new article */
export const routerComponent: Component<{ routes?: RouteDef[] }> = {
  inject: ['bus', 'db'],
  apply: (ctx, config) => {
    const bus = ctx.get<Bus>('bus')!
    const db = ctx.get<KyestuDb>('db')!
    const articles = new ArticleStore(db)
    const outbound = new OutboundStore(db)
    const routes = config.routes ?? []
    const queue: ArticleEvent[] = []
    let draining = false

    const dispatch = async (event: ArticleEvent): Promise<void> => {
      for (const route of routes) {
        if (route.from !== event.crawlerId) continue
        const formatterId = route.via?.length ? route.via[route.via.length - 1]! : null
        const formatter = formatterId ? ctx.get<NodeHandle>(nodeKey(formatterId))?.api<FormatterApi>() : null
        for (const targetId of route.to ?? []) {
          if (outbound.forwarded(event.platform as any, event.a_id, targetId)) continue
          const target = ctx.get<NodeHandle>(nodeKey(targetId))?.api<TargetApi>()
          if (!target) continue
          const article = articles.getWithRefs(event.platform as any, event.id)
          if (!article) continue
          const rendered = formatter
            ? await formatter.render(article)
            : { text: article.content ?? '', media: [] }
          await target.send({ article, rendered, route: { crawler: event.crawlerId, formatter: formatterId, target: targetId } })
        }
      }
    }

    const drain = async () => {
      if (draining) return
      draining = true
      try {
        while (queue.length) {
          const event = queue.shift()!
          try {
            await dispatch(event)
          } catch (error) {
            ctx.root.reportTaint(ctx.fiber, 'apply', error)
          }
        }
      } finally {
        draining = false
      }
    }

    const off = bus.on((event) => {
      queue.push(event)
      void drain()
    })
    return off
  },
}
