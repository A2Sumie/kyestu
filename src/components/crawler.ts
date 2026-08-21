import { spiderRegistry, probeTikTokLiveStatus, parseNetscapeCookieToPuppeteerCookie, getCookieString } from '@kyestu/spider'
import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { ArticleStore } from '../pipeline/articles'
import { CooldownMap, classifyCrawlError, shouldRetry } from '../pipeline/cooldown'
import { ServiceStateStore, cooldownStore } from '../pipeline/service-state'
import { nextRunAt, resolveCrawlerSchedule } from '../pipeline/schedule'
import { LiveRelay } from '../pipeline/live-relay'
import { tiktokLivePagePacer } from '../pipeline/host-pacer'
import { expandPath } from './cookie-keepalive'
import { NodeHandle, nodeKey } from '../loader/loader'
import type { Bus } from './bus'
import type { BrowserSessionPool } from './browser-pool'
import type { SessionHealthBoard } from '../pipeline/session-health'
import type { ProcessorApi } from '../types/api'

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

/**
 * Platform-aware live status probe. Only TikTok has a real implementation
 * (chain B: /@handle/live hydration JSON, sa7 e2e); every other platform
 * keeps the stub behaviour. The TikTok probe goes through the process-wide
 * per-host pacer (WAF threshold: live-page hydration <= 1 req / 8s, sa7 §4)
 * and resolves credentials the same way the spider does: explicit
 * cookieString wins, else the Netscape jar named by cookie_file (re-read per
 * probe so cookie-keepalive jar rotations are picked up).
 */
function buildLiveStatusProbe(platform: string, config: Record<string, any>, entryId: string): LiveStatusProbe {
  if (platform !== 'tiktok') return defaultLiveStatusProbe
  const resolveCookie = (): string | undefined => {
    if (typeof config.cookieString === 'string' && config.cookieString.trim()) return config.cookieString
    if (typeof config.cookie_file !== 'string' || !config.cookie_file) return undefined
    try {
      return getCookieString(parseNetscapeCookieToPuppeteerCookie(expandPath(config.cookie_file)))
    } catch {
      return undefined
    }
  }
  return async (url) => {
    const handle = url.match(/@([A-Za-z0-9._]+)/)?.[1]
    if (!handle) {
      console.warn(`[crawler:${entryId}] tiktok live probe: cannot derive handle from ${url}`)
      return { live: false }
    }
    await tiktokLivePagePacer.waitTurn('www.tiktok.com')
    const result = await probeTikTokLiveStatus(handle, { cookieString: resolveCookie() })
    if (!result.live && result.reason) {
      console.warn(`[crawler:${entryId}] tiktok live probe @${handle}: ${result.reason}`)
    }
    return { live: result.live, m3u8: result.m3u8, title: result.title }
  }
}

function buildUrls(config: Record<string, any>): string[] {
  if (Array.isArray(config.websites) && config.websites.length) return config.websites
  const origin = String(config.origin ?? '').replace(/\/+$/, '')
  const paths: string[] = config.paths ?? []
  return paths.map((p) => `${origin}/${String(p).replace(/^\/+/, '')}`)
}

const DEFAULT_INTERVAL_SECONDS = 5 * 60

/**
 * `with` keys this component consumes. Includes the spider pass-through
 * surface: the whole config is forwarded to `spider.crawl()` (defaultDriver),
 * so spider-level keys are legitimate here even though this file never reads
 * them. The scheduling keys are consumed by pipeline/schedule.
 */
const CRAWLER_KNOWN_WITH_KEYS = [
  // target selection / scheduling (this component + pipeline/schedule)
  'websites', 'origin', 'paths', 'schedule', 'hot_schedule', 'cron', 'timezone',
  // session / browser routing
  'cookie_file', 'session_profile', 'browser_mode', 'device_profile',
  'extra_headers', 'user_agent', 'locale', 'viewport',
  // processing hooks
  'post_processors', 'live_relay', 'interval_time',
  // spider pass-through (read inside @kyestu/spider's crawl)
  'task_type', 'sub_task_type', 'crawl_engine', 'cookieString', 'requestHeaders',
  'feed', 'label', 'u_id', 'timeout', 'wantHighlights', 'highlightsTimeoutMs',
  'max_list_pages', 'max_detail_count', 'detail_interval_time', 'block_resource_types',
  'hydrate_users', 'hydrate_limit', 'hydrate_concurrency', 'hydrate_interval_time',
  'isArticleKnown', 'articleStateLookup', 'articlePrefixStateLookup', 'isStoredPremierePending',
]

