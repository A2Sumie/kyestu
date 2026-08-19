import { Platform } from '../types'
import type {
    ArticleExtractType,
    GenericMediaInfo,
    GenericArticle,
    GenericFollows,
    TaskType,
    TaskTypeResult,
    CrawlEngine,
} from '../types'
import { BaseSpider, waitForResponse } from './base'
import { isDomainBlocked, recordDomainFailure, recordDomainSuccess } from '../utils/domain-breaker'
import { Page } from 'puppeteer-core'

import { JSONPath } from 'jsonpath-plus'

enum ArticleTypeEnum {
    /**
     * basic page
     */
    POST = 'post',
    /**
     * https://www.instagram.com/stories/username
     */
    STORY = 'story',
    /**
     * https://www.instagram.com/stories/highlights/username
     */
    HIGHLIGHT = 'highlight',
    /**
     * TODO
     *
     * reels page
     */
    // REEL = 'reel',
}

enum InstagramArticleTaskType {
    posts = 'posts',
    stories = 'stories',
    highlights = 'highlights',
}

/**
 * Stories are higher-risk and frequently empty. Bound the navigation so a slow/blocked stories
 * page cannot stall the crawler slot; failures are isolated and never drop posts.
 */
const INSTAGRAM_STORIES_TIMEOUT_MS = 12000

interface InstagramProfileStatus {
    platform: Platform.Instagram
    u_id: string
    numeric_id: string | null
    username: string
    u_avatar: string | null
    live_broadcast_id: string | null
    live_broadcast_visibility: string | null
    is_live: boolean
    live_url: string | null
}

interface InstagramProfileContext {
    u_id: string
    username: string
    u_avatar: string | null
}

const INSTAGRAM_PROFILE_ID_PATTERN = /^[A-Za-z0-9._]+$/i
const RESERVED_INSTAGRAM_PATHS = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct'])
const INSTAGRAM_AUTO_MEDIA_SUMMARY_PATTERNS = [
    /^(?:\d+\.\s*)?(?:may be (?:an?\s+|the\s+)?(?:image|photo|picture|video|reel|story|selfie|screenshot|meme|poster|text|closeup|one or more people)\b|(?:this\s+)?image may contain\b|no (?:photo|video) description available\b)/i,
    /^(?:\d+\.\s*)?(?:photo|video|image|reel|story) (?:by|shared by) .{1,160}? on .{3,80}\.\s*(?:may be\b|(?:this\s+)?image may contain\b|no (?:photo|video) description available\b)/i,
]

function sanitizeInstagramGeneratedText(text: unknown): string | null {
    if (typeof text !== 'string') {
        return null
    }

    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) {
        return null
    }

    return INSTAGRAM_AUTO_MEDIA_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized)) ? null : normalized
}

class InstagramPrivateUnfollowedError extends Error {
    readonly code = 'instagram_private_unfollowed'

    constructor(handle: string) {
        super(
            `Instagram profile ${handle} is private and the current viewer is not following (instagram_private_unfollowed)`,
        )
        this.name = 'InstagramPrivateUnfollowedError'
    }
}

/**
 * Thrown when a profile navigation clearly shows logged-out behavior: the page
 * loaded but the logged-in graphql traffic never fires. Surfaced as an `auth`
 * class error so the spider-manager applies the long IG auth cooldown instead
 * of letting every handle burn the full posts-gate timeout.
 */
class InstagramLoggedOutError extends Error {
    readonly code = 'instagram_logged_out'

    constructor(handle: string) {
        super(
            `Instagram session appears logged out for ${handle}: profile page loaded but no graphql traffic fired (instagram_logged_out)`,
        )
        this.name = 'InstagramLoggedOutError'
    }
}

/**
 * The only session-death predicates that exist in the client (intel §1.3,
 * double-verified): response-body flags login_required / checkpoint_required /
 * two_factor_required. They arrive with HTTP 200, so the graphql gate must
 * inspect the parsed body. `delta_login_review` inside a challenge context is
 * surfaced as hint=environment-changed: same cookie + new IP/UA fingerprint,
 * so restoring the original environment beats swapping cookies.
 */
class InstagramSessionDeadError extends Error {
    readonly code = 'instagram_session_dead'
    readonly predicate: string

    constructor(scope: string, predicate: string, hint?: 'environment-changed') {
        super(
            `Instagram session dead (${predicate}) detected in ${scope} (instagram_session_dead${hint ? ` hint=${hint}` : ''})`,
        )
        this.name = 'InstagramSessionDeadError'
        this.predicate = predicate
    }
}

const INSTAGRAM_SESSION_DEATH_PREDICATES = ['login_required', 'checkpoint_required', 'two_factor_required'] as const

/** Returns the matched death predicate, or null when the body looks alive. */
function instagramSessionDeathPredicate(json: any): string | null {
    if (!json || typeof json !== 'object') {
        return null
    }
    const scopes = [json, (json as any).data]
    for (const scope of scopes) {
        if (!scope || typeof scope !== 'object') {
            continue
        }
        for (const predicate of INSTAGRAM_SESSION_DEATH_PREDICATES) {
            if (scope[predicate] === true || scope[predicate] === 'true') {
                return predicate
            }
        }
    }
    return null
}

/**
 * delta_login_review in a challenge context means the environment fingerprint
 * changed (new IP/UA), not that the cookie expired. Human-readable hint only.
 */
function instagramChallengeContextHint(json: any): 'environment-changed' | null {
    if (!json || typeof json !== 'object') {
        return null
    }
    const serialized = JSON.stringify(json)
    if (!serialized.includes('delta_login_review')) {
        return null
    }
    const challengeRelated =
        typeof json.challenge === 'object' ||
        typeof (json as any).data?.challenge === 'object' ||
        typeof (json as any).checkpoint_url === 'string' ||
        typeof (json as any).data?.checkpoint_url === 'string'
    return challengeRelated ? 'environment-changed' : null
}

function normalizeInstagramHandle(value: unknown) {
    return String(value || '')
        .trim()
        .replace(/^@+/, '')
        .toLowerCase()
}

function instagramProfileAccess(user: any) {
    if (!user || (user?.is_private !== true && user?.is_private !== 'true')) {
        return null
    }
    const following = user?.friendship_status?.following ?? user?.friendshipStatus?.following
    return {
        isPrivate: true,
        following: following === true,
    }
}

