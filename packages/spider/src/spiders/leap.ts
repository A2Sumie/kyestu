import dayjs from 'dayjs'
import { Page } from 'puppeteer-core'
import { Platform } from '../types'
import type { GenericArticle, GenericMediaInfo, TaskType, TaskTypeResult, CrawlEngine } from '../types'
import { BaseSpider } from './base'

export enum ArticleTypeEnum {
    ARTICLE = 'article',
}

export type LeapFeedKind = 'leap-news' | 'leap-schedule'

export interface LeapFeedConfig {
    feed: LeapFeedKind
    u_id: string
    label: string
    tab: 'news' | 'schedule'
}

export interface LeapListItem {
    detailUrl: string
    title: string
    dateText: string
    category?: string | null
    summary?: string | null
    thumbnail?: string | null
}

interface LeapDetailPayload {
    title: string
    dateText: string
    category?: string | null
    bodyText: string
    bodyHtml: string
    media: Array<GenericMediaInfo>
    extraData?: Record<string, any>
}

interface LeapListPageResult {
    items: Array<LeapListItem>
}

const LEAP_HOST = 'leap-projects.jp'
const LEAP_BASE_PATH = '/idol'

const FEED_CONFIGS: Record<LeapFeedKind, LeapFeedConfig> = {
    'leap-news': {
        feed: 'leap-news',
        u_id: 'leap:news',
        label: 'LEAP! Information',
        tab: 'news',
    },
    'leap-schedule': {
        feed: 'leap-schedule',
        u_id: 'leap:schedule',
        label: 'LEAP! Schedule',
        tab: 'schedule',
    },
}

