import dayjs from 'dayjs'
import { Page, type HTTPRequest, type HTTPResponse } from 'puppeteer-core'
import { Platform } from '../types'
import type { CrawlEngine, GenericArticle, GenericMediaInfo, TaskType, TaskTypeResult } from '../types'
import { BaseSpider } from './base'

export enum ArticleTypeEnum {
    ARTICLE = 'article',
}

type FeedKind = 'fc-news' | 'official-news' | 'official-blog' | 'ticket' | 'radio' | 'movie' | 'photo' | 'live-report'

const IMMUTABLE_DETAIL_FEEDS = new Set<FeedKind>(['fc-news', 'official-news', 'official-blog', 'live-report'])
// Mutable feeds re-crawl detail pages by default; once the article is stored a
// TTL-gated re-crawl keeps content changes (stream urls, ticket state) flowing
// without paying a full detail pass for unchanged pages every round.
const MUTABLE_DETAIL_TTL_S: Partial<Record<FeedKind, number>> = {
    radio: 24 * 3600,
    movie: 48 * 3600,
    ticket: 12 * 3600,
}
// Published photo archives are append-only; skip re-crawling archived albums
// whose stored rows are older than this TTL. The current collection (headline)
// is never skipped because photos are appended to it continuously.
const PHOTO_ARCHIVE_TTL_S = 72 * 3600

export interface FeedConfig {
    feed: FeedKind
    u_id: string
    label: string
}

export interface WebsiteListItem {
    detailUrl: string
    title: string
    dateText: string
    summary?: string | null
    member?: string | null
    thumbnail?: string | null
    uAvatar?: string | null
}

interface WebsiteDetailPayload {
    title: string
    dateText: string
    bodyText: string
    bodyHtml: string
    member?: string | null
    media: Array<GenericMediaInfo>
    uAvatar?: string | null
    extraData?: Record<string, any>
}

interface WebsiteAuthGateSnapshot {
    url?: string | null
    documentTitle?: string | null
    bodyText?: string | null
    hasLoginForm?: boolean
    hasPasswordInput?: boolean
    hasLoginButton?: boolean
    hasRegistrationLink?: boolean
    hasDetailContent?: boolean
}

interface WebsiteListPageResult {
    items: Array<WebsiteListItem>
    nextUrl?: string | null
}

interface WebsiteBuildOptions {
    articleId?: string
    detailUrl?: string
}

type WebsiteTimeSource = 'explicit' | 'estimated_publish' | 'crawl_observed'

type WebsiteArticleTime = {
    createdAt: number
    source: WebsiteTimeSource
    dateText: string | null
    crawledAt: number
}

interface WebsiteCrawlOptions {
    max_list_pages?: number
    max_detail_count?: number
    detail_interval_time?: {
        min?: number
        max?: number
    }
    block_resource_types?: Array<string>
}

interface ResolvedWebsiteCrawlOptions {
    maxListPages: number
    maxDetailCount: number
    detailIntervalTime: {
        min: number
        max: number
    }
    blockResourceTypes: Array<string>
}

const DEFAULT_BLOCK_RESOURCE_TYPES = ['font', 'image', 'media']

export interface WebsitePhotoEntry {
    modalId: string
    dataCode?: string | null
    detailUrl: string
    title: string
    theme?: string | null
    dateText: string
    member?: string | null
    bodyText: string
    bodyHtml: string
    media: Array<GenericMediaInfo>
    uAvatar?: string | null
    extraData?: Record<string, any>
}

export interface WebsitePhotoAlbumPayload {
    currentUrl: string
    albumId: string
    pageTheme?: string | null
    entries: Array<WebsitePhotoEntry>
}

interface StandardEntryListOptions {
    waitForSelector: string
    itemSelector: string
    detailSelector: string
    titleSelector: string
    dateSelector: string
    summarySelector?: string
    thumbnailSelector?: string
    memberSelector?: string
}

const FEED_CONFIGS: Record<FeedKind, FeedConfig> = {
    'fc-news': {
        feed: 'fc-news',
        u_id: '22/7:fc-news',
        label: '22/7 FC News',
    },
    'official-news': {
        feed: 'official-news',
        u_id: '22/7:official-news',
        label: '22/7 Official News',
    },
    'official-blog': {
        feed: 'official-blog',
        u_id: '22/7:official-blog',
        label: '22/7 Official Blog',
    },
    ticket: {
        feed: 'ticket',
        u_id: '22/7:ticket',
        label: '22/7 Ticket',
    },
    radio: {
        feed: 'radio',
        u_id: '22/7:radio',
        label: '22/7 Radio',
    },
    movie: {
        feed: 'movie',
        u_id: '22/7:movie',
        label: '22/7 Movie',
    },
    photo: {
        feed: 'photo',
        u_id: '22/7:photo',
        label: '22/7 Photo',
    },
    'live-report': {
        feed: 'live-report',
        u_id: '22/7:live-report',
        label: '22/7 Live Report',
    },
}

const MOBILE_227_HOST = 'nanabunnonijyuuni-mobile.com'
const MAX_LIST_PAGES = 3
const MAX_DETAIL_COUNT = 20
const DEFAULT_DETAIL_INTERVAL_TIME = {
    min: 0,
    max: 0,
}
const WEBSITE_RESOURCE_TYPES = new Set([
    'document',
    'stylesheet',
    'image',
    'media',
    'font',
    'script',
    'texttrack',
    'xhr',
    'fetch',
    'eventsource',
    'websocket',
    'manifest',
    'other',
])

const BRIGHTCOVE_PLAYBACK_HOST = 'edge.api.brightcove.com'
const BRIGHTCOVE_PLAYBACK_PATH_RE = /^\/playback\/v1\/accounts\/(\d+)\/videos\/(\d+)\/?$/i
const BRIGHTCOVE_VIDEO_CODEC_RE = /\b(?:avc1|hvc1|hev1|av01|vp\d{1,2}|mpeg2video|theora)\b/i

interface BrightcovePlaybackSource {
    src: string
    type: string
    codecs: string | null
}

interface BrightcovePlaybackCapture {
    accountId: string
    videoId: string
    policyKey: string | null
    poster: string | null
    sourceUrl: string | null
    sourceCodecs: string | null
    hasVideoCodec: boolean
}

interface BrightcovePlaybackRecord {
    video_id: string
    account_id: string
    policy_key: string | null
    api_url: string | null
    source_url: string | null
    source_codecs: string | null
    has_video_codec: boolean
    poster: string | null
}

function parseBrightcovePlaybackUrl(value: string) {
    try {
        const parsed = new URL(value)
        if (parsed.hostname !== BRIGHTCOVE_PLAYBACK_HOST) {
            return null
        }
        const match = BRIGHTCOVE_PLAYBACK_PATH_RE.exec(parsed.pathname)
        if (!match) {
            return null
        }
        return {
            accountId: match[1]!,
            videoId: match[2]!,
        }
    } catch {
        return null
    }
}

function buildBrightcovePlaybackApiUrl(accountId: string, videoId: string, policyKey?: string | null) {
    const url = new URL(`https://${BRIGHTCOVE_PLAYBACK_HOST}/playback/v1/accounts/${accountId}/videos/${videoId}`)
    if (policyKey) {
        url.searchParams.set('bc_policy', policyKey)
    }
    return url.href
}

function pickBrightcoveDownloadSource(sources: unknown) {
    if (!Array.isArray(sources)) {
        return null
    }
    const normalized = sources
        .map((source) => {
            if (!source || typeof source !== 'object') {
                return null
            }
            const record = source as Record<string, unknown>
            const src = typeof record.src === 'string' ? record.src : null
            const type = typeof record.type === 'string' ? record.type : null
            const codecs = typeof record.codecs === 'string' ? record.codecs : null
            if (!src || !type) {
                return null
            }
            return { src, type, codecs }
        })
        .filter((source): source is BrightcovePlaybackSource => source !== null)

    const hasVideoCodec = (source: BrightcovePlaybackSource) => BRIGHTCOVE_VIDEO_CODEC_RE.test(source.codecs || '')
    const https = (source: BrightcovePlaybackSource) => source.src.startsWith('https://')
    const isHls = (source: BrightcovePlaybackSource) => /mpegurl/i.test(source.type)
    const isDash = (source: BrightcovePlaybackSource) => /dash/i.test(source.type)
    const isMp4 = (source: BrightcovePlaybackSource) => /^video\/mp4$/i.test(source.type)

    return (
        normalized.find((source) => isHls(source) && https(source) && hasVideoCodec(source)) ||
        normalized.find((source) => isHls(source) && hasVideoCodec(source)) ||
        normalized.find((source) => isDash(source) && https(source) && hasVideoCodec(source)) ||
        normalized.find((source) => isDash(source) && hasVideoCodec(source)) ||
        normalized.find((source) => isMp4(source) && https(source)) ||
        normalized.find((source) => isMp4(source)) ||
        normalized.find((source) => isHls(source) && https(source)) ||
        normalized.find((source) => isHls(source)) ||
        normalized.find((source) => isDash(source) && https(source)) ||
        normalized.find((source) => isDash(source)) ||
        normalized.find((source) => https(source)) ||
        null
    )
}

