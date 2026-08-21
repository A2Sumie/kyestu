import path from 'path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { existsSync, mkdirSync } from 'fs'
import { Browser as CfTBrowser, computeExecutablePath, detectBrowserPlatform, install } from '@puppeteer/browsers'
import {
  applyBrowserProfile,
  resolveBrowserProfile,
  type BrowserMode,
  type BrowserProfileConfig,
  type DeviceProfile,
  type ProfileViewport,
} from '@kyestu/spider'
import type { Component } from '../core/types'

export interface BrowserPageRequest {
  browser_mode?: BrowserMode
  device_profile?: DeviceProfile
  session_profile?: string
  extra_headers?: Record<string, string>
  viewport?: Partial<ProfileViewport>
  user_agent?: string
  locale?: string
  timezone?: string
}

interface BrowserRuntimeSession {
  browser: Browser
  mode: BrowserMode
  sessionId: string
  userDataDir: string
}

const CREATE_PAGE_MAX_ATTEMPTS = 2
const BROWSER_CLOSE_TIMEOUT_MS = 5_000
const EVICTION_BACKOFF_MS = 30_000
// Chrome-for-Testing build used when the host has no system Chrome; matches
// the pinned CHROME_VERSION in idol-bbq's production Dockerfile.
const CHROME_FALLBACK_BUILD_ID = '142.0.7444.175'

