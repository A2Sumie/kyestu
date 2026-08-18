import puppeteer from 'puppeteer-core'
import { Spider } from '../src'
import { parseNetscapeCookieToPuppeteerCookie, UserAgent } from '../src/utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createLogger, winston, format } from '@kyestu/log'
import type { GenericFollows } from '../src/types'
import { InstagramSpider, InsApiJsonParser } from '../src/spiders/instagram'
import { resetDomainBreakers } from '../src/utils/domain-breaker'
import { test, expect } from 'bun:test'

const dataPath = (...parts: Array<string>) => join(import.meta.dir, 'data', ...parts)

/**
 * require network access & headless browser
 */
test.skip('spider', async () => {
    const url = 'https://www.instagram.com/instagram'
    const spider = Spider.getSpider(url)
    if (spider) {
        const spiderInstance = new spider(
            createLogger({
                defaultMeta: { service: 'tweet-forwarder' },
                level: 'debug',
                format: format.combine(
                    format.colorize(),
                    format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
                    format.printf(({ message, timestamp, level, label, service, childService }) => {
                        const metas = [service, childService, label, level]
                            .filter(Boolean)
                            .map((meta) => `[${meta}]`)
                            .join(' ')
                        return `${timestamp} ${metas}: ${message}`
                    }),
                ),
            }),
        ).init()
        let id = await spiderInstance._match_valid_url(url, spider)?.groups?.id
        expect(id).toBe('instagram')
        const browser = await puppeteer.launch({
            headless: true,
            channel: 'chrome',
        })
        const page = await browser.newPage()
        await page.setUserAgent(UserAgent.CHROME)
        await page.setCookie(...parseNetscapeCookieToPuppeteerCookie('tests/data/expire.cookies'))
        let res = []
        let follows = {} as GenericFollows
        try {
            res = await spiderInstance.crawl(url, page, 'article')
            follows = (await spiderInstance.crawl(url, page, 'follows')) as unknown as GenericFollows
        } catch (e) {
            console.error(e)
        } finally {
            await browser.close()
        }
        expect(res.length).toBeGreaterThan(0)
        expect(follows.followers).toBeGreaterThan(0)
    }
})

test('Instagram API JSON Parser', async () => {
    const posts_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts.json'), 'utf-8'))
    const profile_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-profile.json'), 'utf-8'))
    const highlights_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-highlights.json'), 'utf-8'))

    const posts_json_result = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts-result.json'), 'utf-8'))
    const highlights_json_result = JSON.parse(
        readFileSync(dataPath('instagram', 'instagram-highlights-result.json'), 'utf-8'),
    )
    const profile_json_result = JSON.parse(
        readFileSync(dataPath('instagram', 'instagram-follows-result.json'), 'utf-8'),
    )

    const posts = InsApiJsonParser.postsParser(posts_json)

    expect(posts).toHaveLength(posts_json_result.length)
    expect(posts[0]).toMatchObject({
        a_id: posts_json_result[0].a_id,
        u_id: posts_json_result[0].u_id,
        username: posts_json_result[0].username,
        url: posts_json_result[0].url,
        type: posts_json_result[0].type,
    })
    expect(posts.every((item) => item.username.length > 0)).toBeTrue()
    expect(posts.every((item) => item.u_id.length > 0)).toBeTrue()
    expect(posts.some((item) => (item.media?.length ?? 0) > 0)).toBeTrue()
    expect(InsApiJsonParser.highlightsParser(highlights_json, 1710759600)).toEqual(highlights_json_result)
    expect(InsApiJsonParser.followsParser(profile_json)).toMatchObject({
        platform: 2,
        u_id: profile_json_result.u_id,
        username: profile_json_result.username,
        followers: profile_json_result.followers,
    })
    expect(InsApiJsonParser.profileStatusParser(profile_json)).toMatchObject({
        platform: 2,
        u_id: profile_json_result.u_id,
        numeric_id: profile_json?.data?.user?.id ? String(profile_json.data.user.id) : null,
        username: profile_json_result.username,
        is_live: false,
        live_broadcast_id: null,
        live_broadcast_visibility: null,
        live_url: null,
    })
})

test('Instagram GraphQL friendly-name detection accepts current non-/graphql/query endpoints', () => {
    const postData = 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D'

    expect(
        InsApiJsonParser.graphQLFriendlyNameFromRequest(
            'https://www.instagram.com/ajax/bulk-route-definitions/',
            'POST',
            postData,
        ),
    ).toBe('PolarisProfilePostsQuery')
    expect(
        InsApiJsonParser.graphQLFriendlyNameFromRequest(
            'https://www.instagram.com/ajax/bulk-route-definitions/',
            'GET',
            postData,
        ),
    ).toBeNull()
})