function startBrightcovePlaybackCapture(page: Page) {
    const captures = new Map<string, BrightcovePlaybackCapture>()
    const policyByAccount = new Map<string, string>()

    const onRequest = (request: HTTPRequest) => {
        const parsed = parseBrightcovePlaybackUrl(request.url())
        if (!parsed) {
            return
        }
        const accept = String(request.headers()?.['accept'] || '')
        const policyKey = /(?:^|;)\s*pk=([^;]+)/i.exec(accept)?.[1]?.trim()
        if (policyKey) {
            policyByAccount.set(parsed.accountId, policyKey)
        }
    }

    const onResponse = async (response: HTTPResponse) => {
        const parsed = parseBrightcovePlaybackUrl(response.url())
        if (!parsed) {
            return
        }
        if (response.status() < 200 || response.status() >= 300) {
            return
        }
        let payload: Record<string, any> | null = null
        try {
            payload = JSON.parse(await response.text()) as Record<string, any>
        } catch {
            return
        }
        const sources = Array.isArray(payload?.sources) ? payload.sources : []
        const source = pickBrightcoveDownloadSource(sources)
        const sourceCodecs =
            sources
                .map((source) => (source && typeof source === 'object' ? source.codecs : null))
                .filter((value): value is string => typeof value === 'string')
                .join(',') || null
        const hasVideoCodec = BRIGHTCOVE_VIDEO_CODEC_RE.test(sourceCodecs || '')
        captures.set(parsed.videoId, {
            accountId: parsed.accountId,
            videoId: parsed.videoId,
            policyKey: policyByAccount.get(parsed.accountId) || null,
            poster: typeof payload?.poster === 'string' ? payload.poster : null,
            sourceUrl: source?.src || null,
            sourceCodecs,
            hasVideoCodec,
        })
    }

    page.on('request', onRequest)
    page.on('response', onResponse)

    const records = () => {
        const serialized: Record<string, BrightcovePlaybackRecord> = {}
        for (const [videoId, capture] of captures) {
            const policyKey = capture.policyKey || policyByAccount.get(capture.accountId) || null
            serialized[videoId] = {
                video_id: videoId,
                account_id: capture.accountId,
                policy_key: policyKey,
                api_url: policyKey ? buildBrightcovePlaybackApiUrl(capture.accountId, videoId, policyKey) : null,
                source_url: capture.sourceUrl,
                source_codecs: capture.sourceCodecs,
                has_video_codec: capture.hasVideoCodec,
                poster: capture.poster,
            }
        }
        return serialized
    }

    const stop = () => {
        page.off('request', onRequest)
        page.off('response', onResponse)
    }

    return { captures, records, stop }
}

async function waitForBrightcovePlayback(
    page: Page,
    capture: ReturnType<typeof startBrightcovePlaybackCapture>,
    selector: string,
    timeoutMs = 4000,
) {
    const expectedVideoIds = await page
        .$$eval(selector, (nodes) =>
            Array.from(
                new Set(nodes.map((node) => String(node.getAttribute('data-video-id') || '').trim()).filter(Boolean)),
            ),
        )
        .catch(() => [] as string[])
    if (expectedVideoIds.length === 0) {
        return
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const records = capture.records()
        const captured = new Set(Object.keys(records))
        if (expectedVideoIds.every((videoId) => captured.has(videoId))) {
            return
        }
        // A video-capable capture is enough: radio pages also initialise an
        // audio-only Brightcove player and we only need the movie/radio video
        // rendition before serialising the page.
        if (expectedVideoIds.some((videoId) => records[videoId]?.has_video_codec)) {
            return
        }
        await sleep(200)
    }
}

function cleanText(value?: string | null): string {
    return (value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function cleanMultilineText(value?: string | null): string {
    const lines = (value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())

    const collapsed = lines.reduce<Array<string>>((acc, line) => {
        if (!line) {
            if (acc[acc.length - 1] !== '') {
                acc.push('')
            }
            return acc
        }
        acc.push(line)
        return acc
    }, [])

    return collapsed
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
        return fallback
    }
    return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function resolveWebsiteCrawlOptions(options: WebsiteCrawlOptions = {}): ResolvedWebsiteCrawlOptions {
    const minDelay = clampInteger(options.detail_interval_time?.min, DEFAULT_DETAIL_INTERVAL_TIME.min, 0, 60000)
    const maxDelay = clampInteger(
        options.detail_interval_time?.max,
        Math.max(minDelay, DEFAULT_DETAIL_INTERVAL_TIME.max),
        minDelay,
        60000,
    )
    const rawBlockResourceTypes = options.block_resource_types || DEFAULT_BLOCK_RESOURCE_TYPES
    const blockResourceTypes = Array.from(
        new Set(
            rawBlockResourceTypes
                .map((value) => String(value || '').trim())
                .filter((value) => WEBSITE_RESOURCE_TYPES.has(value)),
        ),
    )

    return {
        maxListPages: clampInteger(options.max_list_pages, MAX_LIST_PAGES, 1, MAX_LIST_PAGES),
        maxDetailCount: clampInteger(options.max_detail_count, MAX_DETAIL_COUNT, 1, MAX_DETAIL_COUNT),
        detailIntervalTime: {
            min: minDelay,
            max: maxDelay,
        },
        blockResourceTypes,
    }
}

function randomInterval(range: ResolvedWebsiteCrawlOptions['detailIntervalTime']) {
    if (range.max <= range.min) {
        return range.min
    }
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function websiteErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function isAuthOrRateLimitWebsiteError(error: unknown) {
    return /login|csrf|cookie|session expired|challenge|checkpoint|rate limit|too many requests|temporarily blocked|forbidden|401|403|429/i.test(
        websiteErrorMessage(error),
    )
}

function isTransientWebsiteError(error: unknown) {
    return /timeout|timed out|navigation|econnreset|socket hang up|network|fetch failed|temporarily unavailable|bad gateway|service unavailable|net::err|aborted/i.test(
        websiteErrorMessage(error),
    )
}

async function retryTransient<T>(operation: () => Promise<T>, context: string, retries = 1): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await operation()
        } catch (error) {
            lastError = error
            if (!isTransientWebsiteError(error) || attempt >= retries) {
                throw error
            }
            await sleep(600 * (attempt + 1))
        }
    }
    throw lastError
}

export function resolveWebsiteFeedResourceBlocking(feed: FeedKind, blockResourceTypes: Array<string>) {
    if (feed === 'radio' || feed === 'movie' || feed === 'photo') {
        return blockResourceTypes.filter((type) => type === 'font')
    }

    return blockResourceTypes
}

function formatSafeWebsiteUrl(url: string) {
    const parsed = tryParseWebsiteUrl(url)
    if (!parsed) {
        return url.slice(0, 160)
    }
    const queryKeys = Array.from(parsed.searchParams.keys()).sort()
    return `${parsed.origin}${parsed.pathname}${queryKeys.length > 0 ? `?${queryKeys.map((key) => `${key}=...`).join('&')}` : ''}`
}

export function isWebsiteAuthGateSnapshot(snapshot: WebsiteAuthGateSnapshot) {
    if (snapshot.hasDetailContent) {
        return false
    }

    const title = cleanText(snapshot.documentTitle).toLowerCase()
    const body = cleanText(snapshot.bodyText).toLowerCase()
    const loginTitle = /^ログイン\s*\|/.test(title) || /^login\s*\|/.test(title)
    const loginBody =
        /(ログイン|login)/i.test(body) && /(新規会員登録|会員登録|password|パスワード|メールアドレス)/i.test(body)
    const loginControls = Boolean(snapshot.hasLoginForm || snapshot.hasPasswordInput || snapshot.hasLoginButton)
    const registrationGate = Boolean(snapshot.hasLoginButton && snapshot.hasRegistrationLink)

    return Boolean(loginTitle || (loginBody && loginControls) || registrationGate)
}

async function detectWebsiteAuthGate(page: Page, detailSelector: string) {
    const snapshot = (await page.evaluate((selector) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const controls = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'))
        const controlTexts = controls
            .map((node) => clean(node.textContent || (node as HTMLInputElement).value))
            .filter(Boolean)
        return {
            url: location.href,
            documentTitle: document.title,
            bodyText: clean(document.body?.innerText || document.body?.textContent).slice(0, 1200),
            hasLoginForm: Boolean(document.querySelector('form[action*="/login"]')),
            hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
            hasLoginButton: controlTexts.some((text) => /^(ログイン|login)$/i.test(text)),
            hasRegistrationLink: controls.some((node) => {
                const text = clean(node.textContent || (node as HTMLInputElement).value)
                const href = (node as HTMLAnchorElement).href || ''
                return /新規会員登録|会員登録/i.test(text) || /\/page\/about/.test(href)
            }),
            hasDetailContent: Boolean(document.querySelector(selector)),
        }
    }, detailSelector)) as WebsiteAuthGateSnapshot

    return isWebsiteAuthGateSnapshot(snapshot) ? snapshot : null
}

function assertRequiredWebsiteDetail(
    hasDetail: boolean,
    authGate: WebsiteAuthGateSnapshot | null,
    feed: FeedKind,
    url: string,
    selectorLabel: string,
) {
    if (hasDetail) {
        return
    }
    if (authGate) {
        throw new Error(
            `Website auth required for ${feed} detail ${formatSafeWebsiteUrl(url)}: login page shown; refresh browser session/cookies`,
        )
    }
    throw new Error(`Website ${feed} detail missing ${selectorLabel}; format may have changed`)
}

