import { describe, expect, test } from 'bun:test'
import dayjs from 'dayjs'
import {
    buildPhotoAlbumArticle,
    buildWebsiteArticle,
    isWebsiteAuthGateSnapshot,
    NanabunnonijyuuniWebsiteSpider,
    resolveWebsiteCrawlOptions,
    resolveWebsiteFeedResourceBlocking,
    splitPhotoAlbumPayloadByDate,
    type FeedConfig,
} from '../src/spiders/website'

describe('NanabunnonijyuuniWebsiteSpider.resolveFeed', () => {
    test('matches supported 22/7 FC and live-report routes', () => {
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/ticket/list?ima=2101',
            )?.feed,
        ).toBe('ticket')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed('https://nanabunnonijyuuni-mobile.com/s/n110/news/list?ima=2148')
                ?.feed,
        ).toBe('official-news')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/news/list?ima=2149&ct=news',
            )?.feed,
        ).toBe('fc-news')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/diary/official_blog/list?ima=2201',
            )?.feed,
        ).toBe('official-blog')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/contents_list?ima=2217&cd=133&ct=radio',
            )?.feed,
        ).toBe('radio')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/diary/nananiji_movie?ima=2246',
            )?.feed,
        ).toBe('movie')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ima=2342&ct=photoga',
            )?.feed,
        ).toBe('photo')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/diary/special/list?ima=2638',
            )?.feed,
        ).toBe('live-report')
    })

    test('treats matching detail urls as their feed family', () => {
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447001?ima=3201',
            )?.feed,
        ).toBe('official-blog')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/contents/6390467233112?ima=3253',
            )?.feed,
        ).toBe('radio')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447178?ima=3255&cd=nananiji_movie',
            )?.feed,
        ).toBe('movie')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447239?ima=3300&cd=special',
            )?.feed,
        ).toBe('live-report')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/gallery/p10053?ima=3257',
            )?.feed,
        ).toBe('photo')
        expect(
            NanabunnonijyuuniWebsiteSpider.resolveFeed(
                'https://nanabunnonijyuuni-mobile.com/s/n110/contents_list?ima=3546&cd=122&ct=member_photo_053',
            )?.feed,
        ).toBe('photo')
    })

    test('extractBasicInfo follows the resolved feed id', () => {
        expect(
            NanabunnonijyuuniWebsiteSpider.extractBasicInfo(
                'https://nanabunnonijyuuni-mobile.com/s/n110/news/list?ima=2149&ct=news',
            )?.u_id,
        ).toBe('22/7:fc-news')
        expect(
            NanabunnonijyuuniWebsiteSpider.extractBasicInfo(
                'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ima=2342&ct=photoga',
            )?.u_id,
        ).toBe('22/7:photo')
    })
})

describe('resolveWebsiteCrawlOptions', () => {
    test('caps website crawl budget for high-frequency shallow scans', () => {
        expect(
            resolveWebsiteCrawlOptions({
                max_list_pages: 1,
                max_detail_count: 6,
                detail_interval_time: {
                    min: 900,
                    max: 2200,
                },
                block_resource_types: ['image', 'font', 'media', 'script', 'unknown-kind'],
            }),
        ).toEqual({
            maxListPages: 1,
            maxDetailCount: 6,
            detailIntervalTime: {
                min: 900,
                max: 2200,
            },
            blockResourceTypes: ['image', 'font', 'media', 'script'],
        })
    })

    test('keeps invalid crawl budget values within safe defaults', () => {
        expect(
            resolveWebsiteCrawlOptions({
                max_list_pages: 99,
                max_detail_count: 0,
                detail_interval_time: {
                    min: -1,
                    max: 100000,
                },
            }),
        ).toMatchObject({
            maxListPages: 3,
            maxDetailCount: 1,
            detailIntervalTime: {
                min: 0,
                max: 60000,
            },
            blockResourceTypes: ['font', 'image', 'media'],
        })
    })
})

