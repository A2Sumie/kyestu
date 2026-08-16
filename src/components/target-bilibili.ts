import { readFileSync } from 'fs'
import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { articleKey, outboundKey, OutboundStore } from '../pipeline/outbound'
import { registerBilibiliRecoveryTarget } from '../pipeline/bilibili-reconcile'
import { TargetRuntime } from '../pipeline/target-runtime'
import { VideoPairings, teaserJoinPlatform } from '../pipeline/pairing'
import { ShortVideoDedup } from '../pipeline/short-video-dedup'
import { uploadVideo } from '../pipeline/biliup'
import type { SendInput, TargetApi } from './target-qq'
import type { RenderedPayload } from './formatter'

/** Bilibili target: text/photo dynamics + video upload (biliup) with X-teaser pairing. */

const ENDPOINTS = {
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
  let cookies: Record<string, string> = {}
  if (config.cookie_file) {
    try {
      const doc = JSON.parse(readFileSync(config.cookie_file, 'utf8'))
      for (const c of doc?.cookie_info?.cookies ?? []) {
        if (c?.name && c?.value) cookies[String(c.name)] = String(c.value)
      }
    } catch {
      // unreadable cookie file surfaces as auth failure on first call
    }
  }
  const sessdata = config.sessdata ?? cookies.SESSDATA ?? ''
  const biliJct = config.bili_jct ?? cookies.bili_jct ?? ''
  return { bili_jct: biliJct, sessdata, cookies: { SESSDATA: sessdata, bili_jct: biliJct, ...cookies } }
}

export class BilibiliClient {
  private readonly creds: BiliCredentials
  private readonly endpoints: Record<keyof typeof ENDPOINTS, string>

  constructor(config: Record<string, any>) {
    this.creds = readCredentials(config)
    // config.endpoints overrides exist so smoke tests / staging can point the
    // client at a mock API instead of api.bilibili.com
    this.endpoints = { ...ENDPOINTS, ...(config.endpoints ?? {}) }
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
    const data = await this.call(this.endpoints.uploadPhoto, { method: 'POST', body: form })
    return {
      img_src: data.image_url,
      img_width: data.image_width,
      img_height: data.image_height,
      img_size: data.img_size ?? buffer.length,
    }
  }

