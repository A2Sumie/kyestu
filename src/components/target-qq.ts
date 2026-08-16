import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { articleKey, outboundKey, OutboundStore } from '../pipeline/outbound'
import { OneBotClient, OneBotNonRetryableError, type OneBotMessageSegment } from './onebot'
import type { RenderedPayload } from './formatter'

export interface SendInput {
  article: { platform: string; a_id: string }
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
    const outbound = new OutboundStore(ctx.get<KyestuDb>('db')!)
    const groupId = config.group_id
    const minInterval = Number(config.min_interval ?? 1000)
    let lastSentAt = 0

    const api: TargetApi = {
      async send({ article, rendered, route }) {
        const key = outboundKey({
          crawler: route.crawler,
          formatter: route.formatter,
          target: String(route.target),
          article: articleKey(article.platform as any, article.a_id),
        })
        const aKey = articleKey(article.platform as any, article.a_id)
        const { id, duplicate } = outbound.claim(
          key,
          { text: rendered.text, media: rendered.media.map((m) => m.path) },
          { route_key: key, target_id: String(route.target), task_kind: 'article', article_key: aKey },
        )
        if (duplicate) return

        const segments: OneBotMessageSegment[] = []
        if (rendered.text) segments.push({ type: 'text', data: { text: rendered.text } })
        for (const media of rendered.media) {
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
          outbound.markForwarded(article.platform as any, article.a_id, String(route.target))
        } catch (error) {
          outbound.mark(id, 'failed', error instanceof Error ? error.message : String(error))
          throw error
        }
      },
    }
    ctx.expose(api)
  },
}