describe('resolveWebsiteFeedResourceBlocking', () => {
    test('keeps low-value resource blocking for text/detail feeds', () => {
        expect(resolveWebsiteFeedResourceBlocking('official-news', ['font', 'image', 'media'])).toEqual([
            'font',
            'image',
            'media',
        ])
        expect(resolveWebsiteFeedResourceBlocking('official-blog', ['font', 'image', 'media'])).toEqual([
            'font',
            'image',
            'media',
        ])
        expect(resolveWebsiteFeedResourceBlocking('live-report', ['font', 'image', 'media'])).toEqual([
            'font',
            'image',
            'media',
        ])
        expect(resolveWebsiteFeedResourceBlocking('ticket', ['font', 'image', 'media'])).toEqual([
            'font',
            'image',
            'media',
        ])
    })

    test('narrows media-heavy FC content feeds to font blocking only', () => {
        expect(resolveWebsiteFeedResourceBlocking('radio', ['font', 'image', 'media'])).toEqual(['font'])
        expect(resolveWebsiteFeedResourceBlocking('movie', ['font', 'image', 'media'])).toEqual(['font'])
        expect(resolveWebsiteFeedResourceBlocking('photo', ['font', 'image', 'media'])).toEqual(['font'])
    })
})

describe('isWebsiteAuthGateSnapshot', () => {
    test('detects FC detail pages replaced by the login gate', () => {
        expect(
            isWebsiteAuthGateSnapshot({
                documentTitle: 'ログイン | 22/7ファンクラブ',
                bodyText: '22/7ファンクラブ ログイン または 新規会員登録',
                hasLoginForm: true,
                hasLoginButton: true,
                hasRegistrationLink: true,
                hasDetailContent: false,
            }),
        ).toBe(true)
    })

    test('does not treat normal detail content as auth even when text mentions login', () => {
        expect(
            isWebsiteAuthGateSnapshot({
                documentTitle: 'NEWS | 22/7(ナナブンノニジュウニ)',
                bodyText: 'LINE MUSIC にログインしてキャンペーンに参加してください。',
                hasLoginForm: false,
                hasLoginButton: false,
                hasRegistrationLink: false,
                hasDetailContent: true,
            }),
        ).toBe(false)
    })
})

describe('buildPhotoAlbumArticle', () => {
    test('groups a photoga page into one album article with all media and member notes', () => {
        const article = buildPhotoAlbumArticle(
            {
                feed: 'photo',
                u_id: '22/7:photo',
                label: '22/7 Photo',
            },
            {
                detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga',
                title: '3rd Anniversary',
                dateText: '2026.03.19',
                summary: '3rd Anniversary',
                member: null,
                thumbnail: null,
            },
            {
                currentUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga',
                albumId: 'photoga',
                pageTheme: '3rd Anniversary',
                entries: [
                    {
                        modalId: 'modal-1',
                        dataCode: '35054',
                        detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga#modal-1',
                        title: '3rd Anniversary - 北原実咲',
                        theme: '3rd Anniversary',
                        dateText: '2026.03.19',
                        member: '北原実咲',
                        bodyText: '最初のメッセージ',
                        bodyHtml: '<p>最初のメッセージ</p>',
                        media: [{ type: 'photo', url: 'https://example.com/1.jpg', alt: '北原実咲' }],
                        uAvatar: 'https://example.com/a1.jpg',
                        extraData: {
                            modal_id: 'modal-1',
                            photo_code: '35054',
                        },
                    },
                    {
                        modalId: 'modal-2',
                        dataCode: '35055',
                        detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga#modal-2',
                        title: '3rd Anniversary - 黒崎ありす',
                        theme: '3rd Anniversary',
                        dateText: '2026.03.19',
                        member: '黒崎ありす',
                        bodyText: '次のメッセージ',
                        bodyHtml: '<p>次のメッセージ</p>',
                        media: [{ type: 'photo', url: 'https://example.com/2.jpg', alt: '黒崎ありす' }],
                        uAvatar: 'https://example.com/a2.jpg',
                        extraData: {
                            modal_id: 'modal-2',
                            photo_code: '35055',
                        },
                    },
                ],
            },
        )[0]!

        expect(article.a_id).toBe('photo:album:photoga:35054')
        expect(article.username).toBe('22/7 Photo')
        expect(article.url).toBe('https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga')
        expect(article.has_media).toBe(true)
        expect(article.media?.map((media) => media.url)).toEqual([
            'https://example.com/1.jpg',
            'https://example.com/2.jpg',
        ])
        expect(article.content).toContain('【3rd Anniversary】')
        expect(article.content).toContain('【北原実咲】')
        expect(article.content).toContain('【黒崎ありす】')
        expect(article.extra?.data?.album_id).toBe('photoga')
        expect(article.extra?.data?.members).toEqual(['北原実咲', '黒崎ありす'])
        expect(article.extra?.data?.entries).toHaveLength(2)
    })
})