function userFromInstagramProfilePayload(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
        return null
    }
    const data = (payload as any)?.data
    return data?.user || (payload as any)?.user || null
}

function extractStoryAccessibilityText(caption: unknown): string | null {
    const normalized = sanitizeInstagramGeneratedText(caption)
    if (!normalized) {
        return null
    }

    const numberedText = normalized.match(/^\d+\.\s*(?<text>.*)$/)?.groups?.text
    return sanitizeInstagramGeneratedText(numberedText || normalized)
}

class InstagramSpider extends BaseSpider {
    // extends from XBaseSpider regex
    static _VALID_URL = /^(https:\/\/)?(www\.)?instagram\.com\/(?<id>[A-Za-z0-9._]+)(?:\/)?(?:\?.*)?$/i
    static _PLATFORM = Platform.Instagram
    BASE_URL: string = 'https://www.instagram.com/'
    NAME: string = 'Instagram Generic Spider'

    static extractBasicInfo(url: string) {
        try {
            const parsed = new URL(url)
            if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) {
                return undefined
            }

            const id = parsed.pathname.split('/').filter(Boolean)[0]
            if (!id || RESERVED_INSTAGRAM_PATHS.has(id.toLowerCase()) || !INSTAGRAM_PROFILE_ID_PATTERN.test(id)) {
                return undefined
            }

            return {
                u_id: id,
                platform: Platform.Instagram,
            }
        } catch {
            return undefined
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
            isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
        },
    ): Promise<TaskTypeResult<T, Platform.Instagram>> {
        const result = super._match_valid_url(url, InstagramSpider)?.groups
        if (!result) {
            throw new Error(`Invalid URL: ${url}`)
        }
        const id = result.id!
        if (RESERVED_INSTAGRAM_PATHS.has(id.toLowerCase())) {
            throw new Error(`Invalid URL: ${url}`)
        }
        const _url = `${this.BASE_URL}${id}`
        const { task_type, sub_task_type } = config

        if (!page) {
            throw new Error('Instagram spider requires a Page instance')
        }

        if (task_type === 'article') {
            const wantPosts =
                !sub_task_type || sub_task_type.length === 0 || sub_task_type.includes(InstagramArticleTaskType.posts)
            const wantStories = sub_task_type?.includes(InstagramArticleTaskType.stories) ?? false
            const wantHighlights = sub_task_type?.includes(InstagramArticleTaskType.highlights) ?? false

            const articles: Array<GenericArticle<Platform.Instagram>> = []
            if (wantPosts && wantHighlights) {
                // One profile navigation serves posts + highlights tray + profile
                // payload; the tray is captured on the same page load instead of
                // navigating to the identical URL a second time.
                this.log?.info('Trying to grab posts and highlights.')
                const combined = await InsApiJsonParser.grabPostsAndHighlights(page, _url, {
                    isArticleKnown: config.isArticleKnown,
                    wantHighlights: true,
                })
                articles.push(...combined.posts)
                if (combined.highlights.length > 0) {
                    articles.push(...combined.highlights)
                } else {
                    try {
                        // The tray query did not resolve on the shared load (rare):
                        // only pay a dedicated navigation when the profile actually
                        // renders highlight links.
                        const hasHighlightsLinks = await page.evaluate(() =>
                            Boolean(document.querySelector('a[href*="/stories/highlights/"]')),
                        )
                        if (hasHighlightsLinks) {
                            articles.push(...(await InsApiJsonParser.grabHighlights(page, _url)))
                        }
                    } catch (error) {
                        this.log?.warn(`Failed to grab highlights for ${id}, keeping posts only: ${error}`)
                    }
                }
            } else {
                if (wantPosts) {
                    this.log?.info('Trying to grab posts.')
                    articles.push(
                        ...(await InsApiJsonParser.grabPosts(page, _url, {
                            isArticleKnown: config.isArticleKnown,
                        })),
                    )
                }
                if (wantHighlights) {
                    this.log?.info('Trying to grab highlights.')
                    try {
                        articles.push(...(await InsApiJsonParser.grabHighlights(page, _url)))
                    } catch (error) {
                        this.log?.warn(`Failed to grab highlights for ${id}, keeping other articles: ${error}`)
                    }
                }
            }
            if (wantStories) {
                this.log?.info(`Trying to grab stories.`)
                try {
                    const stories = await InsApiJsonParser.grabStories(page, `${this.BASE_URL}stories/${id}/`, {
                        timeout: INSTAGRAM_STORIES_TIMEOUT_MS,
                    })
                    articles.push(...stories)
                } catch (error) {
                    this.log?.warn(`Failed to grab stories for ${id}, keeping posts only: ${error}`)
                }
            }
            return articles as TaskTypeResult<T, Platform.Instagram>
        }

        if (task_type === 'follows') {
            this.log?.info('Trying to grab follows.')
            return [await InsApiJsonParser.grabFollowsNumber(page, _url)] as TaskTypeResult<T, Platform.Instagram>
        }

        throw new Error('Invalid task type')
    }
}

namespace InsApiJsonParser {
    const GRAPHQL_FORM_QUERY_KEY = 'fb_api_req_friendly_name'

    const PROFILE_POSTS_KEY = 'PolarisProfilePostsQuery'
    const PROFILE_USER_KEY = 'PolarisProfilePageContentQuery'
    const PROFILE_HIGHLIGHTS_KEY = 'PolarisProfileStoryHighlightsTrayContentQuery'

    // Origin key for the shared in-page-fetch circuit breaker.
    const INSTAGRAM_WEB_ORIGIN = 'www.instagram.com'

    export function graphQLFriendlyNameFromRequest(
        url: string,
        method: string,
        postData: string | null | undefined,
    ): string | null {
        if (method !== 'POST' || !postData) {
            return null
        }

        const parseFriendlyName = (data: string) => {
            try {
                const friendlyName = new URLSearchParams(data).get(GRAPHQL_FORM_QUERY_KEY)
                return friendlyName?.trim() || null
            } catch {
                return null
            }
        }
        const decodePostData = (data: string) => {
            try {
                return decodeURIComponent(data)
            } catch {
                return data
            }
        }

        const friendlyName = parseFriendlyName(postData) || parseFriendlyName(decodePostData(postData))
        if (!friendlyName) {
            return null
        }

        return url.includes('/graphql/query') ||
            url.includes('/api/graphql') ||
            postData.includes(GRAPHQL_FORM_QUERY_KEY)
            ? friendlyName
            : null
    }

