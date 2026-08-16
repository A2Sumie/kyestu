import { expect, test } from 'bun:test'
import { Platform } from '@kyestu/spider/types'
import {
    formatArticleAttributionLine,
    formatArticleHeaderLine,
    formatArticlePlainTimeToken,
    formatArticleTimeToken,
    formatTranslationPassthrough,
    formatWebsiteCardText,
    PASSTHROUGH_CARD_DEFERRED_MARKER,
} from '../src/text'
import type { Article } from '../src/types'

const IORI_TS = Math.floor(Date.UTC(2026, 6, 20, 6, 56, 0) / 1000)

function xArticle(type: string): Article {
    return {
        platform: Platform.X,
        a_id: `x-${type}`,
        u_id: 'minami__iori',
        username: '南伊織【22/7】',
        created_at: IORI_TS,
        content: '',
        url: 'https://x.com/minami__iori/status/1',
        type,
        ref: null,
        has_media: false,
        media: [],
        extra: null,
        u_avatar: null,
    }
}

function websiteArticle(timeSource: string): Article {
    return {
        platform: Platform.Website,
        a_id: `website-${timeSource}`,
        u_id: '22/7:official-news',
        username: '22/7 Official News',
        created_at: 1710000000,
        content: 'Website body',
        url: 'https://nanabunnonijyuuni-mobile.com/s/n110/news/detail/1',
        type: 'article',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'website_meta',
            data: {
                site: '22/7',
                feed: 'official-news',
                time_source: timeSource,
            },
        },
        u_avatar: null,
    }
}

test('compact article time uses explicit positive timezone and subscript YY', () => {
    const timestamp = Math.floor(Date.UTC(2026, 7, 3, 8, 5, 0) / 1000)
    expect(formatArticleTimeToken(timestamp)).toBe('1705⁺⁹(0803₂₆)')
})

test('lower metadata time uses plain timezone and year digits', () => {
    const timestamp = Math.floor(Date.UTC(2026, 7, 3, 8, 5, 0) / 1000)
    expect(formatArticlePlainTimeToken(timestamp)).toBe('1705+9(0803_26)')
})

test('website photo card text keeps the body out and adds the photo badge', () => {
    const article = {
        ...websiteArticle('published'),
        a_id: 'photo:album:photoga:35054',
        u_id: '22/7:photo',
        username: '22/7 Photo',
        content: '【说到夏天！】\n\n【相川奈央】\n一到夏天，相川就会变蓝。',
        url: 'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga',
        extra: {
            extra_type: 'website_meta' as const,
            data: {
                site: '22/7',
                feed: 'photo',
                title: '说到夏天！',
            },
        },
    }

    expect(formatWebsiteCardText(article)).toBe(
        [
            '【22/7 PHOTO📷】说到夏天！',
            '',
            '22/7官网 PHOTO 0100⁺⁹（240310）',
            'https://nanabunnonijyuuni-mobile.com/s/n110/gallery?ct=photoga',
        ].join('\n'),
    )
    expect(formatWebsiteCardText(article)).not.toContain('一到夏天')
})

test('website estimated publish time is marked as EST in render metadata', () => {
    const article = websiteArticle('estimated_publish')

    expect(formatArticleHeaderLine(article)).toContain('0100 EST.')
    expect(formatArticleAttributionLine(article)).toContain('0100 EST.')
})

test('website crawl-observed time says it is a crawl timestamp', () => {
    const article = websiteArticle('crawl_observed')

    expect(formatArticleHeaderLine(article)).toContain('抓取于 0100⁺⁹')
    expect(formatArticleAttributionLine(article)).toContain('抓取于 0100⁺⁹（240310）')
})

test('translation passthrough uses the title/body/blank/attribution layout', () => {
    const article = xArticle('tweet')
    const text = formatTranslationPassthrough(article, '刚才比平时更kururun（轻飘飘开心）呢。注意到的人请举手！')

    expect(text).toBe(
        [
            '南伊織【22/7】 1556⁺⁹(0720₂₆) X',
            '刚才比平时更kururun（轻飘飘开心）呢。注意到的人请举手！',
            '',
            '@minami__iori 南伊織【22/7】 1556+9(0720_26) X发推',
        ].join('\n'),
    )
})

test('translation passthrough title separates the name from the compact time token', () => {
    const text = formatTranslationPassthrough(xArticle('tweet'), '译文')
    expect(text.split('\n')[0]).toBe('南伊織【22/7】 1556⁺⁹(0720₂₆) X')
    expect(text.split('\n').at(-1)).toBe('@minami__iori 南伊織【22/7】 1556+9(0720_26) X发推')
})

test('translation passthrough appends the card marker when the first layer has body and a ref', () => {
    const article = {
        ...xArticle('retweet'),
        ref: { ...xArticle('tweet'), u_id: 'someone_else', username: 'Someone Else' },
    }
    const text = formatTranslationPassthrough(article, '第一层评论')

    expect(text).toBe(
        [
            '南伊織【22/7】 1556⁺⁹(0720₂₆) X',
            '第一层评论',
            '',
            PASSTHROUGH_CARD_DEFERRED_MARKER,
            '',
            '@minami__iori 南伊織【22/7】 1556+9(0720_26) X转推',
        ].join('\n'),
    )
    expect(text).toContain('余下见卡片')
})

test('translation passthrough without a ref keeps the plain title/body/attribution layout', () => {
    const text = formatTranslationPassthrough(xArticle('tweet'), '译文')
    expect(text).not.toContain('余下见卡片')
    expect(text).toBe(
        ['南伊織【22/7】 1556⁺⁹(0720₂₆) X', '译文', '', '@minami__iori 南伊織【22/7】 1556+9(0720_26) X发推'].join('\n'),
    )
})

test('translation passthrough returns attribution only when the first layer has no body', () => {
    const article = {
        ...xArticle('retweet'),
        ref: { ...xArticle('tweet'), u_id: 'someone_else', username: 'Someone Else' },
    }
    const text = formatTranslationPassthrough(article, '')

    expect(text).toBe('@minami__iori 南伊織【22/7】 1556+9(0720_26) X转推')
    expect(text).not.toContain('余下见卡片')
})

test('translation passthrough drops a redundant @handle when it equals the display name', () => {
    const article = { ...xArticle('tweet'), username: 'minami__iori' }
    const text = formatTranslationPassthrough(article, '译文')
    const lines = text.split('\n')
    expect(lines[0]).toBe('minami__iori 1556⁺⁹(0720₂₆) X')
    expect(lines.at(-1)).toBe('@minami__iori 1556+9(0720_26) X发推')
})