export function makeCrawlerComponent(kind: string): Component<Record<string, any>> {
  return {
    knownWithKeys: CRAWLER_KNOWN_WITH_KEYS,
    // 'cookie-health' is deliberately NOT a declared coeffect here: session
    // gating is opt-in per config (BRIEF 2c "no session_profile/cookie_file
    // → does not participate"), and legacy configs without a cookie-keepalive
    // entry must keep crawling (compat §3). Declaring it would park every
    // crawler INACTIVE the moment keepalive is absent — main.ts INFRA_
    // DEFAULTS does not include keepalive. The board is read per round
    // instead (ctx.get), which also means a keepalive reload (new board
    // generation) is picked up without reloading this fiber.
    inject: ['db', 'bus'],
    apply: (ctx, config) => {
      const db = ctx.get<KyestuDb>('db')!
      const articles = new ArticleStore(db)
      const bus = ctx.get<Bus>('bus')!
      const browser = ctx.get<BrowserSessionPool>('browser') ?? null
      const fiber = ctx.fiber!
      const entryId = String(config.__id)
      // cooldowns persist to service_state scoped by entry id: per-target
      // isolation (full-url keys) carries across rebuilds/restarts, and an
      // expired cooldown never revives (absolute expiry, compared at load)
      const cooldowns = new CooldownMap({ store: cooldownStore(new ServiceStateStore(db), entryId) })
      const platform = kind.replace(/^x-list$/, 'x')
      // session-health feedback key (2c): the crawler participates in the
      // keepalive loop only when its config names a session or a jar; the
      // board is resolved per round so absence (no keepalive entry) and
      // reload (new board generation) are both handled without lifecycle
      // coupling.
      const sessionKey = String(config.session_profile ?? config.cookie_file ?? '')
      const boardOf = () => (sessionKey ? ctx.get<SessionHealthBoard>('cookie-health') ?? null : null)
      const processor = (config.__needs as string[] ?? [])
        .map((id) => ctx.get<NodeHandle>(nodeKey(id))?.api<ProcessorApi>())
        .find((api) => api && typeof api.process === 'function')
      // post_processors (production: per-article extract/plan runs, e.g. the
      // showroom/event-time extractor) resolve lazily at crawl time — they are
      // not route edges, so they cannot be read at apply time
      const postProcessors: Array<{ processor_id: string; action?: string; min_confidence?: number }> =
        Array.isArray(config.post_processors) ? config.post_processors : []

      const urls = buildUrls(config)
      const schedule = resolveCrawlerSchedule(config)
      const tickSeconds = schedule?.tickSeconds ?? 15
      let nextAt = 0 // first round fires immediately
      let running = false
      const liveRelay = config.live_relay?.enabled
        ? // capture only; player sync lives in the app/live-player plugin
          new LiveRelay(config.live_relay, undefined, (event) => bus.emit('live', { ...event, crawlerId: entryId }))
        : null
      const liveStatusProbe = liveRelay ? (testLiveStatusProbe ?? buildLiveStatusProbe(platform, config, entryId)) : null

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
        if (id !== null) {
          bus.emit('article', { platform: platformName, id, a_id: raw.a_id, crawlerId: entryId })
          for (const pp of postProcessors) {
            const api = ctx.get<NodeHandle>(nodeKey(String(pp.processor_id)))?.api<ProcessorApi>()
            if (!api || typeof api.process !== 'function') continue
            await api
              .process(raw.content ?? '', { sourceRef: raw.a_id, minConfidence: pp.min_confidence })
              .catch(() => null)
          }
        }
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
        const board = boardOf()
        try {
          // session-health gate (§6.1 withholding): a quarantined session is
          // not touched at all — one log line per round, no requests
          let guardLogged = false
          for (const [index, url] of urls.entries()) {
            if (index > 0 && waitTimeMs > 0) await fiber.wrap(() => Bun.sleep(waitTimeMs))()
            if (board && sessionKey) {
              const verdict = board.guard(sessionKey)
              if (verdict.blocked) {
                if (!guardLogged) {
                  console.warn(`[crawler:${entryId}] session '${sessionKey}' ${verdict.reason} — skipping this round`)
                  guardLogged = true
                }
                continue
              }
            }
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
            if (succeeded) {
              cooldowns.succeed(url)
              board?.record(sessionKey, true)
            } else {
              cooldowns.recordMessage(url, lastError instanceof Error ? lastError.message : String(lastError))
              cooldowns.hit(url, classifyCrawlError(lastError), platform)
              // auth-class failure = the session itself is suspect: feed the
              // board so keepalive escalates suspect -> broken -> quarantined
              if (board && sessionKey && classifyCrawlError(lastError) === 'auth') {
                board.record(sessionKey, false, lastError)
              }
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
