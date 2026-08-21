/**
 * Hand-written type shim for the vendored @kyestu/spider workspace package:
 * tsconfig.typecheck.json maps the package here so the root typecheck does
 * not compile packages/ sources.
 *
 * DRIFT GUARD: tests/shim-drift.test.ts asserts at runtime that
 *   1. every value declared here exists on the real module with a matching
 *      shape (function/class vs object vs primitive),
 *   2. every real top-level value export is declared here (no unshimmed
 *      additions after an upstream sync),
 *   3. spiderRegistry declares every public method of the real registry.
 * Any upstream sync of packages/spider must update this file in the same
 * commit; otherwise the drift test fails.
 */
declare module '@kyestu/spider' {
  // ---- registry ---------------------------------------------------------
  export enum SpiderPriority {
    LOWEST = 1,
    LOW = 2,
    NORMAL = 3,
    HIGH = 4,
    HIGHEST = 5,
  }

  export interface SpiderPlugin {
    id: string
    /** Platform enum value (the enum itself is not re-exported at the package root) */
    platform: number
    priority: SpiderPriority
    urlPattern: RegExp
    create: (log?: any) => BaseSpider
    extractBasicInfo?: (url: string) => { u_id: string; platform: number } | undefined
  }

  export class BaseSpider {
    static _VALID_URL: RegExp
    NAME: string
    init?(): any
    crawl(url: string, page?: any, traceId?: string, config?: any): Promise<any>
  }

  export class SpiderRegistry {
    static getInstance(): SpiderRegistry
    register(plugin: SpiderPlugin): this
    findByUrl(url: string): SpiderPlugin | null
    findById(id: string): SpiderPlugin | null
    findByPlatform(platform: number): SpiderPlugin[]
    extractBasicInfo(url: string): { u_id: string; platform: number } | undefined
    getRegisteredPlugins(): SpiderPlugin[]
  }

  /** the process-wide singleton, populated at import time by spiders/index */
  export const spiderRegistry: SpiderRegistry

  /** deprecated pre-registry helpers, still exported upstream */
  export const Spider: {
    getSpider(url: string): unknown
    extractBasicInfo(url: string): unknown
  }

  // ---- per-spider namespace modules (`export * as X from './x'`) --------
  // Consumed only inside packages/spider; shimmed as opaque namespaces.
  export const X: Record<string, unknown>
  export const Instagram: Record<string, unknown>
  export const Tiktok: Record<string, unknown>
  export const TiktokLive: Record<string, unknown>

  // ---- spiders/tiktok-live (chain-B live status probe) ---------------------
  export interface TikTokLiveProbeResult {
    live: boolean
    m3u8?: string
    title?: string
    /** why live=false (not-live / invalid handle / challenge / parse failure) */
    reason?: string
  }
  export interface TikTokLiveProbeOptions {
    cookieString?: string
    fetchPage?: (url: string, headers: Record<string, string>) => Promise<string>
    timeoutMs?: number
  }
  export function probeTikTokLiveStatus(handle: string, options?: TikTokLiveProbeOptions): Promise<TikTokLiveProbeResult>
  export function parseLiveRoomFromHtml(html: string): TikTokLiveProbeResult
  export function pickHlsPullUrl(pullData: any): string | null
  export const Youtube: Record<string, unknown>
  export const Website: Record<string, unknown>
  export const Leap: Record<string, unknown>
  export const MessageBoard: Record<string, unknown>

  // ---- spiders/base helpers ---------------------------------------------
  export function waitForEvent(...args: any[]): any
  export function waitForResponse(...args: any[]): any
  export const defaultViewport: { width: number; height: number }
  export function beginXOperationCapture(page: any): void
  export function drainCapturedXOperations(page: any): unknown[]

  // ---- utils/browser ------------------------------------------------------
  export type BrowserMode = 'headless' | 'headed-xvfb' | 'headed'
  export type DeviceProfile = string
  export interface ProfileViewport {
    width: number
    height: number
    deviceScaleFactor?: number
    isMobile?: boolean
    hasTouch?: boolean
  }
  export interface BrowserProfileConfig {
    deviceProfile: DeviceProfile
    userAgent?: string
    viewport?: Partial<ProfileViewport>
    extraHeaders?: Record<string, string>
    locale?: string
    timezone?: string
    windowSize: { width: number; height: number }
  }
  export interface BrowserProfileOverrides {
    extraHeaders?: Record<string, string>
    locale?: string
    timezone?: string
    userAgent?: string
    viewport?: Partial<ProfileViewport>
  }
  export const DEVICE_PROFILE_PRESETS: Record<string, DeviceProfile>
  export function resolveBrowserProfile(
    deviceProfile?: DeviceProfile,
    overrides?: BrowserProfileOverrides,
  ): BrowserProfileConfig
  export function applyBrowserProfile(
    page: any,
    deviceProfile: DeviceProfile,
    options?: {
      userAgent?: string
      viewport?: Partial<ProfileViewport>
      extraHeaders?: Record<string, string>
      locale?: string
      timezone?: string
    },
  ): Promise<void>
  export function buildBrowserRequestHeaders(...args: any[]): Record<string, string>

  // ---- utils (cookies, cache, http) ---------------------------------------
  export interface NetscapeCookieFileAudit {
    total_cookie_rows: number
    usable_cookie_count: number
    expired_cookie_count: number
    session_cookie_count: number
    malformed_cookie_count: number
    http_only_cookie_count: number
    domains: Array<string>
    cookie_names: Array<string>
  }
  export function parseNetscapeCookieToPuppeteerCookie(...args: any[]): any
  export function auditNetscapeCookieFile(...args: any[]): NetscapeCookieFileAudit
  export function getCookieString(...args: any[]): string
  export class SimpleExpiringCache<T = any> {
    constructor(...args: any[])
    get(key: string): T | undefined
    set(key: string, value: T, ttlMs?: number): void
  }

  export const DEFAULT_FETCH_TIMEOUT_MS: number
  export const UserAgent: Record<string, string>
  /** namespace, not a class: HTTPClient.download_webpage(...) */
  export const HTTPClient: {
    download_webpage(url: string, headers?: Record<string, string>, options?: DownloadWebpageOptions): Promise<Response>
  }
  export class HttpStatusError extends Error {}
  export class HttpTimeoutError extends Error {}
  export interface DownloadWebpageOptions {
    timeoutMs?: number
    headers?: Record<string, string>
  }

  // ---- utils/domain-breaker ------------------------------------------------
  export interface DomainCircuitBreakerOptions {
    failureThreshold?: number
    blockDurationMs?: number
  }
  export function isDomainBlocked(domain: string): boolean
  export function recordDomainSuccess(domain: string): void
  export function recordDomainFailure(domain: string, options?: DomainCircuitBreakerOptions): void
  export function resetDomainBreakers(): void
  export function domainBreakerSnapshot(domain: string): { failCount: number; blocked: boolean }

  // ---- utils/instagram-media-url -------------------------------------------
  export function instagramMediaUrlExpiryEpochSeconds(url: string, nowMs?: number): number | null
  export function isInstagramMediaUrlExpired(url: string, nowMs?: number): boolean
  export function normalizeInstagramMediaUrlForCache(url: string): string
}
