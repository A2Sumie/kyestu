import { expect, test } from 'bun:test'
import { Platform } from '@kyestu/spider/types'
import {
    CARD_FONT_FAMILY,
    CARD_TRANSLATION_FONT_FAMILY,
    CARD_UI_FONT_FAMILY,
    articleParser,
    estimateTextLinesHeight,
    layoutMediaRows,
    resolve227WebsiteBrandKey,
    sanitizeCardText,
} from '../template/img/DefaultCard'
import { languageFontMap } from '../src/img/utils/font'
import { getIconCode } from '../src/img/utils/twemoji'
import { ImgConverter, isSupportedOpenTypeFont, loadDynamicAsset, resolveSatoriFontLang } from '../src/img'
import satori from 'satori'
import fs from 'fs'

function buildWebsiteArticle(feed: string, site: string = '22/7') {
    return {
        platform: Platform.Website,
        extra: {
            extra_type: 'website_meta',
            data: {
                site,
                feed,
            },
        },
    } as Parameters<typeof resolve227WebsiteBrandKey>[0]
}

function findReactElement(node: any, predicate: (node: any) => boolean): any {
    if (!node) {
        return null
    }
    if (Array.isArray(node)) {
        for (const child of node) {
            const match = findReactElement(child, predicate)
            if (match) {
                return match
            }
        }
        return null
    }
    if (typeof node !== 'object') {
        return null
    }
    if (predicate(node)) {
        return node
    }
    if (typeof node.type === 'function') {
        return findReactElement(node.type(node.props), predicate)
    }
    return findReactElement(node.props?.children, predicate)
}

function findReactElements(node: any, predicate: (node: any) => boolean): any[] {
    if (!node) {
        return []
    }
    if (Array.isArray(node)) {
        return node.flatMap((child) => findReactElements(child, predicate))
    }
    if (typeof node !== 'object') {
        return []
    }
    const children = typeof node.type === 'function' ? node.type(node.props) : node.props?.children
    return [...(predicate(node) ? [node] : []), ...findReactElements(children, predicate)]
}

function readPngSize(buffer: Buffer) {
    expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    }
}

test('resolve227WebsiteBrandKey distinguishes official and FC website feeds', () => {
    expect(resolve227WebsiteBrandKey(buildWebsiteArticle('official-news'))).toBe('official')
    expect(resolve227WebsiteBrandKey(buildWebsiteArticle('official-blog'))).toBe('official')
    expect(resolve227WebsiteBrandKey(buildWebsiteArticle('live-report'))).toBe('official')

    for (const feed of ['fc-news', 'ticket', 'radio', 'movie', 'photo']) {
        expect(resolve227WebsiteBrandKey(buildWebsiteArticle(feed))).toBe('fc')
    }
})

test('resolve227WebsiteBrandKey ignores non-22/7 website data and non-website platforms', () => {
    expect(resolve227WebsiteBrandKey(buildWebsiteArticle('official-news', 'other-site'))).toBeNull()
    expect(
        resolve227WebsiteBrandKey({
            platform: Platform.X,
            extra: {
                extra_type: 'website_meta',
                data: {
                    site: '22/7',
                    feed: 'official-news',
                },
            },
        } as Parameters<typeof resolve227WebsiteBrandKey>[0]),
    ).toBeNull()
    expect(
        resolve227WebsiteBrandKey({
            platform: Platform.Website,
            extra: null,
        } as Parameters<typeof resolve227WebsiteBrandKey>[0]),
    ).toBeNull()
})