describe('splitPhotoAlbumPayloadByDate', () => {
    test('keeps FC photo batches separated by posting day', () => {
        const batches = splitPhotoAlbumPayloadByDate({
            currentUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/contents_list?ct=member_photo_052',
            albumId: 'member_photo_052',
            pageTheme: '冬のアイテム',
            entries: [
                {
                    modalId: 'modal-1',
                    dataCode: 'photo260210_a13',
                    detailUrl: 'https://example.com#modal-1',
                    title: '冬のアイテム - 相川奈央',
                    dateText: '2026.02.10',
                    member: '相川奈央',
                    bodyText: '冬の可愛いパジャマ',
                    bodyHtml: '<p>冬の可愛いパジャマ</p>',
                    media: [{ type: 'photo', url: 'https://example.com/1.jpg', alt: '相川奈央' }],
                },
                {
                    modalId: 'modal-2',
                    dataCode: 'photo260210_a14',
                    detailUrl: 'https://example.com#modal-2',
                    title: '冬のアイテム - 麻丘真央',
                    dateText: '2026.02.10',
                    member: '麻丘真央',
                    bodyText: '上下逆さで泳ぐ鯛！',
                    bodyHtml: '<p>上下逆さで泳ぐ鯛！</p>',
                    media: [{ type: 'photo', url: 'https://example.com/2.jpg', alt: '麻丘真央' }],
                },
                {
                    modalId: 'modal-3',
                    dataCode: 'photo260217_a17',
                    detailUrl: 'https://example.com#modal-3',
                    title: '冬のアイテム - 椎名桜月',
                    dateText: '2026.02.17',
                    member: '椎名桜月',
                    bodyText: 'あったかい飲み物',
                    bodyHtml: '<p>あったかい飲み物</p>',
                    media: [{ type: 'photo', url: 'https://example.com/3.jpg', alt: '椎名桜月' }],
                },
            ],
        })

        expect(batches).toHaveLength(2)
        expect(batches[0]?.entries.map((entry) => entry.dataCode)).toEqual(['photo260210_a13', 'photo260210_a14'])
        expect(batches[1]?.entries.map((entry) => entry.dataCode)).toEqual(['photo260217_a17'])

        const articles = batches.flatMap((batch) =>
            buildPhotoAlbumArticle(
                {
                    feed: 'photo',
                    u_id: '22/7:photo',
                    label: '22/7 Photo',
                },
                {
                    detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/contents_list?ct=member_photo_052',
                    title: '冬のアイテム',
                    dateText: '2026.02.17',
                    summary: '冬のアイテム',
                    member: null,
                    thumbnail: null,
                },
                batch,
            ),
        )

        expect(articles).toHaveLength(2)
        expect(articles[0]?.a_id).toBe('photo:album:member_photo_052:photo260210_a13')
        expect(articles[1]?.a_id).toBe('photo:album:member_photo_052:photo260217_a17')
    })
})