  async createTextDynamic(text: string): Promise<any> {
    return this.call(this.endpoints.createDynamic, {
      method: 'POST',
      params: { csrf: this.creds.bili_jct },
      body: JSON.stringify({ dyn_req: { content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] }, scene: 1 } }),
    })
  }

  async createPhotoDynamic(
    text: string,
    pics: Array<{ img_src: string; img_width: number; img_height: number; img_size: number }>,
  ): Promise<any> {
    return this.call(this.endpoints.createDynamic, {
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
    const db = ctx.get<KyestuDb>('db')!
    const outbound = new OutboundStore(db)
    const client = new BilibiliClient(config)
    const pairings = new VideoPairings(db)
    const pairingCfg = { enabled: config.video_pairing?.enabled === true, ...config.video_pairing }
    const minInterval = Number(config.min_interval ?? 10_000)
    let lastSentAt = 0

    // DB-recovery reconciliation: when a recovery marker exists at boot, seed
    // sent state from the account's actual B站 archives so restored articles
    // are not re-uploaded (idol-bbq bilibili-recovery-reconciliation parity)
    if (config.video_upload?.enabled && config.reconcile_on_recovery !== false) {
      registerBilibiliRecoveryTarget(db, {
        id: String(config.__id ?? 'bilibili'),
        cookie_file: config.video_upload?.cookie_file ?? config.cookie_file,
        sessdata: config.sessdata,
        bili_jct: config.bili_jct,
      })
    }

    // FC media suppression (idol-bbq parity): only the configured FC areas
    // (photo/movie/radio) drop media; public official-site feeds never match the
    // members-only text heuristic because they legitimately announce FC updates.
    const SUPPRESS_MEMBERS_ONLY_RE =
      /会员限定|会員限定|メンバー限定|メン限|メンシプ|members?[-\s]?only|subscribers?[-\s]?only/i
    const suppressedUids = new Set(
      (Array.isArray(config.suppress_media_uids) ? config.suppress_media_uids : []).map((v: unknown) =>
        String(v).trim(),
      ),
    )
    const mediaCountSuffix = (media: RenderedPayload['media']): string => {
      const photos = media.filter((m) => m.type === 'photo').length
      const videos = media.length - photos
      const parts: string[] = []
      if (photos > 0) parts.push(`${photos} 张图片`)
      if (videos > 0) parts.push(`${videos} 个视频`)
      return parts.length ? `，已过滤 ${parts.join('、')}` : ''
    }
    const suppressionNotice = (input: SendInput): string | null => {
      const article = input.article
      const uId = String(article.u_id ?? '')
      if (uId && suppressedUids.has(uId)) {
        return `FC ${uId.split(':').pop() || uId} 内容`
      }
      if (!config.suppress_members_only_media) return null
      if ((article.extra as any)?.data?.members_only === true) return '会员限定内容'
      if (article.platform === 'website') return null
      const haystack = [article.content ?? '', article.translation ?? ''].join('\n')
      return SUPPRESS_MEMBERS_ONLY_RE.test(haystack) ? '会员限定内容' : null
    }

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
      try {
        const wait = minInterval - (Date.now() - lastSentAt)
        if (wait > 0) await Bun.sleep(wait)
        const photos = input.rendered.media.filter((m) => m.type === 'photo')
        if (photos.length === 0) {
          await client.createTextDynamic(text)
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
          await client.createPhotoDynamic(text, pics)
        }
        lastSentAt = Date.now()
        outbound.mark(id, 'sent')
      } catch (error) {
        outbound.mark(id, 'failed', error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    const runtime = new TargetRuntime(ctx, db, String(config.__id), config, rawSend)

    const sendVideo = async (input: SendInput): Promise<void> => {
      const article = input.article as any
      const joinPlatform = teaserJoinPlatform(article.content, pairingCfg.join_platforms ?? ['tiktok', 'instagram'])
      if (article.platform === 'twitter' && pairingCfg.enabled && joinPlatform) {
        pairings.hold(String(config.__id), article, input.rendered.media.filter((m) => m.type === 'video'), joinPlatform, pairingCfg)
        return // held: waiting for the main-platform video
      }
      const videoPaths = input.rendered.media.filter((m) => m.type === 'video').map((m) => m.path)
      if (!videoPaths.length) return
      let parts = videoPaths
      let pairingKey: string | null = null
      if (pairingCfg.enabled && (article.platform === 'tiktok' || article.platform === 'instagram')) {
        const pending = pairings.findPending(String(config.__id), article.platform, article.u_id)
        if (pending) {
          pairingKey = pending.pairing_key
          const teaserPaths = (pending.teaser_media ?? []).map((m: any) => m.path).filter(Boolean)
          parts = [...teaserPaths, ...videoPaths]
        }
      }
      const cover = input.rendered.media.find((m) => m.type === 'photo')?.path
      // cross-platform short-video dedup: claim-before-upload (idol-bbq's
      // check-then-mark-after-upload raced simultaneous IG/TT arrivals)
      const dedup = new ShortVideoDedup(db)
      const duplicate =
        config.video_upload?.dedup === false
          ? null
          : dedup.checkOrClaim({
              platform: article.platform,
              a_id: article.a_id,
              u_id: article.u_id,
              content: article.content,
              translation: (article as any).translation,
              created_at: article.created_at,
              type: article.type,
            })
      if (duplicate) return // same short video already uploaded from another platform
      const result = await uploadVideo(
        {
          cookie_file: config.video_upload?.cookie_file ?? config.cookie_file,
          sessdata: config.sessdata,
          bili_jct: config.bili_jct,
          tid: config.video_upload?.tid,
          tags: config.video_upload?.tags,
          title_template: config.video_upload?.title_template,
          desc_template: config.video_upload?.desc_template,
          timezone: config.video_upload?.timezone ?? config.timezone,
          python_path: config.video_upload?.python_path,
          helper_path: config.video_upload?.helper_path,
        },
        { videoPaths: parts, coverPath: cover, article },
      )
      if (pairingKey) pairings.mark(pairingKey, 'merged', result)
    }

    ctx.effect(() => runtime.startFlushLoop())
    ctx.expose({
      send: async (input: SendInput) => {
        const notice = suppressionNotice(input)
        if (notice) {
          // text-only: media is dropped with an explicit filtered-count notice
          const text = `【媒体未转载：${notice}${mediaCountSuffix(input.rendered.media)}】\n${input.rendered.text}`
          await runtime.send({ ...input, rendered: { text, media: [] } })
          outbound.markForwarded(input.article.platform as any, input.article.a_id, String(input.route.target))
          return
        }
        const hasVideo = input.rendered.media.some((m) => m.type === 'video')
        if (hasVideo) {
          await sendVideo(input)
        } else {
          await runtime.send(input)
        }
        outbound.markForwarded(input.article.platform as any, input.article.a_id, String(input.route.target))
      },
    } satisfies TargetApi)
  },
}
