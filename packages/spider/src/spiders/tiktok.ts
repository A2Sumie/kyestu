import { Platform } from '../types'
import type { GenericMediaInfo, GenericArticle, GenericFollows, TaskType, TaskTypeResult, CrawlEngine } from '../types'
import { BaseSpider, waitForResponse } from './base'
import { Page } from 'puppeteer-core'

import { JSONPath } from 'jsonpath-plus'
import { getCookieString, HTTPClient, SimpleExpiringCache } from '../utils'

const TIKTOK_HTTP_TIMEOUT_MS = 15000
const TIKTOK_BROWSER_HYDRATE_ATTEMPTS = 3
const TIKTOK_BROWSER_HYDRATE_POLL_MS = 5000
const TIKTOK_HYDRATE_BACKOFF_MS = [5000, 12000, 30000]
const TIKTOK_SECUID_CACHE_TTL_S = 6 * 60 * 60
const TIKTOK_INVALID_HANDLE_CACHE_TTL_S = 24 * 60 * 60

class TiktokInvalidHandleError extends Error {
    readonly code = 'tiktok_invalid_handle'

    constructor(handle: string) {
        super(`TikTok handle @${handle} appears to not exist (tiktok_invalid_handle)`)
        this.name = 'TiktokInvalidHandleError'
    }
}

enum ArticleTypeEnum {
    /**
     * basic page: https://www.tiktok.com/api/post/item_list/
     */
    POST = 'post',
}

class TiktokSpider extends BaseSpider {
    // extends from XBaseSpider regex
    static _VALID_URL =
        /^(https:\/\/)?(www\.)?tiktok\.com\/@(?<id>[A-Za-z0-9._]+)(?:\/video\/(?<videoId>\d+)\/?)?(?:\?.*)?$/i
    static _PLATFORM = Platform.TikTok
    BASE_URL: string = 'https://www.tiktok.com/'
    NAME: string = 'Tiktok Generic Spider'

    protected cache: SimpleExpiringCache = new SimpleExpiringCache()
    private expire: number = 60 * 3 // 3 minutes

    async _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: {
            task_type: T
            crawl_engine: CrawlEngine
            sub_task_type?: Array<string>
            cookieString?: string
        },
    ): Promise<TaskTypeResult<T, Platform.TikTok>> {
        const result = super._match_valid_url(url, TiktokSpider)?.groups
        if (!result) {
            throw new Error(`Invalid URL: ${url}`)
        }
        let random_hex7 = this.cache.get('random_hex7')
        if (!random_hex7) {
            random_hex7 = TiktokApiJsonParser.randomHexString(7)
            this.cache.set('random_hex7', random_hex7, this.expire)
        }
        let device_id = this.cache.get('device_id')
        if (!device_id) {
            device_id = TiktokApiJsonParser.randomDeviceId().toString()
            this.cache.set('device_id', device_id, this.expire)
        }
        const { id, videoId } = result
        const _url = `${this.BASE_URL}@${id}`
        const videoUrl = videoId ? `${_url}/video/${videoId}/` : null
        const cookieString =
            config.cookieString || (page ? getCookieString(await page.browserContext().cookies()) : undefined)
        const { task_type } = config
        if (task_type === 'article') {
            this.log?.info(videoUrl ? 'Trying to grab video.' : 'Trying to grab posts.')
            const res = videoUrl
                ? await TiktokApiJsonParser.grabVideo(videoUrl, page, cookieString)
                : await TiktokApiJsonParser.grabPosts(
                      _url,
                      random_hex7,
                      Number(device_id),
                      page,
                      cookieString,
                      this.cache,
                  )
            return res as TaskTypeResult<T, Platform.TikTok>
        }

        if (task_type === 'follows') {
            this.log?.info('Trying to grab follows.')
            return [
                await TiktokApiJsonParser.grabFollowsNumber(_url, random_hex7, Number(device_id), page, cookieString),
            ] as TaskTypeResult<T, Platform.TikTok>
        }

        throw new Error('Invalid task type')
    }
}

namespace TiktokApiJsonParser {
    const BelowRange = 7250000000000000000
    const AboveRange = 7351147085025500000
    const _API_BASE_URL = 'https://www.tiktok.com/api/creator/item_list/'

    const hex_digits = '0123456789abcdefABCDEF'