test('Instagram grabPosts resolves after posts query without waiting for highlights query', async () => {
    const posts_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts.json'), 'utf-8'))
    const listeners = new Map<string, Array<(data: any) => void>>()
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                handler({
                    url: () => 'https://www.instagram.com/ajax/bulk-route-definitions/',
                    status: () => 200,
                    json: async () => posts_json,
                    request: () => ({
                        method: () => 'POST',
                        postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
                    }),
                })
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    const posts = await InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/instagram/')

    expect(posts.length).toBeGreaterThan(0)
    // The auxiliary profile-payload listener may remain attached until its own
    // timeout; posts/highlights listeners must all be cleaned up.
    expect((listeners.get('response') || []).length).toBeLessThanOrEqual(1)
})

test('Instagram backfills avatar-less posts via page-context web_profile_info', async () => {    // XDT timeline payload whose user nodes dropped all avatar fields.
    const posts_json = {
        data: {
            xdt_api__v1__feed__user_timeline_graphql_connection: {
                edges: [
                    {
                        node: {
                            code: 'NOAV1',
                            taken_at: 1742400132,
                            caption: { text: 'avatar-less post' },
                            user: { username: 'noav_user', full_name: 'No Avatar' },
                            image_versions2: { candidates: [{ width: 720, url: 'https://example.com/p.jpg' }] },
                        },
                    },
                ],
            },
        },
    }
    const listeners = new Map<string, Array<(data: any) => void>>()
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                handler({
                    url: () => 'https://www.instagram.com/graphql/query/',
                    status: () => 200,
                    json: async () => posts_json,
                    request: () => ({
                        method: () => 'POST',
                        postData: () =>
                            'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
                    }),
                })
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
        evaluate: async (fn: unknown, handle: string) => {
            // Simulate the in-page fetch of web_profile_info.
            expect(handle).toBe('noav_user')
            expect(String(fn)).toContain('web_profile_info')
            return 'https://example.com/hd-avatar.jpg'
        },
    } as any

    const posts = await InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/noav_user/')

    expect(posts).toHaveLength(1)
    expect(posts[0]?.u_avatar).toBe('https://example.com/hd-avatar.jpg')
})

