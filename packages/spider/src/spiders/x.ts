import { Platform } from '../types'
import type {
    ArticleExtractType,
    CrawlEngine,
    GenericArticle,
    GenericArticleRef,
    GenericFollows,
    GenericMediaInfo,
    TaskType,
    TaskTypeResult,
} from '../types'
import { BaseSpider } from './base'
import { Page } from 'puppeteer-core'
import { JSONPath } from 'jsonpath-plus'
import type { Logger } from '@kyestu/log'
import { waitForResponse } from './base'
import { SimpleExpiringCache, UserAgent } from '../utils'
import { v4 as uuidv4 } from 'uuid'
import { noop } from 'puppeteer-core/lib/esm/third_party/rxjs/rxjs.js'

type XListApiEngine = 'api-statuses' | 'api-member' | 'api-graphql' | 'api-unified'

enum ArticleTypeEnum {
    /**
     *
     */
    TWEET = 'tweet',
    RETWEET = 'retweet',
    QUOTED = 'quoted',
    CONVERSATION = 'conversation',
}

const X_BASE_VALID_URL = /^(?:https:\/\/)?(?:www\.)?x\.com\//

enum XApis {
    UserTweets = 'UserTweets',
    UserTweetsAndReplies = 'UserTweetsAndReplies',
    UserByScreenName = 'UserByScreenName',
    ListLatestTweetsTimeline = 'ListLatestTweetsTimeline',
    ListMembers = 'ListMembers',
    TweetDetail = 'TweetDetail',
}

const DEFAULT_QUERY_APIS = [
    XApis.UserTweets,
    XApis.UserTweetsAndReplies,
    XApis.UserByScreenName,
    XApis.ListLatestTweetsTimeline,
] as Array<XApis>

const CAPTURED_HEADER_KEYS = new Set([
    'accept-language',
    'authorization',
    'content-type',
    'referer',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'user-agent',
    'x-csrf-token',
    'x-twitter-active-user',
    'x-twitter-auth-type',
    'x-twitter-client-language',
])

enum XTweetsTaskType {
    tweets = 'tweets',
    replies = 'replies',
}

const X_UNIFIED_LIST_MAX_HYDRATED_USERS = 10
const X_UNIFIED_LIST_DEFAULT_CONCURRENCY = 2
const X_UNIFIED_LIST_MAX_CONCURRENCY = 4
const X_UNIFIED_LIST_MEMBER_CURSORS = new Map<string, number>()
const X_UNIFIED_LIST_MEMBER_CACHE = new Map<string, Array<string>>()
const X_UNIFIED_LIST_CACHE_LIMIT = 50

function setUnifiedListMemberCache(listId: string, userIds: Array<string>) {
    if (!X_UNIFIED_LIST_MEMBER_CACHE.has(listId) && X_UNIFIED_LIST_MEMBER_CACHE.size >= X_UNIFIED_LIST_CACHE_LIMIT) {
        const oldestKey = X_UNIFIED_LIST_MEMBER_CACHE.keys().next().value
        if (oldestKey !== undefined) {
            X_UNIFIED_LIST_MEMBER_CACHE.delete(oldestKey)
            X_UNIFIED_LIST_MEMBER_CURSORS.delete(oldestKey)
        }
    }
    X_UNIFIED_LIST_MEMBER_CACHE.set(listId, userIds)
}

function setUnifiedListMemberCursor(listId: string, cursor: number) {
    if (
        !X_UNIFIED_LIST_MEMBER_CURSORS.has(listId) &&
        X_UNIFIED_LIST_MEMBER_CURSORS.size >= X_UNIFIED_LIST_CACHE_LIMIT
    ) {
        const oldestKey = X_UNIFIED_LIST_MEMBER_CURSORS.keys().next().value
        if (oldestKey !== undefined) {
            X_UNIFIED_LIST_MEMBER_CURSORS.delete(oldestKey)
        }
    }
    X_UNIFIED_LIST_MEMBER_CURSORS.set(listId, cursor)
}
// In-flight dedup for rest-id lookups across concurrent XApiClient instances:
// the same screen name never triggers two UserByScreenName requests at once.
const X_REST_ID_IN_FLIGHT = new Map<string, Promise<string>>()
// GraphQL requests observed on a page outside capture windows (e.g. during the
// manager's warmup navigation). Buffered per page so the first capture attempt
// can consume what warmup already triggered instead of reloading the page.
const X_PAGE_REQUEST_BUFFER = new WeakMap<
    object,
    {
        buffer: Array<{ url: string; headers: Record<string, string> }>
        handler: (request: { url: () => string; headers: () => Record<string, string> }) => void
    }
>()
const X_PAGE_REQUEST_BUFFER_LIMIT = 500

/**
 * Starts buffering X GraphQL requests fired by the page (typically attached
 * before a warmup navigation). Idempotent per page; the buffer lives until
 * drainCapturedXOperations consumes it.
 */
export function beginXOperationCapture(page: Page) {
    if (X_PAGE_REQUEST_BUFFER.has(page)) {
        return
    }
    const buffer: Array<{ url: string; headers: Record<string, string> }> = []
    const handler = (request: { url: () => string; headers: () => Record<string, string> }) => {
        if (!/\/i\/api\/graphql\//.test(request.url())) {
            return
        }
        buffer.push({ url: request.url(), headers: request.headers() })
        if (buffer.length > X_PAGE_REQUEST_BUFFER_LIMIT) {
            buffer.shift()
        }
    }
    X_PAGE_REQUEST_BUFFER.set(page, { buffer, handler })
    page.on('request', handler)
}

/**
 * Returns (and clears) the GraphQL requests buffered on a page.
 */
export function drainCapturedXOperations(page: Page) {
    const entry = X_PAGE_REQUEST_BUFFER.get(page)
    if (!entry) {
        return []
    }
    X_PAGE_REQUEST_BUFFER.delete(page)
    page.off('request', entry.handler)
    return entry.buffer
}
// Must match the `count` variable of XApiClient.grabTweets. The list timeline
// (count=20) covers a member's latest tweets; when the discovery window already
// contains at least this many tweets from a member, their UserTweets hydration
// request would only return a subset of tweets we already have, so it is skipped.
const X_USER_TIMELINE_HYDRATE_COUNT = 5
const X_FETCH_TIMEOUT_MS = 20_000
// Cross-crawl cache TTLs. X operation profiles (query ids + headers) and rest ids are
// stable for long periods; caching them on the spider instance removes the per-crawl
// browser navigations and UserByScreenName lookups that were the request-budget driver.
const X_CACHE_OPERATION_PROFILE_TTL_S = 12 * 60 * 60
const X_CACHE_REST_ID_TTL_S = 24 * 60 * 60
const X_CACHE_LIST_VIEWPORT_TTL_S = 10 * 60
const X_REPLIES_404_NEGATIVE_TTL_S = 30 * 60

interface XOperationProfile {
    queryId: string
    url: string
    headers: Record<string, string>
    capturedAt: number
}

function normalizeRequestHeaders(headers?: Record<string, string>) {
    return Object.fromEntries(
        Object.entries(headers || {}).filter(
            ([key, value]) => typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim(),
        ),
    )
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeHydrationUserId(userId?: string | null) {
    const trimmed = typeof userId === 'string' ? userId.trim().replace(/^@+/, '') : ''
    return trimmed ? trimmed.toLowerCase() : ''
}

function clampPositiveInteger(value: unknown, fallback: number, max: number) {
    const normalized = Math.floor(Number(value))
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback
    }
    return Math.min(normalized, max)
}

function resolveRandomIntervalMs(interval?: { min?: number; max?: number }) {
    const min = Math.max(0, Math.floor(Number(interval?.min || 0)))
    const max = Math.max(min, Math.floor(Number(interval?.max || min)))
    if (max <= 0) {
        return 0
    }
    return min + Math.floor(Math.random() * (max - min + 1))
}

function formatHydrationError(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function isTooManyRequestsError(error: unknown) {
    return /too many requests|(^|\s)429(\s|$)/i.test(formatHydrationError(error))
}

function isAuthOrRateLimitError(error: unknown) {
    return /(^|\s)(401|403|429)(\s|$)|too many requests|auth(?:entication|orization)?/i.test(
        formatHydrationError(error),
    )
}

function isNotFoundError(error: unknown) {
    return /not found|(^|\s)404(\s|$)/i.test(formatHydrationError(error))
}

async function fetchWithTimeout(input: string | URL, init: RequestInit = {}, timeoutMs = X_FETCH_TIMEOUT_MS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        return await fetch(input, {
            ...init,
            signal: init.signal || controller.signal,
        })
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`X fetch timed out after ${timeoutMs}ms`)
        }
        throw error
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Single response-status gate for every X API fetch. Always embeds the numeric HTTP status in the
 * thrown message so downstream crawl-error classification can distinguish auth (401/403), rate limit
 * (429) and transient (5xx). statusText is often empty over HTTP/2, so the number must not be dropped.
 */
function assertXResponseOk(res: Response, context: string): void {
    if (res.ok) {
        return
    }
    const statusText = res.statusText ? ` ${res.statusText}` : ''
    const retryAfterHeader = res.headers?.get?.('retry-after')
    const retryAfter =
        res.status === 429 && retryAfterHeader ? ` retry_after=${retryAfterHeader.replace(/\s+/g, '_')}` : ''
    throw new Error(`Failed to fetch ${context}: ${res.status}${statusText}${retryAfter}`)
}

class XUserTimeLineSpider extends BaseSpider {
    // extends from XBaseSpider regex
    static _VALID_URL = new RegExp(X_BASE_VALID_URL.source + /(?<id>\w+)\/?$/.source)
    static _PLATFORM = Platform.X
    BASE_URL: string = 'https://x.com/'
    NAME: string = 'X TimeLine Spider'

    init(): this {
        super.init()
        return this
    }

    async _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: {
            crawl_engine: CrawlEngine
            task_type: T
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
        },
    ): Promise<TaskTypeResult<T, Platform.X>> {
        const result = super._match_valid_url(url, XUserTimeLineSpider)?.groups
        if (!result) {
            throw new Error(`Invalid URL: ${url}`)
        }
        const { id } = result
        if (!id) {
            throw new Error(`Invalid URL: ${url}, id not found`)
        }

        const { crawl_engine, task_type, sub_task_type, cookieString, requestHeaders } = config
        const apiClient = new XApiClient(requestHeaders, page, this.log, this.cache)

        if (crawl_engine === 'api') {
            this.log?.warn(`[Engine Api] API engine will be banned by X if you use it too much`)
            try {
                let cookie_string = cookieString
                if (!cookie_string && page) {
                    const cookie = await page.browserContext().cookies()
                    cookie_string = cookie.map((c) => `${c.name}=${c.value}`).join('; ')
                }
                if (!cookie_string) {
                    throw new Error('Cookie string is required for API mode')
                }

                await apiClient.prepareUserOperations(id, {
                    needTweets:
                        task_type === 'article' &&
                        (!sub_task_type ||
                            sub_task_type.length === 0 ||
                            sub_task_type.includes(XTweetsTaskType.tweets)),
                    needReplies:
                        task_type === 'article' &&
                        (!sub_task_type ||
                            sub_task_type.length === 0 ||
                            sub_task_type.includes(XTweetsTaskType.replies)),
                })

                if (task_type === 'article') {
                    let res = []
                    if (
                        !sub_task_type ||
                        sub_task_type.length === 0 ||
                        sub_task_type.includes(XTweetsTaskType.tweets)
                    ) {
                        this.log?.info(`Trying to grab tweets for ${id}.`)
                        const tweets = await apiClient.grabTweets(id, cookie_string)
                        res.push(...tweets)
                    }
                    if (
                        !sub_task_type ||
                        sub_task_type.length === 0 ||
                        sub_task_type.includes(XTweetsTaskType.replies)
                    ) {
                        this.log?.info(`Trying to grab replies for ${id}.`)
                        const replies = await apiClient.grabReplies(id, cookie_string)
                        res.push(...replies)
                    }
                    return res as TaskTypeResult<T, Platform.X>
                }

                if (task_type === 'follows') {
                    this.log?.info(`Trying to grab follows for ${id}.`)
                    return [await apiClient.grabFollowsNumber(id, cookie_string)] as TaskTypeResult<T, Platform.X>
                }
            } catch (e) {
                // Deliberately NO browser fallback. The API response (429/auth/network)
                // must surface to the scheduler's cooldown logic instead of being masked
                // by a second browser request that compounds X risk control.
                this.log?.error(`[Engine Api] Failed to crawl for ${id}: ${e}`)
                throw e
            }
        }

        if (!page) {
            throw new Error('Browser mode requires a Page instance')
        }

        const _url = `${this.BASE_URL}${id}`
        if (task_type === 'article') {
            let res = []
            if (!sub_task_type || sub_task_type.length === 0 || sub_task_type.includes(XTweetsTaskType.tweets)) {
                this.log?.info(`Trying to grab tweets for ${id}.`)
                const tweets = await XApiJsonParser.grabTweets(page, _url)
                res.push(...tweets)
            }
            if (!sub_task_type || sub_task_type.length === 0 || sub_task_type.includes(XTweetsTaskType.replies)) {
                this.log?.info(`Trying to grab replies for ${id}.`)
                const replies = await XApiJsonParser.grabReplies(page, _url + '/with_replies')
                res.push(...replies)
            }
            return res as TaskTypeResult<T, Platform.X>
        }

        if (task_type === 'follows') {
            this.log?.info(`Trying to grab follows for ${id}.`)
            return [await XApiJsonParser.grabFollowsNumber(page, _url)] as TaskTypeResult<T, Platform.X>
        }

        throw new Error('Invalid task type')
    }
}