test('layoutMediaRows handles three and four image sets without pairing incompatible ratios', () => {
    const wide = { type: 'photo' as const, url: 'wide', width: 1600, height: 900 }
    const portrait = { type: 'photo' as const, url: 'portrait', width: 900, height: 1200 }
    const ultraWide = { type: 'photo' as const, url: 'ultra-wide', width: 1800, height: 500 }
    const ultraTall = { type: 'photo' as const, url: 'ultra-tall', width: 300, height: 1400 }

    expect(layoutMediaRows([wide, portrait, portrait], 0).map((row) => row.length)).toEqual([1, 2])
    expect(layoutMediaRows([portrait, portrait, portrait, portrait], 0).map((row) => row.length)).toEqual([2, 2])
    expect(layoutMediaRows([wide, portrait, ultraWide, ultraTall], 0).map((row) => row.length)).toEqual([1, 1, 1, 1])
})

test('layoutMediaRows gives a single portrait image a readable contained shape', () => {
    const portrait = { type: 'photo' as const, url: 'portrait', width: 900, height: 1600 }
    const [[tile]] = layoutMediaRows([portrait], 0)

    expect(tile?.width).toBeGreaterThanOrEqual(340)
    expect(tile?.height).toBeGreaterThanOrEqual(560)
    expect(tile?.height).toBeLessThanOrEqual(620)
})

test('estimateTextLinesHeight stays conservative for long mixed Japanese text', () => {
    const text =
        '【本日の東京】\n最高気温26℃/最低気温15℃\nくもり☁昼前から昼過ぎは晴れ☀\n\n' +
        '服装:日中半袖で⭕朝晩外出の方も薄手の長袖1枚で大丈夫🩵半袖の方はカーディガン等薄手のアウターあると安心。\n'.repeat(
            4,
        )

    expect(estimateTextLinesHeight(text, 16, 492)).toBeGreaterThan(280)
})

test('card font family puts Latin digits font before CJK so digit metrics stay proportional', () => {
    const families = CARD_FONT_FAMILY.split(',').map((font) => font.trim())

    expect(families[0]).toBe('Noto Sans')
    expect(families.indexOf('Noto Sans')).toBeLessThan(families.indexOf('Noto Sans CJK JP'))
    expect(families.indexOf('Noto Sans')).toBeLessThan(families.indexOf('Noto Sans SC'))
    expect(families).toContain('Noto Sans JP')
    expect(families.at(-1)).toBe('Unifont')
})

test('translation font family keeps Latin digits ahead of CJK while preserving SC-before-JP order', () => {
    const families = CARD_TRANSLATION_FONT_FAMILY.split(',').map((font) => font.trim())

    expect(families[0]).toBe('Noto Sans')
    expect(families.indexOf('Noto Sans')).toBeLessThan(families.indexOf('Noto Sans SC'))
    expect(families.indexOf('Noto Sans SC')).toBeLessThan(families.indexOf('Noto Sans CJK JP'))
    expect(families.indexOf('Noto Sans CJK SC')).toBeLessThan(families.indexOf('Noto Sans CJK JP'))
    expect(families.at(-1)).toBe('Unifont')
})

test('Latin digit run keeps proportional advance under the card font stack', async () => {
    const fontsDir = process.env.FONTS_DIR || './assets/fonts'
    const notoSans = fs.readFileSync(`${fontsDir}/NotoSans-Regular.ttf`)
    const nodes: Array<{ width: number; index: number }> = []
    let index = 0
    await satori(
        {
            type: 'div',
            props: {
                style: { display: 'flex', fontFamily: CARD_FONT_FAMILY, fontSize: 32 },
                children: [
                    { type: 'span', props: { style: { display: 'flex' }, children: '0123456789' } },
                    { type: 'span', props: { style: { display: 'flex' }, children: 'ABCDEFGHIJ' } },
                ],
            },
        },
        {
            width: 1000,
            height: 100,
            fonts: [{ name: 'Noto Sans', data: notoSans, weight: 400, style: 'normal' }],
            onNodeDetected: (node: any) => {
                if (node?.type === 'span') {
                    nodes.push({ width: node.width, index: index++ })
                }
            },
        },
    )
    const digitWidth = nodes.find((node) => node.index === 0)?.width || 0
    const latinWidth = nodes.find((node) => node.index === 1)?.width || 0
    expect(digitWidth).toBeGreaterThan(0)
    expect(digitWidth).toBeLessThan(220)
    expect(Math.abs(digitWidth - latinWidth)).toBeLessThan(latinWidth)
})

