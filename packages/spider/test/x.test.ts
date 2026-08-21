import puppeteer from 'puppeteer-core'
import { Spider, X } from '../src'
import { parseNetscapeCookieToPuppeteerCookie, SimpleExpiringCache, UserAgent } from '../src/utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createLogger, winston, format } from '@kyestu/log'
import { test, expect } from 'bun:test'
import type { GenericFollows } from '../src/types'
import { assertXResponseOk } from '../src/spiders/x'

const dataPath = (...parts: Array<string>) => join(import.meta.dir, 'data', ...parts)

test('X Spider', async () => {
    const url = 'https://x.com/X'
    const spider = Spider.getSpider(url)
    if (spider) {
        let id = await new spider()._match_valid_url(url, spider)?.groups?.id
        expect(id).toBe('X')
    }
})

test('X timeline URL regex accepts profile URLs with a trailing slash', () => {
    const spider = new X.XUserTimeLineSpider().init()
    expect(spider._match_valid_url('https://x.com/X/', X.XUserTimeLineSpider)?.groups?.id).toBe('X')
})

test('X API mode without a browser preserves the API failure reason', async () => {
    const spider = new X.XUserTimeLineSpider().init()

    await expect(
        spider.crawl('https://x.com/X', undefined, 'api-error-regression', {
            task_type: 'follows',
            crawl_engine: 'api',
        }),
    ).rejects.toThrow('Cookie string is required for API mode')
})

test('X API mode surfaces 429 instead of falling back to the browser', async () => {
    const spider = new X.XUserTimeLineSpider().init()
    const originalPrepare = X.XApiClient.prototype.prepareUserOperations
    const originalGrabFollows = X.XApiClient.prototype.grabFollowsNumber
    const originalBrowserGrabFollows = (X.XApiJsonParser as any).grabFollowsNumber
    try {
        ;(X.XApiClient.prototype as any).prepareUserOperations = async () => undefined
        ;(X.XApiClient.prototype as any).grabFollowsNumber = async () => {
            throw new Error('Failed to fetch follows: 429 retry_after=900')
        }
        ;(X.XApiJsonParser as any).grabFollowsNumber = async () => {
            throw new Error('browser fallback was called')
        }
        const page = {
            browserContext: () => ({
                cookies: async () => [{ name: 'auth_token', value: 'token' }],
            }),
        } as any

        await expect(
            spider.crawl('https://x.com/X', page, 'api-no-fallback', {
                task_type: 'follows',
                crawl_engine: 'api',
            }),
        ).rejects.toThrow('429')
    } finally {
        X.XApiClient.prototype.prepareUserOperations = originalPrepare
        X.XApiClient.prototype.grabFollowsNumber = originalGrabFollows
        ;(X.XApiJsonParser as any).grabFollowsNumber = originalBrowserGrabFollows
    }
})

/**
 * require network access & headless browser
 */
