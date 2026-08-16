import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { articleKey, outboundKey, OutboundStore } from '../pipeline/outbound'
import { OneBotClient, OneBotNonRetryableError, type OneBotMessageSegment } from './onebot'
import { TargetRuntime } from '../pipeline/target-runtime'
import type { RenderedPayload } from './formatter'

export interface SendInput {
  article: { platform: string; a_id: string; id?: number; created_at?: number; content?: string | null }
  rendered: RenderedPayload
  route: { crawler: string; formatter?: string | null; target: string }
}

export interface TargetApi {
  send: (input: SendInput) => Promise<void>
}

const CHUNK = 10

export const qqTargetComponent: Component<Record<string, any>> = {
  inject: ['onebot', 'db'],
  apply: (ctx, config) => {
    const client = ctx.get<OneBotClient>('onebot')!
    const db = ctx.get<KyestuDb>('db')!
    const outbound = new OutboundStore(db)
    const groupId = config.group_id
    const minInterval = Number(config.min_interval ?? 1000)
    let lastSentAt = 0

    const rawSend = async (input: SendInput, text: string): Promise<void> => {
      const aKey = articleKey(input.article.platform as any, input.article.a_id)
      const key = outboundKey({
        crawler: input.route.crawler,
        formatter: input.route.formatter,
        target: String(input.route.target),
        article: aKey,
      })
      const { id, duplicate } = outbound.claim(
        key,
        { text, media: input.rendered.media.map((m) => m.path) },
        { route_key: key, target_id: String(input.route.target), task_kind: 'article', article_key: aKey },
      )
      if (duplicate) return

      const segments: OneBotMessageSegment[] = []
      if (text) segments.push({ type: 'text', data: { text } })
      for (const media of input.rendered.media) {
        segments.push({ type: media.type === 'video' ? 'video' : 'image', data: { file: `file://${media.path}` } })
      }
      if (segments.length === 0) {
        outbound.mark(id, 'skipped', 'empty payload')
        return
      }

      try {
        for (let i = 0; i < segments.length; i += CHUNK) {
          const chunk = segments.slice(i, i + CHUNK)
          const wait = minInterval - (Date.now() - lastSentAt)
          if (wait > 0) await Bun.sleep(wait)
          let lastError: unknown
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await client.sendGroupMsg(groupId, chunk)
              lastError = null
              break
            } catch (error) {
              lastError = error
              if (error instanceof OneBotNonRetryableError) throw error
            }
          }
          if (lastError) throw lastError
          lastSentAt = Date.now()
        }
        outbound.mark(id, 'sent')
      } catch (error) {
        outbound.mark(id, 'failed', error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    const runtime = new TargetRuntime(ctx, db, String(config.__id), config, rawSend)
    ctx.effect(() => runtime.startFlushLoop())
    ctx.expose({
      send: async (input: SendInput) => {
        await runtime.send(input)
        outbound.markForwarded(input.article.platform as any, input.article.a_id, String(input.route.target))
      },
    } satisfies TargetApi)
  },
}