    export function randomHexString(length: number): string {
        return Array.from({ length }, () => hex_digits[Math.floor(Math.random() * hex_digits.length)]).join('')
    }

    export function randomDeviceId(): number {
        return Math.floor(Math.random() * (AboveRange - BelowRange + 1) + BelowRange)
    }

    async function checkLogin(page: Page) {
        const login_form = await page.waitForSelector('form[id="loginForm"]', { timeout: 1000 }).catch(() => null)
        if (login_form) {
            throw new Error('You need to login first, check your cookies')
        }
    }

    async function checkSomethingWrong(page: Page) {
        const main_frame_error = await page
            .waitForSelector('div[id="main-frame-error"]', { timeout: 1000 })
            .catch(() => null)
        if (main_frame_error) {
            const error_content = (await main_frame_error.evaluate((e) => e.textContent))?.replace(/\s+/g, ' ')
            throw new Error(`Something wrong on the page: ${error_content}`)
        }
    }

    function buildHeaders(url: string, cookieString?: string): Record<string, string> {
        const headers: Record<string, string> = {
            'accept-language': 'en-US,en;q=0.9',
            referer: url,
        }
        if (cookieString?.trim()) {
            headers.cookie = cookieString
        }
        return headers
    }

    function extractUniversalData(text: string): string | null {
        return text.match(/<script\s*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)?.[1] || null
    }

    function pickUrl(value: any): string | null {
        if (!value) {
            return null
        }
        if (typeof value === 'string') {
            return value
        }
        if (Array.isArray(value)) {
            return (
                value.find((item) => typeof item === 'string' && item.includes('aweme/v1/play')) ||
                value.find((item) => typeof item === 'string') ||
                null
            )
        }
        return pickUrl(
            value.UrlList ||
                value.url_list ||
                value.PlayAddr?.UrlList ||
                value.playAddr?.url_list ||
                value.Data ||
                value.src,
        )
    }

    async function extractUniversalDataFromLoadedPage(page: Page): Promise<string> {
        for (let attempt = 0; attempt < TIKTOK_BROWSER_HYDRATE_ATTEMPTS; attempt++) {
            await page
                .waitForSelector('script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]', {
                    timeout: TIKTOK_BROWSER_HYDRATE_POLL_MS,
                })
                .catch(() => null)
            const browserContent = extractUniversalData(await page.content())
            if (browserContent) {
                return browserContent
            }
            await checkSomethingWrong(page)
            if (attempt < TIKTOK_BROWSER_HYDRATE_ATTEMPTS - 1) {
                // Backoff between hydration polls instead of hammering: the hydration
                // script may be delayed by rate-limiting; linear retries feed the 429s.
                await new Promise((resolve) => setTimeout(resolve, TIKTOK_HYDRATE_BACKOFF_MS[attempt]))
            }
        }

        throw new Error('Cannot find user data (browser hydration missing)')
    }