function sanitizeSessionId(value?: string) {
  return (value || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
}

type LaunchFn = (browserMode: BrowserMode, userDataDir: string, profile: BrowserProfileConfig) => Promise<Browser>

export interface BrowserSessionPoolOptions {
  cacheRoot?: string
  /** test seam: replace puppeteer.launch */
  launcher?: LaunchFn
  /** test seam: skip the post-eviction relaunch backoff */
  skipBackoff?: boolean
}

/** Downloads the pinned Chrome-for-Testing build into the cache once per process. */
async function ensureFallbackChrome(cacheRoot: string): Promise<string> {
  const platform = detectBrowserPlatform()
  if (!platform) throw new Error('cannot auto-provision Chrome: unsupported platform')
  const cacheDir = path.join(cacheRoot, 'chrome')
  mkdirSync(cacheDir, { recursive: true })
  const executablePath = computeExecutablePath({
    browser: CfTBrowser.CHROME,
    buildId: CHROME_FALLBACK_BUILD_ID,
    cacheDir,
    platform,
  })
  if (existsSync(executablePath)) return executablePath
  const installed = await install({
    browser: CfTBrowser.CHROME,
    buildId: CHROME_FALLBACK_BUILD_ID,
    cacheDir,
    platform,
  })
  return installed.executablePath
}

/**
 * Pooled Chrome sessions keyed by `sessionProfile:browserMode`.
 * Ported from idol-bbq browser-session-pool with the same semantics:
 * in-flight launch dedup, dead-handle eviction with backoff, close with SIGKILL fallback.
 */
export class BrowserSessionPool {
  private readonly sessions = new Map<string, BrowserRuntimeSession>()
  private readonly pendingLaunches = new Map<string, Promise<BrowserRuntimeSession>>()
  private readonly evictionBackoff = new Map<string, number>()
  private readonly browserRoot: string
  private readonly launcher?: LaunchFn
  private readonly skipBackoff: boolean
  private closing = false

  constructor(options: BrowserSessionPoolOptions = {}) {
    this.browserRoot = path.join(options.cacheRoot ?? 'cache', 'browser')
    this.launcher = options.launcher
    this.skipBackoff = options.skipBackoff ?? false
    mkdirSync(this.browserRoot, { recursive: true })
  }

  get size(): number {
    return this.sessions.size
  }

  async createPage(request: BrowserPageRequest = {}): Promise<Page> {
    if (this.closing) throw new Error('Browser session pool is closing')
    const resolvedProfile = resolveBrowserProfile(request.device_profile, {
      extraHeaders: request.extra_headers,
      locale: request.locale,
      timezone: request.timezone,
      userAgent: request.user_agent,
      viewport: request.viewport,
    })
    const defaultBrowserMode: BrowserMode =
      process.env.DISPLAY || process.env.ENABLE_XVFB === '1' ? 'headed-xvfb' : 'headless'
    let browserMode = request.browser_mode || ((process.env.BROWSER_MODE as BrowserMode | undefined) ?? defaultBrowserMode)
    // never pop a foreground Chrome on a macOS dev host: headed modes require Xvfb
    if (process.platform === 'darwin' && process.env.ENABLE_XVFB !== '1' && browserMode !== 'headless') {
      browserMode = 'headless'
    }
    const sessionId = sanitizeSessionId(request.session_profile || request.device_profile || 'default')
    const sessionKey = `${sessionId}:${browserMode}`

    let lastError: unknown
    for (let attempt = 1; attempt <= CREATE_PAGE_MAX_ATTEMPTS; attempt += 1) {
      const session = await this.getOrCreateSession(sessionKey, sessionId, browserMode, resolvedProfile)
      let page: Page
      try {
        page = await session.browser.newPage()
      } catch (error) {
        lastError = error
        if (this.isSessionAlive(session) && !this.isBrowserConnectionError(error)) throw error
        await this.evictSession(sessionKey, session)
        continue
      }
      try {
        await applyBrowserProfile(page, resolvedProfile.deviceProfile, {
          userAgent: resolvedProfile.userAgent,
          viewport: resolvedProfile.viewport,
          extraHeaders: resolvedProfile.extraHeaders,
          locale: resolvedProfile.locale,
          timezone: resolvedProfile.timezone,
        })
      } catch (error) {
        await page.close().catch(() => null)
        throw error
      }
      return page
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to create browser page: ${String(lastError)}`)
  }

  async closeAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pendingLaunches.values()])
    await Promise.all([...this.sessions.values()].map((session) => this.closeBrowser(session)))
    this.sessions.clear()
  }

  private async getOrCreateSession(
    sessionKey: string,
    sessionId: string,
    browserMode: BrowserMode,
    profile: BrowserProfileConfig,
  ): Promise<BrowserRuntimeSession> {
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      if (this.isSessionAlive(existing)) return existing
      await this.evictSession(sessionKey, existing)
    }
    const inFlight = this.pendingLaunches.get(sessionKey)
    if (inFlight) return await inFlight
    const replacement = this.sessions.get(sessionKey)
    if (replacement && this.isSessionAlive(replacement)) return replacement

    const backoffUntil = this.evictionBackoff.get(sessionKey)
    if (!this.skipBackoff && backoffUntil && backoffUntil > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoffUntil - Date.now(), EVICTION_BACKOFF_MS)))
    }

    const launchPromise = this.launchSession(sessionKey, sessionId, browserMode, profile).finally(() => {
      if (this.pendingLaunches.get(sessionKey) === launchPromise) this.pendingLaunches.delete(sessionKey)
    })
    this.pendingLaunches.set(sessionKey, launchPromise)
    return await launchPromise
  }

  private async launchSession(
    sessionKey: string,
    sessionId: string,
    browserMode: BrowserMode,
    profile: BrowserProfileConfig,
  ): Promise<BrowserRuntimeSession> {
    const userDataDir = path.join(this.browserRoot, `${sessionId}-${browserMode}`)
    mkdirSync(userDataDir, { recursive: true })
    const browser = await (this.launcher ?? this.defaultLauncher)(browserMode, userDataDir, profile)
    const runtimeSession: BrowserRuntimeSession = { browser, mode: browserMode, sessionId, userDataDir }
    browser.once('disconnected', () => {
      if (this.sessions.get(sessionKey) === runtimeSession) {
        this.sessions.delete(sessionKey)
        this.evictionBackoff.set(sessionKey, Date.now() + EVICTION_BACKOFF_MS)
        void this.closeBrowser(runtimeSession)
      }
    })
    this.sessions.set(sessionKey, runtimeSession)
    return runtimeSession
  }

  private isSessionAlive(session: BrowserRuntimeSession): boolean {
    try {
      return session.browser.connected
    } catch {
      return false
    }
  }

  private isBrowserConnectionError(error: unknown): boolean {
    return /connection (?:closed|lost)|target closed|browser has disconnected|session closed|protocol error/i.test(
      error instanceof Error ? error.message : String(error),
    )
  }

  private async evictSession(sessionKey: string, session: BrowserRuntimeSession): Promise<void> {
    if (this.sessions.get(sessionKey) === session) {
      this.sessions.delete(sessionKey)
      this.evictionBackoff.set(sessionKey, Date.now() + EVICTION_BACKOFF_MS)
    }
    await this.closeBrowser(session)
  }

  private async closeBrowser(session: BrowserRuntimeSession): Promise<void> {
    const proc = session.browser.process?.()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        session.browser.close(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('browser close timed out')), BROWSER_CLOSE_TIMEOUT_MS)
        }),
      ])
    } catch {
      try {
        proc?.kill('SIGKILL')
      } catch {
        // already gone
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private defaultLauncher: LaunchFn = async (browserMode, userDataDir, profile) => {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    const lang = process.env.BROWSER_LANG || 'ja-JP'
    const extraArgs = (process.env.BROWSER_EXTRA_ARGS || '')
      .split(/\s+/)
      .map((arg) => arg.trim())
      .filter(Boolean)
    const args = [
      process.env.NO_SANDBOX ? '--no-sandbox' : '',
      process.env.NO_SANDBOX ? '--disable-setuid-sandbox' : '',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
      '--disable-popup-blocking',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-infobars',
      '--window-position=0,0',
      `--window-size=${profile.windowSize.width},${profile.windowSize.height}`,
      `--lang=${lang}`,
      ...extraArgs,
    ].filter(Boolean)
    const baseOptions = {
      headless: browserMode === 'headless',
      handleSIGINT: false,
      handleSIGHUP: false,
      handleSIGTERM: false,
      args,
      defaultViewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      userDataDir,
    }
    if (executablePath) {
      return puppeteer.launch({ ...baseOptions, executablePath })
    }
    try {
      return await puppeteer.launch({ ...baseOptions, channel: 'chrome' as const })
    } catch (channelError) {
      // host without system Chrome: auto-provision the pinned build into the
      // cache (persists across restarts) instead of failing the crawl
      const fallbackPath = await ensureFallbackChrome(this.browserRoot).catch((downloadError) => {
        throw new Error(
          `chrome launch failed (${channelError instanceof Error ? channelError.message : channelError}); ` +
            `auto-provision also failed: ${downloadError instanceof Error ? downloadError.message : downloadError}`,
        )
      })
      return puppeteer.launch({ ...baseOptions, executablePath: fallbackPath })
    }
  }
}

export const browserPoolComponent: Component<{ cache_root?: string }> = {
  knownWithKeys: ['cache_root'],
  apply: (ctx, config) => {
    const pool = new BrowserSessionPool({ cacheRoot: config.cache_root })
    ctx.set('browser', pool)
    ctx.expose(pool)
    return async () => {
      await pool.closeAll()
    }
  },
}
