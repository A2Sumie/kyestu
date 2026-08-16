import { spiderRegistry } from '@kyestu/spider'
import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { ArticleStore } from '../pipeline/articles'
import { CooldownMap, classifyCrawlError, shouldRetry } from '../pipeline/cooldown'
import { nextRunAt, resolveCrawlerSchedule } from '../pipeline/schedule'
import { LiveRelay } from '../pipeline/live-relay'
import { NodeHandle, nodeKey } from '../loader/loader'
import type { Bus } from './bus'
import type { BrowserSessionPool } from './browser-pool'

export interface CrawlResult {
  platform: number
  a_id: string
  u_id: string
  username?: string
  created_at?: number
  content?: string | null
  url: string
  type?: string
  ref?: unknown
  has_media?: boolean
  media?: Array<{ type: string; url: string }> | null
  extra?: unknown
  u_avatar?: string | null
}

export type CrawlDriver = (input: {
  kind: string
  url: string
  config: Record<string, any>
  browser: BrowserSessionPool | null
}) => Promise<CrawlResult[]>

const PLATFORM_NAME: Record<number, string> = {
  1: 'twitter', // Platform.X
  2: 'instagram',
  3: 'tiktok',
  4: 'youtube',
  5: 'website',
}

async function defaultDriver({ url, config, browser }: Parameters<CrawlDriver>[0]): Promise<CrawlResult[]> {
  const plugin = spiderRegistry.findByUrl(url)
  if (!plugin) throw new Error(`no spider registered for ${url}`)
  const spider = plugin.create()
  spider.init?.()
  let page: any
  if (browser && (config.browser_mode || config.device_profile || config.session_profile)) {
    page = await browser.createPage({
      browser_mode: config.browser_mode,
      device_profile: config.device_profile,
      session_profile: config.session_profile,
      extra_headers: config.extra_headers,
      user_agent: config.user_agent,
      locale: config.locale,
      timezone: config.timezone,
    })
  }
  try {
    return (await spider.crawl(url, page, undefined, config)) as unknown as CrawlResult[]
  } finally {
    await page?.close?.().catch(() => null)
  }
}

let testDriver: CrawlDriver | null = null
/** test seam: replace the real spider-backed driver */
export function setCrawlDriverForTest(driver: CrawlDriver | null): void {
  testDriver = driver
}

export type LiveStatusProbe = (url: string) => Promise<{ live: boolean; m3u8?: string; title?: string }>

let testLiveStatusProbe: LiveStatusProbe | null = null
export function setLiveStatusProbeForTest(probe: LiveStatusProbe | null): void {
  testLiveStatusProbe = probe
}

const defaultLiveStatusProbe: LiveStatusProbe = async () => ({ live: false })

function buildUrls(config: Record<string, any>): string[] {
  if (Array.isArray(config.websites) && config.websites.length) return config.websites
  const origin = String(config.origin ?? '').replace(/\/+$/, '')
  const paths: string[] = config.paths ?? []
  return paths.map((p) => `${origin}/${String(p).replace(/^\/+/, '')}`)
}

const DEFAULT_INTERVAL_SECONDS = 5 * 60