    async function checkPageHealth(page: Page) {
        const [loginForm, mainFrameError] = await Promise.all([
            page.waitForSelector('form[id="loginForm"]', { timeout: 1000 }).catch(() => null),
            page.waitForSelector('div[id="main-frame-error"]', { timeout: 1000 }).catch(() => null),
        ])
        if (loginForm) {
            throw new Error('You need to login first, check your cookies')
        }
        if (mainFrameError) {
            const error_content = (await mainFrameError.evaluate((e) => e.textContent))?.replace(/\s+/g, ' ')
            throw new Error(`Something wrong on the page: ${error_content}`)
        }
    }

    function parseEdges(json: any): { edges: any; scoped: boolean } {
        // Prefer the target user's own timeline edges when the payload exposes them
        // scoped (classic profile graphql shape). A document-wide $..edges lookup can
        // match a different section (viewer feed, reels tray) whose nodes carry no
        // owner, which previously produced posts with an empty u_id (and later an
        // "@<shortcode>" notification handle).
        const scoped = JSONPath({ path: '$..edge_owner_to_timeline_media.edges', json })[0]
        if (Array.isArray(scoped) && scoped.length > 0) {
            return { edges: scoped, scoped: true }
        }
        const xdt = JSONPath({ path: '$..xdt_api__v1__feed__user_timeline_graphql_connection.edges', json })[0]
        if (Array.isArray(xdt) && xdt.length > 0) {
            return { edges: xdt, scoped: false }
        }
        const edges_json = JSONPath({ path: '$..edges', json })[0]
        if (!edges_json) {
            throw new Error('Edges json format may have changed')
        }
        return { edges: edges_json, scoped: false }
    }

    function fallbackUsername(...candidates: Array<string | null | undefined>) {
        for (const candidate of candidates) {
            const normalized = candidate?.trim()
            if (normalized) {
                return normalized
            }
        }
        return ''
    }

    function normalizeInstagramUrl(url: unknown) {
        return typeof url === 'string' && url.trim() ? url.replace('\\u0026', '&') : null
    }

    function profileContextFromUser(user: any): InstagramProfileContext | null {
        const handle = fallbackUsername(user?.username)
        if (!handle) {
            return null
        }
        return {
            u_id: handle,
            username: fallbackUsername(user?.full_name, handle),
            u_avatar: normalizeInstagramUrl(
                user?.hd_profile_pic_url_info?.url || user?.profile_pic_url_hd || user?.profile_pic_url,
            ),
        }
    }

    function postProfileContext(node: any, crawledProfile: InstagramProfileContext | null) {
        const owner = profileContextFromUser(node?.user) || profileContextFromUser(node?.owner)
        if (!crawledProfile || !owner || crawledProfile.u_id === owner.u_id) {
            return null
        }

        return {
            data: {
                crawled_profile: crawledProfile,
                post_owner: owner,
            },
            extra_type: 'instagram_profile_context',
        } as ArticleExtractType<Platform.Instagram>
    }

    function mediaParser(edge: any): Array<GenericMediaInfo> {
        let arr = [] as Array<GenericMediaInfo>
        // Candidates are kept width-descending (app behavior: it switches to a
        // fallback candidate ~10s before the signed URL expires; there is no
        // re-sign path in the client). The top candidate stays the primary
        // `url`; the rest become the ordered `fallback_urls` chain.
        const orderedCandidateUrls = (candidates: any): string[] => {
            if (!Array.isArray(candidates) || candidates.length === 0) {
                return []
            }
            return [...candidates]
                .sort((a: any, b: any) => (b?.width || 0) - (a?.width || 0))
                .map((candidate: any) => normalizeInstagramUrl(candidate?.url))
                .filter((url: string | null): url is string => Boolean(url))
        }
        const pickBestCandidateUrl = (candidates: any): string | null => {
            return orderedCandidateUrls(candidates)[0] ?? null
        }
        const pushMedia = (type: GenericMediaInfo['type'], urls: string[]) => {
            if (urls.length === 0) {
                return
            }
            const [url, ...fallbackUrls] = urls
            arr.push({
                type,
                url: url!,
                ...(fallbackUrls.length > 0 ? { fallback_urls: fallbackUrls } : {}),
            })
        }
        const pushNodeMedia = (node: any) => {
            const imageUrls = orderedCandidateUrls(node?.image_versions2?.candidates)
            const videoUrls = orderedCandidateUrls(node?.video_versions)
            const legacyVideoUrl = normalizeInstagramUrl(node?.video_url)
            if (legacyVideoUrl && !videoUrls.includes(legacyVideoUrl)) {
                videoUrls.push(legacyVideoUrl)
            }
            if (videoUrls.length > 0) {
                pushMedia('video_thumbnail', imageUrls)
                pushMedia('video', videoUrls)
                return
            }
            pushMedia('photo', imageUrls)
        }
        // cover
        const cover_candidates = edge?.image_versions2?.candidates
        if (cover_candidates) {
            pushNodeMedia(edge)
        }
        // video
        const video_candidates = edge?.video_versions
        const videoUrlFallback = normalizeInstagramUrl(edge?.video_url)
        if ((video_candidates || videoUrlFallback) && !arr.some((item) => item.type === 'video')) {
            const videoUrls = orderedCandidateUrls(video_candidates)
            if (videoUrlFallback && !videoUrls.includes(videoUrlFallback)) {
                videoUrls.push(videoUrlFallback)
            }
            pushMedia('video', videoUrls)
        }
        // carousel (current node.carousel_media shape, plus the legacy sidecar
        // edge_sidecar_to_children.edges shape as a forward-compatibility fallback)
        const carousel_media =
            edge?.carousel_media ||
            edge?.edge_sidecar_to_children?.edges?.map((carouselEdge: any) => carouselEdge?.node).filter(Boolean)
        if (carousel_media) {
            // If carousel exists, the top-level cover/video is only a preview for the carousel.
            arr = []
            carousel_media.forEach((media: any) => {
                pushNodeMedia(media)
            })
        }
        const dedup = new Map<string, GenericMediaInfo>()
        for (const media of arr) {
            if (!media.url) {
                continue
            }
            const normalizedUrl = media.url.replace('\\u0026', '&')
            dedup.set(`${media.type}:${normalizedUrl}`, {
                ...media,
                url: normalizedUrl,
            })
        }
        return Array.from(dedup.values())
    }