test('card UI metadata font prefers modern sans before simplified CJK fallback', () => {
    const families = CARD_UI_FONT_FAMILY.split(',').map((font) => font.trim())

    expect(families[0]).toBe('Noto Sans')
    expect(families.indexOf('Noto Sans CJK SC')).toBeGreaterThan(families.indexOf('Noto Sans'))
    expect(families).not.toContain('Noto Sans CJK JP')
})

test('dynamic fallback font list covers decorative lisu-shaped glyphs', () => {
    expect(languageFontMap.unknown).toContain('Noto+Sans+Lisu')
    for (const font of [
        'Noto+Sans+Armenian',
        'Noto+Sans+Syriac',
        'Noto+Sans+Bengali',
        'Noto+Sans+Arabic',
        'Noto+Serif+Tibetan',
        'Noto+Sans+Khmer',
        'Noto+Sans+Ethiopic',
        'Noto+Sans+Balinese',
        'Noto+Sans+Egyptian+Hieroglyphs',
        'Noto+Sans+Linear+A',
        'Noto+Sans+Vai',
        'Noto+Sans+Cherokee',
        'Noto+Sans+Mongolian',
        'Noto+Sans+Tai+Tham',
        'Noto+Sans+Batak',
        'Noto+Sans+Inscriptional+Pahlavi',
        'Noto+Sans+Miao',
        'Noto+Sans+Bamum',
    ]) {
        expect(languageFontMap.unknown).toContain(font)
    }
})

test('bundled font manifest includes broad kaomoji script coverage with valid font files', () => {
    const fontsDir = process.env.FONTS_DIR || './assets/fonts'
    const fonts = JSON.parse(fs.readFileSync(`${fontsDir}/fonts.json`, 'utf-8')) as Array<{
        name: string
        font_file_name: string
        weight: number
    }>
    const requiredFonts = [
        'Noto Sans Armenian',
        'Noto Sans Syriac',
        'Noto Sans Bengali',
        'Noto Sans Arabic',
        'Noto Sans Lisu',
        'Noto Sans Telugu',
        'Noto Sans Thai',
        'Noto Sans Tamil',
        'Noto Sans Malayalam',
        'Noto Sans Hebrew',
        'Noto Sans Devanagari',
        'Noto Sans Kannada',
        'Noto Sans Khmer',
        'Noto Sans Ethiopic',
        'Noto Sans Balinese',
        'Noto Serif Tibetan',
        'Noto Sans Egyptian Hieroglyphs',
        'Noto Sans Linear A',
        'Noto Sans Vai',
        'Noto Sans Cherokee',
        'Noto Sans Mongolian',
        'Noto Sans Tai Tham',
        'Noto Sans Batak',
        'Noto Sans Inscriptional Pahlavi',
        'Noto Sans Miao',
        'Noto Sans Bamum',
    ]

    for (const name of requiredFonts) {
        const font = fonts.find((candidate) => candidate.name === name && candidate.weight === 400)
        expect(font).toBeTruthy()
        expect(isSupportedOpenTypeFont(fs.readFileSync(`${fontsDir}/${font?.font_file_name}`))).toBeTrue()
    }
})

test('emoji icon code ignores text and emoji variation selectors', () => {
    expect(getIconCode('❤︎')).toBe('2764')
    expect(getIconCode('❤️')).toBe('2764')
})

test('sanitizeCardText removes stray selectors from rino-style decorative text', () => {
    expect(sanitizeCardText('おはりのち︎︎︎︎❤︎')).toBe('おはりのち❤️')
    expect(sanitizeCardText('今日も素敵🪄︎︎◝✩ ‌‌ ‌')).toBe('今日も素敵🪄◝✩  ')
})