export function makeCrawlerComponent(kind: string): Component<Record<string, any>> {
  return {
    inject: ['db', 'bus'],
    apply: (ctx, config) => {
      const db = ctx.get<KyestuDb>('db')!
      const articles = new ArticleStore(db)
      const bus = ctx.get<Bus>('bus')!
      const browser = ctx.get<BrowserSessionPool>('browser') ?? null
      const fiber = ctx.fiber!
      const entryId = String(config.__id)
      const cooldowns = new CooldownMap()
      const platform = kind.replace(/^x-list$/, 'x')
      const processor = (config.__needs as string[] ?? [])
        .map((id) => ctx.get<NodeHandle>(nodeKey(id))?.api<{ process: (text: string) => Promise<string> }>())
        .find((api) => api && typeof api.process === 'function')

      const urls = buildUrls(config)
      const schedule = resolveCrawlerSchedule(config)
      const tickSeconds = schedule?.tickSeconds ?? 15
      let nextAt = 0 // first round fires immediately
      let running = false
      const liveRelay = config.live_relay?.enabled
        ? // capture only; player sync lives in the app/live-player plugin
          new LiveRelay(config.live_relay, undefined, (event) => bus.emit('live', { ...event, crawlerId: entryId }))
        : null
      const liveStatusProbe = liveRelay ? (testLiveStatusProbe ?? defaultLiveStatusProbe) : null

      const persistOne = fiber.wrap(async (raw: CrawlResult): Promise<void> => {
        const platformName = PLATFORM_NAME[raw.platform] ?? platform
        if (articles.exists(platformName as any, raw.a_id)) return
        let translation: string | null = null
        let translatedBy: string | null = null
        if (processor && raw.content) {
          try {
            translation = await processor.process(raw.content)
            translatedBy = 'processor/openai'
          } catch {
            translation = null
          }
        }
        const refs = raw.ref && typeof raw.ref === 'object' ? [raw.ref as any] : undefined
        const id = articles.save({
          platform: platformName as any,
          a_id: raw.a_id,
          u_id: raw.u_id,
          username: raw.username,
          created_at: raw.created_at,
          content: raw.content ?? null,
          translation,
          translated_by: translatedBy,
          url: raw.url,
          type: typeof raw.type === 'string' ? raw.type : 'post',
          ref: null,
          has_media: Boolean(raw.has_media ?? raw.media?.length),
          media: raw.media ?? null,
          extra: raw.extra ?? null,
          u_avatar: raw.u_avatar ?? null,
          ...(refs ? { refs } : {}),
        } as any)
        if (id !== null) bus.emit('article', { platform: platformName, id, a_id: raw.a_id, crawlerId: entryId })
      })

      // production spider-manager waits a random interval_time between target
      // URLs inside one round (risk-control pacing); keep the same math
      const waitTimeMs = (() => {
        const interval = (config as any).interval_time as { min?: number; max?: number } | undefined
        const min = Math.max(0, Number(interval?.min) || 0)
        const max = Math.max(min, Number(interval?.max) || min)
        return max === min ? min : Math.floor(Math.random() * (max - min + 1)) + min
      })()

      const round = async (): Promise<void> => {
        if (running) return
        running = true
        try {
          for (const [index, url] of urls.entries()) {
            if (index > 0 && waitTimeMs > 0) await fiber.wrap(() => Bun.sleep(waitTimeMs))()
            const cooled = cooldowns.check(url)
            if (cooled.cooled) continue
            let lastError: unknown
            let succeeded = false
            for (let attempt = 0; attempt < 2 && !succeeded; attempt++) {
              try {
                const results = await (testDriver ?? defaultDriver)({ kind, url, config, browser })
                for (const raw of results) await persistOne(raw)
                if (liveRelay && liveStatusProbe) {
                  const handle = url.split('/').filter(Boolean).pop() ?? url
                  await liveRelay.sync(handle, await liveStatusProbe(url)).catch(() => null)
                }
                succeeded = true
              } catch (error) {
                lastError = error
                if (!shouldRetry(classifyCrawlError(error), platform)) break
              }
            }
            if (succeeded) cooldowns.succeed(url)
            else {
              cooldowns.recordMessage(url, lastError instanceof Error ? lastError.message : String(lastError))
              cooldowns.hit(url, classifyCrawlError(lastError), platform)
            }
          }
        } finally {
          running = false
        }
      }

      ctx.effect(() => {
        const timer = setInterval(() => {
          const now = Math.floor(Date.now() / 1000)
          if (now < nextAt) return
          nextAt = schedule ? (nextRunAt(schedule, now, entryId) ?? now + DEFAULT_INTERVAL_SECONDS) : now + DEFAULT_INTERVAL_SECONDS
          round().catch((error) => ctx.root.reportTaint(ctx.fiber, 'apply', error))
        }, tickSeconds * 1000)
        round().catch((error) => ctx.root.reportTaint(ctx.fiber, 'apply', error))
        return () => {
          clearInterval(timer)
          void liveRelay?.stopAll()
        }
      })
    },
  }
}