    function postParser(
        edge: any,
        crawledProfile: InstagramProfileContext | null,
        fallbackHandle: string,
    ): GenericArticle<Platform.Instagram> {
        const node = edge.node
        const owner = profileContextFromUser(node?.user) || profileContextFromUser(node?.owner)
        const handle = fallbackUsername(owner?.u_id, crawledProfile?.u_id, fallbackHandle)
        const displayName = fallbackUsername(owner?.username, crawledProfile?.username, handle)
        const avatarUrl = normalizeInstagramUrl(owner?.u_avatar || crawledProfile?.u_avatar)
        const permalinkType = node?.product_type === 'clips' ? 'reel' : 'p'
        return {
            platform: Platform.Instagram,
            a_id: node?.code,
            u_id: handle,
            username: displayName,
            created_at: node?.taken_at,
            content: sanitizeInstagramGeneratedText(node?.caption?.text),
            url: `https://www.instagram.com/${permalinkType}/${node?.code}/`,
            type: ArticleTypeEnum.POST,
            ref: null,
            has_media: true,
            media: mediaParser(node),
            extra: postProfileContext(node, crawledProfile),
            u_avatar: avatarUrl,
        }
    }

    function highlightParser(edge: any, observedAt: number): GenericArticle<Platform.Instagram> {
        const node = edge?.node
        const id = /\w+[:,](?<id>\d+)/.exec(node?.id)?.groups?.id ?? ''
        const coverUrl = normalizeInstagramUrl(
            node?.cover_media?.cropped_image_version?.url || node?.cover_media?.full_image_version?.url,
        )
        return {
            platform: Platform.Instagram,
            a_id: id,
            u_id: fallbackUsername(node?.user?.username),
            username: '',
            created_at: observedAt,
            content: node?.title ?? null,
            url: `https://www.instagram.com/stories/highlights/${id}/`,
            type: ArticleTypeEnum.HIGHLIGHT,
            ref: null,
            has_media: Boolean(coverUrl),
            media: coverUrl ? [{ type: 'photo', url: coverUrl }] : null,
            extra: null,
            u_avatar: null,
        }
    }
    function storyParser(item: any): GenericArticle<Platform.Instagram> {
        return {
            platform: Platform.Instagram,
            a_id: item?.id?.split('_')[0] || '',
            u_id: '',
            username: '',
            created_at: item?.taken_at,
            content: extractStoryAccessibilityText(item?.accessibility_caption),
            url: '',
            type: ArticleTypeEnum.STORY,
            ref: null,
            has_media: true,
            media: mediaParser(item),
            extra: null,
            u_avatar: '',
        }
    }

    export function highlightsParser(
        json: any,
        observedAt = Math.floor(Date.now() / 1000),
    ): Array<GenericArticle<Platform.Instagram>> {
        // Prefer the scoped highlights tray edges; a generic $..edges fallback can
        // match a different edges section and silently parse the wrong payload.
        const scoped = JSONPath({ path: '$..highlights.edges', json })[0]
        const edges = Array.isArray(scoped) && scoped.length > 0 ? scoped : parseEdges(json).edges
        return edges
            .map((edge: any) => highlightParser(edge, observedAt))
            .filter((article: GenericArticle<Platform.Instagram>) => article.a_id && article.u_id)
    }

    export function postsParser(
        json: any,
        options: { fallbackHandle?: string } = {},
    ): Array<GenericArticle<Platform.Instagram>> {
        const parsed = parseEdges(json)
        const crawledProfile = parsed.scoped ? profileContextFromUser(json?.data?.user) : null
        const fallbackHandle = String(options.fallbackHandle || '').trim()

        // Private profile breaker: when the crawled account is private and the
        // current viewer is not following it, the posts query itself often hangs
        // until its own timeout. Whenever the payload already exposes the profile
        // user (classic graphql) or post nodes (XDT), fail fast with a dedicated
        // error instead of burning the full posts timeout.
        const edgeUsers = parsed.edges.map((edge: any) => edge?.node?.user || edge?.node?.owner).filter(Boolean)
        const targetHandle = normalizeInstagramHandle(crawledProfile?.u_id || fallbackHandle)
        const accessCandidates: Array<any> = parsed.scoped
            ? [json?.data?.user].filter(Boolean)
            : edgeUsers.filter((user: any) => {
                  if (!targetHandle) {
                      return edgeUsers.length === 1
                  }
                  return normalizeInstagramHandle(user?.username) === targetHandle
              })
        const blockedAccess = accessCandidates
            .map((user: any) => instagramProfileAccess(user))
            .find((access: any) => access && !access.following)
        if (blockedAccess) {
            throw new InstagramPrivateUnfollowedError(crawledProfile?.u_id || fallbackHandle || 'unknown')
        }

        return (
            parsed.edges
                .map((edge: any) => postParser(edge, crawledProfile, fallbackHandle))
                // Drop posts whose owner cannot be identified (no node user/owner and no
                // crawled profile context): they would otherwise be saved with an empty
                // u_id and surface as "@<shortcode>" in forwarded notifications.
                .filter((article: GenericArticle<Platform.Instagram>) => Boolean(article.u_id))
        )
    }

    export function followsParser(json: any): GenericFollows {
        if (!json) {
            throw new Error('Profile format may have changed')
        }
        let user = json?.data?.user
        return {
            platform: Platform.Instagram,
            username: fallbackUsername(user?.full_name, user?.username),
            u_id: fallbackUsername(user?.username),
            followers: user?.follower_count,
        }
    }

    export function profileStatusParser(json: any): InstagramProfileStatus {
        if (!json) {
            throw new Error('Profile format may have changed')
        }
        const user = json?.data?.user
        const handle = fallbackUsername(user?.username)
        const displayName = fallbackUsername(user?.full_name, handle)
        const liveBroadcastId = user?.live_broadcast_id ? String(user.live_broadcast_id) : null
        const visibility = user?.live_broadcast_visibility ? String(user.live_broadcast_visibility) : null
        const avatar = user?.hd_profile_pic_url_info?.url || user?.profile_pic_url_hd || user?.profile_pic_url || null

        return {
            platform: Platform.Instagram,
            u_id: handle,
            numeric_id: user?.id ? String(user.id) : null,
            username: displayName,
            u_avatar: avatar ? String(avatar).replace('\\u0026', '&') : null,
            live_broadcast_id: liveBroadcastId,
            live_broadcast_visibility: visibility,
            is_live: Boolean(liveBroadcastId),
            live_url: handle && liveBroadcastId ? `https://www.instagram.com/${handle}/live/` : null,
        }
    }

