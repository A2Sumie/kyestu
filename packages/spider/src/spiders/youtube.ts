import { Platform } from '../types'
import type { GenericMediaInfo, GenericArticle, TaskType, TaskTypeResult, CrawlEngine } from '../types'
import { BaseSpider } from './base'
import { Page } from 'puppeteer-core'

import { JSONPath } from 'jsonpath-plus'
import { getCookieString, HTTPClient, UserAgent, SimpleExpiringCache } from '../utils'
import dayjs, { type ManipulateType } from 'dayjs'

const DEFAULT_YOUTUBE_HYDRATE_LIMIT = 8
const MAX_YOUTUBE_HYDRATE_LIMIT = 20
const DEFAULT_YOUTUBE_HYDRATE_CONCURRENCY = 2
const MAX_YOUTUBE_HYDRATE_CONCURRENCY = 4
const YOUTUBE_LIST_TIMEOUT_MS = 15000
const YOUTUBE_DETAIL_TIMEOUT_MS = 10000

enum ArticleTypeEnum {
    /**
     * https://www.youtube.com/@username/videos
     */
    VIDEO = 'video',
    /**
     * https://www.youtube.com/@username/shorts
     */
    SHORTS = 'shorts',
}

type YoutubeCrawlConfig<T extends TaskType> = {
    task_type: T
    crawl_engine: CrawlEngine
    sub_task_type?: Array<string>
    hydrate_users?: Array<string>
    hydrate_limit?: number
    hydrate_concurrency?: number
    hydrate_interval_time?: {
        min?: number
        max?: number
    }
    cookieString?: string
    requestHeaders?: Record<string, string>
    max_list_pages?: number
    max_detail_count?: number
    detail_interval_time?: {
        min?: number
        max?: number
    }
    block_resource_types?: Array<string>
    isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
    articleStateLookup?: (a_id: string) => Promise<{
        known: boolean
        createdAt?: number | null
        crawledAt?: number | null
        storedPremierePending?: boolean
    }>
    articlePrefixStateLookup?: (prefix: string) => Promise<{
        known: boolean
        createdAt: number | null
        crawledAt?: number | null
    }>
    isStoredPremierePending?: (a_id: string) => Promise<boolean>
}

