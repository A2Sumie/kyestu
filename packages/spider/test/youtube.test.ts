import dayjs from 'dayjs'
import { test, expect } from 'bun:test'
import { spiderRegistry } from '../src'
import { ArticleTypeEnum, YoutubeApiJsonParser, YoutubeSpider } from '../src/spiders/youtube'
import { HTTPClient, SimpleExpiringCache } from '../src/utils'

const channelHeaderFixture = {
    c4TabbedHeaderRenderer: {
        title: 'Anime English Club',
        channelHandleText: {
            runs: [{ text: '@anime-english-club' }],
        },
        avatar: {
            thumbnails: [
                { url: '//yt3.example.com/s48.jpg', width: 48 },
                { url: '//yt3.example.com/s176.jpg', width: 176 },
            ],
        },
    },
}

const officialChannelHeaderFixture = {
    c4TabbedHeaderRenderer: {
        title: '22/7 OFFICIAL YouTube CHANNEL',
        channelHandleText: {
            runs: [{ text: '@227SMEJ' }],
        },
        avatar: {
            thumbnails: [
                { url: '//yt3.example.com/s48-official.jpg', width: 48 },
                { url: '//yt3.example.com/s176-official.jpg', width: 176 },
            ],
        },
    },
}

const videosFixture = {
    header: channelHeaderFixture,
    richGridRenderer: {
        contents: [
            {
                richItemRenderer: {
                    content: {
                        videoRenderer: {
                            videoId: 'bBRUMp_WNUU',
                            title: {
                                runs: [{ text: 'New music video' }],
                            },
                            descriptionSnippet: {
                                runs: [{ text: 'Official upload' }],
                            },
                            publishedTimeText: {
                                simpleText: '4 days ago',
                            },
                            thumbnail: {
                                thumbnails: [{ url: 'https://i.ytimg.com/vi/bBRUMp_WNUU/hqdefault.jpg', width: 480 }],
                            },
                        },
                    },
                },
            },
        ],
    },
}