test('translated article divider hides external model name', () => {
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'translated-card-test',
        u_id: 'member',
        username: 'Member',
        created_at: 1710000000,
        content: '原文',
        translation: '译文',
        translated_by: 'DeepSeek V4 Flash',
        url: 'https://x.com/member/status/1',
        type: 'tweet',
        ref: null,
        has_media: false,
        media: [],
        extra: null,
        u_avatar: null,
    }
    const { component } = articleParser(article as any)
    const dividerLabel = findReactElement(component, (node) => node.props?.children === '译文 / 原文')
    const providerLabel = findReactElement(component, (node) =>
        String(node.props?.children || '').includes('DeepSeek V4 Flash'),
    )

    expect(dividerLabel).toBeTruthy()
    expect(providerLabel).toBeNull()
})

test('standard original plus translation card patterns only the translation block', () => {
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'combined-translation-card-test',
        u_id: 'member',
        username: 'Member',
        created_at: 1710000000,
        content: '原文ではなく日本語の本文です。',
        translation: '这是同一张动态卡里的译文。',
        translated_by: 'LLM',
        url: 'https://x.com/member/status/1',
        type: 'tweet',
        ref: null,
        has_media: false,
        media: [],
        extra: null,
        u_avatar: null,
    }

    const { component } = articleParser(article as any, { features: ['translated-corner-badge'] } as any)
    const fullCardPattern = findReactElement(component, (node) => node.props?.['data-translated-pattern'] === 'true')
    const translationBlockPattern = findReactElement(
        component,
        (node) => node.props?.['data-translated-block-pattern'] === 'true',
    )
    const geometryShapes = findReactElements(component, (node) =>
        ['circle', 'square', 'triangle', 'diamond'].includes(node.props?.['data-translated-pattern-shape']),
    )

    expect(fullCardPattern).toBeNull()
    expect(translationBlockPattern).toBeTruthy()
    expect(geometryShapes.length).toBeGreaterThan(0)
})

const EXPECTED_TRANSLATED_MARKER_BAR_COLORS = [
    '#29B6F6',
    '#FDD835',
    '#EC407A',
    '#FFB300',
    '#66BB6A',
    '#AD1457',
    '#29B6F6',
]

test('aggregated translation block gets a 1px segmented marker bar on the left', () => {
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'combined-translation-bar-test',
        u_id: 'member',
        username: 'Member',
        created_at: 1710000000,
        content: '原文ではなく日本語の本文です。',
        translation: '这是同一张动态卡里的译文。',
        translated_by: 'LLM',
        url: 'https://x.com/member/status/1',
        type: 'tweet',
        ref: null,
        has_media: false,
        media: [],
        extra: null,
        u_avatar: null,
    }

    const { component } = articleParser(article as any)
    const bar = findReactElement(component, (node) => node.props?.['data-translated-block-bar'] === 'true')
    const cardBar = findReactElement(component, (node) => node.props?.['data-translated-card-bar'] === 'true')
    const translationText = findReactElement(component, (node) => node.props?.children === article.translation)

    expect(cardBar).toBeNull()
    expect(bar).toBeTruthy()
    expect(bar?.props?.style?.left).toBe(0)
    expect(bar?.props?.style?.width).toBe(1)
    expect(bar?.props?.style?.height).toBeGreaterThan(3)
    expect(translationText?.props?.style?.paddingLeft).toBe(3)
    const segments = (bar?.props?.children || []).map((segment: any) => segment.props?.style?.backgroundColor)
    expect(segments).toEqual(EXPECTED_TRANSLATED_MARKER_BAR_COLORS)
    segments.forEach((_color: string, index: number) => {
        expect(bar?.props?.children?.[index]?.props?.style?.flex).toBe(1)
        expect(bar?.props?.children?.[index]?.props?.style?.width).toBe(1)
    })
})