class XStatusSpider extends BaseSpider {
    static _VALID_URL = new RegExp(X_BASE_VALID_URL.source + /(?<id>\w+)\/status\/(?<statusId>\d+)/.source)
    static _PLATFORM = Platform.X
    BASE_URL: string = 'https://x.com/'
    NAME: string = 'X Status Spider'

    init(): this {
        super.init()
        return this
    }

    async _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: {
            crawl_engine: CrawlEngine
            task_type: T
            cookieString?: string
            requestHeaders?: Record<string, string>
        },
    ): Promise<TaskTypeResult<T, Platform.X>> {
        const result = super._match_valid_url(url, XStatusSpider)?.groups
        if (!result) {
            throw new Error(`Invalid URL: ${url}`)
        }
        const { id, statusId } = result
        if (!id || !statusId) {
            throw new Error(`Invalid URL: ${url}, status id not found`)
        }
        if (config.task_type !== 'article') {
            throw new Error('X Status Spider only supports article crawl')
        }

        let cookieString = config.cookieString
        if (!cookieString && page) {
            const cookies = await page.browserContext().cookies()
            cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
        }
        if (!cookieString) {
            throw new Error('Cookie string is required for X status hydrate')
        }

        const apiClient = new XApiClient(config.requestHeaders, page, this.log, this.cache)
        const article = await apiClient.grabTweetDetail(id, statusId, cookieString)
        return (article ? [article] : []) as TaskTypeResult<T, Platform.X>
    }
}
class XListSpider extends BaseSpider {
    static _VALID_URL = new RegExp(X_BASE_VALID_URL.source + /\i\/lists\/(?<id>\d+)/.source)
    static _PLATFORM = Platform.X
    BASE_URL: string = 'https://x.com/'
    NAME: string = 'X OldApi Spider'
    API_PREFIX = 'https://api.twitter.com'

    PUBLIC_TOKEN =
        process.env.X_PUBLIC_TOKEN ||
        'Bearer AAAAAAAAAAAAAAAAAAAAAFQODgEAAAAAVHTp76lzh3rFzcHbmHVvQxYYpTw%3DckAlMINMjmCwxUcaXbAN4XqJVdgMJaHqNOFgPMK0zN1qLqLQCF'

