import { readFileSync } from 'fs'
import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { articleKey, outboundKey, OutboundStore } from '../pipeline/outbound'
import type { SendInput, TargetApi } from './target-qq'

/**
 * Bilibili target v1: text dynamics (scene 1) and photo dynamics (scene 2).
 * Video upload (biliup) is v1.1 — articles with video are skipped with a warning.
 */

const ENDPOINTS = {
  finger: 'https://api.bilibili.com/x/frontend/finger/spi',
  uploadPhoto: 'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs',
  createDynamic: 'https://api.bilibili.com/x/dynamic/feed/create/dyn',
} as const

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

class BiliAuthError extends Error {}
class BiliVelocityError extends Error {}

interface BiliCredentials {
  bili_jct: string
  sessdata: string
  cookies: Record<string, string>
}

function readCredentials(config: Record<string, any>): BiliCredentials {
  const fromConfig = config.sessdata && config.bili_jct ? config : null
  let cookies: Record<string, string> = {}
  if (config.cookie_file) {
    try {
      const doc = JSON.parse(readFileSync(config.cookie_file, 'utf8'))
      for (const c of doc?.cookie_info?.cookies ?? []) {
        if (c?.name && c?.value) cookies[String(c.name)] = String(c.value)
      }
    } catch {
      // missing/unreadable cookie file surfaces as auth failure on first call
    }
  }
  const sessdata = fromConfig?.sessdata ?? cookies.SESSDATA ?? ''
  const biliJct = fromConfig?.bili_jct ?? cookies.bili_jct ?? ''
  return { bili_jct: biliJct, sessdata, cookies: { SESSDATA: sessdata, bili_jct: biliJct, ...cookies } }
}

export class BilibiliClient {
  private readonly creds: BiliCredentials

  constructor(config: Record<string, any>) {
    this.creds = readCredentials(config)
  }

  private cookieHeader(): string {
    return Object.entries(this.creds.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  private async call(url: string, options: RequestInit & { params?: Record<string, string> }): Promise<any> {
    const full = options.params ? `${url}?${new URLSearchParams(options.params)}` : url
    const res = await fetch(full, {
      ...options,
      headers: {
        'User-Agent': UA,
        Referer: 'https://t.bilibili.com',
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...((options.headers as Record<string, string>) ?? {}),
        Cookie: this.cookieHeader(),
      },
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => null)) as any
    const code = data?.code
    if (code === 0) return data?.data
    if (code === -101) throw new BiliAuthError(`bilibili auth failure: ${data?.message}`)
    if (code === -111) throw new BiliVelocityError(`bilibili velocity control: ${data?.message}`)
    throw new Error(`bilibili error code=${code}: ${data?.message ?? res.status}`)
  }

  async uploadPhoto(path: string): Promise<{ img_src: string; img_width: number; img_height: number; img_size: number }> {
    const form = new FormData()
    const buffer = readFileSync(path)
    form.append('file_up', new Blob([buffer]), path.split(/[\\/]/).pop() || 'image.jpg')
    form.append('category', 'daily')
    form.append('csrf', this.creds.bili_jct)
    const data = await this.call(ENDPOINTS.uploadPhoto, { method: 'POST', body: form })
    return {
      img_src: data.image_url,
      img_width: data.image_width,
      img_height: data.image_height,
      img_size: data.img_size ?? buffer.length,
    }
  }

  async createTextDynamic(text: string): Promise<any> {
    return this.call(ENDPOINTS.createDynamic, {
      method: 'POST',
      params: { csrf: this.creds.bili_jct },
      body: JSON.stringify({
        dyn_req: { content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] }, scene: 1 },
      }),
    })
  }

  async createPhotoDynamic(text: string, pics: Array<{ img_src: string; img_width: number; img_height: number; img_size: number }>): Promise<any> {
    return this.call(ENDPOINTS.createDynamic, {
      method: 'POST',
      params: { csrf: this.creds.bili_jct },
      body: JSON.stringify({
        dyn_req: { content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] }, pics, scene: 2 },
      }),
    })
  }
}

export const bilibiliTargetComponent: Component<Record<string, any>> = {
  inject: ['db'],
  apply: (ctx, config) => {
    const outbound = new OutboundStore(ctx.get<KyestuDb>('db')!)
    const client = new BilibiliClient(config)
    const minInterval = Number(config.min_interval ?? 10_000)
    let lastSentAt = 0

    const api: TargetApi = {
      async send({ article, rendered, route }: SendInput) {
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
        try {
          const hasVideo = rendered.media.some((m) => m.type === 'video')
          if (hasVideo) {
            outbound.mark(id, 'skipped', 'video upload is v1.1')
            ctx.root.reportTaint(ctx.fiber, 'apply', new Error(`bilibili target skipped video article ${article.a_id}: video upload lands in v1.1`))
            return
          }
          const wait = minInterval - (Date.now() - lastSentAt)
          if (wait > 0) await Bun.sleep(wait)
          const photos = rendered.media.filter((m) => m.type === 'photo')
          if (photos.length === 0) {
            await client.createTextDynamic(rendered.text)
          } else {
            const pics = []
            for (const photo of photos) {
              try {
                pics.push(await client.uploadPhoto(photo.path))
              } catch (error) {
                if (error instanceof BiliVelocityError) {
                  await Bun.sleep(15_000)
                  pics.push(await client.uploadPhoto(photo.path))
                } else {
                  throw error
                }
              }
            }
            await client.createPhotoDynamic(rendered.text, pics)
          }
          lastSentAt = Date.now()
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
