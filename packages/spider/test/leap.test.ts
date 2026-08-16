import { expect, test } from 'bun:test'
import { LeapProjectsSpider, buildLeapArticle, type LeapFeedConfig } from '../src/spiders/leap'

const NEWS_CONFIG: LeapFeedConfig = {
    feed: 'leap-news',
    u_id: 'leap:news',
    label: 'LEAP! Information',
    tab: 'news',
}

const SCHEDULE_CONFIG: LeapFeedConfig = {
    feed: 'leap-schedule',
    u_id: 'leap:schedule',
    label: 'LEAP! Schedule',
    tab: 'schedule',
}

test('LeapProjectsSpider resolves news feed from the information list', () => {
    expect(LeapProjectsSpider.resolveFeed('https://leap-projects.jp/idol/information/')?.feed).toBe('leap-news')
    expect(LeapProjectsSpider.extractBasicInfo('https://leap-projects.jp/idol/information/')?.u_id).toBe('leap:news')
})

test('LeapProjectsSpider resolves the schedule feed from the #schedule fragment', () => {
    expect(LeapProjectsSpider.resolveFeed('https://leap-projects.jp/idol/information/#schedule')?.feed).toBe(
        'leap-schedule',
    )
    expect(LeapProjectsSpider.extractBasicInfo('https://leap-projects.jp/idol/information/#schedule')?.u_id).toBe(
        'leap:schedule',
    )
})

test('LeapProjectsSpider rejects foreign hosts and paths', () => {
    expect(LeapProjectsSpider.resolveFeed('https://leap-projects.jp/other/')).toBeNull()
    expect(LeapProjectsSpider.resolveFeed('https://example.com/idol/information/')).toBeNull()
})

test('buildLeapArticle emits website_meta with category and explicit Japanese date', () => {
    const article = buildLeapArticle(
        SCHEDULE_CONFIG,
        'https://leap-projects.jp/idol/information/zeppin-disco-vol-6/',
        {
            detailUrl: 'https://leap-projects.jp/idol/information/zeppin-disco-vol-6/',
            title: '8月8日 ZEPPIN DISCO Vol.6',
            dateText: '2026年8月8日',
            category: 'EVENT',
        },
        {
            title: '8月8日 ZEPPIN DISCO Vol.6',
            dateText: '2026年8月8日',
            category: 'EVENT',
            bodyText: '8月8日に開催されるZEPPIN DISCO Vol.6の情報です。',
            bodyHtml: '<p>8月8日に開催されるZEPPIN DISCO Vol.6の情報です。</p>',
            media: [],
        },
    )

    expect(article).toMatchObject({
        platform: 5,
        a_id: 'zeppin-disco-vol-6',
        u_id: 'leap:schedule',
        username: 'LEAP! Schedule',
        type: 'article',
        url: 'https://leap-projects.jp/idol/information/zeppin-disco-vol-6/',
    })
    expect(article.content).toContain('【8月8日 ZEPPIN DISCO Vol.6】')
    expect((article.extra as any).data).toMatchObject({
        site: 'LEAP!',
        host: 'leap-projects.jp',
        feed: 'leap-schedule',
        category: 'EVENT',
        time_source: 'explicit',
        date_text: '2026年8月8日',
    })
    expect(new Date((article.extra as any).data.crawled_at * 1000).getFullYear()).toBeGreaterThan(2025)
})

test('buildLeapArticle parses date ranges and marks same-day posts as estimated publish', () => {
    const now = Math.floor(Date.now() / 1000)
    const today = new Date(now * 1000)
    const todayText = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`

    const article = buildLeapArticle(
        NEWS_CONFIG,
        'https://leap-projects.jp/idol/information/range-post/',
        {
            detailUrl: 'https://leap-projects.jp/idol/information/range-post/',
            title: '4月29日‐5月10日【肉フェス 2026】',
            dateText: `${todayText}〜5月10日`,
            category: 'EVENT',
        },
        {
            title: '4月29日‐5月10日【肉フェス 2026】',
            dateText: `${todayText}〜5月10日`,
            category: 'EVENT',
            bodyText: '本文',
            bodyHtml: '<p>本文</p>',
            media: [],
        },
    )

    expect((article.extra as any).data.time_source).toBe('estimated_publish')
    expect(article.created_at).toBeGreaterThan(0)
})