const lockupVideosFixture = {
    header: officialChannelHeaderFixture,
    richGridRenderer: {
        contents: [
            {
                richItemRenderer: {
                    content: {
                        lockupViewModel: {
                            contentId: 'X6J9TphDexM',
                            contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                            contentImage: {
                                thumbnailViewModel: {
                                    image: {
                                        sources: [
                                            { url: 'https://i.ytimg.com/vi/X6J9TphDexM/hqdefault.jpg', width: 168 },
                                            { url: 'https://i.ytimg.com/vi/X6J9TphDexM/hqdefault.jpg', width: 336 },
                                        ],
                                    },
                                },
                            },
                            metadata: {
                                lockupMetadataViewModel: {
                                    title: {
                                        content: '22/7_the 3rd AUDITION DOCUMENTARY -Misaki Kitahara-',
                                    },
                                    metadata: {
                                        contentMetadataViewModel: {
                                            metadataRows: [
                                                {
                                                    metadataParts: [
                                                        { text: { content: '412 views' } },
                                                        {
                                                            text: { content: '46 minutes ago' },
                                                            accessibilityLabel: '46 minutes ago',
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    },
                                },
                            },
                            rendererContext: {
                                commandContext: {
                                    onTap: {
                                        innertubeCommand: {
                                            watchEndpoint: {
                                                videoId: 'X6J9TphDexM',
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        ],
    },
}

const shortsFixture = {
    header: channelHeaderFixture,
    richGridRenderer: {
        contents: [
            {
                richItemRenderer: {
                    content: {
                        shortsLockupViewModel: {
                            entityId: 'shorts-shelf-item-NYnbjoDltqA',
                            overlayMetadata: {
                                primaryText: {
                                    content: 'Behind the scenes short',
                                },
                            },
                            thumbnail: {
                                sources: [{ url: 'https://i.ytimg.com/vi/NYnbjoDltqA/oar2.jpg', width: 720 }],
                            },
                            onTap: {
                                innertubeCommand: {
                                    reelWatchEndpoint: {
                                        videoId: 'NYnbjoDltqA',
                                    },
                                },
                            },
                        },
                    },
                },
            },
        ],
    },
}

function buildYoutubeInitialData(json: any) {
    return `<script>var ytInitialData = ${JSON.stringify(json)};</script>`
}

function buildYoutubeDetailHtml(videoId: string) {
    return `<script>var ytInitialPlayerResponse = ${JSON.stringify({
        videoDetails: {
            title: `Hydrated ${videoId}`,
            shortDescription: `Detail for ${videoId}`,
            thumbnail: {
                thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1280 }],
            },
        },
        microformat: {
            playerMicroformatRenderer: {
                publishDate: '2026-03-17',
                uploadDate: '2026-03-17',
            },
        },
    })};</script>`
}

function buildYoutubePage() {
    return {
        cookies: async () => [],
        browserContext: () => ({
            cookies: async () => [],
        }),
    } as any
}

test('YouTube Spider URL Validation supports hyphenated handles', () => {
    const url = 'https://www.youtube.com/@anime-english-club'
    const plugin = spiderRegistry.findByUrl(url)

    expect(plugin).not.toBeNull()
    expect(plugin?.id).toBe('youtube')

    if (plugin) {
        const spider = plugin.create()
        const match = spider._match_valid_url(url, YoutubeSpider)
        expect(match?.groups?.id).toBe('anime-english-club')
    }
})

test('YouTube videos parser extracts channel videos', () => {
    const channelMeta = YoutubeApiJsonParser.channelMetaParser(videosFixture, '@fallback')
    const videos = YoutubeApiJsonParser.videosParser(videosFixture, channelMeta)

    expect(videos).toHaveLength(1)
    expect(videos[0]?.type).toBe(ArticleTypeEnum.VIDEO)
    expect(videos[0]?.u_id).toBe('anime-english-club')
    expect(videos[0]?.username).toBe('Anime English Club')
    expect(videos[0]?.url).toBe('https://www.youtube.com/watch?v=bBRUMp_WNUU')
    expect(videos[0]?.media?.[0]).toEqual({
        type: 'video_thumbnail',
        url: 'https://i.ytimg.com/vi/bBRUMp_WNUU/hqdefault.jpg',
    })
})

test('YouTube videos parser extracts current lockup view model videos', () => {
    const channelMeta = YoutubeApiJsonParser.channelMetaParser(lockupVideosFixture, '@fallback')
    const videos = YoutubeApiJsonParser.videosParser(lockupVideosFixture, channelMeta)

    expect(videos).toHaveLength(1)
    expect(videos[0]?.type).toBe(ArticleTypeEnum.VIDEO)
    expect(videos[0]?.a_id).toBe('X6J9TphDexM')
    expect(videos[0]?.u_id).toBe('227SMEJ')
    expect(videos[0]?.username).toBe('22/7 OFFICIAL YouTube CHANNEL')
    expect(videos[0]?.url).toBe('https://www.youtube.com/watch?v=X6J9TphDexM')
    expect(videos[0]?.content).toBe('22/7_the 3rd AUDITION DOCUMENTARY -Misaki Kitahara-')
    expect(videos[0]?.created_at).toBeGreaterThan(0)
    expect(videos[0]?.media?.[0]).toEqual({
        type: 'video_thumbnail',
        url: 'https://i.ytimg.com/vi/X6J9TphDexM/hqdefault.jpg',
    })
})

test('YouTube videos parser marks members-only lockups', () => {
    const fixture = structuredClone(lockupVideosFixture)
    const lockup = fixture.richGridRenderer.contents[0]!.richItemRenderer.content.lockupViewModel
    lockup.contentId = 'members-only-video'
    lockup.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows.push({
        badges: [{ badgeViewModel: { badgeText: 'Members only', badgeStyle: 'BADGE_MEMBERS_ONLY' } }],
    } as any)

    const channelMeta = YoutubeApiJsonParser.channelMetaParser(fixture, '@fallback')
    const videos = YoutubeApiJsonParser.videosParser(fixture, channelMeta)

    expect(videos).toHaveLength(1)
    expect(videos[0]?.a_id).toBe('members-only-video')
    expect(videos[0]?.extra).toEqual({ data: { members_only: true } })
})

test('YouTube shorts parser extracts channel shorts', () => {
    const channelMeta = YoutubeApiJsonParser.channelMetaParser(shortsFixture, '@fallback')
    const shorts = YoutubeApiJsonParser.shortsParser(shortsFixture, channelMeta)

    expect(shorts).toHaveLength(1)
    expect(shorts[0]?.type).toBe(ArticleTypeEnum.SHORTS)
    expect(shorts[0]?.url).toBe('https://www.youtube.com/shorts/NYnbjoDltqA')
    expect(shorts[0]?.content).toBe('Behind the scenes short')
    expect(shorts[0]?.media?.[0]?.type).toBe('video_thumbnail')
})

test('YouTube detail parser extracts publish date and metadata', () => {
    const detailHtml = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
        videoDetails: {
            title: 'Fresh upload',
            shortDescription: 'A brand new clip',
            thumbnail: {
                thumbnails: [{ url: 'https://i.ytimg.com/vi/bBRUMp_WNUU/maxresdefault.jpg', width: 1280 }],
            },
        },
        microformat: {
            playerMicroformatRenderer: {
                publishDate: '2026-03-17',
                uploadDate: '2026-03-17',
                thumbnail: {
                    thumbnails: [{ url: 'https://i.ytimg.com/vi/bBRUMp_WNUU/hqdefault.jpg', width: 480 }],
                },
            },
        },
    })};</script>`

    const detail = YoutubeApiJsonParser.detailParser(detailHtml)

    expect(detail.created_at).toBe(dayjs('2026-03-17').unix())
    expect(detail.title).toBe('Fresh upload')
    expect(detail.description).toBe('A brand new clip')
    expect(detail.thumbnail).toBe('https://i.ytimg.com/vi/bBRUMp_WNUU/hqdefault.jpg')
})

test('YouTube detailParser tolerates malformed ytInitialPlayerResponse assignment', () => {
    const detailHtml = `<script>var ytInitialPlayerResponse = {broken-json;</script>`
    expect(() => YoutubeApiJsonParser.detailParser(detailHtml)).not.toThrow()
})

test('YouTube grabArticles bounds detail hydration to the newest configured limit', async () => {
    const originalDownload = HTTPClient.download_webpage
    const requestedUrls: Array<string> = []
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        requestedUrls.push(url)
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(videosFixture))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData(shortsFixture))
        }
        const videoId = new URL(url).searchParams.get('v') || url.split('/').pop() || 'unknown'
        return new Response(buildYoutubeDetailHtml(videoId))
    }

    try {
        const articles = await YoutubeApiJsonParser.grabArticles(
            buildYoutubePage(),
            'https://www.youtube.com/@anime-english-club',
            {
                hydrate_limit: 1,
                hydrate_concurrency: 1,
            },
        )

        const detailRequests = requestedUrls.filter((url) => url.includes('/watch?') || url.includes('/shorts/'))
        expect(detailRequests).toHaveLength(1)
        expect(articles).toHaveLength(2)
        expect(articles.some((article) => article.content?.startsWith('Hydrated '))).toBeTrue()
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles prioritizes time-less shorts for detail hydration', async () => {
    const originalDownload = HTTPClient.download_webpage
    const detailRequests: Array<string> = []
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(videosFixture))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData(shortsFixture))
        }
        detailRequests.push(url)
        return new Response(buildYoutubeDetailHtml(url.split('/').pop() || 'x'))
    }

    try {
        const articles = await YoutubeApiJsonParser.grabArticles(
            buildYoutubePage(),
            'https://www.youtube.com/@anime-english-club',
            {
                hydrate_limit: 1,
                hydrate_concurrency: 1,
            },
        )

        expect(detailRequests).toHaveLength(1)
        expect(detailRequests[0]).toContain('/shorts/')
        const shorts = articles.find((article) => article.type === ArticleTypeEnum.SHORTS)
        expect(shorts?.content?.startsWith('Hydrated ')).toBeTrue()
        expect(shorts?.created_at).toBeGreaterThan(0)
        const video = articles.find((article) => article.type === ArticleTypeEnum.VIDEO)
        expect(video?.content?.startsWith('Hydrated ')).toBeFalse()
        expect(video?.created_at).toBeGreaterThan(0)
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube detail parser marks upcoming premieres and scheduled start', () => {
    const detailHtml = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
        playabilityStatus: {
            status: 'LIVE_STREAM_OFFLINE',
        },
        videoDetails: {
            title: 'Coming Soon...',
            isUpcoming: true,
            shortDescription: '',
            thumbnail: {
                thumbnails: [{ url: 'https://i.ytimg.com/vi/premiere/maxresdefault.jpg', width: 1280 }],
            },
        },
        microformat: {
            playerMicroformatRenderer: {
                liveBroadcastDetails: {
                    startTimestamp: '2026-07-08T11:55:00Z',
                },
            },
        },
    })};</script>`

    const detail = YoutubeApiJsonParser.detailParser(detailHtml)

    expect(detail.is_premiere_pending).toBeTrue()
    expect(detail.scheduled_start_at).toBe(dayjs('2026-07-08T11:55:00Z').unix())
    expect(detail.created_at).toBe(dayjs('2026-07-08T11:55:00Z').unix())
})

test('YouTube grabArticles rehydrates known premiere placeholders', async () => {
    const originalDownload = HTTPClient.download_webpage
    const requestedUrls: Array<string> = []
    const premiereVideos = {
        header: officialChannelHeaderFixture,
        richGridRenderer: {
            contents: [
                {
                    richItemRenderer: {
                        content: {
                            videoRenderer: {
                                videoId: 'premiere-known',
                                title: { runs: [{ text: 'Coming Soon...' }] },
                                publishedTimeText: { simpleText: 'Upcoming' },
                                thumbnail: {
                                    thumbnails: [
                                        { url: 'https://i.ytimg.com/vi/premiere-known/hqdefault.jpg', width: 480 },
                                    ],
                                },
                            },
                        },
                    },
                },
            ],
        },
    }
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        requestedUrls.push(url)
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(premiereVideos))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData({ header: officialChannelHeaderFixture }))
        }
        return new Response(buildYoutubeDetailHtml('premiere-known'))
    }

    try {
        const articles = await YoutubeApiJsonParser.grabArticles(
            buildYoutubePage(),
            'https://www.youtube.com/@227SMEJ',
            {
                hydrate_limit: 8,
                hydrate_concurrency: 1,
                isArticleKnown: (a_id) => a_id === 'premiere-known',
            },
        )

        expect(requestedUrls.some((url) => url.includes('/watch?') && url.includes('premiere-known'))).toBeTrue()
        expect(articles.find((article) => article.a_id === 'premiere-known')?.content).toContain(
            'Hydrated premiere-known',
        )
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles rehydrates stored-pending premieres with real titles and marks resolution', async () => {
    const originalDownload = HTTPClient.download_webpage
    const requestedUrls: Array<string> = []
    const realTitleVideos = {
        header: officialChannelHeaderFixture,
        richGridRenderer: {
            contents: [
                {
                    richItemRenderer: {
                        content: {
                            videoRenderer: {
                                videoId: 'premiere-real-title',
                                title: { runs: [{ text: '【MV】Real Title' }] },
                                publishedTimeText: { simpleText: 'Upcoming' },
                                thumbnail: {
                                    thumbnails: [
                                        { url: 'https://i.ytimg.com/vi/premiere-real-title/hqdefault.jpg', width: 480 },
                                    ],
                                },
                            },
                        },
                    },
                },
            ],
        },
    }
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        requestedUrls.push(url)
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(realTitleVideos))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData({ header: officialChannelHeaderFixture }))
        }
        return new Response(buildYoutubeDetailHtml('premiere-real-title'))
    }

    try {
        const articles = await YoutubeApiJsonParser.grabArticles(
            buildYoutubePage(),
            'https://www.youtube.com/@227SMEJ',
            {
                hydrate_limit: 8,
                hydrate_concurrency: 1,
                isArticleKnown: () => true,
                isStoredPremierePending: (a_id) => a_id === 'premiere-real-title',
            },
        )

        // A real-titled list item must still be re-hydrated when the stored row is pending...
        expect(requestedUrls.some((url) => url.includes('/watch?') && url.includes('premiere-real-title'))).toBeTrue()
        const premiere = articles.find((article) => article.a_id === 'premiere-real-title')
        expect(premiere?.content).toContain('Hydrated premiere-real-title')
        // ...and a resolved detail page produces an explicit pending:false marker.
        expect((premiere?.extra as any)?.data?.premiere?.pending).toBe(false)
        expect((premiere?.extra as any)?.data?.premiere?.resolved_at).toBeGreaterThan(0)
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles keeps stored-pending premieres pending when detail still upcoming', async () => {
    const originalDownload = HTTPClient.download_webpage
    const realTitleVideos = {
        header: officialChannelHeaderFixture,
        richGridRenderer: {
            contents: [
                {
                    richItemRenderer: {
                        content: {
                            videoRenderer: {
                                videoId: 'premiere-still-upcoming',
                                title: { runs: [{ text: '【MV】Still Upcoming' }] },
                                publishedTimeText: { simpleText: 'Upcoming' },
                                thumbnail: {
                                    thumbnails: [
                                        {
                                            url: 'https://i.ytimg.com/vi/premiere-still-upcoming/hqdefault.jpg',
                                            width: 480,
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            ],
        },
    }
    const upcomingDetailHtml = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
        playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' },
        videoDetails: {
            title: '【MV】Still Upcoming',
            isUpcoming: true,
            shortDescription: '',
            thumbnail: {
                thumbnails: [{ url: 'https://i.ytimg.com/vi/premiere-still-upcoming/maxresdefault.jpg', width: 1280 }],
            },
        },
        microformat: {
            playerMicroformatRenderer: {
                liveBroadcastDetails: { startTimestamp: '2026-07-20T11:55:00Z' },
            },
        },
    })};</script>`
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(realTitleVideos))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData({ header: officialChannelHeaderFixture }))
        }
        return new Response(upcomingDetailHtml)
    }

    try {
        const articles = await YoutubeApiJsonParser.grabArticles(
            buildYoutubePage(),
            'https://www.youtube.com/@227SMEJ',
            {
                hydrate_limit: 8,
                hydrate_concurrency: 1,
                isArticleKnown: () => true,
                isStoredPremierePending: () => true,
            },
        )

        const premiere = articles.find((article) => article.a_id === 'premiere-still-upcoming')
        expect((premiere?.extra as any)?.data?.premiere?.pending).toBe(true)
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles skips detail hydration for already-known articles', async () => {
    const originalDownload = HTTPClient.download_webpage
    const requestedUrls: Array<string> = []
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        requestedUrls.push(url)
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(videosFixture))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData(shortsFixture))
        }
        const videoId = new URL(url).searchParams.get('v') || url.split('/').pop() || 'unknown'
        return new Response(buildYoutubeDetailHtml(videoId))
    }

    try {
        await YoutubeApiJsonParser.grabArticles(buildYoutubePage(), 'https://www.youtube.com/@anime-english-club', {
            hydrate_limit: 8,
            hydrate_concurrency: 2,
            isArticleKnown: (a_id) => a_id === 'bBRUMp_WNUU',
        })

        const detailRequests = requestedUrls.filter((url) => url.includes('/watch?') || url.includes('/shorts/'))
        expect(detailRequests).toHaveLength(1)
        expect(detailRequests[0]).toContain('/shorts/NYnbjoDltqA')
        expect(detailRequests[0]).not.toContain('bBRUMp_WNUU')
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles throttles stored-pending premiere detail rechecks to a TTL', async () => {
    const originalDownload = HTTPClient.download_webpage
    const requestedUrls: Array<string> = []
    const realTitleVideos = {
        header: officialChannelHeaderFixture,
        richGridRenderer: {
            contents: [
                {
                    richItemRenderer: {
                        content: {
                            videoRenderer: {
                                videoId: 'premiere-ttl',
                                title: { runs: [{ text: '【MV】TTL Premiere' }] },
                                publishedTimeText: { simpleText: 'Upcoming' },
                                thumbnail: {
                                    thumbnails: [
                                        { url: 'https://i.ytimg.com/vi/premiere-ttl/hqdefault.jpg', width: 480 },
                                    ],
                                },
                            },
                        },
                    },
                },
            ],
        },
    }
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        requestedUrls.push(url)
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(realTitleVideos))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData({ header: officialChannelHeaderFixture }))
        }
        return new Response(buildYoutubeDetailHtml('premiere-ttl'))
    }

    const cache = new SimpleExpiringCache()
    const options = {
        hydrate_limit: 8,
        hydrate_concurrency: 1,
        isStoredPremierePending: () => true,
        isArticleKnown: () => true,
        cache,
    }
    const countPremiereDetailFetches = () =>
        requestedUrls.filter((url) => url.includes('premiere-ttl') && url.includes('/watch?')).length

    try {
        await YoutubeApiJsonParser.grabArticles(buildYoutubePage(), 'https://www.youtube.com/@227SMEJ', options)
        expect(countPremiereDetailFetches()).toBe(1)

        // A second round within the TTL must not re-fetch the pending premiere.
        await YoutubeApiJsonParser.grabArticles(buildYoutubePage(), 'https://www.youtube.com/@227SMEJ', options)
        expect(countPremiereDetailFetches()).toBe(1)

        // After the TTL expires the premiere is re-checked.
        cache.set('yt:premiere-check:premiere-ttl', Math.floor(Date.now() / 1000) - 601, 1)
        await YoutubeApiJsonParser.grabArticles(buildYoutubePage(), 'https://www.youtube.com/@227SMEJ', options)
        expect(countPremiereDetailFetches()).toBe(2)
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles serves known + premiere state from a single merged lookup', async () => {
    const originalDownload = HTTPClient.download_webpage
    const lookupCalls: Array<string> = []
    const isArticleKnownCalls: Array<string> = []
    const realTitleVideos = {
        header: officialChannelHeaderFixture,
        richGridRenderer: {
            contents: [
                {
                    richItemRenderer: {
                        content: {
                            videoRenderer: {
                                videoId: 'merged-lookup',
                                title: { runs: [{ text: '【MV】Merged' }] },
                                publishedTimeText: { simpleText: 'Upcoming' },
                                thumbnail: {
                                    thumbnails: [
                                        { url: 'https://i.ytimg.com/vi/merged-lookup/hqdefault.jpg', width: 480 },
                                    ],
                                },
                            },
                        },
                    },
                },
            ],
        },
    }
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        if (url.includes('/videos?')) {
            return new Response(buildYoutubeInitialData(realTitleVideos))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData({ header: officialChannelHeaderFixture }))
        }
        return new Response(buildYoutubeDetailHtml('merged-lookup'))
    }

    try {
        await YoutubeApiJsonParser.grabArticles(buildYoutubePage(), 'https://www.youtube.com/@227SMEJ', {
            hydrate_limit: 8,
            hydrate_concurrency: 1,
            articleStateLookup: async (a_id) => {
                lookupCalls.push(a_id)
                return { known: true, storedPremierePending: true }
            },
            isArticleKnown: (a_id) => {
                isArticleKnownCalls.push(a_id)
                return true
            },
        })

        expect(lookupCalls).toContain('merged-lookup')
        expect(isArticleKnownCalls).toEqual([])
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})

test('YouTube grabArticles retries a transient list fetch once before failing', async () => {
    const originalDownload = HTTPClient.download_webpage
    const calls: Array<string> = []
    ;(HTTPClient as any).download_webpage = async (url: string) => {
        calls.push(url)
        if (url.includes('/videos?')) {
            if (calls.filter((entry) => entry.includes('/videos?')).length < 2) {
                throw new Error('socket hang up')
            }
            return new Response(buildYoutubeInitialData(videosFixture))
        }
        if (url.includes('/shorts?')) {
            return new Response(buildYoutubeInitialData(shortsFixture))
        }
        const videoId = new URL(url).searchParams.get('v') || url.split('/').pop() || 'unknown'
        return new Response(buildYoutubeDetailHtml(videoId))
    }

    try {
        const articles = await YoutubeApiJsonParser.grabArticles(
            buildYoutubePage(),
            'https://www.youtube.com/@anime-english-club',
            {
                hydrate_limit: 8,
            },
        )
        expect(articles.length).toBeGreaterThan(0)
        expect(calls.filter((entry) => entry.includes('/videos?')).length).toBe(2)
    } finally {
        ;(HTTPClient as any).download_webpage = originalDownload
    }
})