    async _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: {
            crawl_engine: CrawlEngine
            task_type: T
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
        },
    ): Promise<TaskTypeResult<T, Platform.X>> {
        const result = super._match_valid_url(url, XListSpider)?.groups
        if (!result) {
            throw new Error(`Invalid URL: ${url}`)
        }
        const { id } = result
        if (!id) {
            throw new Error(`Invalid URL: ${url}, id not found`)
        }

        const {
            task_type,
            cookieString,
            requestHeaders,
            sub_task_type,
            hydrate_users,
            hydrate_limit,
            hydrate_concurrency,
            hydrate_interval_time,
        } = config
        const graphqlClient = new XApiClient(requestHeaders, page, this.log, this.cache)
        let cookie_string = cookieString
        if (!cookie_string && page) {
            cookie_string = (await page.browserContext().cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
        }
        if (!cookie_string) {
            throw new Error('Cookie string is required for X List Spider')
        }
        const normalizedEngine = config.crawl_engine === 'api-graphql' ? 'browser' : config.crawl_engine
        const fetchTweets =
            !sub_task_type || sub_task_type.length === 0 || sub_task_type.includes(XTweetsTaskType.tweets)
        const fetchReplies =
            !sub_task_type || sub_task_type.length === 0 || sub_task_type.includes(XTweetsTaskType.replies)
        if (task_type === 'article') {
            this.log?.info(`Trying to grab tweets for ${id}.`)
            let res = [] as Array<GenericArticle<Platform.X>>
            if (normalizedEngine === 'api-statuses') {
                this.log?.warn('Replies are not supported in api-statuses mode for now.')
                this.log?.debug('Using api-statuses engine')
                res = await this.grabTweets(id, cookie_string, requestHeaders)
            } else if (normalizedEngine === 'api-member') {
                this.log?.warn('Replies are not supported in api-member mode for now.')
                this.log?.debug('Using api-member engine')
                res = await this.grabTweetsPoor(id, cookie_string, requestHeaders)
            } else if (normalizedEngine === 'api-unified') {
                this.log?.debug('Using api-unified engine')
                res = await this.grabTweetsUnified(id, cookie_string, graphqlClient, {
                    fetchTweets,
                    fetchReplies,
                    hydrateUsers: hydrate_users,
                    hydrateLimit: hydrate_limit,
                    hydrateConcurrency: hydrate_concurrency,
                    hydrateIntervalTime: hydrate_interval_time,
                })
            } else {
                if (config.crawl_engine === 'api-graphql') {
                    this.log?.warn('api-graphql is treated as a legacy alias for browser-assisted list graphql mode')
                }
                if (fetchReplies) {
                    this.log?.warn('Replies are not supported in browser-assisted list graphql mode for now.')
                }
                this.log?.debug('Using browser-assisted graphql list engine')
                res = fetchTweets ? await graphqlClient.grabTweetsFromList(id, cookie_string) : []
            }
            return res as TaskTypeResult<T, Platform.X>
        }

        if (task_type === 'follows') {
            this.log?.info(`Trying to grab follows for ${id}.`)
            let res = [] as Array<GenericFollows>
            if (normalizedEngine !== 'api-statuses' && normalizedEngine !== 'api-member') {
                res = await graphqlClient.grabFollowsFromList(id, cookie_string)
            } else {
                res = await this.grabFollows(id, cookie_string, requestHeaders)
            }
            return res as TaskTypeResult<T, Platform.X>
        }

        throw new Error('Invalid task type')
    }

    private async grabTweetsUnified(
        list_id: string,
        cookie: string,
        client: XApiClient,
        options: {
            fetchTweets: boolean
            fetchReplies: boolean
            hydrateUsers?: Array<string>
            hydrateLimit?: number
            hydrateConcurrency?: number
            hydrateIntervalTime?: {
                min?: number
                max?: number
            }
        },
    ): Promise<Array<GenericArticle<Platform.X>>> {
        const discoveryTweetsRaw = await client.grabTweetsFromList(list_id, cookie)
        const configuredUsers = this.sanitizeUserIds(options.hydrateUsers)
        const sampledViewportUsers = client.getSampledListUsers(list_id)
        let membersResolved = true
        let listMemberUserIds = await client
            .grabFollowsFromList(list_id, cookie)
            .then((follows) => {
                // ListMembers payloads already carry each member's rest_id: prefill the
                // rest-id caches so member hydration never pays a UserByScreenName
                // request for data we just fetched for free.
                for (const follow of follows) {
                    if (follow?.rest_id) {
                        client.prefillRestId(follow.u_id || '', String(follow.rest_id))
                    }
                }
                return this.sanitizeUserIds(follows.map((follow) => follow?.u_id))
            })
            .catch((error) => {
                this.log?.warn(`Unified list crawl failed to expand list members for ${list_id}: ${error}`)
                membersResolved = false
                return [] as Array<string>
            })
        // A failed ListMembers must never be read as "no members" — that either
        // re-opened the door to non-member accounts (lists without hydrate_users) or
        // silently dropped every real member's discovery tweet (lists with
        // hydrate_users). Reuse the last known-good membership; only if we have never
        // resolved it do we fall back to configured users for this degraded round.
        if (membersResolved) {
            setUnifiedListMemberCache(list_id, listMemberUserIds)
        } else {
            const cached = X_UNIFIED_LIST_MEMBER_CACHE.get(list_id)
            if (cached && cached.length > 0) {
                listMemberUserIds = cached
                this.log?.warn(
                    `Unified list crawl reused ${cached.length} cached members for ${list_id} after member lookup failure`,
                )
            } else {
                this.log?.warn(
                    `Unified list crawl has no member cache for ${list_id}; restricting to configured users this round`,
                )
            }
        }
        // Only confirmed list members (plus explicitly configured users) are valid
        // monitoring targets. The list timeline and viewport sampling can surface
        // non-members (retweet original authors, recommended posts); hydrating or
        // forwarding those produced duplicate, unmarked, off-target tweets.
        const memberAllowSet = new Set<string>(
            [...configuredUsers, ...listMemberUserIds].map((userId) => userId.toLowerCase()),
        )
        // Restrict whenever we have any allow-list, OR whenever membership could not be
        // resolved (degraded round): never fail open to non-members on a lookup error.
        const restrictToMembers = memberAllowSet.size > 0 || !membersResolved
        const isAllowedMember = (userId?: string | null) =>
            !restrictToMembers ||
            (typeof userId === 'string' && memberAllowSet.has(userId.trim().replace(/^@+/, '').toLowerCase()))
        const discoveryTweets = discoveryTweetsRaw.filter((tweet) => isAllowedMember(tweet?.u_id))
        // Per-member count of tweets already covered by the list timeline. A member
        // whose latest tweets are fully inside the discovery window needs no separate
        // UserTweets hydration request (the merge stage dedupes by a_id anyway).
        const discoveryCoverage = new Map<string, number>()
        for (const tweet of discoveryTweets) {
            const key = normalizeHydrationUserId(tweet?.u_id)
            if (!key) continue
            discoveryCoverage.set(key, (discoveryCoverage.get(key) || 0) + 1)
        }
        const activeUserIds = this.sanitizeUserIds([
            ...(discoveryTweets.map((tweet) => tweet?.u_id?.trim()).filter(Boolean) as Array<string>),
            ...sampledViewportUsers,
        ]).filter(isAllowedMember)
        const selectedUserIds = this.selectHydrationUsers({
            listId: list_id,
            configuredUsers,
            activeUserIds,
            listMemberUserIds,
            hydrateLimit: options.hydrateLimit,
        }).filter(isAllowedMember)
        const listContextUserIds = this.sanitizeUserIds([
            ...configuredUsers,
            ...sampledViewportUsers.filter(isAllowedMember),
            ...activeUserIds,
            ...listMemberUserIds,
            ...selectedUserIds,
        ])

        this.log?.info(
            `Unified list crawl prepared ${selectedUserIds.length} accounts for ${list_id} (configured=${configuredUsers.length}, active=${activeUserIds.length}, sampled=${sampledViewportUsers.length}, members=${listMemberUserIds.length}).`,
        )
        if (configuredUsers.length + activeUserIds.length + listMemberUserIds.length > selectedUserIds.length) {
            this.log?.warn(
                `Unified list crawl truncated hydration candidates to ${selectedUserIds.length} for ${list_id} to limit request pressure.`,
            )
        }

        if (selectedUserIds[0]) {
            await client.prepareUserOperations(selectedUserIds[0], {
                needTweets: options.fetchTweets,
                needReplies: options.fetchReplies,
            })
        }

        const hydratedArticles = await this.hydrateUsersFromListActivity(selectedUserIds, client, cookie, {
            ...options,
            discoveryCoverage,
        })
        return this.attachListContextToArticles(
            this.mergeArticles(options.fetchTweets ? discoveryTweets : [], hydratedArticles),
            {
                listId: list_id,
                userIds: listContextUserIds,
            },
        )
    }

    private async hydrateUsersFromListActivity(
        userIds: Array<string>,
        client: XApiClient,
        cookie: string,
        options: {
            fetchTweets: boolean
            fetchReplies: boolean
            hydrateConcurrency?: number
            hydrateIntervalTime?: {
                min?: number
                max?: number
            }
            discoveryCoverage?: Map<string, number>
        },
    ) {
        const articles = [] as Array<GenericArticle<Platform.X>>
        const concurrency = clampPositiveInteger(
            options.hydrateConcurrency,
            X_UNIFIED_LIST_DEFAULT_CONCURRENCY,
            X_UNIFIED_LIST_MAX_CONCURRENCY,
        )
        let rateLimited = false
        let coverageSkippedCount = 0
        let replies404SkippedCount = 0

        for (let index = 0; index < userIds.length && !rateLimited; index += concurrency) {
            const chunk = userIds.slice(index, index + concurrency)
            const chunkResults = await Promise.allSettled(
                chunk.map(
                    async (
                        userId,
                    ): Promise<{
                        userId: string
                        articles: Array<GenericArticle<Platform.X>>
                        failures: Array<{ scope: 'tweets' | 'replies'; error: unknown }>
                        rateLimited: boolean
                    }> => {
                        const userArticles = [] as Array<GenericArticle<Platform.X>>
                        const failures = [] as Array<{ scope: 'tweets' | 'replies'; error: unknown }>
                        const coveredTweetCount = options.discoveryCoverage?.get(normalizeHydrationUserId(userId)) ?? 0
                        if (options.fetchTweets && coveredTweetCount < X_USER_TIMELINE_HYDRATE_COUNT) {
                            try {
                                userArticles.push(...(await client.grabTweets(userId, cookie)))
                            } catch (error) {
                                failures.push({ scope: 'tweets', error })
                                if (isAuthOrRateLimitError(error)) {
                                    return { userId, articles: userArticles, failures, rateLimited: true }
                                }
                            }
                        } else if (options.fetchTweets) {
                            coverageSkippedCount += 1
                            this.log?.debug(
                                `Unified list hydration skipped tweets for @${userId}: covered by list timeline (${coveredTweetCount} tweets).`,
                            )
                        }
                        if (options.fetchReplies) {
                            if (client.isReplies404Cached?.(userId)) {
                                replies404SkippedCount += 1
                                this.log?.debug(`Unified list hydration skipped replies for @${userId}: recent 404`)
                            } else {
                                try {
                                    userArticles.push(...(await client.grabReplies(userId, cookie)))
                                } catch (error) {
                                    failures.push({ scope: 'replies', error })
                                    if (isAuthOrRateLimitError(error)) {
                                        return { userId, articles: userArticles, failures, rateLimited: true }
                                    }
                                }
                            }
                        }
                        return { userId, articles: userArticles, failures, rateLimited: false }
                    },
                ),
            )

            chunkResults.forEach((result, chunkIndex) => {
                const userId = chunk[chunkIndex]
                if (result.status === 'fulfilled') {
                    articles.push(...result.value.articles)
                    if (result.value.failures.length > 0) {
                        this.logHydrationFailures(
                            result.value.userId,
                            result.value.failures,
                            result.value.articles.length,
                        )
                    }
                    if (result.value.rateLimited) {
                        rateLimited = true
                    }
                    return
                }
                this.log?.warn(`Unified list hydration failed for @${userId}: ${result.reason}`)
                if (isAuthOrRateLimitError(result.reason)) {
                    rateLimited = true
                }
            })

            if (rateLimited) {
                this.log?.warn('Unified list hydration stopped early after rate limit response.')
                break
            }

            const delayMs =
                index + concurrency < userIds.length ? resolveRandomIntervalMs(options.hydrateIntervalTime) : 0
            if (delayMs > 0) {
                await sleep(delayMs)
            }
        }

        if (coverageSkippedCount > 0) {
            this.log?.info(
                `Unified list hydration skipped tweets for ${coverageSkippedCount} user(s) already covered by the list timeline.`,
            )
        }
        if (replies404SkippedCount > 0) {
            this.log?.info(
                `Unified list hydration skipped replies for ${replies404SkippedCount} user(s) with recent 404.`,
            )
        }

        return articles
    }

    private logHydrationFailures(
        userId: string,
        failures: Array<{ scope: 'tweets' | 'replies'; error: unknown }>,
        preservedArticleCount: number,
    ) {
        const formatted = failures
            .map((failure) => `${failure.scope}: ${formatHydrationError(failure.error)}`)
            .join('; ')
        const onlyRepliesNotFound = failures.every(
            (failure) => failure.scope === 'replies' && isNotFoundError(failure.error),
        )
        if (preservedArticleCount > 0 && onlyRepliesNotFound) {
            this.log?.debug(
                `Unified list replies unavailable for @${userId}, preserved ${preservedArticleCount} tweet(s): ${formatted}`,
            )
            return
        }

        const prefix = preservedArticleCount > 0 ? 'partially failed' : 'failed'
        this.log?.warn(`Unified list hydration ${prefix} for @${userId}: ${formatted}`)
    }

    private mergeArticles(...articleGroups: Array<Array<GenericArticle<Platform.X>>>) {
        const merged = new Map<string, GenericArticle<Platform.X>>()

        for (const article of articleGroups.flat()) {
            if (!article?.a_id) {
                continue
            }
            const existing = merged.get(article.a_id)
            if (!existing || this.scoreArticle(article) >= this.scoreArticle(existing)) {
                merged.set(article.a_id, article)
            }
        }

        return Array.from(merged.values()).sort((left, right) => (right.created_at || 0) - (left.created_at || 0))
    }

    private sanitizeUserIds(userIds?: Array<string | null | undefined>) {
        return Array.from(
            new Set(
                (userIds || [])
                    .map((userId) => String(userId || '').trim())
                    .filter(Boolean)
                    .map((userId) => userId.replace(/^@+/, '')),
            ),
        )
    }

    private attachListContextToArticles(
        articles: Array<GenericArticle<Platform.X>>,
        context: {
            listId: string
            userIds: Array<string>
        },
    ) {
        if (context.userIds.length === 0) {
            return articles
        }

        return articles.map((article) => this.attachListContext(article, context))
    }

    private attachListContext(
        article: GenericArticle<Platform.X>,
        context: {
            listId: string
            userIds: Array<string>
        },
    ) {
        const existingExtra = article.extra
        const existingData =
            existingExtra?.data && typeof existingExtra.data === 'object'
                ? { ...(existingExtra.data as Record<string, unknown>) }
                : {}

        return {
            ...article,
            extra: {
                ...(existingExtra || {}),
                data: {
                    ...existingData,
                    list_context: {
                        list_id: context.listId,
                        user_ids: context.userIds,
                    },
                },
                extra_type: existingExtra?.extra_type || 'x_list_meta',
            },
        } as unknown as GenericArticle<Platform.X>
    }

    private selectHydrationUsers(options: {
        listId: string
        configuredUsers: Array<string>
        activeUserIds: Array<string>
        listMemberUserIds: Array<string>
        hydrateLimit?: number
    }) {
        const effectiveLimit = Math.max(
            options.configuredUsers.length,
            options.hydrateLimit || X_UNIFIED_LIST_MAX_HYDRATED_USERS,
        )
        const configuredUsers = this.sanitizeUserIds(options.configuredUsers).slice(0, effectiveLimit)
        const configuredSet = new Set(configuredUsers)
        const memberPool = this.sanitizeUserIds(options.listMemberUserIds).filter(
            (userId) => !configuredSet.has(userId),
        )
        const memberSet = new Set(memberPool)
        // Activity samples are ranking hints only, never authorization to monitor a
        // new account. Non-members (often retweet original authors) must not enter
        // the hydration pool.
        const activePool = this.sanitizeUserIds(options.activeUserIds).filter(
            (userId) => memberSet.has(userId) && !configuredSet.has(userId),
        )
        if (memberPool.length === 0) {
            return configuredUsers
        }

        const remaining = Math.max(0, effectiveLimit - configuredUsers.length)
        if (remaining === 0) {
            return configuredUsers
        }

        const memberSlots = Math.min(
            memberPool.length,
            remaining,
            activePool.length === 0 ? remaining : Math.max(1, Math.floor(effectiveLimit / 2)),
        )
        const activeSlots = Math.max(0, remaining - memberSlots)
        const selectedActive = activePool.slice(0, activeSlots)
        const selectedSet = new Set([...configuredUsers, ...selectedActive])
        const rotatedMembers = this.rotateMemberPool(
            options.listId,
            memberPool.filter((userId) => !selectedSet.has(userId)),
            memberSlots,
        )
        const selected = this.sanitizeUserIds([...configuredUsers, ...selectedActive, ...rotatedMembers])
        if (selected.length >= effectiveLimit) {
            return selected.slice(0, effectiveLimit)
        }

        const refillSet = new Set(selected)
        return this.sanitizeUserIds([
            ...selected,
            ...activePool.filter((userId) => !refillSet.has(userId)),
            ...memberPool.filter((userId) => !refillSet.has(userId)),
        ]).slice(0, effectiveLimit)
    }

    private rotateMemberPool(listId: string, userIds: Array<string>, take: number) {
        if (take <= 0 || userIds.length === 0) {
            return [] as Array<string>
        }

        const offset = X_UNIFIED_LIST_MEMBER_CURSORS.get(listId) || 0
        const normalizedOffset = offset % userIds.length
        const rotated = userIds.slice(normalizedOffset).concat(userIds.slice(0, normalizedOffset))
        const selected = rotated.slice(0, take)
        const advance = selected.length > 0 ? selected.length : 1
        setUnifiedListMemberCursor(listId, (normalizedOffset + advance) % userIds.length)
        return selected
    }

    private scoreArticle(article: GenericArticle<Platform.X>) {
        let score = 0
        if (article.content?.trim()) score += 2
        if (article.media?.length) score += 1
        if (article.extra?.content) score += 1
        if (article.ref && typeof article.ref === 'object') score += 2
        if (article.type === ArticleTypeEnum.CONVERSATION) score += 1
        return score
    }

    getCsrfToken(cookie: string) {
        const match = cookie.match(/(?:^|;\s*)ct0=([0-9a-f]+)\s*(?:;|$)/)
        if (match) {
            return match[1]
        }
        return null
    }

    /**
     * @deprecated This api endpoint was 404 not found at 2025-07-19 00:00 UTC.
     */
    async grabTweets(
        id: string,
        cookie_string: string,
        requestHeaders?: Record<string, string>,
    ): Promise<Array<GenericArticle<Platform.X>>> {
        const url = `${this.API_PREFIX}/1.1/lists/statuses.json`
        const params = new URLSearchParams({
            count: '20',
            include_my_retweet: '1',
            include_rts: '1',
            list_id: id,
            cards_platform: 'Web-13',
            include_entities: '1',
            include_user_entities: '1',
            include_cards: '1',
            send_error_codes: '1',
            tweet_mode: 'extended',
            include_ext_alt_text: 'true',
            include_reply_count: 'true',
            ext: 'mediaStats%2ChighlightedLabel%2CvoiceInfo%2CsuperFollowMetadata',
            include_ext_has_nft_avatar: 'true',
            include_ext_is_blue_verified: 'true',
            include_ext_verified_type: 'true',
            include_ext_sensitive_media_warning: 'true',
            include_ext_media_color: 'true',
        })
        // TODO: keep http header case sensitive
        const res = await fetchWithTimeout(`${url}?${params.toString()}`, {
            headers: {
                ...normalizeRequestHeaders(requestHeaders),
                authorization: this.PUBLIC_TOKEN,
                cookie: cookie_string,
                'x-csrf-token': this.getCsrfToken(cookie_string) || '',
            },
        })

        assertXResponseOk(res, 'tweets')

        const json = await res.json()
        if (!json) {
            throw new Error('Failed to fetch tweets with empty json')
        }

        return json.map(XApiJsonParser.oldTweetParser).filter(Boolean) as Array<GenericArticle<Platform.X>>
    }

    async grabTweetsPoor(
        id: string,
        cookie_string: string,
        requestHeaders?: Record<string, string>,
    ): Promise<Array<GenericArticle<Platform.X>>> {
        const url = `${this.API_PREFIX}/1.1/lists/members.json`
        const params = new URLSearchParams({
            list_id: id,
            cards_platform: 'Web-13',
            include_entities: '1',
            include_user_entities: '1',
            include_cards: '1',
            tweet_mode: 'extended',
            include_ext_alt_text: 'true',
            include_ext_media_color: 'true',
        })
        const res = await fetchWithTimeout(`${url}?${params.toString()}`, {
            headers: {
                authorization: this.PUBLIC_TOKEN,
                'user-agent': UserAgent.CHROME,
                ...normalizeRequestHeaders(requestHeaders),
                cookie: cookie_string,
            },
        })

        assertXResponseOk(res, 'follows')
        const json = await res.json()
        if (!json) {
            throw new Error('Failed to fetch follows with empty json')
        }

        return json?.users?.map(XApiJsonParser.oldTweetMemeberParser).filter(Boolean) as Array<
            GenericArticle<Platform.X>
        >
    }

    async grabFollows(
        id: string,
        cookie: string,
        requestHeaders?: Record<string, string>,
    ): Promise<Array<GenericFollows>> {
        const url = `${this.API_PREFIX}/1.1/lists/members.json`
        const params = new URLSearchParams({
            list_id: id,
            count: '99',
        })
        const res = await fetchWithTimeout(`${url}?${params.toString()}`, {
            headers: {
                authorization: this.PUBLIC_TOKEN,
                'user-agent': UserAgent.CHROME,
                ...normalizeRequestHeaders(requestHeaders),
                cookie: cookie,
                'x-csrf-token': this.getCsrfToken(cookie) || '',
            },
        })

        assertXResponseOk(res, 'follows')
        const json = await res.json()
        if (!json) {
            throw new Error('Failed to fetch follows with empty json')
        }

        return json?.users?.map(XApiJsonParser.oldFollowsParser).filter(Boolean) as Array<GenericFollows>
    }
}

