import type { Component } from '../core/types'
import { Bus, type LiveEvent } from './bus'

/**
 * app/live-player: relay live state to a live-player service (tv.n2nj.moe).
 * Split out of the crawler's live_relay so the player sync is a standalone
 * plugin: crawlers only capture; this component owns the player API surface.
 */

export interface LivePlayerTarget {
  player_id?: string
  player_name?: string
  live_player_url: string
  auth_username?: string
  auth_password?: string
  waf_bypass_header?: string
  sync_interval_seconds?: number
}

export interface LivePlayerConfig {
  targets?: Record<string, LivePlayerTarget>
}

export class LivePlayerClient {
  constructor(private readonly targets: Record<string, LivePlayerTarget>) {}

  async sync(event: LiveEvent): Promise<void> {
    const target = this.targets[event.handle]
    if (!target) return
    const url = `${target.live_player_url.replace(/\/+$/, '')}/api/relay/sync`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (target.auth_username) {
      headers.Authorization = `Basic ${Buffer.from(`${target.auth_username}:${target.auth_password ?? ''}`).toString('base64')}`
    }
    if (target.waf_bypass_header) headers['x-n2nj-pass'] = target.waf_bypass_header
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        player_id: target.player_id,
        player_name: target.player_name,
        handle: event.handle,
        status: event.type,
        ...(event.title ? { title: event.title } : {}),
        ...(event.file ? { file: event.file } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
  }
}

export const livePlayerComponent: Component<LivePlayerConfig> = {
  inject: ['bus'],
  apply: (ctx, config) => {
    const bus = ctx.get<Bus>('bus')!
    const client = new LivePlayerClient(config.targets ?? {})
    ctx.expose(client)
    return bus.on('live', (event) => {
      void client.sync(event)
    })
  },
}