function cleanText(value?: string | null): string {
    return (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
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
    return collapsed.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function tryParseLeapUrl(url: string): URL | null {
    try {
        return new URL(url)
    } catch {
        return null
    }
}

function isLeapDetailUrl(url: string): boolean {
    const parsed = tryParseLeapUrl(url)
    if (!parsed || parsed.hostname !== LEAP_HOST) {
        return false
    }
    return /^\/idol\/information\/[^/]+\/$/i.test(parsed.pathname)
}

/** "2026年8月1日" or "2026年4月29日〜5月10日" -> dayjs of the first date. */
function parseLeapDateText(dateText?: string | null): dayjs.Dayjs | null {
    const raw = cleanText(dateText)
    if (!raw) {
        return null
    }
    const match = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
    if (!match) {
        return null
    }
    const parsed = dayjs(`${match[1]}-${match[2]}-${match[3]}`)
    return parsed.isValid() ? parsed : null
}

function hasExplicitTime(dateText?: string | null): boolean {
    const value = cleanText(dateText)
    return /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(value) || /\b\d{1,2}時(?:\d{1,2}分?)?\b/.test(value)
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

function resolveLeapArticleTime(dateText?: string | null) {
    const raw = cleanText(dateText)
    const parsed = parseLeapDateText(raw)
    const crawledAt = dayjs()
    if (parsed && parsed.isValid()) {
        if (hasExplicitTime(raw)) {
            return {
                createdAt: parsed.unix(),
                source: 'explicit' as const,
                dateText: raw || null,
                crawledAt: crawledAt.unix(),
            }
        }
        if (parsed.isSame(crawledAt, 'day')) {
            return {
                createdAt: roundToNearbyHour(crawledAt).unix(),
                source: 'estimated_publish' as const,
                dateText: raw || null,
                crawledAt: crawledAt.unix(),
            }
        }
        return {
            createdAt: parsed.startOf('day').unix(),
            source: 'explicit' as const,
            dateText: raw || null,
            crawledAt: crawledAt.unix(),
        }
    }
    return {
        createdAt: crawledAt.unix(),
        source: 'crawl_observed' as const,
        dateText: raw || null,
        crawledAt: crawledAt.unix(),
    }
}

export function buildLeapArticle(
    config: LeapFeedConfig,
    detailUrl: string,
    listItem: LeapListItem,
    detail: LeapDetailPayload,
): GenericArticle<Platform.Website> {
    const slug = tryParseLeapUrl(detailUrl)?.pathname.split('/').filter(Boolean).pop() || ''
    const articleId = slug || `${config.feed}:${Buffer.from(detailUrl).toString('base64url')}`
    const title = cleanText(detail.title || listItem.title)
    const category = cleanText(detail.category || listItem.category) || null
    const bodyText = cleanMultilineText(detail.bodyText)
    const content = [title ? `【${title}】` : '', bodyText].filter(Boolean).join('\n\n') || title || null
    const media = Array.from(
        new Map<string, GenericMediaInfo>((detail.media || []).map((item) => [`${item.type}:${item.url}`, item])).values(),
    )
    const time = resolveLeapArticleTime(detail.dateText || listItem.dateText)

    return {
        platform: Platform.Website,
        a_id: articleId,
        u_id: config.u_id,
        username: config.label,
        created_at: time.createdAt,
        content,
        url: detailUrl,
        type: ArticleTypeEnum.ARTICLE,
        ref: null,
        has_media: media.length > 0,
        media: media.length > 0 ? media : null,
        extra: {
            data: {
                site: 'LEAP!',
                host: LEAP_HOST,
                feed: config.feed,
                title,
                category,
                summary: cleanText(listItem.summary) || null,
                raw_html: detail.bodyHtml,
                time_source: time.source,
                date_text: time.dateText,
                crawled_at: time.crawledAt,
                ...(detail.extraData || {}),
            },
            content: cleanText(listItem.summary) || title || undefined,
            media: media.length > 0 ? media : undefined,
            extra_type: 'website_meta',
        },
        u_avatar: null,
    }
}

async function extractLeapList(page: Page, url: string, tab: 'news' | 'schedule'): Promise<LeapListPageResult> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('a.info-list__item', { timeout: 15000 })
    return page.evaluate(
        (currentUrl, targetTab) => {
            const clean = (value?: string | null) => (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
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
            const items = Array.from(document.querySelectorAll<HTMLAnchorElement>('a.info-list__item'))
                .filter((anchor) => anchor.getAttribute('data-tab') === targetTab)
                .map((anchor) => {
                    const detailUrl = absolute(anchor.getAttribute('href'))
                    if (!detailUrl) {
                        return null
                    }
                    const thumbnailSrc = absolute(
                        anchor.querySelector<HTMLImageElement>('img')?.getAttribute('src'),
                    )
                    return {
                        detailUrl,
                        title: clean(anchor.querySelector('.info-list__title')?.textContent),
                        dateText: clean(anchor.querySelector('.info-list__date')?.textContent),
                        category: clean(anchor.querySelector('.info-list__tag')?.textContent) || null,
                        summary: null,
                        thumbnail: thumbnailSrc,
                    }
                })
                .filter(Boolean)
            return { items }
        },
        url,
        tab,
    ) as Promise<LeapListPageResult>
}

async function extractLeapDetail(page: Page, url: string): Promise<LeapDetailPayload> {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('article.info-single', { timeout: 15000 })
    return page.evaluate((currentUrl) => {
        const clean = (value?: string | null) => (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
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
        const header = document.querySelector('.info-single__header-inner')
        const headerText = clean(header?.textContent)
        const headerMatch = headerText.match(/^(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/)
        const dateText = headerMatch?.[1] || ''
        const category = clean(header?.querySelector('.info-single__meta, .info-single__tags')?.textContent) || null
        const title = clean(document.querySelector('article.info-single h1')?.textContent)
        const body = document.querySelector<HTMLElement>('.info-single__content-inner')
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
            .filter(Boolean)
        return {
            title: title || '',
            dateText: dateText || '',
            category,
            bodyText: cleanMultiline(body?.innerText || body?.textContent),
            bodyHtml: body?.innerHTML || '',
            media,
        }
    }, url) as Promise<LeapDetailPayload>
}

class LeapProjectsSpider extends BaseSpider {
    static _VALID_URL = /^https?:\/\/(?:www\.)?leap-projects\.jp\/idol\/(?:information(?:\/|$)|information\/[^/?#]+\/$)/i
    static _PLATFORM = Platform.Website
    BASE_URL = `https://${LEAP_HOST}${LEAP_BASE_PATH}/`
    NAME = 'LEAP! Website Spider'

    static resolveFeed(url: string): LeapFeedConfig | null {
        const parsed = tryParseLeapUrl(url)
        if (!parsed || parsed.hostname !== LEAP_HOST) {
            return null
        }
        if (!/^\/idol\/information(?:\/|$)/i.test(parsed.pathname)) {
            return null
        }
        return parsed.hash.includes('schedule') ? FEED_CONFIGS['leap-schedule'] : FEED_CONFIGS['leap-news']
    }

    static extractBasicInfo(url: string) {
        const config = LeapProjectsSpider.resolveFeed(url)
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
        },
    ): Promise<TaskTypeResult<T, Platform.Website>> {
        if (config.task_type !== 'article') {
            throw new Error('LEAP! spider only supports article tasks')
        }
        if (!page) {
            throw new Error('LEAP! spider requires a browser page')
        }

        const feedConfig = LeapProjectsSpider.resolveFeed(url)
        if (!feedConfig) {
            throw new Error(`Unsupported leap-projects url: ${url}`)
        }

        const listUrl = url.split('#')[0] || url
        if (isLeapDetailUrl(listUrl)) {
            const detail = await extractLeapDetail(page, listUrl)
            const article = buildLeapArticle(
                feedConfig,
                listUrl,
                { detailUrl: listUrl, title: detail.title, dateText: detail.dateText, category: detail.category },
                detail,
            )
            return [article] as TaskTypeResult<T, Platform.Website>
        }

        const maxDetailCount = Math.max(
            1,
            Math.min(20, Math.floor(Number(config.max_detail_count) || 20)),
        )
        // The news and schedule crawlers load the same list page (different hash);
        // cache the extracted list for a few minutes so the second crawler does not
        // pay a duplicate navigation for the identical document.
        const listCacheKey = `leap_list:${listUrl}:${feedConfig.tab}`
        const cachedList = this.cache.get(listCacheKey) as LeapListPageResult | null
        const list = cachedList || (await extractLeapList(page, listUrl, feedConfig.tab))
        if (!cachedList) {
            this.cache.set(listCacheKey, list, 300)
        }
        const articles: Array<GenericArticle<Platform.Website>> = []
        for (const item of list.items.slice(0, maxDetailCount)) {
            const articleId = tryParseLeapUrl(item.detailUrl)?.pathname.split('/').filter(Boolean).pop() || ''
            if (articleId && config.isArticleKnown) {
                try {
                    if (await config.isArticleKnown(articleId)) {
                        continue
                    }
                } catch {
                    // fall through to a full re-fetch on lookup error
                }
            }
            try {
                const detail = await extractLeapDetail(page, item.detailUrl)
                articles.push(buildLeapArticle(feedConfig, item.detailUrl, item, detail))
            } catch (error) {
                // Never persist a title-only shell: a stored empty article would be
                // treated as known forever and its real body would never be fetched.
                this.log?.warn?.(`LEAP! detail crawl failed for ${item.detailUrl}, skipping this round: ${error}`)
            }
        }
        return articles as TaskTypeResult<T, Platform.Website>
    }
}

export { LeapProjectsSpider }
export type { LeapDetailPayload }