test('standalone translated card gets a 3px segmented marker bar on the left', () => {
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'summary-card-bar-test',
        u_id: 'message_pack',
        username: '聚合',
        created_at: 1710000000,
        content: '聚合',
        translation: null,
        translated_by: null,
        url: '',
        type: 'message_pack',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'message_pack_meta',
            data: {
                range: '1条 / 1900～2100',
                translated_badge_label: '译文',
                groups: [],
            },
        },
        u_avatar: null,
    }

    const { component } = articleParser(article as any, { features: ['translated-corner-badge'] } as any)
    const cardBar = findReactElement(component, (node) => node.props?.['data-translated-card-bar'] === 'true')
    const blockBar = findReactElement(component, (node) => node.props?.['data-translated-block-bar'] === 'true')

    expect(blockBar).toBeNull()
    expect(cardBar).toBeTruthy()
    expect(cardBar?.props?.style?.left).toBe(0)
    expect(cardBar?.props?.style?.width).toBe(3)
    expect(cardBar?.props?.style?.height).toBeGreaterThan(7)
    const segments = (cardBar?.props?.children || []).map((segment: any) => segment.props?.style?.backgroundColor)
    expect(segments).toEqual(EXPECTED_TRANSLATED_MARKER_BAR_COLORS)
    segments.forEach((_color: string, index: number) => {
        expect(cardBar?.props?.children?.[index]?.props?.style?.width).toBe(3)
    })
})

test('translated-corner-badge feature renders sparse multicolor geometry watermark without text badge', () => {
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'summary-card-test',
        u_id: 'message_pack',
        username: '聚合',
        created_at: 1710000000,
        content: '聚合',
        translation: null,
        translated_by: null,
        url: '',
        type: 'message_pack',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'message_pack_meta',
            data: {
                range: '1条 / 1900～2100',
                translated_badge_label: '译文',
                groups: [],
            },
        },
        u_avatar: null,
    }
    const { component } = articleParser(article as any, { features: ['translated-corner-badge'] } as any)
    const card = findReactElement(component, (node) => node.props?.style?.background === '#ffffff')
    const pinkFill = findReactElement(component, (node) => node.props?.style?.background === '#fff7fb')
    const pattern = findReactElement(component, (node) => node.props?.['data-translated-pattern'] === 'true')
    const clusters = findReactElements(component, (node) => node.props?.['data-translated-pattern-cluster'] === 'true')
    const geometryShapes = findReactElements(component, (node) =>
        ['circle', 'square', 'triangle', 'diamond'].includes(node.props?.['data-translated-pattern-shape']),
    )
    const xShape = findReactElement(component, (node) => node.props?.['data-translated-pattern-shape'] === 'x')
    const visibleTextBadge = findReactElement(component, (node) => node.props?.children === '译文')

    expect(card).toBeTruthy()
    expect(String(card?.props?.tw || '')).not.toContain('rounded')
    expect(card?.props?.style?.borderRadius).toBeUndefined()
    expect(pinkFill).toBeNull()
    expect(pattern).toBeTruthy()
    expect(clusters.length).toBe(0)
    expect(geometryShapes.length).toBe(7)
    expect(geometryShapes.slice(0, 4).map((shape) => shape.props.style.left)).toEqual([28, 180, 332, 484])
    expect(geometryShapes.slice(4, 7).map((shape) => shape.props.style.left)).toEqual([104, 256, 408])
    expect(geometryShapes.slice(0, 4).map((shape) => shape.props.style.top)).toEqual([34, 34, 34, 34])
    expect(geometryShapes[0]?.props.style.width).toBe(48)
    expect(geometryShapes[0]?.props.style.height).toBe(48)
    expect(geometryShapes[0]?.props?.['data-translated-pattern-stroke-width']).toBe(4)
    expect(geometryShapes[0]?.props?.['data-translated-pattern-stroke-opacity']).toBe(0.25)
    expect(geometryShapes.map((shape) => shape.props?.['data-translated-pattern-color'])).toEqual([
        '#facc15',
        '#38bdf8',
        '#fde047',
        '#22c55e',
        '#ec4899',
        '#facc15',
        '#38bdf8',
    ])
    expect(xShape).toBeNull()
    expect(visibleTextBadge).toBeNull()
})

