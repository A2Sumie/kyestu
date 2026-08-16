import type { Component } from '../core/types'

export interface ArticleEvent {
  platform: string
  id: number
  a_id: string
  crawlerId: string
}

type Handler = (event: ArticleEvent) => void

/** process-wide article bus: crawlers publish new articles, the router subscribes */
export class Bus {
  private handlers = new Set<Handler>()

  on(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(event: ArticleEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event)
      } catch {
        // consumer faults isolated from publishers
      }
    }
  }
}

export const busComponent: Component = {
  apply: (ctx) => {
    ctx.set('bus', new Bus())
  },
}