class YoutubeSpider extends BaseSpider {
    // extends from XBaseSpider regex. Besides channel pages (`/@handle`), single
    // video URLs (watch/shorts/live, youtu.be) are accepted: X-link ingest
    // dispatches one-shot scheduled runs for videos linked from posts, and those
    // must resolve to this spider instead of dying with "Spider not found".
    static _VALID_URL =
        /^(?:https:\/\/)?(?:(?:www\.|m\.)?youtube\.com\/(?:@(?<id>[^/?#]+)|watch\?(?=[^\s#]*\bv=)|shorts\/[A-Za-z0-9_-]{6,128}|live\/[A-Za-z0-9_-]{6,128})|youtu\.be\/[A-Za-z0-9_-]{6,128})/
    static _PLATFORM = Platform.YouTube
    BASE_URL: string = 'https://www.youtube.com/'
    NAME: string = 'Youtube Generic Spider'

    async _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: YoutubeCrawlConfig<T>,
    ): Promise<TaskTypeResult<T, Platform.YouTube>> {
        const { task_type } = config
        if (task_type !== 'article') {
            throw new Error('Invalid task type')
        }

        const videoId = YoutubeApiJsonParser.parseVideoId(url)
        if (videoId) {
            // Single-video crawl (X-link ingest): fetch the watch page directly,
            // no channel tabs involved. The page instance is not needed.
            this.log?.info(`Trying to grab video ${videoId}.`)
            const article = await YoutubeApiJsonParser.grabVideo(videoId, {
                cookieString: config.cookieString,
                requestHeaders: config.requestHeaders,
            })
            return [article] as TaskTypeResult<T, Platform.YouTube>
        }

        const result = super._match_valid_url(url, YoutubeSpider)?.groups
        if (!result?.id) {
            throw new Error(`Invalid URL: ${url}`)
        }
        const { id } = result
        const _url = `${this.BASE_URL}@${id}`

        if (!page) {
            throw new Error('YouTube spider requires a Page instance')
        }

        this.log?.info('Trying to grab videos and shorts.')
        const res = await YoutubeApiJsonParser.grabArticles(page, _url, {
            hydrate_limit: config.hydrate_limit,
            hydrate_concurrency: config.hydrate_concurrency,
            hydrate_interval_time: config.hydrate_interval_time,
            isArticleKnown: config.isArticleKnown,
            isStoredPremierePending: config.isStoredPremierePending,
            articleStateLookup: config.articleStateLookup,
            cookieString: config.cookieString,
            requestHeaders: config.requestHeaders,
            cache: this.cache,
        })

        return res as TaskTypeResult<T, Platform.YouTube>
    }
}

namespace YoutubeApiJsonParser {
    type YoutubeArticle = GenericArticle<Platform.YouTube>

    interface ChannelMeta {
        handle: string
        title: string
        avatar: string | null
    }

    interface YoutubeDetail {
        created_at: number
        title: string | null
        description: string | null
        thumbnail: string | null
        is_premiere_pending: boolean
        scheduled_start_at: number | null
        owner_handle: string | null
        owner_name: string | null
        members_only: boolean
    }

    interface GrabVideoOptions {
        cookieString?: string
        requestHeaders?: Record<string, string>
    }

    const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,128}$/
    // Watch pages of members-only videos report UNPLAYABLE/LOGIN_REQUIRED with this
    // reason (hl=en is forced by addLocaleQuery, so the English wording is stable).
    const MEMBERS_ONLY_REASON_RE = /members?[-\s]?only/i

    /**
     * Extract the video id from any single-video YouTube URL shape
     * (watch?v=, /shorts/, /live/, youtu.be). Returns null for channel URLs.
     */
    export function parseVideoId(rawUrl: string): string | null {
        let url: URL
        try {
            url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
        } catch {
            return null
        }
        const hostname = url.hostname.toLowerCase()
        const normalize = (value?: string | null) => (value && YOUTUBE_VIDEO_ID_RE.test(value) ? value : null)
        if (hostname === 'youtu.be') {
            return normalize(url.pathname.split('/').filter(Boolean)[0])
        }
        if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) {
            return null
        }
        if (url.pathname === '/watch') {
            return normalize(url.searchParams.get('v'))
        }
        const parts = url.pathname.split('/').filter(Boolean)
        if (['shorts', 'live', 'embed'].includes(parts[0] || '')) {
            return normalize(parts[1])
        }
        return null
    }

    interface GrabArticlesOptions {
        hydrate_limit?: number
        hydrate_concurrency?: number
        hydrate_interval_time?: {
            min?: number
            max?: number
        }
        isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
        isStoredPremierePending?: (a_id: string) => Promise<boolean> | boolean
        articleStateLookup?: (a_id: string) => Promise<{
            known: boolean
            createdAt?: number | null
            crawledAt?: number | null
            storedPremierePending?: boolean
        }>
        cookieString?: string
        requestHeaders?: Record<string, string>
        cache?: SimpleExpiringCache
    }

    const LOCALE_QUERY = 'hl=en&persist_hl=1&gl=US'
    // Pending premieres used to be re-hydrated from the detail page every round (the
    // only way to detect resolution). Re-checking on a TTL keeps detection while
    // removing the per-round detail fetch for scheduled events that are days away.
    const PREMIERE_RECHECK_TTL_S = 600

    async function downloadListPage(url: string, headers: Record<string, string>) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await HTTPClient.download_webpage(url, headers, { timeout: YOUTUBE_LIST_TIMEOUT_MS })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const transient =
                    /timeout|timed out|network|fetch failed|econnreset|socket hang up|(^|\s)50\d(\s|$)/i.test(message)
                if (!transient || attempt >= 1) {
                    throw error
                }
                await delay(600 * (attempt + 1))
            }
        }
    }

    function normalizeUrl(url?: string | null): string | null {
        if (!url) {
            return null
        }
        if (url.startsWith('//')) {
            return `https:${url}`
        }
        return url.replaceAll('\\u0026', '&')
    }

    function stripHandlePrefix(handle: string): string {
        return handle.replace(/^@/, '')
    }

    function addLocaleQuery(url: string): string {
        const _url = new URL(url)
        _url.searchParams.set('hl', 'en')
        _url.searchParams.set('persist_hl', '1')
        _url.searchParams.set('gl', 'US')
        return _url.toString()
    }

    function textParser(node: any): string {
        if (!node) {
            return ''
        }
        if (typeof node === 'string') {
            return node
        }
        if (typeof node?.simpleText === 'string') {
            return node.simpleText
        }
        if (typeof node?.content === 'string') {
            return node.content
        }
        if (Array.isArray(node?.runs)) {
            return node.runs.map((item: any) => textParser(item)).join('')
        }
        if (Array.isArray(node)) {
            return node.map((item) => textParser(item)).join('')
        }
        if (typeof node?.text === 'string') {
            return node.text
        }
        return ''
    }

    function pickLargestThumbnail(thumbnails?: Array<{ url?: string; width?: number }>): string | null {
        if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
            return null
        }
        const sorted = [...thumbnails].sort((a, b) => (b?.width || 0) - (a?.width || 0))
        return normalizeUrl(sorted[0]?.url)
    }

    function thumbnailParser(node: any): string | null {
        return (
            pickLargestThumbnail(node?.thumbnails) ||
            pickLargestThumbnail(node?.image?.thumbnails) ||
            pickLargestThumbnail(node?.sources)
        )
    }

    function extractAssignedObject<T>(text: string, variableName: string): T | null {
        const assignmentIndex = text.indexOf(variableName)
        if (assignmentIndex === -1) {
            return null
        }
        const startIndex = text.indexOf('{', assignmentIndex)
        if (startIndex === -1) {
            return null
        }

        let depth = 0
        let inString = false
        let escaped = false
        for (let i = startIndex; i < text.length; i++) {
            const char = text[i]
            if (inString) {
                if (escaped) {
                    escaped = false
                } else if (char === '\\') {
                    escaped = true
                } else if (char === '"') {
                    inString = false
                }
                continue
            }

            if (char === '"') {
                inString = true
                continue
            }
            if (char === '{') {
                depth += 1
                continue
            }
            if (char === '}') {
                depth -= 1
                if (depth === 0) {
                    try {
                        return JSON.parse(text.slice(startIndex, i + 1)) as T
                    } catch {
                        return null
                    }
                }
            }
        }
        return null
    }

    function buildContent(title?: string | null, description?: string | null): string | null {
        const parts = [title?.trim(), description?.trim()].filter((part): part is string => Boolean(part))
        if (parts.length === 0) {
            return null
        }
        if (parts.length === 2 && parts[0] === parts[1]) {
            return parts[0] || null
        }
        return parts.join('\n\n') || null
    }

    function mediaParser(url: string | null): Array<GenericMediaInfo> {
        if (!url) {
            return []
        }
        return [
            {
                type: 'video_thumbnail',
                url,
            },
        ]
    }

    function isPremierePlaceholderTitle(value?: string | null) {
        const normalized = String(value || '')
            .trim()
            .replace(/[.。…!！\s]+$/g, '')
        return /^(coming soon|premiere|premiering soon|upcoming)$/i.test(normalized)
    }

    function buildPremiereExtra(detail: Pick<YoutubeDetail, 'is_premiere_pending' | 'scheduled_start_at'>): any {
        if (!detail.is_premiere_pending && !detail.scheduled_start_at) {
            return null
        }
        return {
            data: {
                premiere: {
                    pending: detail.is_premiere_pending,
                    scheduled_start_at: detail.scheduled_start_at,
                    resolved_at: detail.is_premiere_pending ? null : dayjs().unix(),
                },
            },
        }
    }

    function buildMembersOnlyFlagExtra(membersOnly: boolean): any {
        return membersOnly ? { data: { members_only: true } } : null
    }

    /**
     * Merge article extras shallowly by `data` key. Hydration used to replace the
     * list-page extra with the premiere extra (`premiereExtra || article.extra`),
     * which silently dropped the members_only flag on members-only premieres —
     * exactly the content class that needs it. Later extras win per key.
     */
    function mergeArticleExtras(...extras: Array<any>): any {
        const data: Record<string, any> = {}
        for (const extra of extras) {
            if (extra?.data && typeof extra.data === 'object') {
                Object.assign(data, extra.data)
            }
        }
        return Object.keys(data).length > 0 ? { data } : null
    }

    function isPremierePendingArticle(article: YoutubeArticle) {
        const extra = article.extra?.data as any
        return Boolean(extra?.premiere?.pending) || isPremierePlaceholderTitle(article.content?.split('\n')[0])
    }

    function firstString(values: Array<unknown>): string {
        return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() || ''
    }

    /**
     *
     * @param relativeTime like "1 hour ago", "2 days ago"
     * @description parse relative time to timestamp
     * @returns timestamp
     */
    function relativeTimeParser(relativeTime?: string | null): number {
        if (!relativeTime || !/ago/i.test(relativeTime)) {
            return 0
        }
        const matched = relativeTime.match(/(\d+)\s+(\w+)/)
        if (!matched) {
            return 0
        }
        const [, number, unit] = matched
        return dayjs()
            .subtract(parseInt(number || '0'), unit as ManipulateType)
            .unix()
    }

    export function channelMetaParser(json: any, fallbackHandle: string): ChannelMeta {
        if (!json) {
            return {
                handle: stripHandlePrefix(fallbackHandle),
                title: stripHandlePrefix(fallbackHandle),
                avatar: null,
            }
        }
        const header = JSONPath({
            path: '$..c4TabbedHeaderRenderer',
            json,
        })[0]
        const metadata = JSONPath({
            path: '$..channelMetadataRenderer',
            json,
        })[0]
        const handleText =
            textParser(header?.channelHandleText) || metadata?.vanityChannelUrl?.split('/').pop() || fallbackHandle
        return {
            handle: stripHandlePrefix(handleText || fallbackHandle),
            title: textParser(header?.title) || metadata?.title || stripHandlePrefix(fallbackHandle),
            avatar:
                pickLargestThumbnail(header?.avatar?.thumbnails) || pickLargestThumbnail(metadata?.avatar?.thumbnails),
        }
    }

    function videoParser(item: any, channelMeta: ChannelMeta): YoutubeArticle | null {
        const videoId = item?.videoId
        if (!videoId) {
            return null
        }
        const title = textParser(item?.title)
        const description = textParser(item?.descriptionSnippet)
        const thumbnail = thumbnailParser(item?.thumbnail)
        const media = mediaParser(thumbnail)
        return {
            platform: Platform.YouTube,
            a_id: videoId,
            u_id: channelMeta.handle,
            username: channelMeta.title,
            created_at: relativeTimeParser(textParser(item?.publishedTimeText)),
            content: buildContent(title, description),
            url: `https://www.youtube.com/watch?v=${videoId}`,
            type: ArticleTypeEnum.VIDEO,
            ref: null,
            has_media: media.length > 0,
            media,
            extra: buildMembersOnlyExtra(item),
            u_avatar: channelMeta.avatar,
        }
    }

    function isMembersOnlyItem(item: any): boolean {
        const badges = JSONPath({ path: '$..badgeViewModel', json: item }) as Array<any>
        return badges.some((badge) => {
            const style = String(badge?.badgeStyle || '').toUpperCase()
            const text = String(badge?.badgeText || '').toLowerCase()
            return style.includes('MEMBER') || text.includes('members only')
        })
    }

    function buildMembersOnlyExtra(item: any): any {
        return isMembersOnlyItem(item) ? { data: { members_only: true } } : null
    }

    function lockupMetadataTextParts(item: any): Array<string> {
        const rows = item?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows
        if (!Array.isArray(rows)) {
            return []
        }
        return rows.flatMap((row: any) => {
            if (!Array.isArray(row?.metadataParts)) {
                return []
            }
            return row.metadataParts
                .map((part: any) => textParser(part?.text) || part?.accessibilityLabel)
                .map((text: string) => text.trim())
                .filter(Boolean)
        })
    }

    function lockupVideoParser(item: any, channelMeta: ChannelMeta): YoutubeArticle | null {
        const contentType = String(item?.contentType || '')
        if (contentType && !contentType.includes('VIDEO')) {
            return null
        }
        const videoId =
            item?.contentId ||
            firstString(JSONPath({ path: '$..watchEndpoint.videoId', json: item })) ||
            firstString(JSONPath({ path: '$..addToPlaylistCommand.videoId', json: item }))
        if (!videoId) {
            return null
        }

        const title = textParser(item?.metadata?.lockupMetadataViewModel?.title)
        const publishedText = lockupMetadataTextParts(item).find((text) => /ago/i.test(text)) || ''
        const thumbnail =
            thumbnailParser(item?.contentImage?.thumbnailViewModel?.image) ||
            thumbnailParser(item?.contentImage?.thumbnailViewModel)
        const media = mediaParser(thumbnail)
        return {
            platform: Platform.YouTube,
            a_id: videoId,
            u_id: channelMeta.handle,
            username: channelMeta.title,
            created_at: relativeTimeParser(publishedText),
            content: buildContent(title, null),
            url: `https://www.youtube.com/watch?v=${videoId}`,
            type: ArticleTypeEnum.VIDEO,
            ref: null,
            has_media: media.length > 0,
            media,
            extra: buildMembersOnlyExtra(item),
            u_avatar: channelMeta.avatar,
        }
    }

    function shortsParserItem(item: any, channelMeta: ChannelMeta): YoutubeArticle | null {
        const videoId =
            item?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
            item?.navigationEndpoint?.reelWatchEndpoint?.videoId
        if (!videoId) {
            return null
        }
        const title = textParser(item?.overlayMetadata?.primaryText) || textParser(item?.accessibilityText)
        const thumbnail = thumbnailParser(item?.thumbnail)
        const media = mediaParser(thumbnail)
        return {
            platform: Platform.YouTube,
            a_id: videoId,
            u_id: channelMeta.handle,
            username: channelMeta.title,
            created_at: relativeTimeParser(
                textParser(item?.timestampText) || textParser(item?.overlayMetadata?.secondaryText),
            ),
            content: buildContent(title, null),
            url: `https://www.youtube.com/shorts/${videoId}`,
            type: ArticleTypeEnum.SHORTS,
            ref: null,
            has_media: media.length > 0,
            media,
            extra: null,
            u_avatar: channelMeta.avatar,
        }
    }

    export function videosParser(json: any, channelMeta: ChannelMeta): Array<YoutubeArticle> {
        if (!json) {
            return []
        }
        const videoRendererItems = JSONPath({
            path: '$..videoRenderer',
            json,
        })
        const lockupItems = JSONPath({
            path: '$..lockupViewModel',
            json,
        })
        const articles = [
            ...videoRendererItems.map((item: any) => videoParser(item, channelMeta)),
            ...lockupItems.map((item: any) => lockupVideoParser(item, channelMeta)),
        ].filter((item): item is YoutubeArticle => Boolean(item))

        const dedup = new Map<string, YoutubeArticle>()
        for (const article of articles) {
            dedup.set(article.a_id, article)
        }
        return Array.from(dedup.values())
    }

    export function shortsParser(json: any, channelMeta: ChannelMeta): Array<YoutubeArticle> {
        if (!json) {
            return []
        }
        const items = JSONPath({
            path: '$..shortsLockupViewModel',
            json,
        }) as Array<any>
        return items
            .map((item: any) => shortsParserItem(item, channelMeta))
            .filter((item): item is YoutubeArticle => Boolean(item))
    }

    export function detailParser(text: string): YoutubeDetail {
        const initialPlayerResponse = extractAssignedObject<any>(text, 'ytInitialPlayerResponse')
        const microformat = initialPlayerResponse?.microformat?.playerMicroformatRenderer
        const videoDetails = initialPlayerResponse?.videoDetails
        const thumbnail =
            pickLargestThumbnail(microformat?.thumbnail?.thumbnails) ||
            pickLargestThumbnail(videoDetails?.thumbnail?.thumbnails)
        const publishedAt = microformat?.publishDate || microformat?.uploadDate
        const liveDetails =
            microformat?.liveBroadcastDetails ||
            initialPlayerResponse?.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer
        const scheduledStartText =
            liveDetails?.startTimestamp || liveDetails?.offlineSlate?.liveStreamOfflineSlateRenderer?.scheduledStartTime
        const scheduled_start_at = scheduledStartText ? dayjs(scheduledStartText).unix() || null : null
        const title = videoDetails?.title || textParser(microformat?.title)
        const playability = initialPlayerResponse?.playabilityStatus
        const playabilityStatus = String(playability?.status || '')
        const isUpcoming =
            Boolean(videoDetails?.isUpcoming) ||
            playabilityStatus === 'LIVE_STREAM_OFFLINE' ||
            Boolean(playability?.liveStreamability)
        const is_premiere_pending = Boolean(isUpcoming || isPremierePlaceholderTitle(title))
        const created_at = scheduled_start_at || (publishedAt ? dayjs(publishedAt).unix() : 0)
        const ownerHandleMatch = String(microformat?.ownerProfileUrl || '').match(/@([^/?#]+)/)
        // Members-only videos are UNPLAYABLE/LOGIN_REQUIRED for a non-member jar and
        // explain it in the reason text ("Join this channel to get access to
        // members-only content ..."). Require both so region locks etc. never flag.
        const unplayable = playabilityStatus === 'UNPLAYABLE' || playabilityStatus === 'LOGIN_REQUIRED'
        const reasonText = [
            textParser(playability?.reason),
            textParser(playability?.errorScreen?.playerErrorMessageRenderer?.reason),
            textParser(playability?.errorScreen?.playerErrorMessageRenderer?.subreason),
        ].join('\n')
        const members_only = unplayable && MEMBERS_ONLY_REASON_RE.test(reasonText)
        return {
            created_at,
            title,
            description: videoDetails?.shortDescription || textParser(microformat?.description),
            thumbnail,
            is_premiere_pending,
            scheduled_start_at,
            owner_handle: ownerHandleMatch?.[1] || null,
            owner_name: microformat?.ownerChannelName || null,
            members_only,
        }
    }

    function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
        if (!Number.isFinite(value) || !value) {
            return fallback
        }
        return Math.max(0, Math.min(Math.floor(value), max))
    }

    function resolveInterval(interval?: { min?: number; max?: number }): number {
        const min = Math.max(0, Number(interval?.min || 0))
        const max = Math.max(min, Number(interval?.max || min))
        if (max === min) {
            return min
        }
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    async function delay(ms: number) {
        if (ms <= 0) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, ms))
    }

    function dedupeArticles(articles: Array<YoutubeArticle>): Array<YoutubeArticle> {
        const dedup = new Map<string, YoutubeArticle>()
        for (const article of articles) {
            dedup.set(article.a_id, article)
        }
        return Array.from(dedup.values())
    }

    async function hydrateArticle(
        article: YoutubeArticle,
        headers: Record<string, string>,
        options: { markPremiereResolved?: boolean } = {},
    ): Promise<YoutubeArticle> {
        const webpage = await HTTPClient.download_webpage(addLocaleQuery(article.url), headers, {
            timeout: YOUTUBE_DETAIL_TIMEOUT_MS,
        })
        const detail = detailParser(await webpage.text())
        const media = detail.thumbnail ? mediaParser(detail.thumbnail) : article.media
        let premiereExtra = buildPremiereExtra(detail)
        if (!premiereExtra && options.markPremiereResolved) {
            // A stored-pending premiere whose detail page no longer reports upcoming/scheduled state has
            // resolved; emit an explicit marker so the refresh gate can trust this over list-page shape.
            premiereExtra = {
                data: {
                    premiere: {
                        pending: false,
                        scheduled_start_at: detail.scheduled_start_at,
                        resolved_at: dayjs().unix(),
                    },
                },
            }
        }
        return {
            ...article,
            created_at: detail.created_at || article.created_at,
            content: buildContent(detail.title, detail.description) || article.content,
            has_media: Boolean(media && media.length > 0),
            media,
            // Merge instead of replace: the list-page members_only flag must survive
            // detail hydration even when a premiere extra is built.
            extra: mergeArticleExtras(article.extra, premiereExtra) as YoutubeArticle['extra'],
        }
    }

    /**
     * @param videoId YouTube video id from a watch/shorts/live URL
     * @description grab a single video from its watch page (X-link ingest path).
     * Builds the same article shape as the channel crawl, including premiere state
     * and the members_only flag recovered from playabilityStatus.
     */
    export async function grabVideo(videoId: string, options: GrabVideoOptions = {}): Promise<YoutubeArticle> {
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
        const headers = {
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': options.requestHeaders?.['user-agent'] || UserAgent.CHROME,
            cookie: options.cookieString?.trim() || '',
        }
        const detailUrl = addLocaleQuery(watchUrl)
        let detail: YoutubeDetail
        try {
            const webpage = await HTTPClient.download_webpage(detailUrl, headers, { timeout: YOUTUBE_DETAIL_TIMEOUT_MS })
            detail = detailParser(await webpage.text())
            if (!detail.title && !detail.description) {
                throw new Error('missing player response')
            }
        } catch {
            // Bare HTTP occasionally gets a consent/bot shell without the player
            // response; fall back to the curl impersonation path once.
            const curlPage = await HTTPClient.download_webpage_curl(detailUrl, headers, {
                timeout: YOUTUBE_DETAIL_TIMEOUT_MS,
            })
            detail = detailParser(await curlPage.text())
        }
        if (!detail.title && !detail.description) {
            throw new Error(`Cannot find YouTube player response for ${videoId}`)
        }
        const media = mediaParser(detail.thumbnail)
        const handle = detail.owner_handle
        return {
            platform: Platform.YouTube,
            a_id: videoId,
            u_id: handle || 'youtube',
            username: detail.owner_name || handle || 'YouTube',
            created_at: detail.created_at,
            content: buildContent(detail.title, detail.description),
            url: watchUrl,
            type: ArticleTypeEnum.VIDEO,
            ref: null,
            has_media: media.length > 0,
            media,
            extra: mergeArticleExtras(buildPremiereExtra(detail), buildMembersOnlyFlagExtra(detail.members_only)),
            u_avatar: null,
        }
    }

    /**
     * @param url https://www.youtube.com/@username
     * @description grab videos and shorts from html
     */
    export async function grabArticles(
        page: Page,
        url: string,
        options: GrabArticlesOptions = {},
    ): Promise<Array<YoutubeArticle>> {
        const fallbackHandle = stripHandlePrefix(url.split('/').pop() || '')
        const videosUrl = `${url}/videos?${LOCALE_QUERY}`
        const shortsUrl = `${url}/shorts?${LOCALE_QUERY}`
        // Prefer the manager-merged cookie string (seeded file cookies + live browser
        // session); fall back to reading the page jar only when no cookie string was
        // provided. Keep the fetch UA aligned with the browser profile.
        const cookieString = options.cookieString?.trim()
            ? options.cookieString
            : getCookieString(await page.cookies(videosUrl, shortsUrl))
        const headers = {
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': options.requestHeaders?.['user-agent'] || UserAgent.CHROME,
            cookie: cookieString,
        }
        const [videosPage, shortsPage] = await Promise.all([
            downloadListPage(videosUrl, headers),
            downloadListPage(shortsUrl, headers),
        ])
        let [videosText, shortsText] = await Promise.all([videosPage.text(), shortsPage.text()])
        let videosJson = extractAssignedObject<any>(videosText, 'ytInitialData')
        let shortsJson = extractAssignedObject<any>(shortsText, 'ytInitialData')
        // Per-page fallback: only re-fetch the list(s) that actually lacked initial data,
        // instead of doubling the request count for both tabs on every failure.
        if (!videosJson) {
            const curlPage = await HTTPClient.download_webpage_curl(videosUrl, headers, {
                timeout: YOUTUBE_LIST_TIMEOUT_MS,
            })
            videosText = await curlPage.text()
            videosJson = extractAssignedObject<any>(videosText, 'ytInitialData')
        }
        if (!shortsJson) {
            const curlPage = await HTTPClient.download_webpage_curl(shortsUrl, headers, {
                timeout: YOUTUBE_LIST_TIMEOUT_MS,
            })
            shortsText = await curlPage.text()
            shortsJson = extractAssignedObject<any>(shortsText, 'ytInitialData')
        }
        if (!videosJson && !shortsJson) {
            throw new Error('Cannot find YouTube initial data')
        }

        const channelMeta = channelMetaParser(videosJson || shortsJson, fallbackHandle)
        const baseArticles = dedupeArticles([
            ...videosParser(videosJson, channelMeta),
            ...shortsParser(shortsJson, channelMeta),
        ]).sort((a, b) => b.created_at - a.created_at)
        const hydrateLimit = clampPositiveInteger(
            options.hydrate_limit,
            DEFAULT_YOUTUBE_HYDRATE_LIMIT,
            MAX_YOUTUBE_HYDRATE_LIMIT,
        )
        const hydrateConcurrency = Math.max(
            1,
            clampPositiveInteger(
                options.hydrate_concurrency,
                DEFAULT_YOUTUBE_HYDRATE_CONCURRENCY,
                MAX_YOUTUBE_HYDRATE_CONCURRENCY,
            ),
        )
        const knownIds = new Set<string>()
        const storedPendingPremiereIds = new Set<string>()
        if (options.articleStateLookup) {
            // Merged lookup: one DB round-trip per article serves both the known
            // gate and the premiere-pending override.
            await Promise.all(
                baseArticles.map(async (article) => {
                    try {
                        const state = await options.articleStateLookup?.(article.a_id)
                        if (!state?.known) {
                            return
                        }
                        if (state.storedPremierePending) {
                            storedPendingPremiereIds.add(article.a_id)
                            return
                        }
                        if (!isPremierePendingArticle(article)) {
                            knownIds.add(article.a_id)
                        }
                    } catch {
                        // A lookup failure should not make the crawler miss upstream content; fall back to normal hydrate.
                    }
                }),
            )
        } else if (options.isArticleKnown) {
            await Promise.all(
                baseArticles.map(async (article) => {
                    try {
                        if (!(await options.isArticleKnown?.(article.a_id))) {
                            return
                        }
                        // Resolution of a premiere can only be proven from the detail page, so a stored-pending
                        // article must be re-hydrated even though it is already known.
                        if (await options.isStoredPremierePending?.(article.a_id)) {
                            storedPendingPremiereIds.add(article.a_id)
                            return
                        }
                        if (!isPremierePendingArticle(article)) {
                            knownIds.add(article.a_id)
                        }
                    } catch {
                        // A lookup failure should not make the crawler miss upstream content; fall back to normal hydrate.
                    }
                }),
            )
        }

        const articlesById = new Map(baseArticles.map((article) => [article.a_id, article]))
        const hydrateQueue = baseArticles
            .filter((article) => {
                if (knownIds.has(article.a_id)) {
                    return false
                }
                const premiereCheck = storedPendingPremiereIds.has(article.a_id) || isPremierePendingArticle(article)
                if (!premiereCheck) {
                    return true
                }
                // Scheduled premieres can sit pending for weeks; re-hydrating their
                // detail page every round wastes a request per round. Re-check on a
                // TTL, and always re-check near the scheduled start.
                const cacheKey = `yt:premiere-check:${article.a_id}`
                const lastCheck = options.cache?.get(cacheKey) as number | null
                const scheduled = (article.extra?.data?.premiere?.scheduled_start_at as number | null) || null
                const nearSchedule = Boolean(scheduled && Date.now() / 1000 >= scheduled - 60)
                if (
                    typeof lastCheck === 'number' &&
                    Date.now() / 1000 - lastCheck < PREMIERE_RECHECK_TTL_S &&
                    !nearSchedule
                ) {
                    return false
                }
                options.cache?.set(cacheKey, Math.floor(Date.now() / 1000), PREMIERE_RECHECK_TTL_S * 2)
                return true
            })
            .sort((a, b) => {
                // Items without a usable list timestamp need the detail page most: the shorts tab
                // markup no longer exposes a published time, so shorts carry created_at=0 from the
                // list and would otherwise sink to the back of the queue and starve under a tight
                // hydrate limit. Hydrate time-less items first, then newest-first.
                const aNeedsTime = a.created_at > 0 ? 0 : 1
                const bNeedsTime = b.created_at > 0 ? 0 : 1
                if (aNeedsTime !== bNeedsTime) {
                    return bNeedsTime - aNeedsTime
                }
                return b.created_at - a.created_at
            })
            .slice(0, hydrateLimit)
        for (let index = 0; index < hydrateQueue.length; index += hydrateConcurrency) {
            const chunk = hydrateQueue.slice(index, index + hydrateConcurrency)
            const hydrated = await Promise.allSettled(
                chunk.map((article) =>
                    hydrateArticle(article, headers, {
                        markPremiereResolved: storedPendingPremiereIds.has(article.a_id),
                    }),
                ),
            )
            for (let chunkIndex = 0; chunkIndex < hydrated.length; chunkIndex++) {
                const result = hydrated[chunkIndex]
                const fallback = chunk[chunkIndex]
                if (result?.status === 'fulfilled') {
                    articlesById.set(result.value.a_id, result.value)
                } else if (fallback) {
                    articlesById.set(fallback.a_id, fallback)
                }
            }
            if (index + hydrateConcurrency < hydrateQueue.length) {
                await delay(resolveInterval(options.hydrate_interval_time))
            }
        }

        return Array.from(articlesById.values()).sort((a, b) => b.created_at - a.created_at)
    }
}

export { ArticleTypeEnum, YoutubeApiJsonParser }
export { YoutubeSpider }