test.skip('spider', async () => {
    const url = 'https://x.com/X'
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
        expect(id).toBe('X')
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

function buildXTimelineTweetResult(id: string, userId: string, text: string, replyToId?: string) {
    return {
        __typename: 'Tweet',
        legacy: {
            id_str: id,
            full_text: text,
            created_at: 'Tue Mar 11 20:55:07 +0000 2025',
            entities: {
                urls: [],
                media: [],
            },
            ...(replyToId ? { in_reply_to_status_id_str: replyToId } : {}),
        },
        core: {
            user_results: {
                result: {
                    core: {
                        screen_name: userId,
                        name: userId,
                    },
                    avatar: {
                        image_url: `https://example.com/${userId}_normal.jpg`,
                    },
                },
            },
        },
    }
}

test('X API JSON Parser', async () => {
    const x_json = JSON.parse(readFileSync(dataPath('x', 'x.json'), 'utf-8'))
    const x_result = JSON.parse(readFileSync(dataPath('x', 'x-result.json'), 'utf-8'))
    const x_replies_result = JSON.parse(readFileSync(dataPath('x', 'x-replies-result.json'), 'utf-8'))
    const x_follows = JSON.parse(readFileSync(dataPath('x', 'x-follows.json'), 'utf-8'))
    const x_follows_result = JSON.parse(readFileSync(dataPath('x', 'x-follows-result.json'), 'utf-8'))
    const x_response = X.XApiJsonParser.tweetsArticleParser(x_json)
    const x_replies_response = X.XApiJsonParser.tweetsRepliesParser(x_json)
    const x_follows_response = X.XApiJsonParser.tweetsFollowsParser(x_follows)
    expect(x_response).toEqual(x_result)
    expect(x_replies_response).toEqual(x_replies_result)
    expect(x_follows_response).toEqual(x_follows_result)
})

test('X replies parser reads TimelineAddToModule conversations', async () => {
    const json = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddToModule',
                                    moduleItems: [
                                        {
                                            entryId: 'profile-conversation-test-tweet-100',
                                            item: {
                                                itemContent: {
                                                    tweet_results: {
                                                        result: buildXTimelineTweetResult(
                                                            '100',
                                                            'parent_member',
                                                            'parent text',
                                                        ),
                                                    },
                                                },
                                            },
                                        },
                                        {
                                            entryId: 'profile-conversation-test-tweet-101',
                                            item: {
                                                itemContent: {
                                                    tweet_results: {
                                                        result: buildXTimelineTweetResult(
                                                            '101',
                                                            'reply_member',
                                                            '@parent_member reply text',
                                                            '100',
                                                        ),
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }

    const replies = X.XApiJsonParser.tweetsRepliesParser(json)

    expect(replies).toHaveLength(1)
    expect(replies[0]?.a_id).toBe('101')
    expect(replies[0]?.type).toBe(X.ArticleTypeEnum.CONVERSATION)
    expect(replies[0]?.content).toBe('reply text')
    expect((replies[0]?.ref as any)?.a_id).toBe('100')
})

test('X replies parser keeps direct reply timeline entries', async () => {
    const json = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddEntries',
                                    entries: [
                                        {
                                            entryId: 'tweet-201',
                                            content: {
                                                itemContent: {
                                                    tweet_results: {
                                                        result: buildXTimelineTweetResult(
                                                            '201',
                                                            'reply_member',
                                                            'direct reply',
                                                            '200',
                                                        ),
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }

    const replies = X.XApiJsonParser.tweetsRepliesParser(json)

    expect(replies).toHaveLength(1)
    expect(replies[0]?.a_id).toBe('201')
    expect(replies[0]?.type).toBe(X.ArticleTypeEnum.CONVERSATION)
    expect(replies[0]?.ref).toBe('200')
})

test('X tweet detail parser selects the requested status from a conversation response', async () => {
    const json = {
        data: {
            threaded_conversation_with_injections_v2: {
                instructions: [
                    {
                        type: 'TimelineAddEntries',
                        entries: [
                            {
                                entryId: 'tweet-500',
                                content: {
                                    itemContent: {
                                        tweet_results: {
                                            result: buildXTimelineTweetResult('500', 'other_member', 'thread head'),
                                        },
                                    },
                                },
                            },
                            {
                                entryId: 'tweet-501',
                                content: {
                                    itemContent: {
                                        tweet_results: {
                                            result: buildXTimelineTweetResult('501', 'target_member', 'target text'),
                                        },
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        },
    }

    const tweet = X.XApiJsonParser.tweetDetailParser(json, '501')

    expect(tweet).toMatchObject({
        a_id: '501',
        u_id: 'target_member',
        content: 'target text',
        url: 'https://x.com/target_member/status/501',
    })
})

test('X follows browser parser fails fast on login pages', async () => {
    const listeners = new Map<string, (data: any) => void>()
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            listeners.set(eventName, handler)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            if (listeners.get(eventName) === handler) {
                listeners.delete(eventName)
            }
        },
        setViewport: async () => undefined,
        goto: async () => undefined,
        waitForSelector: async () => ({}),
    } as any

    await expect(X.XApiJsonParser.grabFollowsNumber(page, 'https://x.com/expired')).rejects.toThrow(
        'You need to login first',
    )
    expect(listeners.has('response')).toBeFalse()
})

test('X browser fallback keeps the active browser profile viewport by default', async () => {
    const listeners = new Map<string, (data: any) => void>()
    let setViewportCalls = 0
    const page = {
        on: (eventName: string, handler: (data: any) => void) => {
            listeners.set(eventName, handler)
        },
        off: (eventName: string, handler: (data: any) => void) => {
            if (listeners.get(eventName) === handler) {
                listeners.delete(eventName)
            }
        },
        setViewport: async () => {
            setViewportCalls += 1
        },
        goto: async () => {
            listeners.get('response')?.({
                url: () => 'https://x.com/i/api/graphql/UserTweets',
                status: () => 500,
                request: () => ({
                    method: () => 'GET',
                }),
            })
        },
        waitForSelector: async () => {
            throw new Error('not found')
        },
    } as any

    await expect(X.XApiJsonParser.grabTweets(page, 'https://x.com/X')).rejects.toThrow()

    expect(setViewportCalls).toBe(0)
})

test('X parser keeps video variants without bitrate', async () => {
    const result = buildXTimelineTweetResult('301', 'video_member', 'video post https://t.co/media')
    result.legacy.entities.media = [
        {
            url: 'https://t.co/media',
            media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/301/pu/img/thumb.jpg',
            type: 'video',
        },
    ] as any
    ;(result.legacy as any).extended_entities = {
        media: [
            {
                url: 'https://t.co/media',
                media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/301/pu/img/thumb.jpg',
                type: 'video',
                video_info: {
                    variants: [
                        {
                            content_type: 'application/x-mpegURL',
                            url: 'https://video.twimg.com/ext_tw_video/301/playlist.m3u8',
                        },
                        {
                            content_type: 'video/mp4',
                            url: 'https://video.twimg.com/ext_tw_video/301/vid/720x720/video.mp4',
                        },
                    ],
                },
            },
        ],
    }
    const json = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddEntries',
                                    entries: [
                                        {
                                            entryId: 'tweet-301',
                                            content: {
                                                itemContent: {
                                                    tweet_results: {
                                                        result,
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }

    const tweets = X.XApiJsonParser.tweetsArticleParser(json)

    expect(tweets[0]?.content).toBe('video post ')
    expect(tweets[0]?.media).toEqual([
        {
            type: 'video',
            url: 'https://video.twimg.com/ext_tw_video/301/vid/720x720/video.mp4',
        },
        {
            type: 'video_thumbnail',
            url: 'https://pbs.twimg.com/ext_tw_video_thumb/301/pu/img/thumb.jpg',
        },
    ])
})

test('X old API parser tolerates missing entities', async () => {
    const tweet = X.XApiJsonParser.oldTweetParser({
        id_str: '401',
        full_text: 'legacy post',
        created_at: 'Tue Mar 11 20:55:07 +0000 2025',
        user: {
            screen_name: 'legacy_member',
            name: 'Legacy Member',
        },
    })

    expect(tweet).toMatchObject({
        a_id: '401',
        u_id: 'legacy_member',
        content: 'legacy post',
        media: null,
        has_media: false,
    })
})

test('X old API parser skips status entries without id or created_at', async () => {
    expect(
        X.XApiJsonParser.oldTweetParser({
            id_str: '402',
            full_text: 'missing timestamp',
        }),
    ).toBeNull()
    expect(
        X.XApiJsonParser.oldTweetMemeberParser({
            status: { id_str: '403' },
            user: { screen_name: 'legacy_member', name: 'Legacy Member' },
        }),
    ).toBeNull()
})

test('X parser expands premium long tweets from the note_tweet payload', async () => {
    const truncated = '【お知らせ】\n桧山依子ですが、体調不良のため下記のスケジュールを欠席とさせていただきます。'
    const full =
        '【お知らせ】\n桧山依子ですが、体調不良のため下記のスケジュールを欠席とさせていただきます。\n\n・8/7(金)\n河瀬詩の"うたっけ！" #31\n\nなお、本人の体調は快方に向かっておりますので、8/10(月)以降順次、活動の再開を予定しております。\n\nhttps://t.co/nwSlMQy3jG'
    const result = buildXTimelineTweetResult('701', '227_staff', truncated)
    ;(result as any).note_tweet = {
        note_tweet_results: {
            result: {
                id: 'Tm90ZVR3ZWV0OjIwODUzMDUwNTA5ODE5NjU4MjU=',
                text: full,
                entity_set: {
                    hashtags: [],
                    symbols: [],
                    urls: [
                        {
                            display_url: 'example.com/news/…',
                            expanded_url: 'https://example.com/news/detail/11404?ima=0018',
                            indices: [220, 243],
                            url: 'https://t.co/nwSlMQy3jG',
                        },
                    ],
                    user_mentions: [],
                },
            },
        },
    }
    const json = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddEntries',
                                    entries: [
                                        {
                                            entryId: 'tweet-701',
                                            content: {
                                                itemContent: {
                                                    tweet_results: {
                                                        result,
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }

    const tweets = X.XApiJsonParser.tweetsArticleParser(json)

    expect(tweets).toHaveLength(1)
    expect(tweets[0]?.content).toBe(
        full.replace('https://t.co/nwSlMQy3jG', 'https://example.com/news/detail/11404?ima=0018'),
    )
})

test('X parser keeps legacy text when a note payload carries no overflow', async () => {
    const text = '普通の長さの投稿。note_tweet が同内容で付いていても、超出部分がなければ legacy.full_text を使う。'
    const result = buildXTimelineTweetResult('704', 'premium_member', text)
    ;(result as any).note_tweet = {
        note_tweet_results: {
            result: {
                id: 'note-704',
                text,
                entity_set: {
                    hashtags: [],
                    symbols: [],
                    urls: [
                        {
                            display_url: 'example.com',
                            expanded_url: 'https://example.com/',
                            indices: [0, 23],
                            url: 'https://t.co/abc123XYZ',
                        },
                    ],
                    user_mentions: [],
                },
            },
        },
    }
    const json = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddEntries',
                                    entries: [
                                        {
                                            entryId: 'tweet-704',
                                            content: {
                                                itemContent: {
                                                    tweet_results: {
                                                        result,
                                                    },
                                                },
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }

    const tweets = X.XApiJsonParser.tweetsArticleParser(json)

    expect(tweets).toHaveLength(1)
    expect(tweets[0]?.content).toBe(text)
})

test('X parser expands premium long tweets under TweetWithVisibilityResults', async () => {
    const truncated = '長い投稿の冒頭部分だけがlegacy.full_textに入っている'
    const full =
        '長い投稿の冒頭部分だけがlegacy.full_textに入っている。そしてnote_tweetに全文が含まれている。これはX Premiumの投稿で、タイムライン上では"さらに表示"のリンクが付く。'
    const quotedResult = buildXTimelineTweetResult('703', 'premium_member', truncated)
    ;(quotedResult as any).note_tweet = {
        note_tweet_results: {
            result: {
                id: 'note-703',
                text: full,
            },
        },
    }
    const result = buildXTimelineTweetResult('702', 'member_account', 'quotes a long post')
    ;(result as any).__typename = 'Tweet'
    ;(result as any).quoted_status_result = {
        result: {
            __typename: 'TweetWithVisibilityResults',
            tweet: quotedResult,
        },
    }
    ;(result.legacy as any).is_quote_status = true

    const tweet = X.XApiJsonParser.tweetDetailParser(
        {
            data: {
                threaded_conversation_with_injections_v2: {
                    instructions: [
                        {
                            type: 'TimelineAddEntries',
                            entries: [
                                {
                                    entryId: 'tweet-702',
                                    content: {
                                        itemContent: {
                                            tweet_results: {
                                                result,
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
            },
        },
        '702',
    )

    expect(tweet?.content).toBe('quotes a long post')
    expect(tweet?.type).toBe(X.ArticleTypeEnum.QUOTED)
    expect((tweet?.ref as any)?.a_id).toBe('703')
    expect((tweet?.ref as any)?.content).toBe(full)
})

test('X unified list hydration keeps member slots when active users fill the limit', () => {
    const spider = new X.XListSpider()

    const selected = (spider as any).selectHydrationUsers({
        listId: 'member-slot-list',
        configuredUsers: ['sally_amaki'],
        activeUserIds: ['active1', 'active2', 'active3', 'active4', 'active5'],
        listMemberUserIds: ['member1', 'member2', 'member3', 'member4', 'member5'],
        hydrateLimit: 5,
    })

    expect(selected).toHaveLength(5)
    expect(selected).toContain('sally_amaki')
    expect(selected.some((userId: string) => userId.startsWith('member'))).toBe(true)
})

test('X unified list hydration never selects non-member activity authors', () => {
    const spider = new X.XListSpider()
    const selected = (spider as any).selectHydrationUsers({
        listId: 'member-filter-list',
        configuredUsers: ['configured_user'],
        activeUserIds: ['member2', 'retweet_original', 'recommended_author'],
        listMemberUserIds: ['member1', 'member2', 'member3'],
        hydrateLimit: 4,
    })

    expect(selected).toContain('configured_user')
    expect(selected).toContain('member2')
    expect(selected).not.toContain('retweet_original')
    expect(selected).not.toContain('recommended_author')
    expect(selected.every((id: string) => ['configured_user', 'member1', 'member2', 'member3'].includes(id))).toBe(true)
})

test('X unified list hydration rotates list members across rounds', () => {
    const spider = new X.XListSpider()
    const options = {
        listId: 'rotating-member-list',
        configuredUsers: [] as string[],
        activeUserIds: [] as string[],
        listMemberUserIds: ['member1', 'member2', 'member3', 'member4', 'member5', 'member6'],
        hydrateLimit: 3,
    }

    const first = (spider as any).selectHydrationUsers(options)
    const second = (spider as any).selectHydrationUsers(options)

    expect(first).toEqual(['member1', 'member2', 'member3'])
    expect(second).toEqual(['member4', 'member5', 'member6'])
})

test('X unified list hydration honors configured concurrency', async () => {
    const spider = new X.XListSpider()
    let activeRequests = 0
    let maxActiveRequests = 0
    const requestedUsers: Array<string> = []
    const client = {
        grabTweets: async (userId: string) => {
            activeRequests += 1
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
            requestedUsers.push(userId)
            await new Promise((resolve) => setTimeout(resolve, 1))
            activeRequests -= 1
            return []
        },
        grabReplies: async () => [],
    }

    await (spider as any).hydrateUsersFromListActivity(['alpha', 'beta', 'gamma'], client, 'cookie', {
        fetchTweets: true,
        fetchReplies: false,
        hydrateConcurrency: 1,
    })

    expect(maxActiveRequests).toBe(1)
    expect(requestedUsers).toEqual(['alpha', 'beta', 'gamma'])
})

test('X unified list hydration preserves tweets when replies fail', async () => {
    const spider = new X.XListSpider()
    const client = {
        grabTweets: async (userId: string) => [
            {
                platform: 0,
                a_id: `${userId}-tweet`,
                u_id: userId,
                username: userId,
                created_at: 1,
                content: 'tweet',
                url: `https://x.com/${userId}/status/1`,
                type: 'tweet',
                ref: null,
                media: null,
                has_media: false,
                extra: null,
            },
        ],
        grabReplies: async () => {
            throw new Error('Failed to fetch replies: 404 Not Found')
        },
    }

    const articles = await (spider as any).hydrateUsersFromListActivity(['alpha'], client, 'cookie', {
        fetchTweets: true,
        fetchReplies: true,
        hydrateConcurrency: 1,
    })

    expect(articles.map((article: any) => article.a_id)).toEqual(['alpha-tweet'])
})

test('X unified list hydration stops after rate limit response', async () => {
    const spider = new X.XListSpider()
    const requestedUsers: Array<string> = []
    const client = {
        grabTweets: async (userId: string) => {
            requestedUsers.push(userId)
            throw new Error('Failed to fetch tweets: 429 Too Many Requests')
        },
        grabReplies: async () => [],
    }

    const articles = await (spider as any).hydrateUsersFromListActivity(['alpha', 'beta', 'gamma'], client, 'cookie', {
        fetchTweets: true,
        fetchReplies: true,
        hydrateConcurrency: 1,
    })

    expect(articles).toEqual([])
    expect(requestedUsers).toEqual(['alpha'])
})

test('X unified list hydration skips tweets already covered by the list timeline', async () => {
    const spider = new X.XListSpider()
    let grabTweetsCalls = 0
    let grabRepliesCalls = 0
    const client = {
        grabTweets: async () => {
            grabTweetsCalls += 1
            return []
        },
        grabReplies: async () => {
            grabRepliesCalls += 1
            return []
        },
    }

    await (spider as any).hydrateUsersFromListActivity(['alpha', 'beta'], client, 'cookie', {
        fetchTweets: true,
        fetchReplies: true,
        hydrateConcurrency: 2,
        discoveryCoverage: new Map([
            ['alpha', 5],
            ['beta', 1],
        ]),
    })

    expect(grabTweetsCalls).toBe(1)
    expect(grabRepliesCalls).toBe(2)
})

test('X unified list hydration coverage lookup tolerates @ prefixes and casing', async () => {
    const spider = new X.XListSpider()
    let grabTweetsCalls = 0
    const client = {
        grabTweets: async () => {
            grabTweetsCalls += 1
            return []
        },
        grabReplies: async () => [],
    }

    await (spider as any).hydrateUsersFromListActivity(['@ALPHA'], client, 'cookie', {
        fetchTweets: true,
        fetchReplies: false,
        hydrateConcurrency: 1,
        discoveryCoverage: new Map([['alpha', 6]]),
    })

    expect(grabTweetsCalls).toBe(0)
})

test('assertXResponseOk passes through a 2xx response without throwing', () => {
    expect(() => assertXResponseOk({ ok: true, status: 200, statusText: 'OK' } as Response, 'tweets')).not.toThrow()
})

test('assertXResponseOk always embeds the numeric status even when statusText is empty', () => {
    // fetch over HTTP/2 commonly returns an empty statusText; the numeric status must survive so the
    // downstream crawl-error classifier can still distinguish auth/rate-limit/transient.
    let thrown: unknown
    try {
        assertXResponseOk({ ok: false, status: 429, statusText: '' } as Response, 'tweets')
    } catch (error) {
        thrown = error
    }
    expect((thrown as Error).message).toBe('Failed to fetch tweets: 429')
})

test('assertXResponseOk keeps statusText when the runtime provides it', () => {
    let thrown: unknown
    try {
        assertXResponseOk({ ok: false, status: 403, statusText: 'Forbidden' } as Response, 'user info (X)')
    } catch (error) {
        thrown = error
    }
    expect((thrown as Error).message).toBe('Failed to fetch user info (X): 403 Forbidden')
})

test('X ListMembers parser carries each member rest_id for prefill', () => {
    const json = {
        data: {
            list: {
                members_timeline: {
                    timeline: {
                        instructions: [
                            {
                                type: 'TimelineAddEntries',
                                entries: [
                                    {
                                        content: {
                                            itemContent: {
                                                user_results: {
                                                    result: {
                                                        rest_id: '111',
                                                        core: { name: 'Alpha', screen_name: 'alpha' },
                                                        legacy: { followers_count: 100 },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                    {
                                        content: {
                                            itemContent: {
                                                user_results: {
                                                    result: {
                                                        rest_id: '222',
                                                        core: { name: 'Beta', screen_name: 'beta' },
                                                        legacy: { followers_count: 200 },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
        },
    }

    const follows = X.XApiJsonParser.tweetsFollowsFromListParser(json)
    expect(follows).toHaveLength(2)
    expect((follows[0] as any).rest_id).toBe('111')
    expect((follows[1] as any).rest_id).toBe('222')
})

test('XApiClient prefilled rest ids answer with normalized keys and no extra request', async () => {
    const client = new X.XApiClient()
    client.prefillRestId('@Alpha', '12345')
    ;(client as any).getRawUserInfo = async () => {
        throw new Error('must not be called')
    }
    expect(await client.getRestId('ALPHA', 'cookie')).toBe('12345')
    expect(await client.getRestId('alpha', 'cookie')).toBe('12345')
})

test('XApiClient dedupes concurrent rest-id lookups for the same user', async () => {
    const client = new X.XApiClient()
    let lookupCalls = 0
    ;(client as any).getRawUserInfo = async () => {
        lookupCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { data: { user: { result: { rest_id: '4242' } } } }
    }

    const [first, second] = await Promise.all([
        client.getRestId('gamma', 'cookie'),
        client.getRestId('@GAMMA', 'cookie'),
    ])
    expect(first).toBe('4242')
    expect(second).toBe('4242')
    expect(lookupCalls).toBe(1)
})

test('XApiClient preloads persisted query ids from the spider cache', () => {
    const cache = new SimpleExpiringCache()
    cache.set('x-queryid:ListMembers', 'listMembersQueryId', 3600)
    const client = new X.XApiClient(undefined, undefined, undefined, cache)
    expect((client as any).api_with_queryid['ListMembers']).toBe('listMembersQueryId')
})

// ---------------------------------------------------------------------------
// X RE-intel landing (2026-08-21): retry-after consumption, guest token mint,
// error-envelope codes, original-size media URLs, stable client uuid.
// ---------------------------------------------------------------------------

import {
    isAuthOrRateLimitError,
    isNotFoundError,
    parseRetryAfterSeconds,
    stableClientUuid,
    throwForXGraphQLErrors,
} from '../src/spiders/x'

test('parseRetryAfterSeconds parses integer seconds', () => {
    expect(parseRetryAfterSeconds({ 'retry-after': '120' })).toBe(120)
    expect(parseRetryAfterSeconds(new Headers({ 'Retry-After': '45' }))).toBe(45)
})

test('parseRetryAfterSeconds parses HTTP-date form', () => {
    const date = new Date(Date.now() + 90 * 1000).toUTCString()
    const seconds = parseRetryAfterSeconds({ 'retry-after': date })
    expect(seconds).not.toBeNull()
    expect(seconds!).toBeGreaterThan(80)
    expect(seconds!).toBeLessThanOrEqual(90)
    // Past dates are expired hints, not backoffs.
    expect(parseRetryAfterSeconds({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() })).toBeNull()
})

test('parseRetryAfterSeconds prefers x-retry-after-milliseconds and rejects garbage', () => {
    expect(parseRetryAfterSeconds({ 'retry-after': '120', 'x-retry-after-milliseconds': '4500' })).toBe(5)
    expect(parseRetryAfterSeconds({ 'retry-after': 'not-a-date' })).toBeNull()
    expect(parseRetryAfterSeconds({ 'retry-after': '-5' })).toBeNull()
    expect(parseRetryAfterSeconds({ 'retry-after': '0' })).toBeNull()
    expect(parseRetryAfterSeconds({})).toBeNull()
    expect(parseRetryAfterSeconds(null)).toBeNull()
})

test('assertXResponseOk normalizes retry-after to seconds and stamps retryAfterSeconds', () => {
    let thrown: any
    try {
        assertXResponseOk(
            { ok: false, status: 429, statusText: '', headers: new Headers({ 'retry-after': '120' }) } as Response,
            'tweets',
        )
    } catch (error) {
        thrown = error
    }
    expect(thrown.message).toBe('Failed to fetch tweets: 429 retry_after=120')
    expect(thrown.retryAfterSeconds).toBe(120)
})

test('assertXResponseOk consumes x-retry-after-milliseconds on 429', () => {
    let thrown: any
    try {
        assertXResponseOk(
            {
                ok: false,
                status: 429,
                statusText: '',
                headers: new Headers({ 'retry-after': 'bogus', 'x-retry-after-milliseconds': '90000' }),
            } as Response,
            'tweets',
        )
    } catch (error) {
        thrown = error
    }
    expect(thrown.message).toBe('Failed to fetch tweets: 429 retry_after=90')
    expect(thrown.retryAfterSeconds).toBe(90)
})

test('throwForXGraphQLErrors passes errors[0].code through message and xErrorCode', () => {
    let thrown: any
    try {
        throwForXGraphQLErrors({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }, 'tweets')
    } catch (error) {
        thrown = error
    }
    expect(thrown.message).toBe('Failed to fetch tweets: Rate limit exceeded (code 88)')
    expect(thrown.xErrorCode).toBe(88)
})

test('throwForXGraphQLErrors keeps the legacy message shape when no code exists', () => {
    expect(() => throwForXGraphQLErrors({ errors: [{ message: 'Boom' }] }, 'tweets')).toThrow(
        'Failed to fetch tweets: Boom',
    )
    expect(() => throwForXGraphQLErrors({ data: {} }, 'tweets')).not.toThrow()
})

test('X error codes drive auth/rate-limit and not-found classification', () => {
    const withCode = (code: number) => {
        try {
            throwForXGraphQLErrors({ errors: [{ code, message: 'err' }] }, 'tweets')
        } catch (error) {
            return error
        }
        throw new Error('unreachable')
    }
    expect(isAuthOrRateLimitError(withCode(88))).toBe(true)
    expect(isAuthOrRateLimitError(withCode(32))).toBe(true)
    expect(isAuthOrRateLimitError(withCode(99))).toBe(true)
    expect(isAuthOrRateLimitError(withCode(50))).toBe(false)
    expect(isNotFoundError(withCode(50))).toBe(true)
    expect(isNotFoundError(withCode(144))).toBe(true)
    expect(isNotFoundError(withCode(88))).toBe(false)
    // Message-embedded codes (e.g. after the error crosses a string boundary)
    // remain classifiable.
    expect(isAuthOrRateLimitError(new Error('Failed to fetch tweets: Rate limit exceeded (code 88)'))).toBe(true)
    expect(isNotFoundError(new Error('Failed to fetch tweet detail: No status found (code 144)'))).toBe(true)
    // Existing regex behavior is preserved for plain status messages.
    expect(isAuthOrRateLimitError(new Error('Failed to fetch tweets: 429 retry_after=60'))).toBe(true)
    expect(isAuthOrRateLimitError(new Error('Failed to fetch tweets: 404'))).toBe(false)
})

test('mediaParser upgrades photos to the 4096 variant keeping the original format', () => {
    const tweet = buildXTimelineTweetResult('301', 'member', 'with media')
    ;(tweet.legacy as any).extended_entities = {
        media: [
            { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AAA.jpg' },
            { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/BBB.png' },
            {
                type: 'video',
                media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/ccc.jpg',
                video_info: {
                    variants: [
                        {
                            bitrate: 100,
                            url: 'https://video.twimg.com/x/low.mp4?tag=12',
                            content_type: 'video/mp4',
                        },
                        {
                            bitrate: 2000,
                            url: 'https://video.twimg.com/x/high.mp4?tag=12',
                            content_type: 'video/mp4',
                        },
                    ],
                },
            },
        ],
    }
    const json = {
        data: {
            user: {
                result: {
                    timeline_v2: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddEntries',
                                    entries: [
                                        {
                                            entryId: 'tweet-301',
                                            content: { itemContent: { tweet_results: { result: tweet } } },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        },
    }
    const [article] = X.XApiJsonParser.tweetsArticleParser(json)
    const byType = new Map(article!.media!.map((m: any, index: number) => [`${m.type}:${index}`, m.url]))
    expect(byType.get('photo:0')).toBe('https://pbs.twimg.com/media/AAA.jpg?format=jpg&name=4096x4096')
    // png keeps png — forcing jpg would drop the alpha channel.
    expect(byType.get('photo:1')).toBe('https://pbs.twimg.com/media/BBB.png?format=png&name=4096x4096')
    // Video variant selection is unchanged: highest-bitrate mp4, ?tag=12 kept.
    expect(byType.get('video:2')).toBe('https://video.twimg.com/x/high.mp4?tag=12')
    // Thumbs outside /media/ are not rewritten.
    expect(byType.get('video_thumbnail:3')).toBe('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/ccc.jpg')
})

test('stableClientUuid is a stable per-profile uuid v5', () => {
    const cookie = 'auth_token=deadbeef1234; ct0=xyz'
    const uuid = stableClientUuid(cookie)
    // Same account identity regardless of cookie ordering / csrf value.
    expect(uuid).toBe(stableClientUuid('ct0=abc; auth_token=deadbeef1234'))
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // A different account is a different profile.
    expect(uuid).not.toBe(stableClientUuid('auth_token=ffffaaaa; ct0=xyz'))
})

test('XApiClient mints, caches and re-mints guest tokens on 429', async () => {
    const originalFetch = globalThis.fetch
    const cache = new SimpleExpiringCache()
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    let activateCount = 0
    let userInfoCount = 0
    globalThis.fetch = (async (url: any, init: any) => {
        const target = String(url)
        calls.push({ url: target, headers: (init?.headers || {}) as Record<string, string> })
        if (target.includes('guest/activate')) {
            activateCount += 1
            return new Response(JSON.stringify({ guest_token: `gt${activateCount}` }), { status: 200 })
        }
        if (target.includes('UserByScreenName')) {
            userInfoCount += 1
            if (userInfoCount === 1) {
                return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } })
            }
            return new Response(JSON.stringify({ data: { user: { result: { rest_id: '42' } } } }), { status: 200 })
        }
        throw new Error(`unexpected fetch in test: ${target}`)
    }) as any
    try {
        const client = new X.XApiClient(undefined, undefined, undefined, cache)
        ;(client as any).api_with_queryid['UserByScreenName'] = 'qid'

        // Mint + cache: two reads, one activate request.
        expect(await client.resolveGuestToken()).toBe('gt1')
        expect(await client.resolveGuestToken()).toBe('gt1')
        expect(activateCount).toBe(1)
        // A second client shares the cross-crawl cache.
        const other = new X.XApiClient(undefined, undefined, undefined, cache)
        expect(await other.resolveGuestToken()).toBe('gt1')
        expect(activateCount).toBe(1)

        // getRawUserInfo: first attempt 429s -> re-mint -> retry succeeds.
        const json = await client.getRawUserInfo('someone', 'auth_token=tok; ct0=csrf')
        expect(json?.data?.user?.result?.rest_id).toBe('42')
        expect(activateCount).toBe(2)
        expect(userInfoCount).toBe(2)
        const userInfoCalls = calls.filter((call) => call.url.includes('UserByScreenName'))
        expect(userInfoCalls[0]?.headers['x-guest-token']).toBe('gt1')
        expect(userInfoCalls[1]?.headers['x-guest-token']).toBe('gt2')
        // Default bearer is the static web token (no consumer env in test).
        expect(String(calls.find((call) => call.url.includes('guest/activate'))?.headers.authorization)).toStartWith(
            'Bearer ',
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('XApiClient honors X_GUEST_TOKEN override without minting', async () => {
    const originalFetch = globalThis.fetch
    const originalOverride = process.env.X_GUEST_TOKEN
    let fetchCalls = 0
    globalThis.fetch = (async () => {
        fetchCalls += 1
        throw new Error('must not fetch')
    }) as any
    process.env.X_GUEST_TOKEN = 'env-override-token'
    try {
        const client = new X.XApiClient()
        expect(await client.resolveGuestToken()).toBe('env-override-token')
        expect(fetchCalls).toBe(0)
    } finally {
        globalThis.fetch = originalFetch
        if (originalOverride === undefined) {
            delete process.env.X_GUEST_TOKEN
        } else {
            process.env.X_GUEST_TOKEN = originalOverride
        }
    }
})

test('XApiClient mints an app-style bearer via oauth2/token when consumer env is set', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.X_CONSUMER_KEY
    const originalSecret = process.env.X_CONSUMER_SECRET
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = []
    globalThis.fetch = (async (url: any, init: any) => {
        const target = String(url)
        calls.push({ url: target, headers: (init?.headers || {}) as Record<string, string>, body: init?.body })
        if (target.includes('oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'app-bearer-token' }), { status: 200 })
        }
        if (target.includes('guest/activate')) {
            return new Response(JSON.stringify({ guest_token: 'gt-app' }), { status: 200 })
        }
        throw new Error(`unexpected fetch in test: ${target}`)
    }) as any
    process.env.X_CONSUMER_KEY = 'dummy-key'
    process.env.X_CONSUMER_SECRET = 'dummy-secret'
    try {
        const client = new X.XApiClient()
        expect(await client.resolveGuestToken()).toBe('gt-app')
        const oauthCall = calls.find((call) => call.url.includes('oauth2/token'))
        expect(oauthCall?.headers.authorization).toBe(`Basic ${Buffer.from('dummy-key:dummy-secret').toString('base64')}`)
        expect(oauthCall?.body).toBe('grant_type=client_credentials')
        const activateCall = calls.find((call) => call.url.includes('guest/activate'))
        expect(activateCall?.headers.authorization).toBe('Bearer app-bearer-token')
    } finally {
        globalThis.fetch = originalFetch
        if (originalKey === undefined) {
            delete process.env.X_CONSUMER_KEY
        } else {
            process.env.X_CONSUMER_KEY = originalKey
        }
        if (originalSecret === undefined) {
            delete process.env.X_CONSUMER_SECRET
        } else {
            process.env.X_CONSUMER_SECRET = originalSecret
        }
    }
})