    const USERNAME_REGEX_FROM_OG_TITLE =
        /(?:趁\s*(?<username>.*?)\s*的这条快拍|Watch this story by (?<username>.*?) on Instagram)/i
    async function storiesParser(json: any, page: Page): Promise<Array<GenericArticle<Platform.Instagram>>> {
        const reels_media = JSONPath({ path: '$..reels_media', json })[0]
        if (!Array.isArray(reels_media) || reels_media.length === 0) {
            return []
        }
        const res = reels_media
            .map((i: any) => {
                const ownerHandle = fallbackUsername(i.user?.username)
                const ownerName = fallbackUsername(i.user?.full_name, ownerHandle)
                const stories = (Array.isArray(i.items) ? i.items : [])
                    .map((item: any) => storyParser(item))
                    .map((item: any) => {
                        return {
                            ...item,
                            u_id: ownerHandle,
                            username: ownerName,
                            url: `https://www.instagram.com/stories/${ownerHandle}/${item.a_id}`,
                            u_avatar: i.user?.profile_pic_url,
                        }
                    })
                return stories
            })
            .flat()
        const og_title = await page.$('meta[property="og:title"]')
        const title = await og_title?.evaluate((el) => el.getAttribute('content'))
        const username = fallbackUsername(title?.match(USERNAME_REGEX_FROM_OG_TITLE)?.groups?.username)
        for (const item of res) {
            item.username = fallbackUsername(username, item.username, item.u_id)
        }
        return res
    }

    /**
     * @param url https://www.instagram.com/username
     * @description grab common posts from user page
     */
    type IgProfileFetchResult = {
        posts: Array<GenericArticle<Platform.Instagram>>
        highlightsJson: unknown
        profileJson: unknown
    }

    const PROFILE_PAYLOAD_CACHE_TTL_MS = 120_000
    const PROFILE_PAYLOAD_CACHE = new Map<string, { payload: unknown; expiresAt: number }>()
    // Profile payload promises observed during a posts crawl. Live-relay consumers
    // (which run right after the crawl on their own page) can await these instead of
    // paying a third profile navigation per round.
    const PENDING_PROFILE_PROMISES = new Map<string, Promise<unknown>>()

    function readCachedProfilePayload(url: string) {
        const entry = PROFILE_PAYLOAD_CACHE.get(url)
        if (!entry) {
            return null
        }
        if (entry.expiresAt <= Date.now()) {
            PROFILE_PAYLOAD_CACHE.delete(url)
            return null
        }
        return entry.payload
    }

    function sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function storeProfilePayload(url: string, payload: unknown) {
        if (!payload) {
            return
        }
        PROFILE_PAYLOAD_CACHE.set(url, { payload, expiresAt: Date.now() + PROFILE_PAYLOAD_CACHE_TTL_MS })
        if (PROFILE_PAYLOAD_CACHE.size > 128) {
            const oldest = Array.from(PROFILE_PAYLOAD_CACHE.entries()).sort(
                (a, b) => a[1].expiresAt - b[1].expiresAt,
            )[0]
            if (oldest) {
                PROFILE_PAYLOAD_CACHE.delete(oldest[0])
            }
        }
    }

    function parseHandleFromUrl(url: string) {
        try {
            return String(new URL(url).pathname).split('/').filter(Boolean)[0] || ''
        } catch {
            return ''
        }
    }

    function buildGraphQLResponseGate(friendlyNameKey: string) {
        return async (response: any, control: { done: (data?: any) => void; fail: (reason: any) => void }) => {
            const responseUrl = response.url()
            const request = response.request()
            const friendlyName = graphQLFriendlyNameFromRequest(responseUrl, request.method(), request.postData())
            if (friendlyName !== friendlyNameKey) {
                return
            }
            if (response.status() >= 300 && response.status() < 400) {
                const location = response.headers()['location'] || ''
                if (/login/i.test(location)) {
                    control.fail(
                        new Error(`Error: login redirect (${response.status()}): session expired or checkpoint`),
                    )
                } else {
                    control.fail(
                        new Error(
                            `Error: redirect (${response.status()}) to ${location || 'unknown'} - likely rate limit or challenge`,
                        ),
                    )
                }
                return
            }
            if (response.status() >= 400) {
                control.fail(new Error(`Error: ${response.status()}`))
                return
            }
            try {
                const json = await response.json()
                // Session-death predicates (intel §1.3, verified on both Android
                // and iOS): the body of a dead/challenged session carries
                // login_required / checkpoint_required / two_factor_required at
                // the top level or right outside `data`. A 200 status means
                // nothing here — these arrive with HTTP 200.
                const deadPredicate = instagramSessionDeathPredicate(json)
                if (deadPredicate) {
                    const hint = instagramChallengeContextHint(json)
                    control.fail(
                        new InstagramSessionDeadError(
                            `${friendlyNameKey} response body`,
                            deadPredicate,
                            hint === 'environment-changed' ? hint : undefined,
                        ),
                    )
                    return
                }
                control.done(json)
            } catch (e) {
                control.fail(e)
            }
        }
    }

    // Grace window for the logged-out heuristic below. Logged-in profile loads
    // emit graphql traffic within a couple of seconds; the wide margin keeps the
    // detector conservative (a slow-but-healthy session is never misjudged).
    const LOGGED_OUT_PROBE_MS = 8000