describe('buildWebsiteArticle', () => {
    const radioConfig: FeedConfig = {
        feed: 'radio',
        u_id: '22/7:radio',
        label: '22/7 Radio',
    }
    const movieConfig: FeedConfig = {
        feed: 'movie',
        u_id: '22/7:movie',
        label: '22/7 Movie',
    }

    test('keeps radio title and falls back to list cover when detail media is empty', () => {
        const article = buildWebsiteArticle(
            radioConfig,
            'https://nanabunnonijyuuni-mobile.com/s/n110/contents/6390467233112',
            {
                detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/contents/6390467233112',
                title: 'Radio Title',
                dateText: '2026.03.20',
                summary: null,
                member: null,
                thumbnail: 'https://example.com/radio-cover.jpg',
            },
            {
                title: '',
                dateText: '2026.03.20',
                bodyText: 'Radio body',
                bodyHtml: '<p>Radio body</p>',
                member: null,
                media: [],
            },
        )

        expect(article.content).toContain('【Radio Title】')
        expect(article.has_media).toBe(true)
        expect(article.media).toEqual([
            {
                type: 'photo',
                url: 'https://example.com/radio-cover.jpg',
            },
        ])
        expect(article.extra?.data?.title).toBe('Radio Title')
    })

    test('keeps movie title and passes through extracted poster thumbnails', () => {
        const article = buildWebsiteArticle(
            movieConfig,
            'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447178?cd=nananiji_movie',
            {
                detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447178?cd=nananiji_movie',
                title: 'Movie List Title',
                dateText: '2026.03.20',
                summary: null,
                member: null,
                thumbnail: null,
            },
            {
                title: 'Movie Detail Title',
                dateText: '2026.03.20',
                bodyText: '',
                bodyHtml: '',
                member: null,
                media: [
                    {
                        type: 'video_thumbnail',
                        url: 'https://example.com/movie-poster.jpg',
                    },
                ],
            },
        )

        expect(article.content).toContain('【Movie Detail Title】')
        expect(article.has_media).toBe(true)
        expect(article.media).toEqual([
            {
                type: 'video_thumbnail',
                url: 'https://example.com/movie-poster.jpg',
            },
        ])
        expect(article.extra?.data?.title).toBe('Movie Detail Title')
    })

    test('uses current crawl time for same-day website entries that only expose a date', () => {
        const before = dayjs().unix()
        const today = dayjs().format('YYYY.MM.DD')
        const article = buildWebsiteArticle(
            {
                feed: 'live-report',
                u_id: '22/7:live-report',
                label: '22/7 Live Report',
            },
            'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447855?cd=special',
            {
                detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447855?cd=special',
                title: 'Live Report Title',
                dateText: today,
                summary: null,
                member: null,
                thumbnail: null,
            },
            {
                title: 'Live Report Title',
                dateText: today,
                bodyText: 'Live Report Body',
                bodyHtml: '<p>Live Report Body</p>',
                member: null,
                media: [],
            },
        )
        const after = dayjs().unix()

        expect(article.created_at).toBeGreaterThanOrEqual(before - 16 * 60)
        expect(article.created_at).toBeLessThanOrEqual(after + 16 * 60)
        expect(article.extra?.data?.time_source).toBe('estimated_publish')
        expect(article.extra?.data?.crawled_at).toBeGreaterThanOrEqual(before)
        expect(article.extra?.data?.crawled_at).toBeLessThanOrEqual(after)
    })

    test('marks personal website date-only entries as crawl-observed time', () => {
        const before = dayjs().unix()
        const today = dayjs().format('YYYY.MM.DD')
        const article = buildWebsiteArticle(
            {
                feed: 'official-blog',
                u_id: '22/7:official-blog',
                label: '22/7 Official Blog',
            },
            'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447855',
            {
                detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/diary/detail/447855',
                title: 'Blog Title',
                dateText: today,
                summary: null,
                member: 'Member Name',
                thumbnail: null,
            },
            {
                title: 'Blog Title',
                dateText: today,
                bodyText: 'Blog Body',
                bodyHtml: '<p>Blog Body</p>',
                member: 'Member Name',
                media: [],
            },
        )
        const after = dayjs().unix()

        expect(article.extra?.data?.time_source).toBe('crawl_observed')
        expect(article.created_at).toBeGreaterThanOrEqual(before)
        expect(article.created_at).toBeLessThanOrEqual(after)
    })

    test('preserves explicit time from website date text', () => {
        const article = buildWebsiteArticle(
            radioConfig,
            'https://nanabunnonijyuuni-mobile.com/s/n110/contents/6390467233112',
            {
                detailUrl: 'https://nanabunnonijyuuni-mobile.com/s/n110/contents/6390467233112',
                title: 'Radio Title',
                dateText: '2026.03.20 18:15',
                summary: null,
                member: null,
                thumbnail: null,
            },
            {
                title: 'Radio Title',
                dateText: '2026.03.20 18:15',
                bodyText: 'Radio body',
                bodyHtml: '<p>Radio body</p>',
                member: null,
                media: [],
            },
        )

        expect(article.created_at).toBe(dayjs('2026-03-20 18:15').unix())
    })
})