test('Instagram avatar backfill skips the in-page fetch once the domain breaker is open', async () => {
    // Simulate a dead session: web_profile_info keeps failing → the shared
    // breaker opens → subsequent avatar backfills must not touch the page at all.
    resetDomainBreakers()
    let evaluateCalls = 0
    const listeners = new Map<string, Array<(data: any) => void>>()
    const makePage = (handle: string) =>
        ({
            on: (eventName: string, handler: (data: any) => void) => {
                const handlers = listeners.get(eventName) || []
                handlers.push(handler)
                listeners.set(eventName, handlers)
            },
            off: (eventName: string, handler: (data: any) => void) => {
                listeners.set(
                    eventName,
                    (listeners.get(eventName) || []).filter((entry) => entry !== handler),
                )
            },
            goto: async () => {
                for (const handler of listeners.get('response') || []) {
                    handler({
                        url: () => 'https://www.instagram.com/graphql/query/',
                        status: () => 200,
                        json: async () => ({
                            data: {
                                xdt_api__v1__feed__user_timeline_graphql_connection: {
                                    edges: [
                                        {
                                            node: {
                                                code: 'BREAKER1',
                                                taken_at: 1742400132,
                                                caption: { text: 'breaker post' },
                                                user: { username: handle, full_name: 'Breaker' },
                                                image_versions2: {
                                                    candidates: [{ width: 720, url: 'https://example.com/b.jpg' }],
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        }),
                        request: () => ({
                            method: () => 'POST',
                            postData: () =>
                                'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
                        }),
                    })
                }
            },
            waitForSelector: async () => {
                throw new Error('not found')
            },
            evaluate: async () => {
                evaluateCalls += 1
                return null // web_profile_info fails (non-2xx or exception)
            },
        }) as any

    try {
        // Round 1: probe fires and fails (failure 1 of 3). Distinct handles per
        // round — the AVATAR_CACHE miss-TTL would otherwise swallow the probe.
        await InsApiJsonParser.grabPosts(makePage('breaker_a'), 'https://www.instagram.com/breaker_a/')
        expect(evaluateCalls).toBe(1)

        // Rounds 2 and 3: more failures — the breaker opens at 3.
        await InsApiJsonParser.grabPosts(makePage('breaker_b'), 'https://www.instagram.com/breaker_b/')
        await InsApiJsonParser.grabPosts(makePage('breaker_c'), 'https://www.instagram.com/breaker_c/')
        expect(evaluateCalls).toBe(3)

        // Round 4: breaker is open — the in-page fetch must be skipped entirely
        // even for a fresh handle.
        const posts = await InsApiJsonParser.grabPosts(makePage('breaker_d'), 'https://www.instagram.com/breaker_d/')
        expect(evaluateCalls).toBe(3)
        expect(posts).toHaveLength(1)
        expect(posts[0]?.u_avatar).toBeNull()
    } finally {
        resetDomainBreakers()
    }
})

test('Instagram grabPosts merges reloaded posts when a cache-bust reload returns newer data', async () => {
    const posts_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts.json'), 'utf-8'))
    const listeners = new Map<string, Array<(data: any) => void>>()
    const makeResponse = (json: any) => ({
        url: () => 'https://www.instagram.com/ajax/bulk-route-definitions/',
        status: () => 200,
        json: async () => json,
        request: () => ({
            method: () => 'POST',
            postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
        }),
    })
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                handler(makeResponse(posts_json))
            }
        },
        reload: async () => {
            const withNewer = JSON.parse(JSON.stringify(posts_json))
            const edges = withNewer?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges || []
            const template = edges[0]?.node
            edges.unshift({
                node: {
                    ...template,
                    id: '9999999999999999999',
                    taken_at_timestamp: 1786600000,
                    shortcode: 'NEWPOST',
                    code: 'NEWPOST',
                },
            })
            for (const handler of listeners.get('response') || []) {
                handler(makeResponse(withNewer))
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    const posts = await InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/instagram/', {
        isArticleKnown: async () => true,
    })
    expect(posts.some((post) => post.a_id === 'NEWPOST')).toBe(true)
    // The auxiliary profile-payload listener may remain attached until its own
    // timeout; posts/highlights listeners must all be cleaned up.
    expect((listeners.get('response') || []).length).toBeLessThanOrEqual(1)
})

test('Instagram grabPosts skips cache-bust reload when the first response has unknown posts', async () => {
    const posts_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts.json'), 'utf-8'))
    const listeners = new Map<string, Array<(data: any) => void>>()
    let reloadCalls = 0
    const makeResponse = () => ({
        url: () => 'https://www.instagram.com/ajax/bulk-route-definitions/',
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        json: async () => posts_json,
        request: () => ({
            method: () => 'POST',
            postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
        }),
    })
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                handler(makeResponse())
            }
        },
        reload: async () => {
            reloadCalls += 1
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    const posts = await InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/instagram/', {
        isArticleKnown: async () => false,
    })

    expect(posts.length).toBeGreaterThan(0)
    expect(reloadCalls).toBe(0)
    // The auxiliary profile-payload listener may remain attached until its own
    // timeout; posts/highlights listeners must all be cleaned up.
    expect((listeners.get('response') || []).length).toBeLessThanOrEqual(1)
})

test('Instagram parser drops generated media summaries while preserving real captions', () => {
    const posts = InsApiJsonParser.postsParser({
        data: {
            user: {
                edge_owner_to_timeline_media: {
                    edges: [
                        {
                            node: {
                                code: 'AUTOALT',
                                taken_at: 1773845200,
                                caption: {
                                    text: 'May be an image of 1 person, strawberry and text',
                                },
                                user: {
                                    username: 'ig_user',
                                    full_name: 'IG User',
                                    hd_profile_pic_url_info: {
                                        url: 'https://example.com/avatar.jpg',
                                    },
                                },
                                image_versions2: {
                                    candidates: [{ width: 720, url: 'https://example.com/photo.jpg' }],
                                },
                            },
                        },
                        {
                            node: {
                                code: 'REALCAP',
                                taken_at: 1773845201,
                                caption: {
                                    text: 'May be we can still use this phrase as a real caption',
                                },
                                user: {
                                    username: 'ig_user',
                                    full_name: 'IG User',
                                    hd_profile_pic_url_info: {
                                        url: 'https://example.com/avatar.jpg',
                                    },
                                },
                                image_versions2: {
                                    candidates: [{ width: 720, url: 'https://example.com/photo2.jpg' }],
                                },
                            },
                        },
                    ],
                },
            },
        },
    })

    expect(posts[0]?.content).toBeNull()
    expect(posts[1]?.content).toBe('May be we can still use this phrase as a real caption')
})

test('Instagram parser marks video covers as thumbnails', () => {
    const posts = InsApiJsonParser.postsParser({
        data: {
            user: {
                edge_owner_to_timeline_media: {
                    edges: [
                        {
                            node: {
                                code: 'VIDEOPOST',
                                taken_at: 1773845200,
                                caption: { text: 'video caption' },
                                user: {
                                    username: 'ig_user',
                                    full_name: 'IG User',
                                },
                                image_versions2: {
                                    candidates: [{ width: 720, url: 'https://example.com/video-cover.jpg' }],
                                },
                                video_versions: [{ width: 720, url: 'https://example.com/video.mp4' }],
                            },
                        },
                    ],
                },
            },
        },
    })

    expect(posts[0]?.media).toEqual([
        { type: 'video_thumbnail', url: 'https://example.com/video-cover.jpg' },
        { type: 'video', url: 'https://example.com/video.mp4' },
    ])
})

test('Instagram parser preserves videos inside carousel media', () => {
    const posts = InsApiJsonParser.postsParser({
        data: {
            user: {
                edge_owner_to_timeline_media: {
                    edges: [
                        {
                            node: {
                                code: 'CAROUSELVIDEO',
                                taken_at: 1773845200,
                                caption: { text: 'carousel caption' },
                                user: {
                                    username: 'ig_user',
                                    full_name: 'IG User',
                                },
                                image_versions2: {
                                    candidates: [{ width: 720, url: 'https://example.com/top-cover.jpg' }],
                                },
                                carousel_media: [
                                    {
                                        image_versions2: {
                                            candidates: [{ width: 720, url: 'https://example.com/photo.jpg' }],
                                        },
                                    },
                                    {
                                        image_versions2: {
                                            candidates: [{ width: 720, url: 'https://example.com/carousel-cover.jpg' }],
                                        },
                                        video_versions: [{ width: 720, url: 'https://example.com/carousel-video.mp4' }],
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    })

    expect(posts[0]?.media).toEqual([
        { type: 'photo', url: 'https://example.com/photo.jpg' },
        { type: 'video_thumbnail', url: 'https://example.com/carousel-cover.jpg' },
        { type: 'video', url: 'https://example.com/carousel-video.mp4' },
    ])
})

test('Instagram parser records crawled profile context for collaboration posts', () => {
    const posts = InsApiJsonParser.postsParser({
        data: {
            user: {
                username: 'shiina_satsuki227',
                full_name: '椎名桜月',
                profile_pic_url_hd: 'https://example.com/shiina-avatar.jpg',
                edge_owner_to_timeline_media: {
                    edges: [
                        {
                            node: {
                                code: 'COLLABPOST',
                                taken_at: 1773845200,
                                caption: { text: 'collaboration caption' },
                                user: {
                                    username: 'em_matcha227',
                                    full_name: '望月りの',
                                    hd_profile_pic_url_info: {
                                        url: 'https://example.com/rino-avatar.jpg',
                                    },
                                },
                                image_versions2: {
                                    candidates: [{ width: 720, url: 'https://example.com/photo.jpg' }],
                                },
                            },
                        },
                    ],
                },
            },
        },
    })

    expect(posts[0]).toMatchObject({
        a_id: 'COLLABPOST',
        u_id: 'em_matcha227',
        username: '望月りの',
        extra: {
            extra_type: 'instagram_profile_context',
            data: {
                crawled_profile: {
                    u_id: 'shiina_satsuki227',
                    username: '椎名桜月',
                    u_avatar: 'https://example.com/shiina-avatar.jpg',
                },
                post_owner: {
                    u_id: 'em_matcha227',
                    username: '望月りの',
                    u_avatar: 'https://example.com/rino-avatar.jpg',
                },
            },
        },
    })
})

test('Instagram posts parser never attributes fallback edges to the crawled profile', () => {
    const posts = InsApiJsonParser.postsParser({
        data: {
            user: { username: 'nao_aikawa227', full_name: '相川奈央' },
            recommendations: {
                edges: [
                    {
                        node: {
                            code: 'UNRELATED',
                            taken_at: 1773845200,
                            caption: { text: 'recommended post' },
                            image_versions2: { candidates: [{ width: 720, url: 'https://example.com/x.jpg' }] },
                        },
                    },
                ],
            },
        },
    })
    expect(posts).toEqual([])
})

test('Instagram stories drop accessibility summaries', async () => {
    const page = {
        goto: async () => undefined,
        waitForSelector: async () => {
            throw new Error('not found')
        },
        $$: async () => [
            {
                evaluate: async () =>
                    JSON.stringify({
                        xdt_api__v1__feed__reels_media: true,
                        reels_media: [
                            {
                                user: {
                                    username: 'nananijigram22_7',
                                },
                                items: [
                                    {
                                        id: '36963634381048168_1',
                                        taken_at: 1773845200,
                                        accessibility_caption: '1. May be a photo of one or more people',
                                        image_versions2: {
                                            candidates: [{ width: 720, url: 'https://example.com/story.jpg' }],
                                        },
                                    },
                                ],
                            },
                        ],
                    }),
            },
        ],
        $: async () => null,
    } as any

    const stories = await InsApiJsonParser.grabStories(page, 'https://www.instagram.com/stories/nananijigram22_7/')

    expect(stories).toHaveLength(1)
    expect(stories[0]?.content).toBeNull()
})

test('Instagram stories throw a contextual error for malformed reels_media JSON', async () => {
    const page = {
        goto: async () => undefined,
        waitForSelector: async () => {
            throw new Error('not found')
        },
        $$: async () => [{ evaluate: async () => 'xdt_api__v1__feed__reels_media {broken json' }],
        $: async () => null,
    } as any

    await expect(
        InsApiJsonParser.grabStories(page, 'https://www.instagram.com/stories/nananijigram22_7/'),
    ).rejects.toThrow('Instagram stories JSON parse failed')
})

test('Instagram stories return empty array when reels_media is missing', async () => {
    const page = {
        goto: async () => undefined,
        waitForSelector: async () => {
            throw new Error('not found')
        },
        $$: async () => [
            {
                evaluate: async () =>
                    JSON.stringify({
                        xdt_api__v1__feed__reels_media: true,
                        data: {
                            user: {
                                username: 'nananijigram22_7',
                            },
                        },
                    }),
            },
        ],
        $: async () => null,
    } as any

    const stories = await InsApiJsonParser.grabStories(page, 'https://www.instagram.com/stories/nananijigram22_7/')

    expect(stories).toHaveLength(0)
})

test('Instagram profile status parser detects live broadcasts', () => {
    const profile_json = {
        data: {
            user: {
                id: '58726731378',
                username: 'shiina_satsuki227',
                full_name: '椎名桜月',
                profile_pic_url_hd: 'https://example.com/avatar.jpg',
                live_broadcast_id: '1234567890',
                live_broadcast_visibility: 'public',
            },
        },
    }

    expect(InsApiJsonParser.profileStatusParser(profile_json)).toMatchObject({
        platform: 2,
        u_id: 'shiina_satsuki227',
        numeric_id: '58726731378',
        username: '椎名桜月',
        is_live: true,
        live_broadcast_id: '1234567890',
        live_broadcast_visibility: 'public',
        live_url: 'https://www.instagram.com/shiina_satsuki227/live/',
    })
})

test('Instagram extractBasicInfo preserves dotted profile handles', () => {
    expect(Spider.extractBasicInfo('https://www.instagram.com/nananijigram22_7_the.3rd/')?.u_id).toBe(
        'nananijigram22_7_the.3rd',
    )
    expect(Spider.extractBasicInfo('https://www.instagram.com/p/DV0oKjQEcFT/')).toBeUndefined()
})

test('Instagram stories keep a non-empty username when og:title does not expose it', async () => {
    const page = {
        goto: async () => undefined,
        waitForSelector: async () => {
            throw new Error('not found')
        },
        $$: async () => [
            {
                evaluate: async () =>
                    JSON.stringify({
                        xdt_api__v1__feed__reels_media: true,
                        reels_media: [
                            {
                                user: {
                                    username: 'nananijigram22_7',
                                },
                                items: [
                                    {
                                        id: '36963634381048167_1',
                                        taken_at: 1773845200,
                                        accessibility_caption: '1. Story caption',
                                        image_versions2: {
                                            candidates: [{ width: 720, url: 'https://example.com/story.jpg' }],
                                        },
                                    },
                                ],
                            },
                        ],
                    }),
            },
        ],
        $: async () => ({
            evaluate: async () => 'Instagram',
        }),
    } as any

    const stories = await InsApiJsonParser.grabStories(page, 'https://www.instagram.com/stories/nananijigram22_7/')

    expect(stories).toHaveLength(1)
    expect(stories[0]?.a_id).toBe('36963634381048167')
    expect(stories[0]?.u_id).toBe('nananijigram22_7')
    expect(stories[0]?.username).toBe('nananijigram22_7')
    expect(stories[0]?.url).toBe('https://www.instagram.com/stories/nananijigram22_7/36963634381048167')
})

test('Instagram article crawl defaults to posts only', async () => {
    const originalGrabPosts = InsApiJsonParser.grabPosts
    const originalGrabStories = InsApiJsonParser.grabStories
    const calls: Array<string> = []
    ;(InsApiJsonParser as any).grabPosts = async () => {
        calls.push('posts')
        return [
            {
                platform: 2,
                a_id: 'POSTONLY',
                u_id: 'instagram',
                username: 'Instagram',
                created_at: 1773845200,
                content: 'post survives',
                url: 'https://www.instagram.com/p/POSTONLY/',
                type: 'post',
                ref: null,
                has_media: false,
                media: [],
                extra: null,
                u_avatar: null,
            },
        ]
    }
    ;(InsApiJsonParser as any).grabStories = async (_page: any, _url: string, config: any) => {
        calls.push(`stories:${config?.timeout}`)
        throw new Error('stories blocked')
    }

    try {
        const spider = new InstagramSpider()
        const articles = await spider.crawl('https://www.instagram.com/instagram/', {} as any, 'ig-default', {
            task_type: 'article',
            crawl_engine: 'browser',
        })

        expect(calls).toEqual(['posts'])
        expect(articles).toHaveLength(1)
        expect(articles[0]?.a_id).toBe('POSTONLY')
    } finally {
        ;(InsApiJsonParser as any).grabPosts = originalGrabPosts
        ;(InsApiJsonParser as any).grabStories = originalGrabStories
    }
})

test('Instagram highlights run only through the explicit highlights subtask', async () => {
    const originalGrabPosts = InsApiJsonParser.grabPosts
    const originalGrabStories = InsApiJsonParser.grabStories
    const originalGrabHighlights = InsApiJsonParser.grabHighlights
    const calls: Array<string> = []
    ;(InsApiJsonParser as any).grabPosts = async () => {
        calls.push('posts')
        return []
    }
    ;(InsApiJsonParser as any).grabStories = async () => {
        calls.push('stories')
        return []
    }
    ;(InsApiJsonParser as any).grabHighlights = async () => {
        calls.push('highlights')
        return []
    }

    try {
        const spider = new InstagramSpider()
        const articles = await spider.crawl('https://www.instagram.com/instagram/', {} as any, 'ig-highlights', {
            task_type: 'article',
            crawl_engine: 'browser',
            sub_task_type: ['highlights'],
        })
        expect(articles).toEqual([])
        expect(calls).toEqual(['highlights'])
    } finally {
        ;(InsApiJsonParser as any).grabPosts = originalGrabPosts
        ;(InsApiJsonParser as any).grabStories = originalGrabStories
        ;(InsApiJsonParser as any).grabHighlights = originalGrabHighlights
    }
})

test('Instagram article crawl uses the browser posts path even when cookies are present', async () => {
    const originalGrabPosts = InsApiJsonParser.grabPosts
    const originalGrabStories = InsApiJsonParser.grabStories
    let browserCalled = false
    ;(InsApiJsonParser as any).grabPosts = async () => {
        browserCalled = true
        return []
    }
    ;(InsApiJsonParser as any).grabStories = async () => []

    try {
        const spider = new InstagramSpider()
        const articles = await spider.crawl('https://www.instagram.com/instagram/', {} as any, 'ig-api-primary', {
            task_type: 'article',
            crawl_engine: 'browser',
            cookieString: 'sessionid=abc',
        })

        expect(articles).toHaveLength(0)
        expect(browserCalled).toBe(true)
    } finally {
        ;(InsApiJsonParser as any).grabPosts = originalGrabPosts
        ;(InsApiJsonParser as any).grabStories = originalGrabStories
    }
})

test('Instagram article crawl does not invoke the private API fallback', async () => {
    const originalGrabPosts = InsApiJsonParser.grabPosts
    const originalGrabStories = InsApiJsonParser.grabStories
    ;(InsApiJsonParser as any).grabPosts = async () => [
        {
            platform: 2,
            a_id: 'BROWSER1',
            u_id: 'instagram',
            username: 'Instagram',
            created_at: 1773845200,
            content: 'browser post',
            url: 'https://www.instagram.com/p/BROWSER1/',
            type: 'post',
            ref: null,
            has_media: false,
            media: [],
            extra: null,
            u_avatar: null,
        },
    ]
    ;(InsApiJsonParser as any).grabStories = async () => []

    try {
        const spider = new InstagramSpider()
        const articles = await spider.crawl('https://www.instagram.com/instagram/', {} as any, 'ig-api-fallback', {
            task_type: 'article',
            crawl_engine: 'browser',
            cookieString: 'sessionid=abc',
        })

        expect(articles).toHaveLength(1)
        expect(articles[0]?.a_id).toBe('BROWSER1')
    } finally {
        ;(InsApiJsonParser as any).grabPosts = originalGrabPosts
        ;(InsApiJsonParser as any).grabStories = originalGrabStories
    }
})

test('Instagram grabPostsAndHighlights captures posts and highlights in a single navigation', async () => {
    const posts_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts.json'), 'utf-8'))
    const highlights_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-highlights.json'), 'utf-8'))
    const listeners = new Map<string, Array<(data: any) => void>>()
    let gotoCount = 0
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            gotoCount += 1
            for (const handler of listeners.get('response') || []) {
                handler({
                    url: () => 'https://www.instagram.com/ajax/bulk-route-definitions/',
                    status: () => 200,
                    json: async () => posts_json,
                    request: () => ({
                        method: () => 'POST',
                        postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
                    }),
                })
                handler({
                    url: () => 'https://www.instagram.com/graphql/query/',
                    status: () => 200,
                    json: async () => highlights_json,
                    request: () => ({
                        method: () => 'POST',
                        postData: () =>
                            'av=0&fb_api_req_friendly_name=PolarisProfileStoryHighlightsTrayContentQuery&variables=%7B%7D',
                    }),
                })
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    const result = await InsApiJsonParser.grabPostsAndHighlights(page, 'https://www.instagram.com/instagram/', {
        isArticleKnown: async () => false,
        wantHighlights: true,
    })

    expect(gotoCount).toBe(1)
    expect(result.posts.length).toBeGreaterThan(0)
    expect(result.highlights.length).toBeGreaterThan(0)
})

test('Instagram grabPosts skips the cache-bust reload for an empty profile', async () => {
    const listeners = new Map<string, Array<(data: any) => void>>()
    let reloadCalls = 0
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                handler({
                    url: () => 'https://www.instagram.com/ajax/bulk-route-definitions/',
                    status: () => 200,
                    json: async () => ({
                        data: {
                            xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [] },
                        },
                    }),
                    request: () => ({
                        method: () => 'POST',
                        postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
                    }),
                })
            }
        },
        reload: async () => {
            reloadCalls += 1
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    const posts = await InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/instagram/', {
        isArticleKnown: async () => true,
    })

    expect(posts).toEqual([])
    expect(reloadCalls).toBe(0)
})

test('Instagram highlights failures are isolated and keep posts', async () => {
    const originalCombined = InsApiJsonParser.grabPostsAndHighlights
    const originalHighlights = InsApiJsonParser.grabHighlights
    const originalStories = InsApiJsonParser.grabStories
    ;(InsApiJsonParser as any).grabPostsAndHighlights = async () => ({
        posts: [
            {
                platform: 2,
                a_id: 'POST1',
                u_id: 'instagram',
                username: 'Instagram',
                created_at: 1773845200,
                content: 'post survives',
                url: 'https://www.instagram.com/p/POST1/',
                type: 'post',
                ref: null,
                has_media: false,
                media: [],
                extra: null,
                u_avatar: null,
            },
        ],
        highlights: [],
    })
    ;(InsApiJsonParser as any).grabHighlights = async () => {
        throw new Error('highlights blocked')
    }
    ;(InsApiJsonParser as any).grabStories = async () => []

    try {
        const spider = new InstagramSpider()
        const page = {
            evaluate: async () => true,
        } as any
        const articles = await spider.crawl('https://www.instagram.com/instagram/', page, 'ig-hl-fail', {
            task_type: 'article',
            crawl_engine: 'browser',
            sub_task_type: ['posts', 'highlights'],
        })

        expect(articles.map((article: any) => article.a_id)).toEqual(['POST1'])
    } finally {
        ;(InsApiJsonParser as any).grabPostsAndHighlights = originalCombined
        ;(InsApiJsonParser as any).grabHighlights = originalHighlights
        ;(InsApiJsonParser as any).grabStories = originalStories
    }
})

test('Instagram posts parser fails fast for private profiles the viewer does not follow', () => {
    expect(() =>
        InsApiJsonParser.postsParser({
            data: {
                user: {
                    username: 'shijo_luna_',
                    is_private: true,
                    friendship_status: { following: false },
                    edge_owner_to_timeline_media: {
                        edges: [
                            {
                                node: {
                                    code: 'PRIVATEPOST',
                                    taken_at: 1773845200,
                                    user: {
                                        username: 'shijo_luna_',
                                        is_private: true,
                                        friendship_status: { following: false },
                                    },
                                    image_versions2: {
                                        candidates: [{ width: 720, url: 'https://example.com/private.jpg' }],
                                    },
                                },
                            },
                        ],
                    },
                },
            },
        }),
    ).toThrow(/private and the current viewer is not following/)
})

test('Instagram media parser falls back to sidecar children and scalar video_url', () => {
    const posts = InsApiJsonParser.postsParser({
        data: {
            user: {
                username: 'nananijigram22_7',
                full_name: '22/7',
                edge_owner_to_timeline_media: {
                    edges: [
                        {
                            node: {
                                code: 'SIDECARVIDEO',
                                taken_at: 1773845200,
                                user: { username: 'nananijigram22_7' },
                                edge_sidecar_to_children: {
                                    edges: [
                                        {
                                            node: {
                                                image_versions2: {
                                                    candidates: [
                                                        {
                                                            width: 720,
                                                            url: 'https://example.com/sidecar-photo.jpg',
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                        {
                                            node: {
                                                image_versions2: {
                                                    candidates: [
                                                        {
                                                            width: 720,
                                                            url: 'https://example.com/sidecar-cover.jpg',
                                                        },
                                                    ],
                                                },
                                                video_url: 'https://example.com/sidecar-video.mp4',
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
        },
    })

    expect(posts[0]?.media).toEqual([
        { type: 'photo', url: 'https://example.com/sidecar-photo.jpg' },
        { type: 'video_thumbnail', url: 'https://example.com/sidecar-cover.jpg' },
        { type: 'video', url: 'https://example.com/sidecar-video.mp4' },
    ])
})

test('Instagram grabPosts fails fast when the profile payload reveals a private unfollowed account', async () => {
    const profile_json = {
        data: {
            user: {
                username: 'shijo_luna_',
                full_name: 'Private',
                is_private: true,
                friendship_status: { following: false },
            },
        },
    }
    const listeners = new Map<string, Array<(data: any) => void>>()
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                handler({
                    url: () => 'https://www.instagram.com/graphql/query/',
                    status: () => 200,
                    json: async () => profile_json,
                    request: () => ({
                        method: () => 'POST',
                        postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePageContentQuery&variables=%7B%7D',
                    }),
                })
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    await expect(InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/shijo_luna_/')).rejects.toThrow(
        /private and the current viewer is not following/,
    )
})

test('Instagram grabPosts fast-fails with an auth-class error on a logged-out profile page', async () => {
    // Logged-out behavior: navigation succeeds, no graphql traffic ever fires,
    // and the page exposes a login entry point. The 60s posts gate must be cut
    // short by InstagramLoggedOutError (message classifies as `auth`).
    // bun's default 5s test timeout would race the 8s probe window — allow 30s.
    const listeners = new Map<string, Array<(data: any) => void>>()
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            // Deliberately fire NO graphql responses — the logged-out shape.
            for (const handler of listeners.get('response') || []) {
                handler({
                    url: () => 'https://www.instagram.com/api/v1/users/web_profile_info/',
                    status: () => 200,
                    json: async () => ({}),
                    request: () => ({
                        method: () => 'GET',
                        postData: () => null,
                    }),
                })
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
        $: async (selector: string) => {
            expect(selector).toContain('loginForm')
            return {} as any // the page shows a login entry
        },
    } as any

    const startedAt = Date.now()
    await expect(
        InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/shiina_satsuki227/'),
    ).rejects.toThrow(/instagram_logged_out/)
    // Fast fail: nowhere near the 60s posts timeout.
    expect(Date.now() - startedAt).toBeLessThan(20000)
}, 30000)

test('Instagram grabPosts behaves normally (full posts wait) when graphql traffic is present', async () => {
    // The logged-out probe must never misfire on a healthy session: graphql
    // responses flowing → probe cancels, posts resolve through the normal gate.
    const posts_json = JSON.parse(readFileSync(dataPath('instagram', 'instagram-posts.json'), 'utf-8'))
    const listeners = new Map<string, Array<(data: any) => void>>()
    let probeSawGraqhql = false
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            const handlers = listeners.get(eventName) || []
            handlers.push(handler)
            listeners.set(eventName, handlers)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            listeners.set(
                eventName,
                (listeners.get(eventName) || []).filter((entry) => entry !== handler),
            )
        },
        goto: async () => {
            for (const handler of listeners.get('response') || []) {
                probeSawGraqhql = true
                handler({
                    url: () => 'https://www.instagram.com/graphql/query/',
                    status: () => 200,
                    json: async () => posts_json,
                    request: () => ({
                        method: () => 'POST',
                        postData: () => 'av=0&fb_api_req_friendly_name=PolarisProfilePostsQuery&variables=%7B%7D',
                    }),
                })
            }
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
        $: async () => {
            throw new Error('probe must not reach the DOM check when graphql fired')
        },
    } as any

    const posts = await InsApiJsonParser.grabPosts(page, 'https://www.instagram.com/instagram/')

    expect(probeSawGraqhql).toBe(true)
    expect(posts.length).toBeGreaterThan(0)
})