    /**
     * Returns an InstagramLoggedOutError when the page looks logged out, or null
     * when the crawl should continue normally. Fires only when BOTH hold after
     * the grace window: (a) not a single /graphql/query or /api/graphql response
     * was observed, and (b) the page exposes no login form/link. Any graphql
     * activity cancels the probe, so normal logged-in crawls are unaffected.
     */
    async function detectLoggedOutEarlyExit(
        page: Page,
        postsSettled: Promise<unknown>,
        handle: string,
    ): Promise<InstagramLoggedOutError | null> {
        let graphqlResponses = 0
        const responseListener = (response: any) => {
            const requestUrl = String(response.url?.() || '')
            if (requestUrl.includes('/graphql/query') || requestUrl.includes('/api/graphql')) {
                graphqlResponses += 1
            }
        }
        page.on('response', responseListener)
        try {
            const probe = new Promise<boolean>((resolve) => {
                setTimeout(() => resolve(graphqlResponses === 0), LOGGED_OUT_PROBE_MS)
            })
            const postsHappened = Promise.resolve(postsSettled).then(
                () => true,
                () => true,
            )
            const outcome = await Promise.race([probe, postsHappened.then(() => 'posts')])
            if (outcome !== true) {
                // Posts gate already settled (success or failure) — nothing to
                // fast-fail; let the normal flow handle it.
                return null
            }
            if (graphqlResponses > 0) {
                return null
            }
            // Second confirmation: an actual login surface on the page. Absence
            // of graphql alone is not enough (defensive against slow networks).
            const loginElement = await Promise.race([
                (page as any).$?.('form[id="loginForm"], a[href*="/accounts/login"]') ?? null,
                sleep(1000).then(() => null),
            ]).catch(() => null)
            if (loginElement) {
                return new InstagramLoggedOutError(handle || 'unknown')
            }
            return null
        } finally {
            page.off('response', responseListener)
        }
    }

    async function fetchIgProfilePayloads(
        page: Page,
        url: string,
        options: {
            wantHighlights: boolean
            highlightsTimeoutMs?: number
            postsTimeoutMs?: number
            viaReload?: boolean
        },
    ): Promise<IgProfileFetchResult> {
        const postsWait = waitForResponse(
            page,
            buildGraphQLResponseGate(PROFILE_POSTS_KEY),
            options.postsTimeoutMs ?? 60000,
        )

        // Highlights and profile payloads are auxiliary: they must never block or fail
        // the posts capture, so their waits are raced with a timeout and swallowed.
        // The reload path re-captures posts only; the profile payload from the first
        // navigation is already stashed.
        const highlightsWait = options.wantHighlights
            ? waitForResponse(
                  page,
                  buildGraphQLResponseGate(PROFILE_HIGHLIGHTS_KEY),
                  options.highlightsTimeoutMs ?? 12000,
              )
            : null
        const profileWait = options.viaReload
            ? null
            : waitForResponse(
                  page,
                  async (response, control) => {
                      const friendlyName = graphQLFriendlyNameFromRequest(
                          response.url(),
                          response.request().method(),
                          response.request().postData(),
                      )
                      if (friendlyName !== PROFILE_USER_KEY) {
                          return
                      }
                      if (response.status() >= 400) {
                          return
                      }
                      try {
                          control.done(await response.json())
                      } catch {
                          // auxiliary payload; ignore
                      }
                  },
                  12000,
              )

        try {
            if (options.viaReload) {
                await page.reload({ waitUntil: 'domcontentloaded' })
            } else {
                await page.goto(url)
            }
        } catch (error) {
            postsWait.cleanup()
            highlightsWait?.cleanup()
            profileWait?.cleanup()
            throw error
        }
        try {
            await checkPageHealth(page)
        } catch (error) {
            postsWait.cleanup()
            highlightsWait?.cleanup()
            profileWait?.cleanup()
            throw error
        }

        // Profile payloads are auxiliary, but they are also the fastest reliable
        // signal for "private profile + viewer not following". Race it against the
        // posts wait so that blocked profiles fail immediately instead of burning
        // the full 60s posts timeout.
        const targetHandle = parseHandleFromUrl(url)
        // Kicked off before the profile race below so its 8s window overlaps the
        // profile race instead of stacking on top of it.
        const loggedOutProbe = detectLoggedOutEarlyExit(page, postsWait.promise, parseHandleFromUrl(url))
        if (profileWait) {
            const profilePromise = profileWait.promise
                .then((result: any) => {
                    const payload = result && result.success ? result.data : null
                    if (payload) {
                        storeProfilePayload(url, payload)
                    }
                    return payload
                })
                .catch(() => null)
                .finally(() => PENDING_PROFILE_PROMISES.delete(url))
            PENDING_PROFILE_PROMISES.set(url, profilePromise)

            const earlyResult = await Promise.race([
                profilePromise.then((payload) => ({ payload })),
                postsWait.promise.then(
                    () => null,
                    () => null,
                ),
            ])
            const profileUser = earlyResult ? userFromInstagramProfilePayload(earlyResult.payload) : null
            const profileAccess = instagramProfileAccess(profileUser)
            if (profileAccess && !profileAccess.following) {
                postsWait.cleanup()
                highlightsWait?.cleanup()
                profileWait.cleanup()
                throw new InstagramPrivateUnfollowedError(profileUser?.username || targetHandle || 'unknown')
            }
        }

        // Logged-out fast fail: when logged out, the profile page loads fine but
        // the logged-in graphql traffic never fires, so every handle burns the
        // full posts-gate timeout and is misclassified as `timeout`. After a
        // short grace window with ZERO graphql responses AND a login surface on
        // the page, treat the session as logged out and raise an auth-class
        // error. Conservative by design: any graphql activity (even unrelated
        // queries) cancels the probe, so normal logged-in crawls are unaffected —
        // missing a real logout only costs the old 60s timeout.
        const loggedOut = await loggedOutProbe
        if (loggedOut) {
            postsWait.cleanup()
            highlightsWait?.cleanup()
            profileWait?.cleanup()
            throw loggedOut
        }

        const postsData = await postsWait.promise
        if (!postsData.success) {
            throw postsData.error
        }
        const posts = postsParser(postsData.data, { fallbackHandle: targetHandle })

        const trayResult = highlightsWait ? await highlightsWait.promise.catch(() => null) : null
        const highlightsJson = trayResult && (trayResult as any).success ? (trayResult as any).data : null

        return { posts, highlightsJson, profileJson: null }
    }

    const AVATAR_CACHE_TTL_MS = 3_600_000
    // A failed lookup must not poison the cache for the full TTL: IG sessions
    // are flaky, and a null cached for an hour guarantees avatar-less posts for
    // an hour. Retry misses quickly instead.
    const AVATAR_CACHE_MISS_TTL_MS = 60_000
    const AVATAR_CACHE = new Map<string, { url: string | null; expiresAt: number }>()