/**
 * This is dangerous, because it will be banned by X if you use it too much
 */
export class XApiClient {
    guest_token = process.env.X_GUEST_TOKEN || '1918915913551839395'
    PUBLIC_TOKEN =
        process.env.X_PUBLIC_TOKEN ||
        'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
    /**
     * 'https://x.com'
     *
     * Notice there is no trailing slash
     */
    BASE_URL = 'https://x.com'
    ASSETS_BASE_URL = 'https://abs.twimg.com/responsive-web/client-web'
    API_PREFIX = '/i/api/graphql'
    BASE_HEADER: Record<string, string>

    api_with_queryid: Partial<Record<XApis, string>>
    name_to_rest_id: Record<string, string>
    operationProfiles: Partial<Record<XApis, XOperationProfile>>
    listViewportUsers: Map<string, Array<string>>
    cache?: SimpleExpiringCache
    page?: Page
    log?: Logger

    constructor(requestHeaders?: Record<string, string>, page?: Page, log?: Logger, cache?: SimpleExpiringCache) {
        this.api_with_queryid = {}
        this.name_to_rest_id = {}
        this.operationProfiles = {}
        this.listViewportUsers = new Map()
        this.cache = cache
        this.page = page
        this.log = log?.child({ subservice: 'XApiClient' })
        this.BASE_HEADER = {
            'user-agent': UserAgent.CHROME,
            referer: 'https://x.com/',
            origin: 'https://x.com',
            ...normalizeRequestHeaders(requestHeaders),
            authorization: this.PUBLIC_TOKEN,
        }
        // Hydrate cached operation profiles (query ids + captured headers) so crawl
        // rounds after the first need no browser navigation at all.
        for (const operation of DEFAULT_QUERY_APIS) {
            const cached = this.cache?.get(this.operationProfileCacheKey(operation))
            if (cached && typeof cached === 'object' && (cached as XOperationProfile)?.queryId) {
                this.operationProfiles[operation] = cached as XOperationProfile
                this.api_with_queryid[operation] = (cached as XOperationProfile).queryId
            }
        }
        // Query ids extracted from the JS bundles are cached separately (ListMembers
        // and TweetDetail are captured by the browser only when that op is requested,
        // so their ids otherwise force a full HTML+JS re-download every round).
        for (const operation of Object.values(XApis)) {
            const queryId = this.cache?.get(this.queryIdCacheKey(operation))
            if (typeof queryId === 'string' && queryId) {
                this.api_with_queryid[operation] = queryId
            }
        }
    }

    private operationProfileCacheKey(operation: XApis) {
        return `x-op:${operation}`
    }

    private queryIdCacheKey(operation: XApis) {
        return `x-queryid:${operation}`
    }