    async function loadUniversalDataFromBrowser(url: string, page: Page): Promise<string> {
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
        })
        await checkLogin(page)
        await checkSomethingWrong(page)
        return extractUniversalDataFromLoadedPage(page)
    }

    async function loadUniversalData(url: string, page?: Page, cookieString?: string): Promise<string> {
        if (page) {
            try {
                return await loadUniversalDataFromBrowser(url, page)
            } catch (browserError) {
                try {
                    const headers = buildHeaders(url, cookieString)
                    const webpage = await HTTPClient.download_webpage(url, headers, { timeout: TIKTOK_HTTP_TIMEOUT_MS })
                    const content = extractUniversalData(await webpage.text())
                    if (content) {
                        return content
                    }
                } catch {}
                throw browserError
            }
        }

        const headers = buildHeaders(url, cookieString)
        const webpage = await HTTPClient.download_webpage(url, headers, { timeout: TIKTOK_HTTP_TIMEOUT_MS })
        const text = await webpage.text()
        const content = extractUniversalData(text)
        if (content) {
            return content
        }

        throw new Error('Cannot find user data (fetch blocked, no browser fallback available)')
    }

    function mediaParser(item: any): Array<GenericMediaInfo> {
        const video = item?.video
        if (!video) {
            return []
        }

        const arr = [] as Array<GenericMediaInfo>
        const pushMedia = (type: GenericMediaInfo['type'], value?: unknown) => {
            const url = pickUrl(value)
            if (!url) {
                return
            }
            arr.push({
                type,
                url: url.replaceAll('\\u0026', '&'),
            })
        }

        // cover
        pushMedia('video_thumbnail', video.cover)
        pushMedia('video_thumbnail', video.originCover)
        pushMedia('video_thumbnail', video.dynamicCover)

        // Prefer the best playable address, but never fail the whole post if bitrate metadata is missing.
        const bitrateInfo = Array.isArray(video.bitrateInfo) ? [...video.bitrateInfo] : []
        const bestBitrate = bitrateInfo.sort(
            (a: any, b: any) => (b?.Bitrate || b?.bitrate || 0) - (a?.Bitrate || a?.bitrate || 0),
        )[0]
        pushMedia('video', bestBitrate?.PlayAddr || bestBitrate?.playAddr)
        pushMedia('video', video.playAddr)
        pushMedia('video', video.downloadAddr)

        const dedup = new Map<string, GenericMediaInfo>()
        for (const media of arr) {
            dedup.set(`${media.type}:${media.url}`, media)
        }
        return Array.from(dedup.values())
    }

    function postParser(item: any): GenericArticle<Platform.TikTok> {
        const author = item?.author
        const media = mediaParser(item)
        return {
            platform: Platform.TikTok,
            a_id: item?.id,
            u_id: author?.uniqueId,
            username: author?.nickname,
            created_at: Number(item?.createTime) || 0,
            content: item?.desc,
            url: `https://www.tiktok.com/@${author?.uniqueId}/video/${item?.id}/`,
            type: ArticleTypeEnum.POST,
            ref: null,
            has_media: media.length > 0,
            media,
            extra: null,
            u_avatar: pickUrl(author?.avatarLarger)?.replace('\\u0026', '&') || null,
        }
    }

    export function postsParser(json: any): Array<GenericArticle<Platform.TikTok>> {
        let items = json?.itemList
        if (!Array.isArray(items)) {
            return []
        }
        return items
            .map(postParser)
            .filter((item: GenericArticle<Platform.TikTok>) => item.a_id && item.u_id && item.created_at > 0)
    }

    function mergePostsById(
        primary: Array<GenericArticle<Platform.TikTok>>,
        secondary: Array<GenericArticle<Platform.TikTok>>,
    ): Array<GenericArticle<Platform.TikTok>> {
        const merged = [...primary]
        const seen = new Set(primary.map((post) => post.a_id))
        for (const post of secondary) {
            if (post.a_id && !seen.has(post.a_id)) {
                seen.add(post.a_id)
                merged.push(post)
            }
        }
        return merged
    }

    function normalizeHandle(value?: string | null) {
        return String(value || '')
            .trim()
            .replace(/^@+/, '')
            .toLowerCase()
    }

    function findUserInfoForHandle(json: any, handle: string) {
        const target = normalizeHandle(handle)
        const candidates = JSONPath({
            path: '$..userInfo',
            json,
            resultType: 'value',
        }) as Array<any>
        return (
            candidates.find(
                (candidate) => normalizeHandle(candidate?.user?.uniqueId || candidate?.user?.username) === target,
            ) || null
        )
    }

    function itemModuleValues(json: any): Array<any> {
        const modules = JSONPath({
            path: '$..ItemModule',
            json,
            resultType: 'value',
        }) as Array<any>
        const first = modules.find((module) => module && typeof module === 'object' && !Array.isArray(module))
        return first ? Object.values(first) : []
    }

    function universalScope(json: any) {
        return json?.__DEFAULT_SCOPE__ || json
    }

    export function videoParser(json: any): Array<GenericArticle<Platform.TikTok>> {
        const scope = universalScope(json)
        const item =
            scope?.['webapp.video-detail']?.itemInfo?.itemStruct || json?.itemInfo?.itemStruct || json?.itemStruct
        return item ? postsParser({ itemList: [item] }) : []
    }

    export function followsParser(json: any): GenericFollows {
        if (!json) {
            throw new Error('Profile format may have changed')
        }
        const userInfo = JSONPath({
            path: "$..['webapp.user-detail'].userInfo",
            json,
            resultType: 'value',
        })[0]
        const user =
            userInfo?.user || json?.data?.userInfo?.user || json?.userInfo?.user || json?.data?.user || json?.user
        const stats =
            userInfo?.stats || json?.data?.userInfo?.stats || json?.userInfo?.stats || json?.data?.stats || json?.stats
        return {
            platform: Platform.TikTok,
            username: user?.nickname || user?.full_name || user?.uniqueId || user?.username || '',
            u_id: user?.uniqueId || user?.username || '',
            followers: stats?.followerCount ?? user?.follower_count ?? 0,
        }
    }

    /**
     *  // ref: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py
     */
    function _build_web_query(sec_uid: string, cursor: number, device_id: number, random7: string) {
        return {
            aid: '1988',
            app_language: 'en',
            app_name: 'tiktok_web',
            browser_language: 'en-US',
            browser_name: 'Mozilla',
            browser_online: 'true',
            browser_platform: 'Win32',
            browser_version: '5.0 (Windows)',
            channel: 'tiktok_web',
            cookie_enabled: 'true',
            count: '15',
            cursor: cursor,
            device_id: device_id,
            device_platform: 'web_pc',
            focus_state: 'true',
            from_page: 'user',
            history_len: '2',
            is_fullscreen: 'false',
            is_page_visible: 'true',
            language: 'en',
            os: 'windows',
            priority_region: '',
            referer: '',
            region: 'US',
            screen_height: '1080',
            screen_width: '1920',
            secUid: sec_uid,
            type: '1',
            tz_name: 'UTC',
            verifyFp: `verify_${random7}`,
            webcast_language: 'en',
        }
    }

    /**
     * @param url https://www.tiktok.com/@username
     * @description grab common posts from api
     */
    export async function grabPosts(
        url: string,
        random_hex7: string,
        device_id: number,
        page?: Page,
        cookieString?: string,
        cache?: SimpleExpiringCache,
    ): Promise<Array<GenericArticle<Platform.TikTok>>> {
        const handle = url.match(/\/\@([^/?]+)/)?.[1] || ''
        const handleKey = handle.toLowerCase()
        const secUidKey = `secuid:${handleKey}`
        const rejectedKey = `creator_api_rejected:${handleKey}`
        const hydrationKey = `hydration_missing:${handleKey}`
        const invalidHandleKey = `invalid_handle:${handleKey}`
        const cachedSecUid = cache?.get(secUidKey)
        const apiRejectedRecently = Boolean(cache?.get(rejectedKey))
        const hydrationMissingRecently = Boolean(cache?.get(hydrationKey))

        // A handle that already failed user resolution this day is not going to
        // exist on the next schedule slot: fast fail instead of paying a full
        // browser navigation every round.
        if (cache?.get(invalidHandleKey)) {
            throw new TiktokInvalidHandleError(handle)
        }

        // Recent hydration failures with a cached secUid: one API attempt, then fast
        // fail. Re-navigating + re-polling the same broken page (up to ~27s of
        // backoff) and re-running the whole round via the manager retry multiplies
        // the waste without changing the outcome.
        if (hydrationMissingRecently && cachedSecUid) {
            const api = await callCreatorApi(String(cachedSecUid), url, device_id, random_hex7, cookieString)
            if (api.ok) {
                return api.posts
            }
            throw api.error || new Error('TikTok creator API rejected')
        }

        let rejectedSecUid: string | null = null
        let lastApiError: unknown = null
        // API-first: with a cached secUid the whole crawl is a single unsigned API
        // request (mirrors yt-dlp's tiktok extractor); the heavy browser navigation
        // is reserved for secUid resolution and API-rejection fallback. A recent
        // rejection skips the doomed first call entirely.
        if (cachedSecUid && !apiRejectedRecently) {
            const api = await callCreatorApi(String(cachedSecUid), url, device_id, random_hex7, cookieString)
            if (api.ok) {
                return api.posts
            }
            rejectedSecUid = String(cachedSecUid)
            lastApiError = api.error
        }

        let browserPosts: Array<GenericArticle<Platform.TikTok>> = []
        let browserContent: string | null = null
        let browserLoginError: unknown = null
        if (page) {
            const { cleanup, promise: waitForPosts } = waitForResponse(
                page,
                async (response, { done, fail }) => {
                    if (!response.url().includes('/api/post/item_list/') || response.request().method() !== 'GET') {
                        return
                    }
                    if (response.status() >= 400) {
                        fail(new Error(`Error: ${response.status()}`))
                        return
                    }
                    try {
                        const json = await response.json()
                        if (Array.isArray(json?.itemList)) {
                            done(json)
                        }
                    } catch {}
                },
                TIKTOK_BROWSER_HYDRATE_POLL_MS,
            )
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded' })
                await checkLogin(page)
                await checkSomethingWrong(page)
                const data = await waitForPosts
                if (data.success) {
                    browserPosts = postsParser(data.data)
                }
                // Reuse this navigation for universal data instead of reloading the
                // same profile page: the posts XHR only fires after hydration, so the
                // universal-data script is almost always present by now.
                browserContent = await extractUniversalDataFromLoadedPage(page)
            } catch (error) {
                cleanup()
                if (error instanceof Error && /You need to login first/.test(error.message)) {
                    browserLoginError = error
                }
            }
        }

        let content: string
        if (browserContent) {
            content = browserContent
        } else if (browserLoginError) {
            // The login wall was already rendered once; re-navigating to the same page
            // (and the doomed HTTP fallback) would only repeat the same failure.
            if (browserPosts.length > 0) {
                return browserPosts
            }
            throw browserLoginError
        } else {
            try {
                content = await loadUniversalData(url, page, cookieString)
            } catch (error) {
                if (browserPosts.length > 0) {
                    return browserPosts
                }
                if (/hydration missing/i.test(error instanceof Error ? error.message : String(error)) && cache) {
                    cache.set(hydrationKey, true, 10 * 60)
                }
                throw error
            }
        }
        let universalData: any
        try {
            universalData = JSON.parse(content)
        } catch (error) {
            throw new Error(
                `TikTok universal data JSON parse failed for @${handle}: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
        const userInfo = findUserInfoForHandle(universalData, handle)
        const userItems = Array.isArray(userInfo?.itemList) ? userInfo.itemList : []
        const fallbackItems = userItems.length > 0 ? [] : itemModuleValues(universalData)
        const pagePosts = mergePostsById(
            browserPosts,
            postsParser({ itemList: userItems.length > 0 ? userItems : fallbackItems }),
        )
        const secUid = userInfo?.user?.secUid
        if (secUid && cache) {
            cache.set(secUidKey, secUid, TIKTOK_SECUID_CACHE_TTL_S)
        }
        if (!secUid) {
            // No user detail and no posts for the requested handle means the account
            // does not exist (TikTok still serves a 200 hydration shell for such
            // pages). Cache it as invalid instead of silently returning "no articles"
            // every slot forever.
            if (pagePosts.length === 0) {
                if (cache) {
                    cache.set(invalidHandleKey, true, TIKTOK_INVALID_HANDLE_CACHE_TTL_S)
                }
                throw new TiktokInvalidHandleError(handle)
            }
            return pagePosts
        }
        // Skip the second API call when this round already rejected the same
        // secUid: the unsigned API does not change its answer within one round.
        if (secUid !== rejectedSecUid) {
            const api = await callCreatorApi(String(secUid), url, device_id, random_hex7, cookieString)
            if (api.ok) {
                return mergePostsById(pagePosts, api.posts)
            }
            lastApiError = api.error
        }
        if (pagePosts.length === 0) {
            if (lastApiError) {
                throw lastApiError
            }
            throw new Error('TikTok creator API rejected (cached rejection), no browser posts available')
        }
        // The browser fallback produced posts: remember the rejection briefly so
        // upcoming rounds skip the doomed first call instead of paying it again.
        if (cache) {
            cache.set(rejectedKey, true, 15 * 60)
        }
        return pagePosts
    }

    async function callCreatorApi(
        secUid: string,
        url: string,
        device_id: number,
        random_hex7: string,
        cookieString?: string,
    ): Promise<{ ok: true; posts: Array<GenericArticle<Platform.TikTok>> } | { ok: false; error: unknown }> {
        try {
            const query_obj = _build_web_query(secUid, 0, device_id, random_hex7)
            // @ts-ignore
            const query = new URLSearchParams(query_obj)
            const res = await HTTPClient.download_webpage(
                `${_API_BASE_URL}?${query.toString()}`,
                buildHeaders(url, cookieString),
                { timeout: TIKTOK_HTTP_TIMEOUT_MS },
            )
            const json = await res.json()
            if (Array.isArray(json?.itemList)) {
                return { ok: true, posts: postsParser(json) }
            }
            return {
                ok: false,
                error: new Error(
                    `TikTok creator API returned no itemList (statusCode=${json?.statusCode ?? 'unknown'}); the unsigned API likely rejected the request`,
                ),
            }
        } catch (error) {
            return { ok: false, error }
        }
    }

    function hasPlayableVideo(articles: Array<GenericArticle<Platform.TikTok>>): boolean {
        return articles.some((article) => article.media?.some((media) => media.type === 'video'))
    }

    async function grabVideoFromPlayer(
        url: string,
        page: Page,
        cookieString?: string,
    ): Promise<Array<GenericArticle<Platform.TikTok>>> {
        const match = url.match(/\/video\/(\d+)/)
        const videoId = match?.[1]
        if (!videoId) {
            return []
        }
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
        const response = await HTTPClient.download_webpage(oembedUrl, buildHeaders(url, cookieString), {
            timeout: TIKTOK_HTTP_TIMEOUT_MS,
        })
        const metadata = await response.json()
        if (String(metadata?.embed_product_id || '') !== videoId) {
            return []
        }

        await page.goto(`https://www.tiktok.com/player/v1/${videoId}?autoplay=1&loop=0&music_info=1&description=1`, {
            waitUntil: 'domcontentloaded',
        })
        await checkLogin(page)
        await checkSomethingWrong(page)
        const viewport = page.viewport() || { width: 800, height: 600 }
        await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 3))
        await page.keyboard.press('Space').catch(() => undefined)
        await page.waitForSelector('video', { timeout: 15000 }).catch(() => null)
        await checkLogin(page)
        await checkSomethingWrong(page)
        const videoUrl = await page
            .$eval('video', (video) => (video as HTMLVideoElement).currentSrc || (video as HTMLVideoElement).src)
            .catch(() => '')
        if (!videoUrl) {
            throw new Error('Cannot find user data (browser hydration missing: player video unavailable)')
        }
        const media: Array<GenericMediaInfo> = []
        if (metadata?.thumbnail_url) {
            media.push({ type: 'video_thumbnail', url: String(metadata.thumbnail_url) })
        }
        media.push({ type: 'video', url: videoUrl })
        const createdAt = Number(metadata?.create_time) || Number(BigInt(videoId) >> 32n)
        if (!createdAt) {
            throw new Error('Cannot determine TikTok video creation time')
        }
        return [
            {
                platform: Platform.TikTok,
                a_id: videoId,
                u_id: String(metadata?.author_unique_id || ''),
                username: String(metadata?.author_name || metadata?.author_unique_id || ''),
                created_at: createdAt,
                content: String(metadata?.title || ''),
                url,
                type: ArticleTypeEnum.POST,
                ref: null,
                has_media: true,
                media,
                extra: null,
                u_avatar: null,
            },
        ]
    }

    export async function grabVideo(
        url: string,
        page?: Page,
        cookieString?: string,
    ): Promise<Array<GenericArticle<Platform.TikTok>>> {
        try {
            const content = await loadUniversalData(url, page, cookieString)
            let articles: Array<GenericArticle<Platform.TikTok>>
            try {
                articles = videoParser(JSON.parse(content))
            } catch (error) {
                throw new Error(
                    `TikTok video JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
            if (hasPlayableVideo(articles)) {
                return articles
            }
            if (!page && articles.length > 0) {
                return articles
            }
        } catch (error) {
            if (!page) {
                throw error
            }
        }
        if (!page) {
            return []
        }
        return await grabVideoFromPlayer(url, page, cookieString)
    }

    export async function grabFollowsNumber(
        url: string,
        random_hex7: string,
        device_id: number,
        page?: Page,
        cookieString?: string,
    ): Promise<GenericFollows> {
        const content = await loadUniversalData(url, page, cookieString)
        let universalData: any
        try {
            universalData = JSON.parse(content)
        } catch (error) {
            throw new Error(
                `TikTok follows universal data JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
        const userInfo = JSONPath({
            path: "$..['webapp.user-detail'].userInfo",
            json: universalData,
            resultType: 'value',
        })[0]
        return {
            followers: userInfo?.stats?.followerCount,
            platform: Platform.TikTok,
            username: userInfo?.user?.nickname,
            u_id: userInfo?.user?.uniqueId,
        }
    }
}

export { ArticleTypeEnum, TiktokApiJsonParser, TiktokInvalidHandleError }
export { TiktokSpider }