    // ---------------------------------------------------------------------
    // X-IG-WWW-Claim replay (app session self-healing parity, intel §1.2).
    //
    // The app sends `X-IG-WWW-Claim: <stored>` on every api/v1 call — an empty
    // or stale claim is sent as literal `0`, which makes the server issue a
    // fresh one in `X-IG-Set-WWW-Claim`. The browser never persists custom
    // response headers, so for the api/v1 requests OUR CODE issues in the page
    // context we replay the stored claim ourselves. Claims are session-scoped
    // (no client TTL, server rotates); per-page in-memory storage is enough.
    // Deliberately NOT applied to graphql requests the page fires on its own —
    // the browser owns those and must not be counterfeited.
    // ---------------------------------------------------------------------
    const WWW_CLAIM_STORE = new Map<string, string>()
    const WWW_CLAIM_SEND_ZERO = '0'

    function claimStorageKeyForPage(page: Page): string {
        try {
            return new URL(page.url()).origin || 'about:blank'
        } catch {
            return 'about:blank'
        }
    }

    function storedWwwClaimForPage(page: Page): string {
        return WWW_CLAIM_STORE.get(claimStorageKeyForPage(page)) || WWW_CLAIM_SEND_ZERO
    }

    function storeWwwClaimFromResponseHeaders(page: Page, headers: Record<string, string> | null | undefined) {
        // Puppeteer lowercases response header names.
        const claim = headers?.['x-ig-set-www-claim']
        if (typeof claim === 'string' && claim.trim()) {
            WWW_CLAIM_STORE.set(claimStorageKeyForPage(page), claim.trim())
        }
    }

    // First backfill source at no extra cost: the profile graphql payload the
    // posts crawl already captured on this same navigation (same fields the
    // web_profile_info endpoint returns).
    function avatarFromProfilePayload(payload: unknown): string | null {
        const user = userFromInstagramProfilePayload(payload)
        return normalizeInstagramUrl(
            user?.hd_profile_pic_url_info?.url || user?.profile_pic_url_hd || user?.profile_pic_url,
        )
    }

    // The XDT timeline / profile graphql payloads intermittently drop the avatar
    // fields; web_profile_info still returns them and works same-origin with the
    // page's session. Used only as a backfill for posts that came out avatar-less.
    async function fetchAvatarViaWebProfileInfo(
        page: Page,
        handle: string,
        profileUrl?: string,
    ): Promise<string | null> {
        if (!handle) {
            return null
        }
        const cached = AVATAR_CACHE.get(handle)
        if (cached && cached.expiresAt > Date.now()) {
            return cached.url
        }
        const cachedProfileUrl = profileUrl ? readCachedProfilePayload(profileUrl) : null
        const fromCapturedPayload = cachedProfileUrl ? avatarFromProfilePayload(cachedProfileUrl) : null
        if (fromCapturedPayload) {
            AVATAR_CACHE.set(handle, { url: fromCapturedPayload, expiresAt: Date.now() + AVATAR_CACHE_TTL_MS })
            return fromCapturedPayload
        }
        // Global per-origin breaker: when the session is dead, every handle's
        // probe fails; trip once and stop hammering for the block window.
        if (isDomainBlocked(INSTAGRAM_WEB_ORIGIN)) {
            AVATAR_CACHE.set(handle, { url: null, expiresAt: Date.now() + AVATAR_CACHE_MISS_TTL_MS })
            return null
        }
        let url: unknown = null
        try {
            url = await (page as any).evaluate?.(
                async (h: string, claim: string) => {
                    try {
                        const res = await fetch(
                            `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(h)}`,
                            {
                                headers: { 'X-IG-App-ID': '936619743392459', 'X-IG-WWW-Claim': claim },
                                credentials: 'include',
                            },
                        )
                        // Persist a rotated claim exactly like the app does: the
                        // header is only visible to the JS we run ourselves; the
                        // browser will not keep it for the next request.
                        const rotatedClaim = res.headers.get('X-IG-Set-WWW-Claim')
                        if (!res.ok) {
                            return { url: null, rotatedClaim }
                        }
                        const user = (await res.json().catch(() => null))?.data?.user
                        const avatarUrl =
                            user?.hd_profile_pic_url_info?.url || user?.profile_pic_url_hd || user?.profile_pic_url || null
                        return { url: avatarUrl, rotatedClaim }
                    } catch {
                        return null
                    }
                },
                handle,
                storedWwwClaimForPage(page),
            )
        } catch {
            url = null
        }
        // The evaluate returns { url, rotatedClaim } | null (legacy test mocks
        // may return a bare string avatar URL — accept both shapes).
        if (url && typeof url === 'object' && (url as any).rotatedClaim !== undefined) {
            const rotated = (url as any).rotatedClaim
            if (typeof rotated === 'string' && rotated.trim()) {
                WWW_CLAIM_STORE.set(claimStorageKeyForPage(page), rotated.trim())
            }
            url = (url as any).url ?? null
        } else if (url && typeof url === 'object') {
            url = (url as any).url ?? null
        }
        const normalized = normalizeInstagramUrl(url)
        if (normalized) {
            recordDomainSuccess(INSTAGRAM_WEB_ORIGIN)
        } else {
            recordDomainFailure(INSTAGRAM_WEB_ORIGIN)
        }
        AVATAR_CACHE.set(handle, {
            url: normalized,
            expiresAt: Date.now() + (normalized ? AVATAR_CACHE_TTL_MS : AVATAR_CACHE_MISS_TTL_MS),
        })
        return normalized
    }

    async function backfillMissingAvatars(
        page: Page,
        posts: Array<GenericArticle<Platform.Instagram>>,
        profileUrl?: string,
    ): Promise<void> {
        const missing = new Map<string, Array<GenericArticle<Platform.Instagram>>>()
        for (const post of posts) {
            if (post.u_avatar || !post.u_id) {
                continue
            }
            const list = missing.get(post.u_id) ?? []
            list.push(post)
            missing.set(post.u_id, list)
        }
        for (const [handle, items] of missing) {
            const url = await fetchAvatarViaWebProfileInfo(page, handle, profileUrl)
            if (!url) {
                continue
            }
            for (const post of items) {
                post.u_avatar = url
            }
        }
    }