    /**
     * Per-request transient retry for X data fetchers. Absorbs 5xx and network blips with one
     * short-backoff retry so a single flaky request no longer forces the manager to re-run the
     * whole per-URL fan-out. Auth (401/403), rate limit (429) and 404 pass through untouched so
     * the caller's invalidation and early-stop logic keeps its semantics.
     */
    private async fetchWithTransientRetry(
        url: string,
        init: RequestInit,
        context: string,
        retries = 1,
    ): Promise<Response> {
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            let res: Response
            try {
                res = await fetchWithTimeout(url, init)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (!/timed out|network|fetch failed|econnreset|socket hang up/i.test(message) || attempt >= retries) {
                    throw error
                }
                this.log?.warn(
                    `X fetch ${context} transient network error, retrying (attempt ${attempt + 1}): ${message}`,
                )
                await sleep(500 * (attempt + 1))
                continue
            }
            if (res.ok || res.status < 500 || attempt >= retries) {
                return res
            }
            this.log?.warn(`X fetch ${context} transient ${res.status}, retrying (attempt ${attempt + 1})`)
            await sleep(500 * (attempt + 1))
        }
        throw new Error(`Failed to fetch ${context}: retries exhausted`)
    }

    private invalidateOperationProfile(operation: XApis) {
        this.cache?.set(this.operationProfileCacheKey(operation), null, 0)
        this.operationProfiles[operation] = undefined
        this.api_with_queryid[operation] = undefined
    }

    private assertOkOrInvalidate(res: Response, context: string, operation: XApis, userId?: string): void {
        if (res.ok) {
            return
        }
        // A 404 on an account-scoped op is almost always the account (deleted/renamed/
        // no replies), not a stale shared query id — drop only that user's rest id so we
        // never clear the shared operation profile and force the whole batch to
        // re-navigate. 403/429 are auth/rate signals handled by the caller's early stop;
        // they must not evict the query-id cache either. Only an old profile 404 (>30min)
        // is treated as a genuinely stale query id worth re-capturing.
        const accountScopedOps = new Set<XApis>([
            XApis.UserTweets,
            XApis.UserTweetsAndReplies,
            XApis.UserByScreenName,
            XApis.TweetDetail,
        ])
        if (res.status === 404) {
            if (userId) {
                const normalized = normalizeHydrationUserId(userId)
                if (normalized) {
                    this.cache?.set(`x-restid:${normalized}`, null, 0)
                }
            }
            const profile = this.operationProfiles[operation]
            const capturedRecently = Boolean(profile && Date.now() - profile.capturedAt < 30 * 60 * 1000)
            if (!accountScopedOps.has(operation) && !capturedRecently) {
                this.invalidateOperationProfile(operation)
                this.log?.warn(`Invalidated cached X operation profile ${operation} after stale 404`)
            }
        }
        assertXResponseOk(res, context)
    }

    async prepareUserOperations(
        screenName: string,
        options: {
            needTweets: boolean
            needReplies: boolean
        },
    ) {
        await this.captureOperationsFromPage(`${this.BASE_URL}/${screenName}`, [
            XApis.UserByScreenName,
            ...(options.needTweets ? [XApis.UserTweets] : []),
        ])
        if (options.needReplies) {
            await this.captureOperationsFromPage(`${this.BASE_URL}/${screenName}/with_replies`, [
                XApis.UserTweetsAndReplies,
            ])
        }
    }

    async prepareListOperations(listId: string) {
        await this.captureOperationsFromPage(`${this.BASE_URL}/i/lists/${listId}`, [
            XApis.ListLatestTweetsTimeline,
            XApis.ListMembers,
        ])
        await this.captureListViewportUsers(listId)
    }

    async prepareTweetDetailOperation(screenName: string, statusId: string) {
        await this.captureOperationsFromPage(`${this.BASE_URL}/${screenName}/status/${statusId}`, [XApis.TweetDetail])
    }

    getSampledListUsers(listId: string) {
        return this.listViewportUsers.get(listId) || []
    }

    // 获取graphql query id, 备份用
    async getGraphqlQueryId(html?: string) {
        let resolvedHtml = html
        if (!resolvedHtml) {
            resolvedHtml = await this.fetchBaseHtml()
        }
        // extract "": "md5/hash"
        {
            // List
            const lists_graphql_js_pattern = /"([^"]*AudioSpacebarScr)"\s*:\s*"(\w+)"/
            const match = resolvedHtml.match(lists_graphql_js_pattern)
            if (match) {
                const js_url = `${this.ASSETS_BASE_URL}/${match[1]}.${match[2]}a.js`
                const js_code = await (await fetchWithTimeout(js_url, { headers: this.BASE_HEADER })).text()
                const queryId = this.getQueryId(js_code, XApis.ListLatestTweetsTimeline)
                if (queryId) {
                    this.api_with_queryid[XApis.ListLatestTweetsTimeline] = queryId
                    this.cache?.set(
                        this.queryIdCacheKey(XApis.ListLatestTweetsTimeline),
                        queryId,
                        X_CACHE_OPERATION_PROFILE_TTL_S,
                    )
                }
            }
        }
    }

    private async captureOperationsFromPage(targetUrl: string, expectedOperations: Array<XApis>) {
        let missingOperations = expectedOperations.filter((operation) => !this.operationProfiles[operation])
        if (missingOperations.length === 0) {
            return
        }

        // Serve as many operations as possible from the cross-crawl cache: only the
        // operations never captured before need a browser visit.
        const stillMissing: Array<XApis> = []
        for (const operation of missingOperations) {
            const cached = this.cache?.get(this.operationProfileCacheKey(operation))
            if (cached && typeof cached === 'object' && (cached as XOperationProfile)?.queryId) {
                this.operationProfiles[operation] = cached as XOperationProfile
                this.api_with_queryid[operation] = (cached as XOperationProfile).queryId
            } else {
                stillMissing.push(operation)
            }
        }
        missingOperations = stillMissing
        if (!this.page || missingOperations.length === 0) {
            return
        }

        const requestedOperations = new Set(missingOperations)
        // Warmup (or any earlier navigation) may already have fired the GraphQL
        // requests we need: consume the page buffer before deciding to navigate.
        for (const { url, headers } of drainCapturedXOperations(this.page)) {
            const parsed = this.parseCapturedOperation(url)
            if (!parsed || !requestedOperations.has(parsed.operationName)) {
                continue
            }
            this.storeOperationProfile(url, headers)
        }
        if (missingOperations.every((operation) => Boolean(this.operationProfiles[operation]))) {
            return
        }

        const onRequest = (request: { url: () => string; headers: () => Record<string, string> }) => {
            const parsed = this.parseCapturedOperation(request.url())
            if (!parsed || !requestedOperations.has(parsed.operationName)) {
                return
            }
            this.storeOperationProfile(request.url(), request.headers())
        }

        this.page.on('request', onRequest)
        try {
            await this.navigateForCapture(targetUrl)

            const deadline = Date.now() + 8000
            while (Date.now() < deadline) {
                if (missingOperations.every((operation) => Boolean(this.operationProfiles[operation]))) {
                    return
                }
                await sleep(150)
            }

            const unresolved = missingOperations.filter((operation) => !this.operationProfiles[operation])
            if (unresolved.length > 0) {
                this.log?.debug(`Browser capture missed operations for ${targetUrl}: ${unresolved.join(', ')}`)
            }
        } finally {
            this.page.off('request', onRequest)
        }
    }

    private async navigateForCapture(targetUrl: string) {
        if (!this.page) {
            return
        }

        try {
            const currentUrl = this.page.url().split('#')[0]
            if (currentUrl === targetUrl) {
                await this.page.reload({
                    waitUntil: 'domcontentloaded',
                    timeout: 15000,
                })
            } else {
                await this.page.goto(targetUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000,
                })
            }
            await sleep(1200)
        } catch (error) {
            this.log?.warn(`Browser capture navigation failed for ${targetUrl}: ${error}`)
        }
    }

    private async captureListViewportUsers(listId: string) {
        if (!this.page) {
            return
        }

        // Viewport sampling is a browser-interaction cost; cache it per list so the
        // twice-per-crawl sampling (list tweets + list members) does not repeat it.
        const cached = this.cache?.get(`x-viewport:${listId}`)
        if (Array.isArray(cached) && cached.length > 0) {
            this.listViewportUsers.set(listId, cached as Array<string>)
            return
        }

        const sampledUsers = new Set<string>()
        const collectVisibleUsers = async () => {
            try {
                const usernames = await this.page!.evaluate(() => {
                    const reserved = new Set([
                        '',
                        'compose',
                        'explore',
                        'home',
                        'i',
                        'jobs',
                        'login',
                        'messages',
                        'notifications',
                        'privacy',
                        'search',
                        'settings',
                        'signup',
                        'tos',
                    ])
                    const links = Array.from(
                        document.querySelectorAll<HTMLAnchorElement>('article a[href*="/status/"]'),
                    )
                    const users = new Set<string>()
                    for (const link of links) {
                        const href = link.getAttribute('href') || ''
                        const match = href.match(/^\/([^/?#]+)\/status\//)
                        if (!match) {
                            continue
                        }
                        const user = match[1]?.trim().replace(/^@+/, '')
                        if (!user || reserved.has(user.toLowerCase())) {
                            continue
                        }
                        users.add(user)
                    }
                    return Array.from(users)
                })
                usernames.forEach((username) => sampledUsers.add(username))
            } catch (error) {
                this.log?.debug(`List viewport sampling failed for ${listId}: ${error}`)
            }
        }

        await collectVisibleUsers()

        const viewport = this.page.viewport()
        // A single larger scroll keeps the sample diverse enough while avoiding the
        // extra ListLatestTweetsTimeline cursor requests each additional scroll used
        // to trigger (those responses were consumed by nobody).
        for (let index = 0; index < 1; index += 1) {
            if (viewport) {
                const targetX = Math.floor(viewport.width * (0.25 + Math.random() * 0.5))
                const targetY = Math.floor(viewport.height * (0.2 + Math.random() * 0.55))
                await this.page.mouse.move(targetX, targetY, { steps: 10 }).catch(() => null)
            }

            const scrollAmount = 800 + Math.floor(Math.random() * 1200)
            await this.page.mouse.wheel({ deltaY: scrollAmount }).catch(() => null)
            await this.page
                .evaluate((amount) => {
                    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]') as HTMLElement | null
                    const scroller =
                        (primaryColumn?.querySelector('section')?.parentElement as HTMLElement | null) || null
                    if (scroller && typeof scroller.scrollBy === 'function') {
                        scroller.scrollBy({ top: amount, behavior: 'instant' })
                        return
                    }
                    window.scrollBy({ top: amount, behavior: 'instant' })
                }, scrollAmount)
                .catch(() => null)
            await sleep(450 + Math.floor(Math.random() * 900))
            await collectVisibleUsers()
        }

        if (sampledUsers.size > 0) {
            const users = Array.from(sampledUsers)
            this.listViewportUsers.set(listId, users)
            if (this.cache) {
                this.cache.set(`x-viewport:${listId}`, users, X_CACHE_LIST_VIEWPORT_TTL_S)
            }
            this.log?.debug(`List viewport sampled ${users.length} accounts for ${listId}: ${users.join(', ')}`)
        }
    }

    private async storeOperationProfile(url: string, headers: Record<string, string>) {
        const parsed = this.parseCapturedOperation(url)
        if (!parsed) {
            return
        }

        const filteredHeaders = this.filterCapturedHeaders(headers)
        this.operationProfiles[parsed.operationName] = {
            queryId: parsed.queryId,
            url,
            headers: filteredHeaders,
            capturedAt: Date.now(),
        }
        this.api_with_queryid[parsed.operationName] = parsed.queryId
        if (this.cache) {
            this.cache.set(
                this.operationProfileCacheKey(parsed.operationName),
                this.operationProfiles[parsed.operationName],
                X_CACHE_OPERATION_PROFILE_TTL_S,
            )
        }
    }

    private parseCapturedOperation(url: string) {
        const match = url.match(/\/i\/api\/graphql\/([^/]+)\/([^/?#]+)/)
        if (!match) {
            return null
        }

        const queryId = match[1]
        const operationName = match[2] as XApis
        if (!queryId || !Object.values(XApis).includes(operationName)) {
            return null
        }

        return {
            queryId,
            operationName,
        }
    }

    private filterCapturedHeaders(headers: Record<string, string>) {
        return Object.fromEntries(
            Object.entries(headers || {}).filter(([key, value]) => {
                const normalizedKey = String(key || '').toLowerCase()
                return CAPTURED_HEADER_KEYS.has(normalizedKey) && typeof value === 'string' && value.trim()
            }),
        )
    }

    private getOperationProfile(operation: XApis, fallbackOperations: Array<XApis> = []) {
        return (
            this.operationProfiles[operation] ||
            fallbackOperations.map((entry) => this.operationProfiles[entry]).find(Boolean)
        )
    }

    private async ensureQueryIds(requiredApis: Array<XApis> = DEFAULT_QUERY_APIS) {
        const targets = Array.from(new Set(requiredApis))
        const missingBefore = targets.filter((api) => !this.api_with_queryid[api])
        if (missingBefore.length === 0) {
            return
        }

        const html = await this.fetchBaseHtml()

        const jsUrls = this.extractJavascriptUrls(html)
        for (const jsUrl of jsUrls) {
            const jsCode = await fetchWithTimeout(jsUrl, { headers: this.BASE_HEADER })
                .then((res) => res.text())
                .catch(() => '')
            if (!jsCode) {
                continue
            }

            for (const api of targets) {
                if (this.api_with_queryid[api]) {
                    continue
                }
                const queryId = this.getQueryId(jsCode, api)
                if (queryId) {
                    this.api_with_queryid[api] = queryId
                    this.cache?.set(this.queryIdCacheKey(api), queryId, X_CACHE_OPERATION_PROFILE_TTL_S)
                }
            }

            if (targets.every((api) => Boolean(this.api_with_queryid[api]))) {
                return
            }
        }

        if (
            targets.includes(XApis.ListLatestTweetsTimeline) &&
            !this.api_with_queryid[XApis.ListLatestTweetsTimeline]
        ) {
            await this.getGraphqlQueryId(html)
        }

        const missingAfter = targets.filter((api) => !this.api_with_queryid[api])
        if (missingAfter.length > 0) {
            throw new Error(`Missing query ids: ${missingAfter.join(', ')}`)
        }
    }

    private async fetchBaseHtml() {
        if (this.page) {
            const html = await this.page.content().catch(() => '')
            if (html) {
                return html
            }
        }

        const webpage = await fetchWithTimeout(this.BASE_URL, {
            headers: this.BASE_HEADER,
        })
        return await webpage.text()
    }

    private extractJavascriptUrls(html: string) {
        const urls = Array.from(html.matchAll(/(?:src|href)="([^"]+\.js)"/g))
            .map((match) => {
                const src = match[1]
                if (!src) {
                    return null
                }
                try {
                    return new URL(src, this.BASE_URL).toString()
                } catch {
                    return null
                }
            })
            .filter((url): url is string => Boolean(url))

        return Array.from(new Set(urls)).sort((left, right) => {
            const leftMain = /\/main\./.test(left) ? 0 : 1
            const rightMain = /\/main\./.test(right) ? 0 : 1
            return leftMain - rightMain
        })
    }

    private async resolveQueryId(operation: XApis) {
        if (!this.api_with_queryid[operation]) {
            await this.ensureQueryIds([operation])
        }

        const queryId = this.api_with_queryid[operation]
        if (!queryId) {
            throw new Error(`Missing query id for ${operation}`)
        }
        return queryId
    }

    private buildOperationHeaders(
        operation: XApis,
        cookie: string,
        options?: {
            extraHeaders?: Record<string, string>
            fallbackOperations?: Array<XApis>
            includeGuestToken?: boolean
            referer?: string
        },
    ) {
        const profile = this.getOperationProfile(operation, options?.fallbackOperations)
        const csrfToken = this.getCsrfToken(cookie)
        const headers: Record<string, string> = {
            ...this.BASE_HEADER,
            ...(profile?.headers || {}),
            ...(options?.referer ? { referer: options.referer } : {}),
            cookie,
            'x-csrf-token': csrfToken || profile?.headers['x-csrf-token'] || '',
            'x-twitter-active-user': profile?.headers['x-twitter-active-user'] || 'yes',
            'x-twitter-auth-type': profile?.headers['x-twitter-auth-type'] || 'OAuth2Session',
            ...(options?.includeGuestToken ? { 'x-guest-token': this.guest_token } : {}),
            ...(options?.extraHeaders || {}),
        }
        if (!headers.authorization) {
            headers.authorization = this.PUBLIC_TOKEN
        }
        if (!headers.origin) {
            headers.origin = 'https://x.com'
        }
        if (!headers.referer) {
            headers.referer = options?.referer || `${this.BASE_URL}/`
        }
        return normalizeRequestHeaders(headers)
    }

    /**
     * UserByScreenName
     */
    async getRawUserInfo(id: string, cookie: string) {
        await this.prepareUserOperations(id, {
            needTweets: false,
            needReplies: false,
        })
        const query_id = await this.resolveQueryId(XApis.UserByScreenName)
        const query_path = `${this.API_PREFIX}/${query_id}/${XApis.UserByScreenName}`
        const variables = {
            screen_name: id,
            withGrokTranslatedBio: false,
        }
        const features = {
            hidden_profile_subscriptions_enabled: true,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            responsive_web_profile_redirect_enabled: false,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            subscriptions_verification_info_is_identity_verified_enabled: true,
            subscriptions_verification_info_verified_since_enabled: true,
            highlights_tweets_tab_ui_enabled: true,
            responsive_web_twitter_article_notes_tab_enabled: true,
            subscriptions_feature_can_gift_premium: true,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
        }
        const fieldToggles = { withPayments: false, withAuxiliaryUserLabels: true }

        const query = this.generateParams(features, variables, fieldToggles)
        const url = `${this.BASE_URL}${query_path}?${query.toString()}`
        const res = await this.fetchWithTransientRetry(
            url,
            {
                headers: this.buildOperationHeaders(XApis.UserByScreenName, cookie, {
                    includeGuestToken: true,
                    referer: `${this.BASE_URL}/${id}`,
                }),
            },
            `user info (${id})`,
        )
        this.assertOkOrInvalidate(res, `user info (${id})`, XApis.UserByScreenName, id)
        const json = await res.json()
        return json
    }

    async getRestId(id: string, cookie: string) {
        const key = normalizeHydrationUserId(id)
        if (!key) {
            throw new Error(`Invalid user id: ${id}`)
        }
        if (this.name_to_rest_id[key]) {
            return this.name_to_rest_id[key]
        }
        const cached = this.cache?.get(`x-restid:${key}`)
        if (cached) {
            this.name_to_rest_id[key] = String(cached)
            return String(cached)
        }
        const inFlight = X_REST_ID_IN_FLIGHT.get(key)
        if (inFlight) {
            return inFlight
        }
        const promise = this.fetchRestIdForUser(key, cookie).finally(() => X_REST_ID_IN_FLIGHT.delete(key))
        X_REST_ID_IN_FLIGHT.set(key, promise)
        return promise
    }

    /**
     * Records a rest id obtained for free from another payload (ListMembers).
     * Normalized key keeps one cache entry per account regardless of casing.
     */
    prefillRestId(key: string, restId: string) {
        const normalized = normalizeHydrationUserId(key)
        if (!normalized || !restId) {
            return
        }
        this.name_to_rest_id[normalized] = restId
        this.cache?.set(`x-restid:${normalized}`, restId, X_CACHE_REST_ID_TTL_S)
    }

    /**
     * Accounts whose replies endpoint 404s do so consistently (private/no
     * replies); a short negative cache skips the doomed request instead of
     * paying one 404 per round per account.
     */
    isReplies404Cached(userId: string) {
        const key = normalizeHydrationUserId(userId)
        return Boolean(key && this.cache?.get(`x-replies-404:${key}`))
    }

    private async fetchRestIdForUser(key: string, cookie: string) {
        const user_info = await this.getRawUserInfo(key, cookie)
        if (!user_info) {
            throw new Error(`Failed to fetch user info for ${key}`)
        }
        const rest_id = user_info?.data?.user?.result?.rest_id
        if (!rest_id) {
            throw new Error(`Failed to fetch rest id for ${key}`)
        }
        this.name_to_rest_id[key] = String(rest_id)
        if (this.cache) {
            this.cache.set(`x-restid:${key}`, String(rest_id), X_CACHE_REST_ID_TTL_S)
        }
        return String(rest_id)
    }

    getQueryId(js: string, targetOperationName: string) {
        const escapedOperationName = targetOperationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`queryId:"([^"]+)",operationName:"${escapedOperationName}"`, 's')
        const match = js.match(regex)
        return match ? match[1] : null
    }

    generateParams(
        features: Record<string, any>,
        variables: Record<string, any>,
        fieldToggles?: Record<string, any>,
    ): URLSearchParams {
        let params = new URLSearchParams()
        params.append('variables', JSON.stringify(variables))
        params.append('features', JSON.stringify(features))
        if (fieldToggles) params.append('fieldToggles', JSON.stringify(fieldToggles))

        return params
    }

    getCsrfToken(cookie: string) {
        const match = cookie.match(/(?:^|;\s*)ct0=([0-9a-f]+)\s*(?:;|$)/)
        if (match) {
            return match[1]
        }
        return null
    }

    async grabTweets(id: string, cookie: string) {
        await this.prepareUserOperations(id, {
            needTweets: true,
            needReplies: false,
        })
        const rest_id = await this.getRestId(id, cookie)
        const query_id = await this.resolveQueryId(XApis.UserTweets)
        const query_path = `${this.API_PREFIX}/${query_id}/${XApis.UserTweets}`
        const uuid = uuidv4({
            rng: cookie ? () => Buffer.from(cookie.padEnd(16, '0')) : undefined,
        })
        const variables = {
            userId: rest_id,
            count: X_USER_TIMELINE_HYDRATE_COUNT,
            includePromotedContent: true,
            withQuickPromoteEligibilityTweetFields: true,
            withVoice: true,
        }
        const features = {
            rweb_video_screen_enabled: false,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_jetfuel_frame: false,
            responsive_web_grok_share_attachment_enabled: true,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_enhance_cards_enabled: false,
        }
        const fieldToggles = { withArticlePlainText: false }
        const query = this.generateParams(features, variables, fieldToggles)

        const url = `${this.BASE_URL}${query_path}?${query.toString()}`
        const res = await this.fetchWithTransientRetry(
            url,
            {
                headers: this.buildOperationHeaders(XApis.UserTweets, cookie, {
                    extraHeaders: { 'x-client-uuid': uuid },
                    referer: `${this.BASE_URL}/${id}`,
                }),
            },
            'tweets',
        )
        this.assertOkOrInvalidate(res, 'tweets', XApis.UserTweets, id)
        const json = await res.json()
        if (json.errors) {
            const firstError = Array.isArray(json.errors) ? json.errors[0] : json.errors
            const message =
                firstError && typeof firstError === 'object' && typeof firstError.message === 'string'
                    ? firstError.message
                    : String(json.errors).slice(0, 200)
            throw new Error(`Failed to fetch tweets: ${message}`)
        }
        return XApiJsonParser.tweetsArticleParser(json)
    }
    async grabReplies(id: string, cookie: string) {
        await this.prepareUserOperations(id, {
            needTweets: false,
            needReplies: true,
        })
        const rest_id = await this.getRestId(id, cookie)
        const query_id = await this.resolveQueryId(XApis.UserTweetsAndReplies)
        const query_path = `${this.API_PREFIX}/${query_id}/${XApis.UserTweetsAndReplies}`
        const uuid = uuidv4({
            rng: cookie ? () => Buffer.from(cookie.padEnd(16, '0')) : undefined,
        })
        const variables = {
            userId: rest_id,
            count: 8,
            includePromotedContent: true,
            withCommunity: true,
            withVoice: true,
        }
        const features = {
            rweb_video_screen_enabled: false,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_jetfuel_frame: false,
            responsive_web_grok_share_attachment_enabled: true,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_enhance_cards_enabled: false,
        }
        const fieldToggles = { withArticlePlainText: false }
        const query = this.generateParams(features, variables, fieldToggles)
        const url = `${this.BASE_URL}${query_path}?${query.toString()}`
        const res = await this.fetchWithTransientRetry(
            url,
            {
                headers: this.buildOperationHeaders(XApis.UserTweetsAndReplies, cookie, {
                    extraHeaders: { 'x-client-uuid': uuid },
                    fallbackOperations: [XApis.UserTweets],
                    referer: `${this.BASE_URL}/${id}/with_replies`,
                }),
            },
            'replies',
        )
        try {
            this.assertOkOrInvalidate(res, 'replies', XApis.UserTweetsAndReplies, id)
        } catch (error) {
            // A 404 here is an account trait, not a transient failure; remember it
            // briefly so the next rounds skip the doomed request.
            if (isNotFoundError(error)) {
                const key = normalizeHydrationUserId(id)
                if (key) {
                    this.cache?.set(`x-replies-404:${key}`, true, X_REPLIES_404_NEGATIVE_TTL_S)
                }
            }
            throw error
        }
        const json = await res.json()
        if (json.errors) {
            const firstError = Array.isArray(json.errors) ? json.errors[0] : json.errors
            const message =
                firstError && typeof firstError === 'object' && typeof firstError.message === 'string'
                    ? firstError.message
                    : String(json.errors).slice(0, 200)
            throw new Error(`Failed to fetch replies: ${message}`)
        }
        return XApiJsonParser.tweetsRepliesParser(json)
    }

    async grabTweetDetail(screenName: string, statusId: string, cookie: string) {
        await this.prepareTweetDetailOperation(screenName, statusId)
        const referer = `${this.BASE_URL}/${screenName}/status/${statusId}`
        // Always build the request URL from the CURRENT statusId. The cached
        // TweetDetail operation profile carries the full URL of the status it
        // was captured from; reusing it would fetch that old tweet.
        const query_id = await this.resolveQueryId(XApis.TweetDetail)
        const query_path = `${this.API_PREFIX}/${query_id}/${XApis.TweetDetail}`
        const variables = {
            focalTweetId: statusId,
            with_rux_injections: false,
            rankingMode: 'Relevance',
            includePromotedContent: true,
            withCommunity: true,
            withQuickPromoteEligibilityTweetFields: true,
            withBirdwatchNotes: true,
            withVoice: true,
        }
        const features = {
            rweb_video_screen_enabled: false,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_jetfuel_frame: false,
            responsive_web_grok_share_attachment_enabled: true,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_enhance_cards_enabled: false,
        }
        const fieldToggles = {
            withArticleRichContentState: true,
            withArticlePlainText: false,
            withGrokAnalyze: false,
        }
        const query = this.generateParams(features, variables, fieldToggles)
        const url = `${this.BASE_URL}${query_path}?${query.toString()}`

        const res = await this.fetchWithTransientRetry(
            url,
            {
                headers: this.buildOperationHeaders(XApis.TweetDetail, cookie, {
                    fallbackOperations: [XApis.UserTweets],
                    referer,
                }),
            },
            'tweet detail',
        )
        this.assertOkOrInvalidate(res, 'tweet detail', XApis.TweetDetail, screenName)
        const json = await res.json()
        if (json.errors) {
            const firstError = Array.isArray(json.errors) ? json.errors[0] : json.errors
            const message =
                firstError && typeof firstError === 'object' && typeof firstError.message === 'string'
                    ? firstError.message
                    : String(json.errors).slice(0, 200)
            throw new Error(`Failed to fetch tweet detail: ${message}`)
        }
        return XApiJsonParser.tweetDetailParser(json, statusId)
    }

    async grabFollowsNumber(id: string, cookie: string) {
        const user_info = await this.getRawUserInfo(id, cookie)
        if (!user_info) {
            throw new Error(`Failed to fetch user info for ${id}`)
        }
        return XApiJsonParser.tweetsFollowsParser(user_info)
    }

    async grabTweetsFromList(list_id: string, cookie: string) {
        await this.prepareListOperations(list_id)
        await this.ensureQueryIds([XApis.ListLatestTweetsTimeline]).catch(() => null)
        const query_id = this.api_with_queryid[XApis.ListLatestTweetsTimeline] ?? 'NRigOCel0QKiWs_GuBgOzw'
        const query_path = `${this.API_PREFIX}/${query_id}/ListLatestTweetsTimeline`
        const variables = { listId: list_id, count: 20 }
        const features = {
            rweb_video_screen_enabled: false,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            responsive_web_profile_redirect_enabled: false,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_jetfuel_frame: true,
            responsive_web_grok_share_attachment_enabled: true,
            responsive_web_grok_annotations_enabled: false,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: true,
            post_ctas_fetch_enabled: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_grok_imagine_annotation_enabled: true,
            responsive_web_grok_community_note_auto_translation_is_enabled: false,
            responsive_web_enhance_cards_enabled: false,
        }
        const query = this.generateParams(features, variables)

        const url = `${this.BASE_URL}${query_path}?${query.toString()}`
        const res = await this.fetchWithTransientRetry(
            url,
            {
                headers: this.buildOperationHeaders(XApis.ListLatestTweetsTimeline, cookie, {
                    referer: `${this.BASE_URL}/i/lists/${list_id}`,
                }),
            },
            'tweets',
        )
        this.assertOkOrInvalidate(res, 'tweets', XApis.ListLatestTweetsTimeline)
        const json = await res.json()
        if (json.errors) {
            const firstError = Array.isArray(json.errors) ? json.errors[0] : json.errors
            const message =
                firstError && typeof firstError === 'object' && typeof firstError.message === 'string'
                    ? firstError.message
                    : String(json.errors).slice(0, 200)
            throw new Error(`Failed to fetch tweets: ${message}`)
        }
        return XApiJsonParser.tweetsArticleParser(json)
    }

    async grabFollowsFromList(list_id: string, cookie: string) {
        await this.prepareListOperations(list_id)
        await this.ensureQueryIds([XApis.ListMembers]).catch(() => null)
        const query_id = this.api_with_queryid[XApis.ListMembers] ?? '8oGwd_SHm0nGs91qI4znfA'
        const query_path = `${this.API_PREFIX}/${query_id}/ListMembers`
        const variables = { listId: list_id, count: 99 }
        const features = {
            rweb_video_screen_enabled: false,
            payments_enabled: false,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            responsive_web_profile_redirect_enabled: false,
            rweb_tipjar_consumption_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            premium_content_api_read_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            responsive_web_grok_analyze_button_fetch_trends_enabled: false,
            responsive_web_grok_analyze_post_followups_enabled: true,
            responsive_web_jetfuel_frame: true,
            responsive_web_grok_share_attachment_enabled: true,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            responsive_web_grok_show_grok_translated_post: false,
            responsive_web_grok_analysis_button_from_backend: true,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_grok_image_annotation_enabled: true,
            responsive_web_grok_imagine_annotation_enabled: true,
            responsive_web_grok_community_note_auto_translation_is_enabled: false,
            responsive_web_enhance_cards_enabled: false,
        }
        const query = this.generateParams(features, variables)

        const url = `${this.BASE_URL}${query_path}?${query.toString()}`
        const res = await this.fetchWithTransientRetry(
            url,
            {
                headers: this.buildOperationHeaders(XApis.ListMembers, cookie, {
                    fallbackOperations: [XApis.ListLatestTweetsTimeline],
                    referer: `${this.BASE_URL}/i/lists/${list_id}`,
                }),
            },
            'follows',
        )
        this.assertOkOrInvalidate(res, 'list members', XApis.ListMembers)
        const json = await res.json()
        if (json.errors) {
            const firstError = Array.isArray(json.errors) ? json.errors[0] : json.errors
            const message =
                firstError && typeof firstError === 'object' && typeof firstError.message === 'string'
                    ? firstError.message
                    : String(json.errors).slice(0, 200)
            throw new Error(`Failed to fetch list members: ${message}`)
        }
        return XApiJsonParser.tweetsFollowsFromListParser(json)
    }
}
namespace XApiJsonParser {
    namespace Card {
        function getThumbnailUrl(
            values: Array<{
                key: string
                value: { type: string } & Record<string, any>
            }>,
        ) {
            let media = values
                .filter((v) => v.value.type === 'IMAGE')
                .map(
                    (v) =>
                        v.value.image_value as {
                            height: number
                            width: number
                            url: string
                        },
                )
            if (media.length <= 0) {
                return
            }
            media = media.sort((a, b) => b.height - a.height)
            return media[0]?.url
        }

        interface BindingValue {
            key: string
            value: {
                string_value: string
                type: string
            }
        }

        const transformPollData = (bindingValues: BindingValue[]) => {
            const resultMap = new Map<number, { name?: string; count?: string }>()

            // 使用正则表达式匹配所有choice数字编号
            const choicePattern = /^choice(\d+)_(label|count)$/

            bindingValues.forEach((item) => {
                const match = item.key.match(choicePattern)
                if (!match) return

                const [, indexStr, type] = match
                const index = parseInt(indexStr || '0', 10)

                if (!resultMap.has(index)) {
                    resultMap.set(index, {})
                }

                const current = resultMap.get(index)!
                if (type === 'label') {
                    current.name = item.value.string_value
                } else if (type === 'count') {
                    current.count = item.value.string_value
                }
            })

            // 转换为有序数组并过滤无效条目
            return Array.from(resultMap.entries())
                .sort(([a], [b]) => a - b) // 按choice数字顺序排序
                .map(([index, values]) => ({
                    name: values.name || `Unknown Choice ${index}`,
                    count: values.count || '0',
                }))
                .filter((item) => item.name && item.count) // 过滤无效条目
        }

        function extractValueByKey(
            values: Array<{
                key: string
                value: { type: string } & Record<string, any>
            }>,
            key: string,
        ) {
            if (!values) {
                return
            }
            const value = values.find((v) => v.key === key)
            if (value) {
                return value.value
            }
            return
        }

        export function cardParser(card: any): ArticleExtractType<Platform.X> | null {
            if (!card) {
                return null
            }
            let _card = {
                type: CardTypeEnum.NONE,
                card_url: card.url,
            } as Card<CardTypeEnum>
            if (card.name.includes('image')) {
                _card.type = CardTypeEnum.IMAGE
            }
            if (card.name.includes('player')) {
                _card.type = CardTypeEnum.PLAYER
            }
            if (card.name.includes('choice')) {
                _card.type = CardTypeEnum.CHOICE
            }
            if (card.name.includes('audiospace')) {
                _card.type = CardTypeEnum.SPACE
            }
            if (_card.type === CardTypeEnum.NONE) {
                return null
            }

            let binding_values = card.binding_values
            if (!Array.isArray(binding_values)) {
                binding_values = Object.entries(binding_values).map(([key, value]) => ({
                    key,
                    value,
                }))
            }

            let media: GenericMediaInfo[] = []
            let content
            if ([CardTypeEnum.IMAGE, CardTypeEnum.PLAYER].includes(_card.type)) {
                _card = {
                    ..._card,
                    title: extractValueByKey(binding_values, 'title')?.string_value,
                    description: extractValueByKey(binding_values, 'description')?.string_value,
                    domain: extractValueByKey(binding_values, 'domain')?.string_value,
                    thumbnail_url: getThumbnailUrl(binding_values),
                    player_url: extractValueByKey(binding_values, 'player_url')?.string_value,
                } as Card<CardTypeEnum.IMAGE | CardTypeEnum.PLAYER>
                const type_guard_card = _card as Card<CardTypeEnum.IMAGE | CardTypeEnum.PLAYER>
                content = [
                    type_guard_card.title ? type_guard_card.title : '',
                    type_guard_card.description ? type_guard_card.description : '',
                    type_guard_card.domain ? type_guard_card.domain : '',
                    'player_url' in type_guard_card && type_guard_card.player_url ? type_guard_card.player_url : '',
                ]
                    .filter(Boolean)
                    .join('\n')
            }
            const thumbnailUrl = (_card as Card<CardTypeEnum.IMAGE | CardTypeEnum.PLAYER>).thumbnail_url || ''
            if (thumbnailUrl) {
                media.push({
                    type: 'photo',
                    url: thumbnailUrl,
                })
            }

            if (_card.type === CardTypeEnum.CHOICE) {
                const choices = binding_values.filter((v: any) => v.key.startsWith('choice'))
                _card = {
                    ..._card,
                    choices: transformPollData(choices),
                } as Card<CardTypeEnum.CHOICE>
                content = `choices:\n${(_card as Card<CardTypeEnum.CHOICE>).choices
                    .map((choice) => `${choice.name}: ${choice.count}`)
                    .join('\n')}`
            }

            if (_card.type === CardTypeEnum.SPACE) {
                content = `space id: ${extractValueByKey(binding_values, 'id')?.string_value}`
            }
            return {
                data: _card,
                content,
                media,
                extra_type: 'card',
            } as ArticleExtractType<Platform.X>
        }
    }

    function collectTimelineEntries(json: any) {
        return JSONPath({ path: "$..instructions[?(@.type === 'TimelineAddEntries')].entries", json })
            .filter(Array.isArray)
            .flat()
    }

    function collectTimelineModuleItemGroups(json: any) {
        return JSONPath({ path: "$..instructions[?(@.type === 'TimelineAddToModule')]", json })
            .map((instruction: any) => instruction?.moduleItems || instruction?.items || [])
            .filter(Array.isArray)
            .filter((items: any[]) => items.length > 0)
    }

    function sanitizeTweetsJson(json: any) {
        let tweets = collectTimelineEntries(json)
        const moduleItemGroups = collectTimelineModuleItemGroups(json)
        let pin_tweet = JSONPath({ path: "$..instructions[?(@.type === 'TimelinePinEntry')].entry", json })[0]
        if (tweets.length === 0 && moduleItemGroups.length === 0) {
            const instructionTypes = Array.from(
                new Set(JSONPath({ path: '$..instructions[*].type', json }).filter(Boolean)),
            )
            throw new Error(
                `Tweet json format may have changed (instruction types: ${instructionTypes.join(', ') || 'none'})`,
            )
        }

        if (pin_tweet) {
            tweets.unshift(pin_tweet)
        }
        return tweets
    }

    function extractTweetResultFromTimelineItem(item: any) {
        const result =
            item?.content?.itemContent?.tweet_results?.result ||
            item?.item?.itemContent?.tweet_results?.result ||
            item?.itemContent?.tweet_results?.result
        return result?.tweet || result || null
    }

    function getTweetResultLegacy(result: any) {
        return result?.legacy || result?.tweet?.legacy
    }

    /**
     * X Premium long-form tweets (>280 chars) are truncated in legacy.full_text and the
     * timeline shows a "show more" prompt. The full text lives in the note_tweet payload,
     * present for both Tweet and TweetWithVisibilityResults shapes. The note payload also
     * carries its own entity_set, since legacy.entities are missing or truncated there.
     */
    function getTweetResultNoteTweet(result: any) {
        const noteTweet = result?.note_tweet || result?.tweet?.note_tweet
        return noteTweet?.note_tweet_results?.result || null
    }

    function unescapeHtmlText(text: string) {
        return text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    }

    /**
     * Only treat a tweet as long-form when the note payload actually carries text beyond
     * the truncated legacy.full_text. Note tweets never appear for regular accounts, so
     * non-premium posts keep the legacy text untouched. legacy.full_text is HTML-escaped
     * (e.g. &amp;) while the note text is raw, so compare normalized forms.
     */
    function isTweetNoteTruncated(result: any, noteText: string) {
        const fullText = getTweetResultLegacy(result)?.full_text || ''
        if (!fullText || !noteText) {
            return false
        }
        return unescapeHtmlText(noteText) !== unescapeHtmlText(fullText)
    }

    function getTweetResultId(result: any) {
        return getTweetResultLegacy(result)?.id_str || null
    }

    function isReplyTweetResult(result: any) {
        return Boolean(getTweetResultLegacy(result)?.in_reply_to_status_id_str)
    }

    function collectConversationResultGroups(json: any, entries: any[]) {
        const entryGroups = entries
            .filter((entry: { entryId?: string }) => entry.entryId?.startsWith('profile-conversation'))
            .map((entry: { content?: { items?: any[] }; items?: any[] }) => entry.content?.items || entry.items || [])
            .filter(Array.isArray)

        return [...entryGroups, ...collectTimelineModuleItemGroups(json)]
            .map((items: any[]) => items.map(extractTweetResultFromTimelineItem).filter(Boolean))
            .filter((results: any[]) => results.length > 0)
    }

    function buildConversationArticle(results: any[]) {
        return results
            .map(tweetParser)
            .filter((tweet): tweet is GenericArticle<Platform.X> => Boolean(tweet))
            .reduce((acc: GenericArticle<Platform.X> | null, tweet) => {
                if (acc) {
                    tweet.ref = acc
                    tweet.type = ArticleTypeEnum.CONVERSATION
                }
                // 去除回复中的@用户名
                if (/^@\w+ /.test(tweet.content || '')) {
                    tweet.content = tweet.content?.replace(/^@\w+ /, '') ?? null
                }
                return tweet
            }, null)
    }

    // 时间转换辅助函数
    function parseTwitterDate(dateStr: string) {
        const parsed = Date.parse(dateStr.replace(/( \+0000)/, ' UTC$1'))
        return Number.isFinite(parsed) ? parsed : 0
    }

    function mediaParser(media: any) {
        if (!media) {
            return null
        }
        const pickVideoVariantUrl = (variants: any) => {
            if (!Array.isArray(variants) || variants.length === 0) {
                return null
            }
            const playableVariants = variants.filter((variant: any) => typeof variant?.url === 'string' && variant.url)
            if (playableVariants.length === 0) {
                return null
            }
            const mp4Variants = playableVariants.filter((variant: any) =>
                String(variant?.content_type || '').includes('mp4'),
            )
            const candidates = mp4Variants.length > 0 ? mp4Variants : playableVariants
            return candidates.sort((a: any, b: any) => (b?.bitrate || 0) - (a?.bitrate || 0))[0]?.url
        }
        return media
            .map((m: any) => {
                const { media_url_https, video_info, type, ext_alt_text } = m
                if (type === 'photo') {
                    return {
                        type,
                        url: media_url_https,
                        ...(ext_alt_text ? { alt: ext_alt_text } : {}),
                    }
                }
                if (type === 'video' || type === 'animated_gif') {
                    const videoUrl = pickVideoVariantUrl(video_info?.variants)
                    return [
                        videoUrl
                            ? {
                                  type: 'video',
                                  url: videoUrl,
                              }
                            : null,
                        {
                            type: 'video_thumbnail',
                            url: media_url_https,
                        },
                    ]
                }
            })
            .flat()
            .filter(Boolean)
    }

    function tweetParser(result: any): GenericArticle<Platform.X> | null {
        // TweetWithVisibilityResults --> result.tweet
        const legacy = getTweetResultLegacy(result)
        if (!legacy?.id_str || !legacy?.created_at) {
            return null
        }
        const userResult = (result.core || result.tweet?.core)?.user_results?.result
        const userLegacy = userResult?.core || userResult?.legacy
        const quotedResult = result.quoted_status_result?.result
        const retweetedResult = result.retweeted_status_result?.result || legacy?.retweeted_status_result?.result
        const replyToId = legacy?.in_reply_to_status_id_str || null
        const noteTweet = getTweetResultNoteTweet(result)
        const noteText = noteTweet?.text || null
        const useNoteText = noteText ? isTweetNoteTruncated(result, noteText) : false
        let content = useNoteText ? noteText : legacy?.full_text
        for (const { url } of legacy?.entities?.media || []) {
            content = content.replace(url, '')
        }

        // 主推文解析
        const tweet = {
            platform: Platform.X,
            a_id: legacy?.id_str,
            u_id: userLegacy?.screen_name,
            username: userLegacy?.name,
            created_at: Math.floor(parseTwitterDate(legacy?.created_at) / 1000),
            content: useNoteText ? noteText : legacy?.full_text,
            url: userLegacy?.screen_name ? `https://x.com/${userLegacy.screen_name}/status/${legacy?.id_str}` : '',
            type: quotedResult
                ? ArticleTypeEnum.QUOTED
                : retweetedResult
                  ? ArticleTypeEnum.RETWEET
                  : replyToId
                    ? ArticleTypeEnum.CONVERSATION
                    : ArticleTypeEnum.TWEET,
            ref: quotedResult ? tweetParser(quotedResult) : retweetedResult ? tweetParser(retweetedResult) : replyToId,
            media: mediaParser(legacy?.extended_entities?.media || legacy?.entities?.media),
            has_media: !!legacy?.extended_entities?.media || !!legacy?.entities?.media,
            extra: Card.cardParser(result.card?.legacy),
            u_avatar:
                userResult?.avatar?.image_url?.replace('_normal', '') ||
                userLegacy?.profile_image_url_https?.replace('_normal', ''),
        }
        // 处理转发类型
        if (retweetedResult) {
            tweet.type = ArticleTypeEnum.RETWEET
            tweet.content = ''
            tweet.ref = tweetParser(retweetedResult)
            // 转发类型推文media按照ref为准
            tweet.media = null
            tweet.has_media = false
            tweet.extra = null
        }
        let urls = [...(useNoteText ? noteTweet?.entity_set?.urls || [] : []), ...(legacy.entities?.urls || [])]
        for (const u of urls) {
            if (u.expanded_url && !u.expanded_url.startsWith('https://x.com/')) {
                tweet.content = tweet.content?.replace(u.url, u.expanded_url) ?? null
            } else {
                tweet.content = tweet.content?.replace(u.url, '') ?? null
            }
        }
        const note_media_urls = useNoteText
            ? noteTweet?.entity_set?.media?.map((m: { url: string }) => m.url) || []
            : []
        let media_urls = legacy.entities?.media?.map((m: { url: string }) => m.url) || []
        for (const url of [...note_media_urls, ...media_urls]) {
            tweet.content = tweet.content?.replace(url, '') ?? null
        }
        return tweet as GenericArticle<Platform.X>
    }

    export function oldTweetParser(json: any): GenericArticle<Platform.X> | null {
        const legacy = json
        if (!legacy?.id_str || typeof legacy?.created_at !== 'string') {
            return null
        }
        const userLegacy = json?.user
        let type: ArticleTypeEnum = ArticleTypeEnum.TWEET
        let ref: GenericArticleRef<Platform.X> | null = null
        if (legacy?.retweeted_status) {
            // high priority
            type = ArticleTypeEnum.RETWEET
            ref = oldTweetParser(legacy?.retweeted_status) ?? legacy?.retweeted_status?.id_str ?? null
        } else if (legacy?.is_quote_status) {
            type = ArticleTypeEnum.QUOTED
            ref = legacy?.quoted_status
                ? (oldTweetParser(legacy?.quoted_status) ?? legacy?.quoted_status?.id_str ?? null)
                : legacy?.quoted_status_id_str || null
        } else if (legacy?.in_reply_to_status_id_str) {
            type = ArticleTypeEnum.CONVERSATION
            ref = legacy?.in_reply_to_status_id_str
        }
        // 主推文解析
        const tweet = {
            platform: Platform.X,
            a_id: legacy?.id_str,
            u_id: userLegacy?.screen_name,
            username: userLegacy?.name,
            created_at: Math.floor(parseTwitterDate(legacy?.created_at) / 1000),
            content: legacy?.full_text,
            url: userLegacy?.screen_name ? `https://x.com/${userLegacy.screen_name}/status/${legacy?.id_str}` : '',
            type: type,
            ref: ref,
            // extended_entities里是video，但entities里只是图片
            media: mediaParser(legacy?.extended_entities?.media || legacy?.entities?.media),
            has_media: !!legacy?.extended_entities?.media || !!legacy?.entities?.media,
            extra: Card.cardParser(legacy.card),
            u_avatar: userLegacy?.profile_image_url_https?.replace('_normal', ''),
        } as GenericArticle<Platform.X>
        // 处理转发类型
        if (tweet.type === ArticleTypeEnum.RETWEET) {
            tweet.content = ''
            // 转发类型推文media按照ref为准
            tweet.media = null
            tweet.has_media = false
            tweet.extra = null
        }

        let urls = legacy.entities?.urls || []
        for (const u of urls) {
            if (u.expanded_url && !u.expanded_url.startsWith('https://x.com/')) {
                tweet.content = tweet.content?.replace(u.url, u.expanded_url) ?? null
            } else {
                tweet.content = tweet.content?.replace(u.url, '') ?? null
            }
        }
        let media_urls = legacy.entities?.media?.map((m: { url: string }) => m.url) || []
        for (const url of media_urls) {
            tweet.content = tweet.content?.replace(url, '') ?? null
        }
        return tweet as GenericArticle<Platform.X>
    }

    export function oldTweetMemeberParser(json: any): GenericArticle<Platform.X> | null {
        const legacy = json?.status
        if (!legacy?.id_str) {
            return null
        }
        // Member-list payloads keep the author at the envelope level instead of
        // `status.user`. Normalize once and reuse the full tweet parser so
        // retweets/quotes/conversations keep the same ref semantics as the main
        // timeline instead of being silently dropped.
        const normalizedLegacy = {
            ...legacy,
            full_text: legacy.full_text || legacy.text,
            user: json?.user || json,
        }
        return oldTweetParser(normalizedLegacy)
    }

    export function tweetsArticleParser(json: any) {
        let tweets = sanitizeTweetsJson(json)
        tweets = tweets
            .filter(
                (t: { entryId?: string }) =>
                    t.entryId?.startsWith('tweet-') && !t.entryId.startsWith('profile-conversation'),
            )
            .map(extractTweetResultFromTimelineItem)
            .filter(Boolean)
        return tweets.map(tweetParser).filter(Boolean) as Array<GenericArticle<Platform.X>>
    }

    export function tweetsRepliesParser(json: any) {
        const tweets = sanitizeTweetsJson(json)
        const conversationResultGroups = collectConversationResultGroups(json, tweets)
        const groupedTweetIds = new Set(
            conversationResultGroups.flatMap((group) => group.map(getTweetResultId).filter(Boolean)),
        )
        const conversationArticles = conversationResultGroups.map(buildConversationArticle).filter(Boolean)
        const directReplyArticles = tweets
            .filter((t: { entryId: string }) => t.entryId?.startsWith('tweet-'))
            .map(extractTweetResultFromTimelineItem)
            .filter(Boolean)
            .filter((result: any) => isReplyTweetResult(result) && !groupedTweetIds.has(getTweetResultId(result)))
            .map(tweetParser)
            .filter(Boolean)

        return [...conversationArticles, ...directReplyArticles] as Array<GenericArticle<Platform.X>>
    }

    export function tweetDetailParser(json: any, statusId?: string) {
        const tweetResults = JSONPath({ path: '$..tweet_results.result', json })
            .map((result: any) => result?.tweet || result)
            .filter(Boolean)
        const targetResult =
            (statusId ? tweetResults.find((result: any) => getTweetResultId(result) === statusId) : null) ||
            tweetResults[0]
        const article = targetResult ? tweetParser(targetResult) : null
        if (!article) {
            throw new Error(`Tweet detail json did not contain tweet ${statusId || ''}`.trim())
        }
        return article
    }

    export function oldFollowsParser(user: any): GenericFollows {
        if (!user) {
            throw new Error('Follows json format may have changed')
        }
        return {
            platform: Platform.X,
            username: user?.name,
            u_id: user?.screen_name,
            followers: user?.followers_count,
        }
    }

    export function tweetsFollowsFromListParser(json: any): Array<GenericFollows & { rest_id?: string | null }> {
        const results = JSONPath({ path: '$..user_results.result', json })
        return results.map((r: any) => {
            return {
                platform: Platform.X,
                username: r?.core?.name,
                u_id: r?.core?.screen_name,
                rest_id: r?.rest_id ?? null,
                followers: r?.legacy?.followers_count,
            }
        })
    }

    export function tweetsFollowsParser(json: any): GenericFollows {
        const user = JSONPath({ path: '$..user.result.legacy', json })[0]
        if (!user) {
            throw new Error('Follows json format may have changed')
        }
        return {
            platform: Platform.X,
            username: user?.name,
            u_id: user?.screen_name,
            followers: user?.followers_count,
        }
    }

    /**
     * @param url https://x.com/username
     * @description grab tweets from user page
     */
    export async function grabTweets(
        page: Page,
        url: string,
        config: {
            viewport?: {
                width: number
                height: number
            }
        } = {},
    ): Promise<Array<GenericArticle<Platform.X>>> {
        const { cleanup, promise: waitForTweets } = waitForResponse(page, async (response, { done, fail }) => {
            const url = response.url()
            if (url.includes('UserTweets') && response.request().method() === 'GET') {
                if (response.status() >= 300 && response.status() < 400) {
                    const location = response.headers()['location'] || ''
                    if (/login/i.test(location)) {
                        fail(new Error(`Error: login redirect (${response.status()}): session expired or checkpoint`))
                    } else {
                        fail(
                            new Error(
                                `Error: redirect (${response.status()}) to ${location || 'unknown'} - likely rate limit or challenge`,
                            ),
                        )
                    }
                    return
                }
                if (response.status() >= 400) {
                    fail(new Error(`Error: ${response.status()}`))
                    return
                }
                response
                    .json()
                    .then((json) => {
                        done(json)
                    })
                    .catch((error) => {
                        fail(error)
                    })
            }
        })
        try {
            // Keep the realistic viewport applied by the browser profile; only override when
            // a caller explicitly requests a specific viewport.
            if (config.viewport) {
                await page.setViewport(config.viewport)
            }
            await page.goto(url, { waitUntil: 'domcontentloaded' })
            await checkLogin(page)
            await checkSomethingWrong(page)
        } catch (error) {
            cleanup()
            throw error
        }
        const data = await waitForTweets
        if (!data.success) {
            throw data.error
        }
        const tweets_json = data.data

        return XApiJsonParser.tweetsArticleParser(tweets_json)
    }

    /**
     * @param url https://x.com/username/replies
     * @description grab replies from user page
     */
    export async function grabReplies(
        page: Page,
        url: string,
        config: {
            viewport?: {
                width: number
                height: number
            }
        } = {},
    ): Promise<Array<GenericArticle<Platform.X>>> {
        const { cleanup, promise: waitForTweets } = waitForResponse(page, async (response, { done, fail }) => {
            const url = response.url()
            if (url.includes('UserTweetsAndReplies') && response.request().method() === 'GET') {
                if (response.status() >= 300 && response.status() < 400) {
                    const location = response.headers()['location'] || ''
                    if (/login/i.test(location)) {
                        fail(new Error(`Error: login redirect (${response.status()}): session expired or checkpoint`))
                    } else {
                        fail(
                            new Error(
                                `Error: redirect (${response.status()}) to ${location || 'unknown'} - likely rate limit or challenge`,
                            ),
                        )
                    }
                    return
                }
                if (response.status() >= 400) {
                    fail(new Error(`Error: ${response.status()}`))
                    return
                }
                response
                    .json()
                    .then((json) => {
                        done(json)
                    })
                    .catch((error) => {
                        fail(error)
                    })
            }
        })
        try {
            if (config.viewport) {
                await page.setViewport(config.viewport)
            }
            await page.goto(url, { waitUntil: 'domcontentloaded' })
            await checkLogin(page)
            await checkSomethingWrong(page)
        } catch (error) {
            cleanup()
            throw error
        }

        const data = await waitForTweets
        if (!data.success) {
            throw data.error
        }
        const tweets_json = data.data
        return XApiJsonParser.tweetsRepliesParser(tweets_json)
    }

    /**
     * @param url https://x.com/username
     */
    export async function grabFollowsNumber(page: Page, url: string): Promise<GenericFollows> {
        const { cleanup, promise: waitForTweets } = waitForResponse(page, async (response, { done, fail }) => {
            const url = response.url()
            if (url.includes('UserByScreenName') && response.request().method() === 'GET') {
                if (response.status() >= 300 && response.status() < 400) {
                    const location = response.headers()['location'] || ''
                    if (/login/i.test(location)) {
                        fail(new Error(`Error: login redirect (${response.status()}): session expired or checkpoint`))
                    } else {
                        fail(
                            new Error(
                                `Error: redirect (${response.status()}) to ${location || 'unknown'} - likely rate limit or challenge`,
                            ),
                        )
                    }
                    return
                }
                if (response.status() >= 400) {
                    fail(new Error(`Error: ${response.status()}`))
                    return
                }
                response
                    .json()
                    .then((json) => {
                        done(json)
                    })
                    .catch((error) => {
                        fail(error)
                    })
            }
        })
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' })
            await checkLogin(page)
            await checkSomethingWrong(page)
        } catch (error) {
            cleanup()
            throw error
        }

        const data = await waitForTweets
        if (!data.success) {
            throw data.error
        }
        const user_json = data.data
        return XApiJsonParser.tweetsFollowsParser(user_json)
    }

    /**
     * Check if there is something wrong on the page of https://x.com/username
     */
    export async function checkSomethingWrong(page: Page) {
        const retry_button = await page
            .waitForSelector('nav[role="navigation"] + div > button', { timeout: 1000 })
            .catch(() => null)
        if (retry_button) {
            const error = await page.$('nav[role="navigation"] + div > div:first-child')
            throw new Error(
                `Something wrong on the page, maybe you have reached the limit or cookies are expired: ${await error?.evaluate((e) => e.textContent)}`,
            )
        }
    }

    export async function checkLogin(page: Page) {
        const login_button = await page
            .waitForSelector('a[href="/login"], [href*="/i/flow/login"]', { timeout: 1000 })
            .catch(() => null)
        if (login_button) {
            throw new Error('You need to login first, check your cookies')
        }
    }
}

enum CardTypeEnum {
    NONE = 'none',
    PLAYER = 'player',
    IMAGE = 'image',
    CHOICE = 'choice',
    SPACE = 'space',
}

type CardDataMedia = {
    title?: string
    description?: string
    domain?: string
    thumbnail_url?: string
}

type CardDataMapping = {
    [CardTypeEnum.PLAYER]: CardDataMedia & {
        player_url: string
    }
    [CardTypeEnum.IMAGE]: CardDataMedia
    [CardTypeEnum.CHOICE]: {
        choices: Array<{
            name: string
            count: string
        }>
    }
    [CardTypeEnum.SPACE]: {}
    [CardTypeEnum.NONE]: {}
}
type Card<T extends CardTypeEnum> = {
    type: T
    card_url: string
} & CardDataMapping[T]

type ExtraContentType = Card<CardTypeEnum> | null

export { ArticleTypeEnum, assertXResponseOk, XApiJsonParser, XUserTimeLineSpider, XStatusSpider, XListSpider }

export type { ExtraContentType, XListApiEngine }