test('translated-corner-badge watermark uses a staggered polka-dot grid on long cards', () => {
    const groups = Array.from({ length: 8 }, (_, index) => ({
        title: `${index + 1}. 消息串 1900～2100`,
        avatars: [{ name: `member-${index}` }],
        items: [
            {
                index: 1,
                text:
                    `@member_${index} 190${index}⁹ X发推\n\n` +
                    '今日はライブのお知らせと感想をまとめました。読みやすい長さの本文を保持します。\n' +
                    '引用や補足も聚合卡里は省略しません。',
            },
        ],
    }))
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'long-summary-card-watermark-grid-test',
        u_id: 'message_pack',
        username: '聚合',
        created_at: 1710000000,
        content: '聚合',
        translation: null,
        translated_by: null,
        url: '',
        type: 'message_pack',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'message_pack_meta',
            data: {
                range: '8条 / 1900～2100',
                translated_badge_label: '译文',
                groups,
            },
        },
        u_avatar: null,
    }
    const { component } = articleParser(article as any, { features: ['translated-corner-badge'] } as any)
    const geometryShapes = findReactElements(component, (node) =>
        ['circle', 'square', 'triangle', 'diamond'].includes(node.props?.['data-translated-pattern-shape']),
    )
    const firstRow = geometryShapes.slice(0, 4)
    const secondRow = geometryShapes.slice(4, 7)

    expect(geometryShapes.length).toBeGreaterThan(16)
    expect(new Set(geometryShapes.map((shape) => shape.props?.['data-translated-pattern-shape'])).size).toBe(4)
    expect(firstRow.map((shape) => shape.props.style.left)).toEqual([28, 180, 332, 484])
    expect(secondRow.map((shape) => shape.props.style.left)).toEqual([104, 256, 408])
    expect(secondRow[0]?.props.style.left - firstRow[0]?.props.style.left).toBe(76)
    expect(secondRow[0]?.props.style.top - firstRow[0]?.props.style.top).toBe(76)
    expect(new Set(geometryShapes.map((shape) => shape.props?.['data-translated-pattern-color']))).toEqual(
        new Set(['#facc15', '#38bdf8', '#fde047', '#22c55e', '#ec4899']),
    )
})

test('long message-pack cards keep only a small height safety margin', () => {
    const groups = Array.from({ length: 8 }, (_, index) => ({
        title: `${index + 1}. 消息串 1900～2100`,
        avatars: [{ name: `member-${index}` }],
        items: [
            {
                index: 1,
                text:
                    `@member_${index} 190${index}⁹ X发推\n\n` +
                    '今日はライブのお知らせと感想をまとめました。読みやすい長さの本文を保持します。\n' +
                    '引用や補足も聚合卡里は省略しません。',
            },
        ],
    }))
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'long-summary-card-height-test',
        u_id: 'message_pack',
        username: '聚合',
        created_at: 1710000000,
        content: '聚合',
        translation: null,
        translated_by: null,
        url: '',
        type: 'message_pack',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'message_pack_meta',
            data: {
                range: '8条 / 1900～2100',
                groups,
            },
        },
        u_avatar: null,
    }

    const { height } = articleParser(article as any)

    expect(height).toBeGreaterThan(1260)
    expect(height).toBeLessThan(1325)
})