    export async function grabPostsAndHighlights(
        page: Page,
        url: string,
        config: {
            isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
            wantHighlights?: boolean
            highlightsTimeoutMs?: number
        } = {},
    ): Promise<{
        posts: Array<GenericArticle<Platform.Instagram>>
        highlights: Array<GenericArticle<Platform.Instagram>>
    }> {
        const wantHighlights = Boolean(config.wantHighlights)
        const first = await fetchIgProfilePayloads(page, url, {
            wantHighlights,
            highlightsTimeoutMs: config.highlightsTimeoutMs,
        })
        let posts = first.posts
        // An empty profile cannot surface anything new: skip the cache-bust reload
        // (the "all known" heuristic would otherwise always trigger it here).
        if (posts.length > 0) {
            const known = new Set<string>()
            const knownResults = await Promise.all(
                posts.map(async (post) => {
                    try {
                        return (await config.isArticleKnown?.(post.a_id)) ? post.a_id : null
                    } catch {
                        return null
                    }
                }),
            )
            for (const id of knownResults) {
                if (id) {
                    known.add(id)
                }
            }
            const allKnown = posts.every((post) => known.has(post.a_id))
            if (allKnown) {
                try {
                    const reloaded = await fetchIgProfilePayloads(page, url, {
                        wantHighlights: false,
                        viaReload: true,
                    })
                    const byId = new Map(posts.map((post) => [post.a_id, post]))
                    for (const post of reloaded.posts) {
                        byId.set(post.a_id, post)
                    }
                    posts = Array.from(byId.values())
                } catch {
                    // keep the first-pass posts
                }
            }
        }

        let highlights: Array<GenericArticle<Platform.Instagram>> = []
        if (wantHighlights && first.highlightsJson) {
            try {
                highlights = highlightsParser(first.highlightsJson)
            } catch {
                // caller falls back to the dedicated highlights navigation
            }
        }
        await backfillMissingAvatars(page, posts, url)
        return { posts, highlights }
    }

    export async function grabPosts(
        page: Page,
        url: string,
        config: {
            isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
        } = {},
    ): Promise<Array<GenericArticle<Platform.Instagram>>> {
        const { posts } = await grabPostsAndHighlights(page, url, { ...config, wantHighlights: false })
        return posts
    }

    export async function grabHighlights(
        page: Page,
        url: string,
        config: {
            timeout?: number
        } = {},
    ): Promise<Array<GenericArticle<Platform.Instagram>>> {
        const { cleanup, promise: waitForHighlights } = waitForResponse(
            page,
            buildGraphQLResponseGate(PROFILE_HIGHLIGHTS_KEY),
            config.timeout ?? 30000,
        )
        try {
            await page.goto(url)
        } catch (error) {
            cleanup()
            throw error
        }
        try {
            await checkPageHealth(page)
        } catch (error) {
            cleanup()
            throw error
        }

        const data = await waitForHighlights
        if (!data.success) {
            throw data.error
        }
        return highlightsParser(data.data)
    }

    /** 由于使用了bun做运行时，无法使用xpath做内容筛选
     *
     * https://github.com/puppeteer/puppeteer/issues/12570
     *
     * https://github.com/oven-sh/bun/issues/13853
     */
    export async function grabStories(
        page: Page,
        url: string,
        config: {
            timeout?: number
        } = {},
    ): Promise<Array<GenericArticle<Platform.Instagram>>> {
        await page.goto(url, config.timeout ? { timeout: config.timeout } : undefined)
        await checkPageHealth(page)
        /**
         * Xpath selector for stories json, but not working in bun with puppeteer version after 22.10+
         */
        // const stores_json = await page.$('::-p-xpath(//script[@type="application/json"])')
        const json_script_tags = await page.$$('script[type="application/json"]')
        for (const json_script_tag of json_script_tags) {
            const text = await json_script_tag.evaluate((el) => el.innerText)
            if (text.includes('xdt_api__v1__feed__reels_media')) {
                try {
                    return await storiesParser(JSON.parse(text), page)
                } catch (error) {
                    throw new Error(
                        `Instagram stories JSON parse failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    )
                }
            }
        }
        return []
    }

    export async function grabFollowsNumber(page: Page, url: string): Promise<GenericFollows> {
        const follows_json = await grabProfileUserPayload(page, url)
        return followsParser(follows_json)
    }

    export async function grabProfileStatus(page: Page, url: string): Promise<InstagramProfileStatus> {
        let profile_json: unknown
        try {
            profile_json = await grabProfileUserPayload(page, url)
        } catch (error) {
            // The web profile GraphQL (PolarisProfilePageContentQuery) has been flaky lately
            // (rate-limit 429 / challenge redirects). Fall back to the profile page meta tag
            // (instagram://user?id=...) so username resolution keeps working.
            profile_json = await grabProfileUserPayloadFromPageMeta(page, url)
            if (!profile_json) {
                throw error
            }
        }
        return profileStatusParser(profile_json)
    }

    async function grabProfileUserPayloadFromPageMeta(page: Page, url: string): Promise<unknown> {
        const html = await page.content().catch(() => '')
        const idMatch = html.match(/instagram:\/\/user\?id=(\d+)/)
        const handleMatch = url.match(/instagram\.com\/([^/?#]+)/)
        if (!idMatch || !handleMatch) {
            return null
        }
        return {
            data: {
                user: {
                    id: idMatch[1],
                    username: handleMatch[1],
                    full_name: '',
                    hd_profile_pic_url_info: null,
                },
            },
        }
    }

    async function grabProfileUserPayload(page: Page, url: string) {
        // The posts crawl usually fired PolarisProfilePageContentQuery moments ago on
        // this same URL (live relay runs right after the crawl): reuse it instead of
        // paying a third full profile navigation per round.
        const cached = readCachedProfilePayload(url)
        if (cached) {
            return cached
        }
        const pending = PENDING_PROFILE_PROMISES.get(url)
        if (pending) {
            const payload = await Promise.race([pending, sleep(5000).then(() => null)])
            if (payload) {
                return payload
            }
        }

        const { cleanup, promise: waitForTweets } = waitForResponse(
            page,
            buildGraphQLResponseGate(PROFILE_USER_KEY),
            20000,
        )
        try {
            await page.goto(url)
        } catch (error) {
            cleanup()
            throw error
        }
        try {
            await checkPageHealth(page)
        } catch (error) {
            cleanup()
            throw error
        }
        const data = await waitForTweets
        if (!data.success) {
            throw data.error
        }
        storeProfilePayload(url, data.data)
        return data.data
    }
}

export { ArticleTypeEnum, InstagramArticleTaskType, InstagramPrivateUnfollowedError, InstagramLoggedOutError, InstagramSessionDeadError, InsApiJsonParser }
export type { InstagramProfileStatus }
export { InstagramSpider }
