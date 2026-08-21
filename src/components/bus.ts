import type { Component } from '../core/types'

export interface ArticleEvent {
  platform: string
  id: number
  a_id: string
  crawlerId: string
}

/** live capture lifecycle, published by crawlers; consumed by app/live-player */
export interface LiveEvent {
  type: 'live' | 'ended'
  handle: string
  crawlerId: string
  title?: string
  file?: string
  m3u8?: string
}

/**
 * Session health events (cookie-keepalive publishes; it also consumes
 * transition->fresh to re-arm quarantined jobs, and logs escalations to the
 * process console). fresh->broken must be observable out-of-band: the 8-17
 * lesson was cookie 409s sitting unseen in a state field for two days.
 * Semantics: docs/bus.md.
 */
export type SessionBusEvent =
  | { kind: 'transition'; key: string; from: string; to: string; detail?: string }
  | { kind: 'expiring'; key: string; minRemainingSeconds: number | null; cookies: number }

interface BusEventMap {
  article: ArticleEvent
  live: LiveEvent
  session: SessionBusEvent
}

/** process-wide event bus: crawlers publish, router / live-player subscribe */
export class Bus {
  private handlers = new Map<string, Set<(event: any) => void>>()

  on<K extends keyof BusEventMap>(channel: K, handler: (event: BusEventMap[K]) => void): () => void {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  emit<K extends keyof BusEventMap>(channel: K, event: BusEventMap[K]): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) {
      try {
        handler(event)
      } catch {
        // consumer faults isolated from publishers
      }
    }
  }
}

export const busComponent: Component = {
  // the bus takes no config at all
  knownWithKeys: [],
  apply: (ctx) => {
    ctx.set('bus', new Bus())
  },
}