test('long message-pack cards render at higher raster width even without watermark', async () => {
    const groups = Array.from({ length: 8 }, (_, index) => ({
        title: `${index + 1}. 消息串 1900～2100`,
        avatars: [{ name: `member-${index}` }],
        items: [
            {
                index: 1,
                text:
                    `@member_${index} 190${index}⁹ X发推\n\n` +
                    '今日はライブのお知らせと感想をまとめました。読みやすい長さの本文を保持します。\n' +
                    '引用や補足も聚合卡里は省略しません。',
            },
        ],
    }))
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'long-summary-card-raster-width-test',
        u_id: 'message_pack',
        username: '聚合',
        created_at: 1710000000,
        content: '聚合',
        translation: null,
        translated_by: null,
        url: '',
        type: 'message_pack',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'message_pack_meta',
            data: {
                range: '8条 / 1900～2100',
                groups,
            },
        },
        u_avatar: null,
    }

    const img = await new ImgConverter().articleToImg(article as any)

    expect(readPngSize(img).width).toBe(1200)
})

test('translated-corner-badge feature renders through satori without layout errors', async () => {
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'summary-card-render-test',
        u_id: 'message_pack',
        username: '聚合',
        created_at: 1710000000,
        content: '聚合\n1. sally_amaki发推 2. nananiji_staff转推',
        translation: null,
        translated_by: null,
        url: '',
        type: 'message_pack',
        ref: null,
        has_media: false,
        media: [],
        extra: {
            extra_type: 'message_pack_meta',
            data: {
                range: '2条 / 1900～2100',
                translated_badge_label: '译文',
                groups: [],
            },
        },
        u_avatar: null,
    }

    const img = await new ImgConverter().articleToImg(article as any, { features: ['translated-corner-badge'] })

    expect(img.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(readPngSize(img).width).toBeGreaterThan(0)
})

test('mixed-script decorative kaomoji snippets render without remote font assets', async () => {
    const previousRemoteAssets = process.env.RENDER_REMOTE_ASSETS
    process.env.RENDER_REMOTE_ASSETS = '0'
    const article = {
        id: -1,
        platform: Platform.X,
        a_id: 'mixed-script-kaomoji-render-test',
        u_id: 'decorative_member',
        username: 'decorative member',
        created_at: 1710000000,
        content: [
            '໒՞ ܸ. .ܸ՞۱',
            '໒՞ ܸ. .ܸ՞১',
            '໒꒰՞ ܸ. .ܸ՞꒱ྀི১',
            '૮꒰˶•༝•˶꒱ა ♡₊˚ ୨୧ ࣪ ִֶָ ༘⋆ ೃ༄ ᥫ᭡ 𓆩♡𓆪',
            '⋆𐙚₊˚⊹♡ Ꮚ ꔫ ᡣ𐭩 ᯓ 𖦹',
        ].join('\n'),
        translation: '໒՞ ܸ. .ܸ՞۱ 也要能在译文区正常渲染。',
        translated_by: 'test',
        url: 'https://x.com/decorative_member/status/1',
        type: 'tweet',
        ref: null,
        has_media: false,
        media: [],
        extra: null,
        u_avatar: null,
    }

    try {
        const img = await new ImgConverter().articleToImg(article as any)
        const size = readPngSize(img)
        expect(size.width).toBeGreaterThan(0)
        expect(size.height).toBeGreaterThan(0)
    } finally {
        if (previousRemoteAssets === undefined) {
            delete process.env.RENDER_REMOTE_ASSETS
        } else {
            process.env.RENDER_REMOTE_ASSETS = previousRemoteAssets
        }
    }
})

test('font loader rejects TTC collections because satori cannot render them', () => {
    expect(isSupportedOpenTypeFont(Buffer.from('ttcf0000'))).toBeFalse()
    expect(isSupportedOpenTypeFont(Buffer.from('OTTO0000'))).toBeTrue()
})

test('unsupported fallback font languages are not passed as satori lang props', () => {
    expect(resolveSatoriFontLang('zh-CN')).toBe('zh-CN')
    expect(resolveSatoriFontLang('mongolian')).toBeUndefined()
    expect(resolveSatoriFontLang('tibetan')).toBeUndefined()
    expect(resolveSatoriFontLang('lo-LA')).toBeUndefined()
})