async function waitForRequiredDetailSelector(
    page: Page,
    feed: FeedKind,
    url: string,
    detailSelector: string,
    timeout = 15000,
) {
    await waitForOptionalSelector(page, `${detailSelector}, form[action*="/login"], input[type="password"]`, timeout)
    const [hasDetail, authGate] = await Promise.all([
        page
            .$(detailSelector)
            .then(Boolean)
            .catch(() => false),
        detectWebsiteAuthGate(page, detailSelector),
    ])
    assertRequiredWebsiteDetail(hasDetail, authGate, feed, url, detailSelector)
}

async function waitForOptionalSelector(page: Page, selector: string, timeout: number) {
    try {
        await page.waitForSelector(selector, { timeout })
        return true
    } catch {
        return false
    }
}

async function configureWebsiteResourceBlocking(page: Page, blockResourceTypes: Array<string>) {
    const key = blockResourceTypes.slice().sort().join(',')
    const guardedPage = page as Page & {
        __websiteResourceGuard?: {
            key: string
            handler: (request: HTTPRequest) => void
        }
    }

    if (guardedPage.__websiteResourceGuard?.key === key) {
        return
    }

    if (guardedPage.__websiteResourceGuard) {
        page.off('request', guardedPage.__websiteResourceGuard.handler)
        guardedPage.__websiteResourceGuard = undefined
    }

    if (blockResourceTypes.length === 0) {
        await page.setRequestInterception(false).catch(() => null)
        return
    }

    const blocked = new Set(blockResourceTypes)
    const handler = (request: HTTPRequest) => {
        const action = blocked.has(request.resourceType()) ? request.abort() : request.continue()
        action.catch(() => null)
    }

    await page.setRequestInterception(true)
    page.on('request', handler)
    guardedPage.__websiteResourceGuard = {
        key,
        handler,
    }
}

function hasExplicitTime(dateText?: string | null): boolean {
    const value = cleanText(dateText)
    if (!value) {
        return false
    }

    return /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(value) || /\b\d{1,2}時(?:\d{1,2}分?)?\b/.test(value)
}

function resolveAbsoluteUrl(url: string, value?: string | null): string | null {
    if (!value) {
        return null
    }
    try {
        return new URL(value, url).href
    } catch {
        return null
    }
}

function parseDateToUnix(dateText?: string | null): number {
    return resolveWebsiteArticleTime(dateText, 'crawl_observed').createdAt
}

function isOperatorAuthoredFeed(feed: FeedKind) {
    return !['official-blog', 'photo'].includes(feed)
}

function roundToNearbyHour(now: dayjs.Dayjs, windowMinutes = 15) {
    const minute = now.minute()
    if (minute <= windowMinutes) {
        return now.startOf('hour')
    }
    if (60 - minute <= windowMinutes) {
        return now.add(1, 'hour').startOf('hour')
    }
    return now
}

function resolveWebsiteArticleTime(
    dateText?: string | null,
    fallbackSource: WebsiteTimeSource = 'crawl_observed',
): WebsiteArticleTime {
    const raw = cleanText(dateText)
    const normalized = raw.replace(/[./]/g, '-')
    const parsed = dayjs(normalized)
    const crawledAt = dayjs()
    if (parsed.isValid()) {
        if (hasExplicitTime(raw)) {
            return {
                createdAt: parsed.unix(),
                source: 'explicit',
                dateText: raw || null,
                crawledAt: crawledAt.unix(),
            }
        }

        if (parsed.isSame(crawledAt, 'day')) {
            const effective = fallbackSource === 'estimated_publish' ? roundToNearbyHour(crawledAt) : crawledAt
            return {
                createdAt: effective.unix(),
                source: fallbackSource,
                dateText: raw || null,
                crawledAt: crawledAt.unix(),
            }
        }

        return {
            createdAt: parsed.startOf('day').unix(),
            source: 'explicit',
            dateText: raw || null,
            crawledAt: crawledAt.unix(),
        }
    }
    return {
        createdAt: crawledAt.unix(),
        source: 'crawl_observed',
        dateText: raw || null,
        crawledAt: crawledAt.unix(),
    }
}

function tryParseWebsiteUrl(url: string): URL | null {
    try {
        return new URL(url)
    } catch {
        return null
    }
}