test('dynamic mongolian fallback fonts omit unsupported satori lang props', async () => {
    const previousRemoteAssets = process.env.RENDER_REMOTE_ASSETS
    const previousFetch = globalThis.fetch
    process.env.RENDER_REMOTE_ASSETS = '1'
    const fontsDir = process.env.FONTS_DIR || './assets/fonts'
    const fontData = fs.readFileSync(`${fontsDir}/NotoSansMongolian-Regular.ttf`)
    const detectorCss = [
        "@font-face { font-family: 'Noto Sans Mongolian'; font-style: normal; font-weight: 400;",
        "src: url(https://fonts.example.test/mongolian.ttf) format('truetype'); unicode-range: U+1800-18AF; }",
    ].join(' ')
    const fontCss = [
        "@font-face { font-family: 'Noto Sans Mongolian'; font-style: normal; font-weight: 400;",
        "src: url(https://fonts.example.test/mongolian.ttf) format('truetype'); }",
    ].join(' ')
    globalThis.fetch = (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes('fonts.googleapis.com/css2?')) {
            return new Response(detectorCss)
        }
        if (href.includes('fonts.googleapis.com/css2?family=Noto%2BSans%2BMongolian')) {
            return new Response(fontCss)
        }
        if (href === 'https://fonts.example.test/mongolian.ttf') {
            return new Response(fontData)
        }
        throw new Error(`unexpected fetch: ${href}`)
    }) as typeof fetch

    try {
        const fonts = await loadDynamicAsset('twemoji', 'mongolian', 'ᠠ')
        expect(fonts).toBeArray()
        expect((fonts as any[]).length).toBeGreaterThan(0)
        expect((fonts as any[]).every((font) => font.name.includes('mongolian'))).toBeTrue()
        expect((fonts as any[]).every((font) => font.lang === undefined)).toBeTrue()
    } finally {
        if (previousRemoteAssets === undefined) {
            delete process.env.RENDER_REMOTE_ASSETS
        } else {
            process.env.RENDER_REMOTE_ASSETS = previousRemoteAssets
        }
        globalThis.fetch = previousFetch
    }
})

test('dynamic asset loader can run in deterministic no-remote mode', async () => {
    const previousRemoteAssets = process.env.RENDER_REMOTE_ASSETS
    const previousFetch = globalThis.fetch
    process.env.RENDER_REMOTE_ASSETS = '0'
    globalThis.fetch = (() => {
        throw new Error('fetch should not be called when RENDER_REMOTE_ASSETS=0')
    }) as typeof fetch

    try {
        expect(await loadDynamicAsset('twemoji', 'emoji', '🧪')).toStartWith('data:image/svg+xml;base64,')
        const jaFallbackFonts = await loadDynamicAsset('twemoji', 'ja-JP', 'テスト')
        expect(jaFallbackFonts).toBeArray()
        expect((jaFallbackFonts as any[])[0]?.name).toBe('Unifont')
        const zhFallbackFonts = await loadDynamicAsset('twemoji', 'zh-CN', '测试')
        expect(zhFallbackFonts).toBeArray()
        expect((zhFallbackFonts as any[])[0]?.name).toBe('Unifont')
        const enclosedCjkFallbackFonts = await loadDynamicAsset('twemoji', 'ja-JP', '㈰')
        expect(enclosedCjkFallbackFonts).toBeArray()
        expect((enclosedCjkFallbackFonts as any[]).map((font) => font.name)).toContain('Noto Sans Symbols')
        const fallbackFonts = await loadDynamicAsset('twemoji', 'unknown', 'ᓚᘏᗢ')
        expect(fallbackFonts).toBeArray()
        expect((fallbackFonts as any[])[0]?.name).toBe('Unifont')
    } finally {
        if (previousRemoteAssets === undefined) {
            delete process.env.RENDER_REMOTE_ASSETS
        } else {
            process.env.RENDER_REMOTE_ASSETS = previousRemoteAssets
        }
        globalThis.fetch = previousFetch
    }
})