function isNewsDetail(pathname: string) {
    return /^\/s\/n110\/news\/detail\/[^/?#]+$/i.test(pathname)
}

function isTicketDetail(pathname: string) {
    return /^\/s\/n110\/ticket\/detail\/[^/?#]+$/i.test(pathname)
}

function isDiaryDetail(pathname: string) {
    return /^\/s\/n110\/diary\/detail\/\d+$/i.test(pathname)
}

function isRadioDetail(pathname: string) {
    return /^\/s\/n110\/contents\/[^/?#]+$/i.test(pathname)
}

function isPhotoDetail(url: URL) {
    return (
        /^\/s\/n110\/gallery\/[^/?#]+$/i.test(url.pathname) ||
        (url.pathname === '/s/n110/contents_list' && (url.searchParams.get('ct') || '').startsWith('member_photo_'))
    )
}

function isPhotoList(url: URL) {
    return url.pathname === '/s/n110/gallery' && url.searchParams.get('ct') === 'photoga'
}

function isRadioList(url: URL) {
    return url.pathname === '/s/n110/contents_list' && url.searchParams.get('ct') === 'radio'
}

function isMovieList(url: URL) {
    return /^\/s\/n110\/diary\/nananiji_movie(?:\/list)?$/i.test(url.pathname)
}

function isLiveReportList(url: URL) {
    return url.pathname === '/s/n110/diary/special/list'
}

function isDetailUrl(feed: FeedKind, url: string) {
    const parsed = tryParseWebsiteUrl(url)
    if (!parsed || parsed.hostname !== MOBILE_227_HOST) {
        return false
    }

    switch (feed) {
        case 'fc-news':
        case 'official-news':
            return isNewsDetail(parsed.pathname)
        case 'official-blog':
            return (
                isDiaryDetail(parsed.pathname) &&
                parsed.searchParams.get('cd') !== 'nananiji_movie' &&
                parsed.searchParams.get('cd') !== 'special'
            )
        case 'ticket':
            return isTicketDetail(parsed.pathname)
        case 'radio':
            return isRadioDetail(parsed.pathname)
        case 'movie':
            return isDiaryDetail(parsed.pathname) && parsed.searchParams.get('cd') === 'nananiji_movie'
        case 'photo':
            return isPhotoDetail(parsed)
        case 'live-report':
            return isDiaryDetail(parsed.pathname) && parsed.searchParams.get('cd') === 'special'
        default:
            return false
    }
}

function extractArticleId(config: FeedConfig, detailUrl: string) {
    const parsed = tryParseWebsiteUrl(detailUrl)
    if (parsed) {
        switch (config.feed) {
            case 'fc-news':
            case 'official-news':
            case 'ticket':
            case 'radio':
            case 'movie':
            case 'official-blog':
            case 'live-report': {
                const id = parsed.pathname.split('/').filter(Boolean).pop()
                if (id) {
                    return id
                }
                break
            }
            case 'photo': {
                const id = parsed.searchParams.get('ct') || parsed.pathname.split('/').filter(Boolean).pop()
                if (id) {
                    return id
                }
                break
            }
        }
    }

    return `${config.feed}:${Buffer.from(detailUrl).toString('base64url')}`
}

function getDetailKey(config: FeedConfig, detailUrl: string) {
    return extractArticleId(config, detailUrl)
}

function buildMedia(
    detailMedia: Array<GenericMediaInfo>,
    fallbackThumbnail?: string | null,
): Array<GenericMediaInfo> | null {
    const dedup = new Map<string, GenericMediaInfo>()
    for (const media of detailMedia) {
        if (media.url) {
            dedup.set(`${media.type}:${media.url}`, media)
        }
    }
    if (fallbackThumbnail) {
        dedup.set(`photo:${fallbackThumbnail}`, {
            type: 'photo',
            url: fallbackThumbnail,
        })
    }
    return dedup.size > 0 ? Array.from(dedup.values()) : null
}

export function buildWebsiteArticle(
    config: FeedConfig,
    detailUrl: string,
    listItem: WebsiteListItem,
    detail: WebsiteDetailPayload,
    options?: WebsiteBuildOptions,
): GenericArticle<Platform.Website> {
    const articleId = options?.articleId || extractArticleId(config, options?.detailUrl || detailUrl)
    const finalUrl = options?.detailUrl || detailUrl
    const title = cleanText(detail.title || listItem.title)
    const summary = cleanText(listItem.summary)
    const bodyText = cleanMultilineText(detail.bodyText)
    const content = [title ? `【${title}】` : '', bodyText].filter(Boolean).join('\n\n') || title || summary || null
    const media = buildMedia(detail.media, listItem.thumbnail)
    const member = cleanText(detail.member || listItem.member) || null
    const time = resolveWebsiteArticleTime(
        detail.dateText || listItem.dateText,
        isOperatorAuthoredFeed(config.feed) ? 'estimated_publish' : 'crawl_observed',
    )

    return {
        platform: Platform.Website,
        a_id: articleId,
        u_id: config.u_id,
        username: member || config.label,
        created_at: time.createdAt,
        content,
        url: finalUrl,
        type: ArticleTypeEnum.ARTICLE,
        ref: null,
        has_media: Boolean(media && media.length > 0),
        media,
        extra: {
            data: {
                site: '22/7',
                host: MOBILE_227_HOST,
                feed: config.feed,
                title,
                member,
                summary: summary || null,
                raw_html: detail.bodyHtml,
                time_source: time.source,
                date_text: time.dateText,
                crawled_at: time.crawledAt,
                ...(detail.extraData || {}),
            },
            content: summary || title || undefined,
            media: media || undefined,
            extra_type: 'website_meta',
        },
        u_avatar: detail.uAvatar || listItem.uAvatar || null,
    }
}

function resolvePhotoAlbumAnchor(payload: WebsitePhotoAlbumPayload) {
    const candidate =
        payload.entries.map((entry) => cleanText(entry.dataCode)).find(Boolean) ||
        payload.entries.map((entry) => cleanText(entry.modalId)).find(Boolean)

    if (candidate) {
        return candidate
    }

    return Buffer.from(`${payload.albumId}:${payload.currentUrl}`).toString('base64url').slice(0, 16)
}

export function buildPhotoAlbumArticle(
    config: FeedConfig,
    listItem: WebsiteListItem,
    payload: WebsitePhotoAlbumPayload,
): Array<GenericArticle<Platform.Website>> {
    if (payload.entries.length === 0) {
        return []
    }

    const title =
        cleanText(payload.pageTheme) ||
        cleanText(listItem.title) ||
        cleanText(payload.entries[0]?.theme) ||
        cleanText(payload.entries[0]?.title)
    const dateText =
        payload.entries.map((entry) => cleanText(entry.dateText)).find(Boolean) || cleanText(listItem.dateText)
    const media = payload.entries.flatMap((entry) => entry.media || [])
    const bodyText = payload.entries
        .map((entry) => {
            const heading = cleanText(entry.member) || cleanText(entry.title)
            const message = cleanMultilineText(entry.bodyText)
            return [heading ? `【${heading}】` : '', message].filter(Boolean).join('\n')
        })
        .filter(Boolean)
        .join('\n\n')
    const bodyHtml = payload.entries
        .map((entry) => entry.bodyHtml)
        .filter(Boolean)
        .join('\n<hr />\n')
    const members = Array.from(new Set(payload.entries.map((entry) => cleanText(entry.member)).filter(Boolean)))
    const albumAnchor = resolvePhotoAlbumAnchor(payload)
    const firstAvatar = payload.entries.map((entry) => entry.uAvatar).find(Boolean) || listItem.uAvatar || null

    return [
        buildWebsiteArticle(
            config,
            payload.currentUrl,
            {
                ...listItem,
                title: title || listItem.title,
                dateText: dateText || listItem.dateText,
                member: null,
                thumbnail: media[0]?.url || listItem.thumbnail,
                uAvatar: firstAvatar,
            },
            {
                title: title || listItem.title,
                dateText: dateText || listItem.dateText,
                bodyText,
                bodyHtml,
                member: null,
                media,
                uAvatar: firstAvatar,
                extraData: {
                    album_id: payload.albumId,
                    album_anchor: albumAnchor,
                    entry_count: payload.entries.length,
                    members: members.length > 0 ? members : null,
                    entries: payload.entries.map((entry) => ({
                        ...entry,
                        bodyText: cleanMultilineText(entry.bodyText),
                    })),
                },
            },
            {
                articleId: `${config.feed}:album:${payload.albumId}:${albumAnchor}`,
                detailUrl: payload.currentUrl,
            },
        ),
    ]
}

export function splitPhotoAlbumPayloadByDate(payload: WebsitePhotoAlbumPayload): Array<WebsitePhotoAlbumPayload> {
    if (payload.entries.length <= 1) {
        return [payload]
    }

    const groups = new Map<string, Array<WebsitePhotoEntry>>()
    for (const entry of payload.entries) {
        const key = cleanText(entry.dateText) || '__undated__'
        const bucket = groups.get(key) || []
        bucket.push(entry)
        groups.set(key, bucket)
    }

    return Array.from(groups.values()).map((entries) => ({
        ...payload,
        entries,
    }))
}

async function extractStandardEntryList(
    page: Page,
    url: string,
    options: StandardEntryListOptions,
): Promise<WebsiteListPageResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(options.waitForSelector, { timeout: 15000 })
    return page.evaluate(
        (currentUrl, selectors) => {
            const clean = (value?: string | null) =>
                (value || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
            const absolute = (value?: string | null) => {
                if (!value) {
                    return null
                }
                try {
                    return new URL(value, currentUrl).href
                } catch {
                    return null
                }
            }
            const items = Array.from(document.querySelectorAll(selectors.itemSelector))
                .map((node) => {
                    const detailUrl = absolute(node.querySelector(selectors.detailSelector)?.getAttribute('href'))
                    if (!detailUrl) {
                        return null
                    }
                    const thumbnailSrc = selectors.thumbnailSelector
                        ? absolute(node.querySelector(selectors.thumbnailSelector)?.getAttribute('src'))
                        : null
                    return {
                        detailUrl,
                        title: clean(node.querySelector(selectors.titleSelector)?.textContent),
                        dateText: clean(node.querySelector(selectors.dateSelector)?.textContent),
                        summary: selectors.summarySelector
                            ? clean(node.querySelector(selectors.summarySelector)?.textContent)
                            : null,
                        member: selectors.memberSelector
                            ? clean(node.querySelector(selectors.memberSelector)?.textContent) || null
                            : null,
                        thumbnail: thumbnailSrc,
                    }
                })
                .filter(Boolean)

            const nextUrl = absolute(document.querySelector('.pager .next a')?.getAttribute('href'))
            return {
                items,
                nextUrl,
            }
        },
        url,
        options,
    ) as Promise<WebsiteListPageResult>
}

async function extractNewsList(page: Page, url: string) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.news_box, .entry-list .entry-item', { timeout: 15000 })
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const legacyItems = Array.from(document.querySelectorAll('.news_box'))
            .map((node) => {
                const detailUrl =
                    absolute(node.querySelector('.news_box_title a')?.getAttribute('href')) ||
                    absolute(node.querySelector('.viewmore a')?.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.news_box_title')?.textContent),
                    dateText: clean(node.querySelector('.news_box_date')?.textContent),
                    summary: clean(node.querySelector('.news_box_description')?.textContent),
                    member: null,
                    thumbnail: null,
                }
            })
            .filter(Boolean)
        const entryItems = Array.from(document.querySelectorAll('.entry-list .entry-item'))
            .map((node) => {
                const detailUrl =
                    absolute(node.querySelector('a.panel')?.getAttribute('href')) ||
                    absolute(node.querySelector('.entry__title a')?.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.entry__title')?.textContent),
                    dateText: clean(node.querySelector('.entry__posted')?.textContent),
                    summary: clean(node.querySelector('.entry__text, .entry__description')?.textContent),
                    member: null,
                    thumbnail: null,
                }
            })
            .filter(Boolean)
        const items = legacyItems.length > 0 ? legacyItems : entryItems
        const nextUrl = absolute(document.querySelector('.pager .next a')?.getAttribute('href'))
        return {
            items,
            nextUrl,
        }
    }, url) as Promise<WebsiteListPageResult>
}

async function extractBlogList(page: Page, url: string) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('a[href*="/diary/detail/"]', { timeout: 15000 })
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const parseBackground = (value?: string | null) => {
            const match = value?.match(/url\((['"]?)(.*?)\1\)/)
            return match?.[2] || null
        }
        const items = Array.from(document.querySelectorAll('a[href*="/diary/detail/"]'))
            .map((anchor) => {
                const detailUrl = absolute(anchor.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                const thumbNode = anchor.querySelector<HTMLElement>(
                    '.blog-entry-list__thumb img, .blog-list__thumb img',
                )
                const thumbFromStyle = parseBackground(thumbNode?.getAttribute('style'))
                return {
                    detailUrl,
                    title: clean(
                        anchor.querySelector('.blog-list__title .title, .blog-entry-list__title .title')
                            ?.textContent,
                    ),
                    dateText: clean(anchor.querySelector('.date')?.textContent),
                    summary: clean(anchor.querySelector('.blog-list__txt')?.textContent),
                    member: clean(anchor.querySelector('.name')?.textContent) || null,
                    thumbnail: absolute(thumbFromStyle || thumbNode?.getAttribute('src')),
                }
            })
            .filter(Boolean)
        const dedupMap = new Map<string, any>()
        for (const item of items as Array<any>) {
            const existing = dedupMap.get(item.detailUrl)
            if (!existing) {
                dedupMap.set(item.detailUrl, item)
                continue
            }
            dedupMap.set(item.detailUrl, {
                detailUrl: item.detailUrl,
                title: existing.title || item.title,
                dateText: existing.dateText || item.dateText,
                summary: existing.summary || item.summary,
                member: existing.member || item.member,
                thumbnail: existing.thumbnail || item.thumbnail,
            })
        }
        const dedup = Array.from(dedupMap.values())
        const nextUrl = absolute(document.querySelector('.pager .next a')?.getAttribute('href'))
        return {
            items: dedup,
            nextUrl,
        }
    }, url) as Promise<WebsiteListPageResult>
}

async function extractRadioList(page: Page, url: string): Promise<WebsiteListPageResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const hasList = await waitForOptionalSelector(page, '.section-radio .radio', 15000)
    if (!hasList) {
        return { items: [], nextUrl: null }
    }
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const items = Array.from(document.querySelectorAll('.section-radio .radio'))
            .map((node) => {
                const detailUrl = absolute(
                    node.querySelector('.radio-img')?.getAttribute('href') ||
                        node.querySelector('.radio-btn.radio')?.getAttribute('href'),
                )
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.radio__title')?.textContent),
                    dateText: clean(node.querySelector('.radio__posted')?.textContent),
                    summary: clean(node.querySelector('.radio__text')?.textContent) || null,
                    member: null,
                    thumbnail: absolute(node.querySelector('.radio-img img')?.getAttribute('src')),
                }
            })
            .filter(Boolean)

        return {
            items: Array.from(new Map(items.map((item: any) => [item.detailUrl, item])).values()),
            nextUrl: null,
        }
    }, url)
}

async function extractMovieList(page: Page, url: string): Promise<WebsiteListPageResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const hasList = await waitForOptionalSelector(page, '.section-movie .movie, .archive-list .archive-item', 15000)
    if (!hasList) {
        return { items: [], nextUrl: null }
    }
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const featured = Array.from(document.querySelectorAll('.section-movie .movie'))
            .map((node) => {
                const detailUrl = absolute(node.querySelector('.movie-img')?.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.movie__title')?.textContent),
                    dateText: clean(node.querySelector('.movie__posted')?.textContent),
                    summary: null,
                    member: null,
                    thumbnail: absolute(node.querySelector('.movie-img img')?.getAttribute('src')),
                }
            })
            .filter(Boolean)

        const archive = Array.from(document.querySelectorAll('.archive-list .archive-item'))
            .map((node) => {
                const detailUrl = absolute(node.querySelector('.archive-inner')?.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.archive__title')?.textContent),
                    dateText: clean(node.querySelector('.archive__posted')?.textContent),
                    summary: null,
                    member: null,
                    thumbnail: absolute(node.querySelector('.archive-thumb img')?.getAttribute('src')),
                }
            })
            .filter(Boolean)

        return {
            items: Array.from(new Map([...featured, ...archive].map((item: any) => [item.detailUrl, item])).values()),
            nextUrl: absolute(document.querySelector('.pager .next a')?.getAttribute('href')),
        }
    }, url)
}

async function extractPhotoList(page: Page, url: string): Promise<WebsiteListPageResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const hasList = await waitForOptionalSelector(page, '.section-photo .headline, .archive-list .archive-item', 15000)
    if (!hasList) {
        return { items: [], nextUrl: null }
    }
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }

        const sectionPhoto = document.querySelector('.section-photo')
        const currentTheme = clean(sectionPhoto?.querySelector('.headline__title')?.textContent)
        const currentDates = Array.from(sectionPhoto?.querySelectorAll('.photo__posted') || []).map((node) =>
            clean(node.textContent),
        )
        const currentThumbnail = absolute(sectionPhoto?.querySelector('.photo__img img')?.getAttribute('src'))

        const items: Array<WebsiteListItem> = []
        if (currentTheme && sectionPhoto?.querySelector('.photo-modal, .photo-block')) {
            items.push({
                detailUrl: currentUrl,
                title: currentTheme,
                dateText: currentDates[currentDates.length - 1] || currentDates[0] || '',
                summary: currentTheme,
                member: null,
                thumbnail: currentThumbnail,
            })
        }

        const archiveItems = Array.from(document.querySelectorAll('.archive-list .archive-item'))
            .map((node) => {
                const detailUrl = absolute(node.querySelector('.archive-inner')?.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.archive__title')?.textContent),
                    dateText: clean(node.querySelector('.archive__posted')?.textContent),
                    summary: clean(node.querySelector('.archive__label')?.textContent),
                    member: null,
                    thumbnail: absolute(node.querySelector('.archive-thumb img')?.getAttribute('src')),
                }
            })
            .filter(Boolean)

        return {
            items: Array.from(new Map([...items, ...archiveItems].map((item: any) => [item.detailUrl, item])).values()),
            nextUrl: absolute(document.querySelector('.pager .next a')?.getAttribute('href')),
        }
    }, url)
}

async function extractLiveReportList(page: Page, url: string): Promise<WebsiteListPageResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.special_box', { timeout: 15000 })
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }

        const items = Array.from(document.querySelectorAll('.special_box'))
            .map((node) => {
                const detailUrl = absolute(node.querySelector('.special_title a')?.getAttribute('href'))
                if (!detailUrl) {
                    return null
                }
                return {
                    detailUrl,
                    title: clean(node.querySelector('.special_title')?.textContent),
                    dateText: clean(node.querySelector('.special_date')?.textContent),
                    summary: null,
                    member: null,
                    thumbnail: absolute(node.querySelector('.special_thumb img')?.getAttribute('src')),
                }
            })
            .filter(
                (
                    item,
                ): item is {
                    detailUrl: string
                    title: string
                    dateText: string
                    summary: null
                    member: null
                    thumbnail: string | null
                } => item !== null,
            )

        return {
            items,
            nextUrl: absolute(document.querySelector('.pager .next a')?.getAttribute('href')),
        }
    }, url)
}

async function extractNewsDetail(page: Page, url: string, feed: FeedKind): Promise<WebsiteDetailPayload> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await waitForRequiredDetailSelector(
        page,
        feed,
        url,
        '#infoDetailTitle, #infoDetail, #infoCaption, .section-article .article__title, .section-article .article-content',
    )
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const cleanMultiline = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r/g, '')
                .split('\n')
                .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const body =
            document.querySelector<HTMLElement>('#infoDetail') ||
            document.querySelector<HTMLElement>('.section-article .article-content')
        const media = Array.from(body?.querySelectorAll('img') || [])
            .map((img) => {
                const src = absolute(img.getAttribute('src'))
                if (!src) {
                    return null
                }
                return {
                    type: 'photo' as const,
                    url: src,
                    alt: clean(img.getAttribute('alt')) || undefined,
                }
            })
            .filter((media): media is { type: 'photo'; url: string; alt: string | undefined } => media !== null)
        return {
            title: clean(
                document.querySelector('#infoCaption')?.textContent ||
                    document.querySelector('.section-article .article__title')?.textContent,
            ),
            dateText: clean(
                document.querySelector('.infoDate')?.textContent ||
                    document.querySelector('.section-article .article__posted')?.textContent,
            ),
            bodyText: cleanMultiline(body?.innerText || body?.textContent),
            bodyHtml: body?.innerHTML || '',
            member: null,
            media,
        }
    }, url)
}

async function extractBlogDetail(page: Page, url: string): Promise<WebsiteDetailPayload> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await waitForRequiredDetailSelector(page, 'official-blog', url, '.blog_detail__title, .blog_detail__main')
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const cleanMultiline = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r/g, '')
                .split('\n')
                .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const body = document.querySelector<HTMLElement>('.blog_detail__main')
        // The tweet share widget sits inside the body container; drop it so its
        // label ("ツイート") and widget DOM never leak into text/media extraction.
        body?.querySelectorAll('.btnTweet').forEach((node) => node.remove())
        const media = Array.from(body?.querySelectorAll('img') || [])
            .map((img) => {
                const src = absolute(img.getAttribute('src'))
                if (!src) {
                    return null
                }
                return {
                    type: 'photo' as const,
                    url: src,
                    alt: clean(img.getAttribute('alt')) || undefined,
                }
            })
            .filter((media): media is { type: 'photo'; url: string; alt: string | undefined } => media !== null)
        return {
            title: clean(document.querySelector('.blog_detail__title')?.textContent),
            dateText: clean(document.querySelector('.blog_detail__date .date')?.textContent),
            bodyText: cleanMultiline(body?.innerText || body?.textContent),
            bodyHtml: body?.innerHTML || '',
            member: clean(document.querySelector('.blog_detail__date .name')?.textContent) || null,
            media,
        }
    }, url)
}

async function extractTicketDetail(page: Page, url: string): Promise<WebsiteDetailPayload> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await waitForRequiredDetailSelector(page, 'ticket', url, '.article__title, .article-content')
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const cleanMultiline = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r/g, '')
                .split('\n')
                .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }

        const body = document.querySelector<HTMLElement>('.article-content')
        const media = Array.from(body?.querySelectorAll('img') || [])
            .map((img) => {
                const src = absolute(img.getAttribute('src'))
                if (!src) {
                    return null
                }
                return {
                    type: 'photo' as const,
                    url: src,
                    alt: clean(img.getAttribute('alt')) || undefined,
                }
            })
            .filter((media): media is { type: 'photo'; url: string; alt: string | undefined } => media !== null)

        const applyUrl =
            document.querySelector<HTMLFormElement>('.article-btn form')?.getAttribute('action') ||
            document.querySelector<HTMLAnchorElement>('.article-btn a')?.getAttribute('href')

        return {
            title: clean(document.querySelector('.article__title')?.textContent),
            dateText: clean(document.querySelector('.article__posted')?.textContent),
            bodyText: cleanMultiline(body?.innerText || body?.textContent),
            bodyHtml: body?.innerHTML || '',
            member: null,
            media,
            extraData: {
                apply_url: absolute(applyUrl),
            },
        }
    }, url)
}

async function extractRadioDetail(page: Page, url: string, listItem: WebsiteListItem): Promise<WebsiteDetailPayload> {
    const brightcove = startBrightcovePlaybackCapture(page)
    let detail: WebsiteDetailPayload
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await waitForRequiredDetailSelector(page, 'radio', url, '.radio__title, #modal-radio, #modal-movie')
        await waitForBrightcovePlayback(page, brightcove, '#modal-radio [data-video-id], #modal-movie [data-video-id]')
        detail = await page.evaluate(
            (currentUrl, playbackByVideoId) => {
                const clean = (value?: string | null) =>
                    (value || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                const cleanMultiline = (value?: string | null) =>
                    (value || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\r/g, '')
                        .split('\n')
                        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                        .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                        .join('\n')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim()
                const absolute = (value?: string | null) => {
                    if (!value) {
                        return null
                    }
                    try {
                        return new URL(value, currentUrl).href
                    } catch {
                        return null
                    }
                }
                const parseBackground = (value?: string | null) => {
                    const match = value?.match(/url\((['"]?)(.*?)\1\)/)
                    return match?.[2] || null
                }

                const thumb = absolute(document.querySelector('.radio__thumb img')?.getAttribute('src'))
                const streamMap = new Map<string, Record<string, any>>()
                Array.from(
                    document.querySelectorAll<HTMLElement>(
                        '#modal-radio [data-video-id], #modal-movie [data-video-id]',
                    ),
                ).forEach((node) => {
                    const videoId = clean(node.getAttribute('data-video-id'))
                    const kind = node.closest('#modal-movie') ? 'movie' : 'radio'
                    const playerRoot = node.closest<HTMLElement>('.video-js')
                    const poster =
                        absolute(node.getAttribute('poster')) ||
                        absolute(
                            parseBackground(
                                playerRoot?.querySelector<HTMLElement>('.vjs-poster')?.getAttribute('style'),
                            ),
                        )
                    const src = absolute(node.getAttribute('src'))
                    if (!videoId && !src && !poster) {
                        return
                    }
                    const key = `${kind}:${videoId || src || poster}`
                    if (streamMap.has(key)) {
                        return
                    }
                    const playback = videoId ? playbackByVideoId[videoId] || null : null
                    streamMap.set(key, {
                        kind,
                        url: src,
                        poster,
                        video_id: videoId || null,
                        account_id: playback?.account_id || null,
                        policy_key: playback?.policy_key || null,
                        playback_api_url: playback?.api_url || null,
                        source_url: playback?.source_url || null,
                        source_codecs: playback?.source_codecs || null,
                        has_video: Boolean(playback?.has_video_codec),
                    })
                })
                const streams = Array.from(streamMap.values())
                    .map((stream) => {
                        if (!stream.url && !stream.poster && !stream.video_id) {
                            return null
                        }
                        return stream
                    })
                    .filter(Boolean)

                const videoStreams = streams.filter(
                    (stream: any) => stream.has_video === true && Boolean(stream.playback_api_url || stream.source_url),
                )
                const primaryVideo = videoStreams.find((stream: any) => stream.kind === 'movie') || videoStreams[0]
                const media = [
                    ...(thumb
                        ? [
                              {
                                  type: 'photo' as const,
                                  url: thumb,
                              },
                          ]
                        : []),
                    // Radio pages also embed an audio-only Brightcove player whose
                    // poster asset is not always downloadable. Attach only the
                    // actual video rendition poster; the renderer generates a
                    // thumbnail from the downloaded video as a fallback anyway.
                    ...videoStreams.flatMap((stream: any) => {
                        if (!stream.poster) {
                            return []
                        }
                        return [
                            {
                                type: 'video_thumbnail' as const,
                                url: stream.poster as string,
                            },
                        ]
                    }),
                    ...(primaryVideo
                        ? [
                              {
                                  type: 'video' as const,
                                  url: String(primaryVideo.playback_api_url || primaryVideo.source_url),
                              },
                          ]
                        : []),
                ]

                const notes = clean(document.querySelector('.radio__notes')?.textContent)
                const accessNote = clean(document.querySelector('#modal-msg .msg')?.textContent)
                const bodyText = [cleanMultiline(document.querySelector('.radio__text')?.textContent), notes]
                    .filter(Boolean)
                    .join('\n\n')

                return {
                    title: clean(document.querySelector('.radio__title')?.textContent),
                    dateText: clean(document.querySelector('.radio__posted')?.textContent),
                    bodyText,
                    bodyHtml: document.querySelector<HTMLElement>('.section-radio-content .content')?.innerHTML || '',
                    member: null,
                    media,
                    extraData: {
                        access_note: accessNote || null,
                        notes: notes || null,
                        streams,
                    },
                } satisfies WebsiteDetailPayload
            },
            url,
            brightcove.records(),
        )
    } finally {
        brightcove.stop()
    }

    const streams = Array.isArray(detail.extraData?.streams) ? detail.extraData.streams : []
    if (streams.length === 0) {
        throw new Error(
            `Website radio detail missing video stream for ${formatSafeWebsiteUrl(url)}; format may have changed`,
        )
    }
    if (!detail.media.some((media) => media.type === 'video')) {
        throw new Error(
            `Website radio detail missing downloadable Brightcove video for ${formatSafeWebsiteUrl(url)}; player API may have changed`,
        )
    }
    return detail
}

async function extractMovieDetail(page: Page, url: string, listItem: WebsiteListItem): Promise<WebsiteDetailPayload> {
    const brightcove = startBrightcovePlaybackCapture(page)
    let detail: WebsiteDetailPayload
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await waitForRequiredDetailSelector(page, 'movie', url, '.movie__title, .movie-player video')
        await waitForBrightcovePlayback(page, brightcove, '.movie-player [data-video-id]')
        detail = await page.evaluate(
            (currentUrl, playbackByVideoId) => {
                const clean = (value?: string | null) =>
                    (value || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                const cleanMultiline = (value?: string | null) =>
                    (value || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\r/g, '')
                        .split('\n')
                        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                        .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                        .join('\n')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim()
                const absolute = (value?: string | null) => {
                    if (!value) {
                        return null
                    }
                    try {
                        return new URL(value, currentUrl).href
                    } catch {
                        return null
                    }
                }
                const parseBackground = (value?: string | null) => {
                    const match = value?.match(/url\((['"]?)(.*?)\1\)/)
                    return match?.[2] || null
                }

                const videoMap = new Map<string, Record<string, any>>()
                Array.from(document.querySelectorAll<HTMLElement>('.movie-player [data-video-id]')).forEach((node) => {
                    const videoId = clean(node.getAttribute('data-video-id'))
                    const playerRoot = node.closest<HTMLElement>('.video-js')
                    const poster =
                        absolute(node.getAttribute('poster')) ||
                        absolute(
                            parseBackground(
                                playerRoot?.querySelector<HTMLElement>('.vjs-poster')?.getAttribute('style'),
                            ),
                        )
                    const src = absolute(node.getAttribute('src'))
                    if (!videoId && !src && !poster) {
                        return
                    }
                    const key = videoId || src || poster || String(videoMap.size)
                    if (videoMap.has(key)) {
                        return
                    }
                    const playback = videoId ? playbackByVideoId[videoId] || null : null
                    videoMap.set(key, {
                        kind: 'movie',
                        url: src,
                        poster,
                        video_id: videoId || null,
                        account_id: playback?.account_id || null,
                        policy_key: playback?.policy_key || null,
                        playback_api_url: playback?.api_url || null,
                        source_url: playback?.source_url || null,
                        source_codecs: playback?.source_codecs || null,
                        has_video: Boolean(playback?.has_video_codec),
                    })
                })
                const videos = Array.from(videoMap.values())
                    .map((video) => {
                        if (!video.url && !video.poster && !video.video_id) {
                            return null
                        }
                        return video
                    })
                    .filter(Boolean)

                const videoStreams = videos.filter(
                    (video: any) => video.has_video === true && Boolean(video.playback_api_url || video.source_url),
                )
                const primaryVideo = videoStreams[0]
                const media = [
                    ...videos.flatMap((video: any) => {
                        if (!video.poster) {
                            return []
                        }
                        return [
                            {
                                type: 'video_thumbnail' as const,
                                url: video.poster as string,
                            },
                        ]
                    }),
                    ...(primaryVideo
                        ? [
                              {
                                  type: 'video' as const,
                                  url: String(primaryVideo.playback_api_url || primaryVideo.source_url),
                              },
                          ]
                        : []),
                ]

                const tags = Array.from(document.querySelectorAll('.movie-tag-list.artist .movie-tag-item'))
                    .map((node) => clean(node.textContent))
                    .filter(Boolean)

                const notes = clean(document.querySelector('.movie__notes')?.textContent)
                const bodyText = [tags.length > 0 ? tags.join(' ') : '', notes].filter(Boolean).join('\n\n')

                return {
                    title: clean(document.querySelector('.movie__title')?.textContent),
                    dateText: clean(document.querySelector('.movie__posted')?.textContent),
                    bodyText: cleanMultiline(bodyText),
                    bodyHtml: document.querySelector<HTMLElement>('.section-movie-content .content')?.innerHTML || '',
                    member: null,
                    media,
                    extraData: {
                        notes: notes || null,
                        tags,
                        streams: videos,
                    },
                } satisfies WebsiteDetailPayload
            },
            url,
            brightcove.records(),
        )
    } finally {
        brightcove.stop()
    }

    const streams = Array.isArray(detail.extraData?.streams) ? detail.extraData.streams : []
    if (streams.length === 0) {
        throw new Error(
            `Website movie detail missing video stream for ${formatSafeWebsiteUrl(url)}; format may have changed`,
        )
    }
    if (!detail.media.some((media) => media.type === 'video')) {
        throw new Error(
            `Website movie detail missing downloadable Brightcove video for ${formatSafeWebsiteUrl(url)}; player API may have changed`,
        )
    }
    return detail
}
async function extractLiveReportDetail(page: Page, url: string): Promise<WebsiteDetailPayload> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await waitForRequiredDetailSelector(
        page,
        'live-report',
        url,
        '.regular-concert-content, .headline__text, .special .regular-concert',
    )
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const cleanMultiline = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r/g, '')
                .split('\n')
                .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, currentUrl).href
            } catch {
                return null
            }
        }
        const body =
            document.querySelector<HTMLElement>('.regular-concert-content') ||
            document.querySelector<HTMLElement>('.special .regular-concert')
        const media = Array.from(body?.querySelectorAll('img') || [])
            .map((img) => {
                const src = absolute(img.getAttribute('src'))
                if (!src) {
                    return null
                }
                return {
                    type: 'photo' as const,
                    url: src,
                    alt: clean(img.getAttribute('alt')) || undefined,
                }
            })
            .filter((media): media is { type: 'photo'; url: string; alt: string | undefined } => media !== null)

        const headline =
            document.querySelector<HTMLElement>('.regular-concert-headline .headline__text') ||
            document.querySelector<HTMLElement>('.regular-concert-headline')

        return {
            title: cleanMultiline(headline?.innerText || headline?.textContent)
                .replace(/\n+/g, ' ')
                .replace(/[<>]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim(),
            dateText: '',
            bodyText: cleanMultiline(body?.innerText || body?.textContent),
            bodyHtml: body?.innerHTML || '',
            member: null,
            media,
        }
    }, url)
}

async function extractPhotoDetailArticles(
    page: Page,
    url: string,
    config: FeedConfig,
    listItem: WebsiteListItem,
): Promise<Array<GenericArticle<Platform.Website>>> {
    // The photo current-collection item uses the gallery url as its detail url;
    // when the list crawl just loaded that very page, reuse it instead of paying
    // a second navigation for the same URL.
    const alreadyOnPage = page.url().split('#')[0] === url
    if (!alreadyOnPage) {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
    }
    await page.waitForSelector('.photo-block, .photo-modal', { timeout: 15000 })

    const payload = (await page.evaluate(() => {
        const clean = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        const cleanMultiline = (value?: string | null) =>
            (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\r/g, '')
                .split('\n')
                .map((line) => line.replace(/[ \t]+/g, ' ').trim())
                .filter((line, index, arr) => Boolean(line) || (arr[index - 1] && arr[index + 1]))
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
        const absolute = (value?: string | null) => {
            if (!value) {
                return null
            }
            try {
                return new URL(value, location.href).href
            } catch {
                return null
            }
        }

        const currentUrl = location.href
        const parsed = new URL(currentUrl)
        const albumId = parsed.searchParams.get('ct') || parsed.pathname.split('/').filter(Boolean).pop() || 'photo'
        const pageTheme = clean(document.querySelector('.headline__title')?.textContent)
        const modalDateMap = new Map<string, string>()

        for (const block of Array.from(document.querySelectorAll('.photo-block'))) {
            const dateText = clean(block.querySelector('.photo__posted')?.textContent)
            const modalIds = Array.from(block.querySelectorAll('.photo__img'))
                .map((anchor) => (anchor.getAttribute('href') || '').replace(/^#/, ''))
                .filter(Boolean)
            modalIds.forEach((modalId) => modalDateMap.set(modalId, dateText))
        }

        const entries = Array.from(document.querySelectorAll<HTMLElement>('.photo-modal'))
            .map((modal) => {
                const modalId = modal.id
                const theme = clean(modal.querySelector('.photo-modal-thema__title')?.textContent) || pageTheme
                const member = clean(modal.querySelector('.photo-modal__artiname')?.textContent)
                const photoUrl = absolute(modal.querySelector('.photo-modal__img img')?.getAttribute('src'))
                const avatarUrl = absolute(modal.querySelector('.photo-modal__artiimag img')?.getAttribute('src'))
                const text = cleanMultiline(modal.querySelector('.photo-modal__text')?.textContent)
                const dataCode = clean(modal.querySelector('.photo-modal-favorite__icon')?.getAttribute('data-code'))
                const title = [theme, member].filter(Boolean).join(' - ')
                if (!modalId) {
                    return null
                }
                return {
                    modalId,
                    dataCode: dataCode || null,
                    articleId: `${albumId}:${dataCode || modalId}`,
                    detailUrl: `${currentUrl}#${modalId}`,
                    title,
                    dateText: modalDateMap.get(modalId) || '',
                    member: member || null,
                    bodyText: text,
                    bodyHtml: modal.innerHTML,
                    media: photoUrl
                        ? [
                              {
                                  type: 'photo' as const,
                                  url: photoUrl,
                                  alt: member || undefined,
                              },
                          ]
                        : [],
                    uAvatar: avatarUrl,
                    extraData: {
                        album_id: albumId,
                        theme,
                        modal_id: modalId,
                        photo_code: dataCode || null,
                    },
                }
            })
            .filter(Boolean)

        return {
            currentUrl,
            albumId,
            pageTheme,
            entries,
        }
    })) as WebsitePhotoAlbumPayload

    return splitPhotoAlbumPayloadByDate(payload).flatMap((groupedPayload) =>
        buildPhotoAlbumArticle(config, listItem, groupedPayload),
    )
}

function extractListPage(page: Page, feedConfig: FeedConfig, url: string): Promise<WebsiteListPageResult> {
    switch (feedConfig.feed) {
        case 'official-news':
            return extractNewsList(page, url)
        case 'fc-news':
        case 'ticket':
            return extractStandardEntryList(page, url, {
                waitForSelector: '.entry-list .entry-item',
                itemSelector: '.entry-list .entry-item',
                detailSelector: 'a.panel',
                titleSelector: '.entry__title',
                dateSelector: '.entry__posted',
            })
        case 'official-blog':
            return extractBlogList(page, url)
        case 'radio':
            return extractRadioList(page, url)
        case 'movie':
            return extractMovieList(page, url)
        case 'photo':
            return extractPhotoList(page, url)
        case 'live-report':
            return extractLiveReportList(page, url)
        default:
            throw new Error(`Unsupported website feed: ${feedConfig.feed}`)
    }
}

function extractDetailPayload(
    page: Page,
    feedConfig: FeedConfig,
    url: string,
    listItem: WebsiteListItem,
): Promise<WebsiteDetailPayload> {
    switch (feedConfig.feed) {
        case 'official-news':
        case 'fc-news':
            return extractNewsDetail(page, url, feedConfig.feed)
        case 'official-blog':
            return extractBlogDetail(page, url)
        case 'ticket':
            return extractTicketDetail(page, url)
        case 'radio':
            return extractRadioDetail(page, url, listItem)
        case 'movie':
            return extractMovieDetail(page, url, listItem)
        case 'live-report':
            return extractLiveReportDetail(page, url)
        default:
            throw new Error(`Unsupported website detail feed: ${feedConfig.feed}`)
    }
}

class NanabunnonijyuuniWebsiteSpider extends BaseSpider {
    static _VALID_URL =
        /^https?:\/\/nanabunnonijyuuni-mobile\.com\/s\/n110\/(?:(?:news\/(?:list|detail\/[^/?#]+))|(?:ticket\/(?:list|detail\/[^/?#]+))|(?:diary\/(?:official_blog\/list|nananiji_movie(?:\/list)?|special\/list|detail\/\d+))|(?:contents_list)|(?:contents\/[^/?#]+)|(?:gallery(?:\/[^/?#]+)?))(?:\?.*)?$/i
    static _PLATFORM = Platform.Website
    BASE_URL = `https://${MOBILE_227_HOST}/`
    NAME = '22/7 Website Spider'

    static resolveFeed(url: string): FeedConfig | null {
        const parsed = tryParseWebsiteUrl(url)
        if (!parsed || parsed.hostname !== MOBILE_227_HOST) {
            return null
        }

        if (parsed.pathname === '/s/n110/news/list') {
            return parsed.searchParams.get('ct') === 'news' ? FEED_CONFIGS['fc-news'] : FEED_CONFIGS['official-news']
        }

        if (isNewsDetail(parsed.pathname)) {
            return FEED_CONFIGS['fc-news']
        }

        if (parsed.pathname === '/s/n110/diary/official_blog/list') {
            return FEED_CONFIGS['official-blog']
        }

        if (parsed.pathname === '/s/n110/ticket/list' || isTicketDetail(parsed.pathname)) {
            return FEED_CONFIGS.ticket
        }

        if (isRadioList(parsed) || isRadioDetail(parsed.pathname)) {
            return FEED_CONFIGS.radio
        }

        if (
            isMovieList(parsed) ||
            (isDiaryDetail(parsed.pathname) && parsed.searchParams.get('cd') === 'nananiji_movie')
        ) {
            return FEED_CONFIGS.movie
        }

        if (isPhotoList(parsed) || isPhotoDetail(parsed)) {
            return FEED_CONFIGS.photo
        }

        if (
            isLiveReportList(parsed) ||
            (isDiaryDetail(parsed.pathname) && parsed.searchParams.get('cd') === 'special')
        ) {
            return FEED_CONFIGS['live-report']
        }

        if (isDiaryDetail(parsed.pathname)) {
            return FEED_CONFIGS['official-blog']
        }

        return null
    }

    static extractBasicInfo(url: string) {
        const config = NanabunnonijyuuniWebsiteSpider.resolveFeed(url)
        if (!config) {
            return undefined
        }
        return {
            u_id: config.u_id,
            platform: Platform.Website,
        }
    }

    async _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: {
            task_type: T
            crawl_engine: CrawlEngine
            sub_task_type?: Array<string>
            cookieString?: string
            max_list_pages?: number
            max_detail_count?: number
            detail_interval_time?: {
                min?: number
                max?: number
            }
            block_resource_types?: Array<string>
            isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
            articleStateLookup?: (
                a_id: string,
            ) => Promise<{ known: boolean; createdAt: number | null; crawledAt?: number | null }>
            articlePrefixStateLookup?: (
                prefix: string,
            ) => Promise<{ known: boolean; createdAt: number | null; crawledAt?: number | null }>
        },
    ): Promise<TaskTypeResult<T, Platform.Website>> {
        if (config.task_type !== 'article') {
            throw new Error('Website spider only supports article tasks')
        }
        if (!page) {
            throw new Error('Website spider requires a browser page in mobile mode')
        }

        const feedConfig = NanabunnonijyuuniWebsiteSpider.resolveFeed(url)
        if (!feedConfig) {
            throw new Error(`Unsupported website url: ${url}`)
        }

        const crawlOptions = resolveWebsiteCrawlOptions(config)
        const effectiveCrawlOptions = {
            ...crawlOptions,
            blockResourceTypes: resolveWebsiteFeedResourceBlocking(feedConfig.feed, crawlOptions.blockResourceTypes),
        }
        await configureWebsiteResourceBlocking(page, effectiveCrawlOptions.blockResourceTypes)

        if (isDetailUrl(feedConfig.feed, url)) {
            const articles = await this.crawlSingleDetail(page, feedConfig, {
                detailUrl: url,
                title: '',
                dateText: '',
            })
            return articles as TaskTypeResult<T, Platform.Website>
        }

        const articles = await this.crawlFeed(
            page,
            feedConfig,
            url,
            effectiveCrawlOptions,
            config.isArticleKnown,
            config.articleStateLookup,
            config.articlePrefixStateLookup,
        )
        return articles as TaskTypeResult<T, Platform.Website>
    }

    // Mutable feeds re-crawl detail pages by default; once the article is stored a
    // TTL-gated re-crawl keeps content changes (stream urls, ticket state) flowing
    // without paying a full detail pass for unchanged pages every round.
    private async crawlFeed(
        page: Page,
        feedConfig: FeedConfig,
        url: string,
        options: ResolvedWebsiteCrawlOptions,
        isArticleKnown?: (a_id: string) => Promise<boolean> | boolean,
        articleStateLookup?: (
            a_id: string,
        ) => Promise<{ known: boolean; createdAt: number | null; crawledAt?: number | null }>,
        articlePrefixStateLookup?: (
            prefix: string,
        ) => Promise<{ known: boolean; createdAt: number | null; crawledAt?: number | null }>,
    ) {
        const discovered = new Map<string, WebsiteListItem>()
        let currentUrl: string | null = url
        let pageCount = 0

        while (currentUrl && pageCount < options.maxListPages) {
            const result: WebsiteListPageResult = await retryTransient(
                () => extractListPage(page, feedConfig, currentUrl as string),
                `list page ${currentUrl}`,
            )
            result.items.forEach((item) => {
                const detailKey = getDetailKey(feedConfig, item.detailUrl)
                if (!discovered.has(detailKey)) {
                    discovered.set(detailKey, item)
                }
            })
            pageCount += 1
            // The newest page already covers the detail budget; older pages are pure waste.
            if (discovered.size >= options.maxDetailCount) {
                break
            }
            // Immutable feeds are newest-first: when every item on this page is
            // already stored, older pages cannot contain anything new either.
            if (IMMUTABLE_DETAIL_FEEDS.has(feedConfig.feed) && isArticleKnown && result.items.length > 0) {
                const states = await Promise.all(
                    result.items.map((item) =>
                        Promise.resolve(isArticleKnown(getDetailKey(feedConfig, item.detailUrl))).catch(() => false),
                    ),
                )
                if (states.every(Boolean)) {
                    break
                }
            }
            currentUrl = result.nextUrl || null
        }

        const articles: Array<GenericArticle<Platform.Website>> = []
        const failedDetails = [] as Array<{ url: string; error: unknown }>
        let detailBudgetUsed = 0
        for (const item of discovered.values()) {
            const detailKey = getDetailKey(feedConfig, item.detailUrl)
            // Immutable feeds: known details are never re-crawled.
            if (IMMUTABLE_DETAIL_FEEDS.has(feedConfig.feed) && isArticleKnown) {
                try {
                    if (await isArticleKnown(detailKey)) {
                        continue
                    }
                } catch {
                    // fall through to a full re-fetch on lookup error
                }
            }
            // Mutable feeds (radio/movie/ticket): TTL-gated re-crawl.
            const mutableTtl = MUTABLE_DETAIL_TTL_S[feedConfig.feed]
            if (mutableTtl != null && articleStateLookup) {
                try {
                    const state = await articleStateLookup(detailKey)
                    const lastCrawledAt = state?.crawledAt ?? state?.createdAt ?? null
                    if (
                        state?.known &&
                        typeof lastCrawledAt === 'number' &&
                        Date.now() / 1000 - lastCrawledAt <= mutableTtl
                    ) {
                        continue
                    }
                } catch {
                    // fall through on lookup error
                }
            }
            // Photo archives: prefix lookup + TTL; the current collection is
            // always crawled (its detailUrl is the gallery url itself).
            if (feedConfig.feed === 'photo' && item.detailUrl !== url && articlePrefixStateLookup) {
                try {
                    const parsed = new URL(item.detailUrl)
                    const albumId = parsed.searchParams.get('ct')
                    if (albumId) {
                        const state = await articlePrefixStateLookup(`photo:album:${albumId}:`)
                        const lastCrawledAt = state?.crawledAt ?? state?.createdAt ?? null
                        if (
                            state?.known &&
                            typeof lastCrawledAt === 'number' &&
                            Date.now() / 1000 - lastCrawledAt <= PHOTO_ARCHIVE_TTL_S
                        ) {
                            continue
                        }
                    }
                } catch {
                    // fall through on lookup error
                }
            }
            if (detailBudgetUsed > 0) {
                const waitTime = randomInterval(options.detailIntervalTime)
                if (waitTime > 0) {
                    await sleep(waitTime)
                }
            }
            try {
                articles.push(
                    ...(await retryTransient(
                        () => this.crawlSingleDetail(page, feedConfig, item),
                        `detail ${item.detailUrl}`,
                    )),
                )
            } catch (error) {
                // Auth/rate-limit and structural (parser) failures keep the original
                // whole-round semantics. Only exhausted transient failures degrade to a
                // partial round instead of re-running every page and detail from scratch.
                if (!isTransientWebsiteError(error)) {
                    throw error
                }
                failedDetails.push({ url: item.detailUrl, error })
                this.log?.warn(
                    `Website crawl partial: detail failed after retry ${formatSafeWebsiteUrl(item.detailUrl)}: ${websiteErrorMessage(error)}`,
                )
            }
            detailBudgetUsed += 1
            if (detailBudgetUsed >= options.maxDetailCount) {
                break
            }
        }

        this.log?.info(
            `Website crawl budget feed=${feedConfig.feed} pages=${pageCount}/${options.maxListPages} details=${detailBudgetUsed}/${options.maxDetailCount} discovered=${discovered.size} blocked=${options.blockResourceTypes.join(',') || 'none'}`,
        )

        const firstFailure = failedDetails[0]
        if (articles.length === 0 && firstFailure) {
            throw firstFailure.error
        }

        return articles.sort((a, b) => b.created_at - a.created_at)
    }

    private async crawlSingleDetail(page: Page, feedConfig: FeedConfig, listItem: WebsiteListItem) {
        if (feedConfig.feed === 'photo') {
            return extractPhotoDetailArticles(page, listItem.detailUrl, feedConfig, listItem)
        }

        const detailPayload = await extractDetailPayload(page, feedConfig, listItem.detailUrl, listItem)
        return [buildWebsiteArticle(feedConfig, listItem.detailUrl, listItem, detailPayload)]
    }
}

export { NanabunnonijyuuniWebsiteSpider, resolveWebsiteCrawlOptions }
