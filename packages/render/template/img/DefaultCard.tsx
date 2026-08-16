import { formatArticleAttributionLine, formatArticleHeaderLine, parseRawContent, parseTranslationContent } from '../../src/text'
import type { Article } from '../../src/types'
import { X } from '@kyestu/spider'
import { Platform } from '@kyestu/spider/types'
import clsx from 'clsx'
import _, { reduce } from 'lodash'
import type { JSX } from 'react/jsx-runtime'
import SVG, { Website227FC, Website227Official } from '../../src/img/assets/svg'
import { KOZUE } from '../../src/img/assets/img'
import type { RenderParserOptions } from '../../src/registry'
import { Buffer } from 'buffer'

const CARD_WIDTH = 600
const CONTENT_WIDTH = CARD_WIDTH - 16 * 2 - 64 - 12
const BASE_FONT_SIZE = 16

type WebsiteBrandKey = 'official' | 'fc'

const OFFICIAL_227_WEBSITE_FEEDS = new Set(['official-news', 'official-blog', 'live-report'])
const FC_227_WEBSITE_FEEDS = new Set(['fc-news', 'ticket', 'radio', 'movie', 'photo'])
const DEFAULT_PLATFORM_BADGE_WIDTH = 32
const DEFAULT_CARD_FEATURES = new Set(['media-contain', 'website-inline-media'])
const MEDIA_GAP = 4
const CARD_TEXT_SIZE = {
    xs: 12,
    sm: 14,
    base: 16,
}
const CARD_LINE_HEIGHT = {
    xs: '16px',
    sm: '19px',
    base: '22px',
    tightBase: '20px',
}
const CARD_TEXT_IGNORABLE_PATTERN = /[\uFE0E\u200B\u200C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
export const CARD_FONT_FAMILY = [
    'Noto Sans',
    'Noto Sans CJK JP',
    'Noto Sans JP',
    'Noto Sans SC',
    'Noto Sans CJK SC',
    'Noto Sans Lao',
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
    'Noto Sans Symbols 2',
    'Noto Sans Symbols',
    'Noto Sans Math',
    'Noto Sans Yi',
    'Noto Sans Canadian Aboriginal',
    'Noto Sans Gujarati',
    'Noto Sans Georgian',
    'Noto Sans Oriya',
    'Unifont',
].join(', ')

export function sanitizeCardText(value: string | null | undefined) {
    return (value || '').replace(/\u2764\uFE0E+/g, '\u2764\uFE0F').replace(CARD_TEXT_IGNORABLE_PATTERN, '')
}
export const CARD_TRANSLATION_FONT_FAMILY = [
    'Noto Sans',
    'Noto Sans SC',
    'Noto Sans CJK SC',
    'Noto Sans CJK JP',
    'Noto Sans JP',
    'Noto Sans Lao',
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
    'Noto Sans Symbols 2',
    'Noto Sans Symbols',
    'Unifont',
].join(', ')
export const CARD_UI_FONT_FAMILY = [
    'Noto Sans',
    'Noto Sans CJK SC',
    'Noto Sans SC',
    'Noto Sans Symbols 2',
    'Noto Sans Symbols',
    'Noto Sans Armenian',
    'Noto Sans Syriac',
    'Noto Sans Bengali',
    'Noto Sans Arabic',
    'Noto Sans Yi',
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
    'Unifont',
].join(', ')

type CardRenderFeatures = Set<string>
type InlineContentBlock =
    | {
          type: 'text'
          text: string
      }
    | {
          type: 'image'
          url: string
          alt?: string
      }
type VisualMedia = Exclude<Article['media'], null>[number]
type MediaLayoutTile = {
    media: VisualMedia
    width: number
    height: number
}
type MediaLayoutRow = Array<MediaLayoutTile>
type MessagePackAvatar = {
    url?: string
    name?: string
    id?: string
}
type MessagePackItem = {
    index?: number
    text?: string
    avatar?: MessagePackAvatar
    media?: Exclude<Article['media'], null>
    mediaLabel?: string
}
type MessagePackGroup = {
    title?: string
    omitted?: number
    avatars?: Array<MessagePackAvatar>
    items?: Array<MessagePackItem>
}
type MessagePackMeta = {
    total?: number
    range?: string
    translated_badge_label?: string
    groups?: Array<MessagePackGroup>
}

function resolveCardFeatures(options?: RenderParserOptions): CardRenderFeatures {
    const features = new Set(DEFAULT_CARD_FEATURES)
    for (const feature of options?.features || []) {
        if (feature.startsWith('no-')) {
            features.delete(feature.slice(3))
        } else {
            features.add(feature)
        }
    }
    return features
}

function hasFeature(features: CardRenderFeatures, feature: string) {
    return features.has(feature)
}

function hasTranslatedCardPatternFeature(features: CardRenderFeatures) {
    return hasFeature(features, 'translated-card-pattern') || hasFeature(features, 'translated-corner-badge')
}

const WEBSITE_BRAND_CONFIG = {
    official: {
        badgeIcon: Website227Official,
        badgeRatio: 54.615 / 80,
        badgeWidth: 42,
        badgeOpacity: 0.5,
        avatarBackground: 'linear-gradient(135deg, #f8fdff 0%, #e0f6ff 100%)',
        avatarBorderColor: '#b6e4f8',
        avatarText: 'HP',
        avatarTextColor: '#008fd0',
        avatarFontSizeAt64: 22,
        avatarLetterSpacing: -0.4,
    },
    fc: {
        badgeIcon: Website227FC,
        badgeRatio: 71.39 / 505.05,
        badgeWidth: 96,
        badgeOpacity: 0.62,
        backdropIcon: Website227Official,
        backdropRatio: 54.615 / 80,
        backdropWidth: 54,
        backdropOpacity: 0.26,
        avatarBackground: 'linear-gradient(135deg, #fff6fb 0%, #f3f5ff 52%, #f5f9e7 100%)',
        avatarBorderColor: '#dccce9',
        avatarText: 'FC',
        avatarTextColor: '#8b67aa',
        avatarFontSizeAt64: 22,
        avatarLetterSpacing: -0.4,
    },
} as const

function getContentWidth(level: number) {
    if (level === 0) {
        return CONTENT_WIDTH
    }
    return CONTENT_WIDTH - 16 * 2 * level
}

function getImageWidth(level: number) {
    if (level === 0) {
        return (CONTENT_WIDTH - MEDIA_GAP) / 2
    }
    return (CONTENT_WIDTH - MEDIA_GAP - 16 * 2 * level) / 2
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
}

function parsePngDimensions(buffer: Buffer) {
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        return null
    }
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    }
}

function parseJpegDimensions(buffer: Buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return null
    }

    let offset = 2
    while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) {
            offset += 1
            continue
        }
        const marker = buffer[offset + 1]
        offset += 2
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue
        }
        const length = buffer.readUInt16BE(offset)
        if (length < 2 || offset + length > buffer.length) {
            return null
        }
        if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
        ) {
            return {
                height: buffer.readUInt16BE(offset + 3),
                width: buffer.readUInt16BE(offset + 5),
            }
        }
        offset += length
    }
    return null
}

function getDataUrlDimensions(url: string) {
    const match = url.match(/^data:image\/(?:png|jpe?g);base64,(.+)$/i)
    if (!match?.[1]) {
        return null
    }
    try {
        const buffer = Buffer.from(match[1], 'base64')
        return parsePngDimensions(buffer) || parseJpegDimensions(buffer)
    } catch {
        return null
    }
}

function getMediaAspect(media: VisualMedia) {
    const width = Number((media as any).width || (media as any).image_width || 0)
    const height = Number((media as any).height || (media as any).image_height || 0)
    if (width > 0 && height > 0) {
        return width / height
    }
    const dataUrlDimensions = getDataUrlDimensions(media.url)
    if (dataUrlDimensions && dataUrlDimensions.width > 0 && dataUrlDimensions.height > 0) {
        return dataUrlDimensions.width / dataUrlDimensions.height
    }
    return 16 / 9
}

function getSingleTileWidth(contentWidth: number, aspect: number) {
    if (aspect < 0.55) {
        return clamp(600 * aspect, 160, contentWidth * 0.58)
    }
    if (aspect < 1) {
        return Math.min(contentWidth * 0.86, Math.max(340, 560 * aspect))
    }
    return contentWidth
}

function getTileHeight(width: number, aspect: number, singleColumn: boolean) {
    const normalizedAspect = singleColumn ? clamp(aspect, 0.18, 4.8) : clamp(aspect, 0.45, 2.8)
    const rawHeight = width / normalizedAspect
    return clamp(rawHeight, 112, singleColumn ? 620 : 360)
}

function shouldPairMedia(left: VisualMedia, right: VisualMedia) {
    const leftAspect = getMediaAspect(left)
    const rightAspect = getMediaAspect(right)
    if (leftAspect < 0.55 && rightAspect < 0.55) {
        return false
    }
    const sameOrientation = (leftAspect < 1 && rightAspect < 1) || (leftAspect >= 1 && rightAspect >= 1)
    const closeEnough = Math.abs(Math.log(leftAspect / rightAspect)) < 0.45
    return sameOrientation || closeEnough
}

function layoutMediaRows(media: Exclude<Article['media'], null>, level: number): Array<MediaLayoutRow> {
    const visualMedia = media.filter((m) => m.type === 'photo' || m.type === 'video_thumbnail')
    const rows: Array<MediaLayoutRow> = []
    let index = 0
    while (index < visualMedia.length) {
        const current = visualMedia[index]
        const next = visualMedia[index + 1]
        if (current && next && shouldPairMedia(current, next)) {
            const width = getImageWidth(level)
            const averageAspect = (getMediaAspect(current) + getMediaAspect(next)) / 2
            const height = getTileHeight(width, averageAspect, false)
            rows.push([
                { media: current, width, height },
                { media: next, width, height },
            ])
            index += 2
            continue
        }

        if (current) {
            const aspect = getMediaAspect(current)
            const width = getSingleTileWidth(getContentWidth(level), aspect)
            rows.push([{ media: current, width, height: getTileHeight(width, aspect, true) }])
        }
        index += 1
    }
    return rows
}

function decodeHtmlEntities(text: string) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
}

function htmlToPlainText(html: string) {
    return decodeHtmlEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\u00a0/g, ' '),
    )
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function absoluteUrl(value: string, baseUrl?: string | null) {
    try {
        return new URL(value, baseUrl || undefined).href
    } catch {
        return value
    }
}

function getWebsiteTitle(article: Article) {
    const title = (article.extra?.data as any)?.title
    if (typeof title === 'string' && title.trim()) {
        return `【${title.trim()}】`
    }
    return article.content?.match(/^【.+?】/)?.[0] || ''
}

function getWebsiteInlineBlocks(article: Article, features: CardRenderFeatures): Array<InlineContentBlock> {
    if (!hasFeature(features, 'website-inline-media')) {
        return []
    }
    if (article.platform !== Platform.Website || article.extra?.extra_type !== 'website_meta') {
        return []
    }
    const rawHtml = (article.extra.data as any)?.raw_html
    if (typeof rawHtml !== 'string' || !/<img\b/i.test(rawHtml)) {
        return []
    }

    const blocks: Array<InlineContentBlock> = []
    const imageRegex = /<img\b[^>]*\bsrc=(["']?)([^"'\s>]+)\1[^>]*>/gi
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = imageRegex.exec(rawHtml))) {
        const text = htmlToPlainText(rawHtml.slice(cursor, match.index))
        if (text) {
            blocks.push({ type: 'text', text })
        }
        const src = match[2]
        if (src) {
            const alt = match[0].match(/\balt=(["']?)(.*?)\1(?:\s|>|$)/i)?.[2]
            blocks.push({
                type: 'image',
                url: absoluteUrl(src, article.url),
                alt: alt ? decodeHtmlEntities(alt).trim() : undefined,
            })
        }
        cursor = match.index + match[0].length
    }
    const tailText = htmlToPlainText(rawHtml.slice(cursor))
    if (tailText) {
        blocks.push({ type: 'text', text: tailText })
    }

    return blocks.some((block) => block.type === 'image') ? blocks : []
}

export function resolve227WebsiteBrandKey(article: Pick<Article, 'platform' | 'extra'>): WebsiteBrandKey | null {
    if (article.platform !== Platform.Website || !article.extra || article.extra.extra_type !== 'website_meta') {
        return null
    }

    const data = article.extra.data as Record<string, unknown> | undefined
    if (!data || data.site !== '22/7' || typeof data.feed !== 'string') {
        return null
    }

    if (OFFICIAL_227_WEBSITE_FEEDS.has(data.feed)) {
        return 'official'
    }

    if (FC_227_WEBSITE_FEEDS.has(data.feed)) {
        return 'fc'
    }

    return null
}

function getPlatformBadge(article: Article) {
    const websiteBrandKey = resolve227WebsiteBrandKey(article)
    if (!websiteBrandKey) {
        const platformBadge = SVG[article.platform] || SVG[Platform.X]
        return {
            layers: [
                {
                    width: DEFAULT_PLATFORM_BADGE_WIDTH,
                    ratio: platformBadge.ratio,
                    icon: platformBadge.icon,
                    opacity: 0.2,
                    right: 16,
                    top: 16,
                    rotate: 6,
                },
            ],
        }
    }

    const brand = WEBSITE_BRAND_CONFIG[websiteBrandKey]
    const fcBrand = websiteBrandKey === 'fc' ? WEBSITE_BRAND_CONFIG.fc : null
    return {
        layers: [
            ...(fcBrand
                ? [
                      {
                          width: fcBrand.backdropWidth,
                          ratio: fcBrand.backdropRatio,
                          icon: fcBrand.backdropIcon,
                          opacity: fcBrand.backdropOpacity,
                          right: 54,
                          top: 10,
                          rotate: -10,
                      },
                  ]
                : []),
            {
                width: brand.badgeWidth,
                ratio: brand.badgeRatio,
                icon: brand.badgeIcon,
                opacity: brand.badgeOpacity,
                right: 16,
                top: 16,
                rotate: 6,
            },
        ],
    }
}

function Avatar({ article, size }: { article: Article; size: 32 | 64 }) {
    if (isMessagePackArticle(article)) {
        return (
            <div
                tw="rounded-full flex-none overflow-hidden flex items-center justify-center"
                style={{
                    width: size,
                    height: size,
                    background: 'linear-gradient(135deg, #eff8ff 0%, #d8efff 52%, #eaf7ff 100%)',
                    border: '1px solid #a7d8f6',
                    boxShadow: '0 2px 8px rgba(14, 116, 144, 0.10)',
                }}
            >
                <span
                    tw="font-bold"
                    style={{
                        color: '#0284c7',
                        fontFamily: CARD_UI_FONT_FAMILY,
                        fontSize: size * 0.48,
                        lineHeight: `${size * 0.48}px`,
                    }}
                >
                    N
                </span>
            </div>
        )
    }

    const websiteBrandKey = resolve227WebsiteBrandKey(article)
    if (!websiteBrandKey && article.u_avatar) {
        return (
            <img
                tw="rounded-full flex-none"
                style={{
                    width: size,
                    height: size,
                    objectFit: 'cover',
                }}
                src={article.u_avatar}
                alt={article.username}
            />
        )
    }

    if (!websiteBrandKey) {
        return <div tw="rounded-full bg-gray-200 flex-none" style={{ width: size, height: size }} />
    }

    const brand = WEBSITE_BRAND_CONFIG[websiteBrandKey]
    return (
        <div
            tw="rounded-full flex-none overflow-hidden flex items-center justify-center"
            style={{
                width: size,
                height: size,
                background: brand.avatarBackground,
                border: `1px solid ${brand.avatarBorderColor}`,
                boxShadow: '0 2px 8px rgba(15, 23, 42, 0.08)',
            }}
        >
            <span
                tw="font-bold"
                style={{
                    color: brand.avatarTextColor,
                    fontSize: (brand.avatarFontSizeAt64 * size) / 64,
                    lineHeight: `${(brand.avatarFontSizeAt64 * size) / 64}px`,
                    letterSpacing: brand.avatarLetterSpacing,
                }}
            >
                {brand.avatarText}
            </span>
        </div>
    )
}

function isMessagePackArticle(article: Article) {
    return article.type === 'message_pack' || article.extra?.extra_type === 'message_pack_meta'
}

function getMessagePackMeta(article: Article): MessagePackMeta | null {
    if (!isMessagePackArticle(article)) {
        return null
    }
    const data = (article.extra?.data || null) as MessagePackMeta | null
    if (!data || !Array.isArray(data.groups)) {
        return null
    }
    return data
}

function formatCardHeaderLine(article: Article) {
    const messagePackMeta = getMessagePackMeta(article)
    if (messagePackMeta) {
        return ['聚合', messagePackMeta.range].filter(Boolean).join(' ')
    }
    return formatArticleHeaderLine(article)
}

function avatarFallbackText(avatar: MessagePackAvatar) {
    const value = String(avatar.name || avatar.id || 'N').trim()
    return Array.from(value)[0] || 'N'
}

function MiniAvatar({ avatar, size = 26 }: { avatar: MessagePackAvatar; size?: number }) {
    if (avatar.url) {
        return (
            <img
                tw="rounded-full flex-none"
                src={avatar.url}
                alt={avatar.name || avatar.id || ''}
                style={{
                    width: size,
                    height: size,
                    objectFit: 'cover',
                    border: '1px solid #ffffff',
                    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.14)',
                }}
            />
        )
    }

    return (
        <div
            tw="rounded-full flex-none flex items-center justify-center"
            style={{
                width: size,
                height: size,
                background: '#e2e8f0',
                border: '1px solid #ffffff',
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.10)',
            }}
        >
            <span
                tw="font-bold text-[#64748b]"
                style={{ fontFamily: CARD_UI_FONT_FAMILY, fontSize: size * 0.44, lineHeight: `${size * 0.44}px` }}
            >
                {sanitizeCardText(avatarFallbackText(avatar))}
            </span>
        </div>
    )
}

function AvatarStack({ avatars }: { avatars: Array<MessagePackAvatar> }) {
    const shown = avatars.filter(Boolean).slice(0, 5)
    if (shown.length === 0) {
        return (
            <div tw="flex flex-col items-center flex-none">
                <MiniAvatar avatar={{ name: 'N' }} size={26} />
            </div>
        )
    }

    return (
        <div tw="flex flex-col items-center flex-none" style={{ rowGap: '2px' }}>
            {shown.map((avatar, index) => (
                <MiniAvatar key={`${avatar.url || avatar.id || avatar.name || 'avatar'}-${index}`} avatar={avatar} />
            ))}
        </div>
    )
}

function MessagePackContent({
    article,
    level,
    features,
}: {
    article: Article
    level: number
    features: CardRenderFeatures
}) {
    const meta = getMessagePackMeta(article)
    if (!meta) {
        return null
    }
    const textFontFamily = hasTranslatedCardPatternFeature(features)
        ? CARD_TRANSLATION_FONT_FAMILY
        : CARD_FONT_FAMILY

    return (
        <div tw="flex flex-col" style={{ rowGap: '8px' }}>
            {meta.groups?.map((group, groupIndex) => (
                <div key={groupIndex} tw="flex flex-col w-full" style={{ rowGap: '8px' }}>
                    <div
                        tw="flex flex-row w-full"
                        style={{
                            columnGap: '8px',
                            alignItems: 'flex-start',
                        }}
                    >
                        <AvatarStack
                            avatars={
                                group.avatars?.length
                                    ? group.avatars
                                    : ((group.items || [])
                                          .map((item) => item.avatar)
                                          .filter(Boolean) as Array<MessagePackAvatar>)
                            }
                        />
                        <div tw="flex flex-col flex-1 min-w-0" style={{ rowGap: '5px' }}>
                            {group.title && (
                                <div
                                    tw="text-[#2563eb]"
                                    lang={hasTranslatedCardPatternFeature(features) ? 'zh-CN' : 'ja-JP'}
                                    style={{
                                        fontFamily: textFontFamily,
                                        fontSize: CARD_TEXT_SIZE.xs,
                                        lineHeight: CARD_LINE_HEIGHT.xs,
                                        fontWeight: 700,
                                        overflowWrap: 'anywhere',
                                        wordBreak: 'break-word',
                                    }}
                                >
                                    {sanitizeCardText(group.title)}
                                </div>
                            )}
                            {(group.items || []).map((item, itemIndex) => {
                                const text = String(item.text || '').trim()
                                const media = (item.media || []).filter(
                                    (m) => m.type === 'photo' || m.type === 'video_thumbnail',
                                )
                                return (
                                    <div key={itemIndex} tw="flex flex-col w-full" style={{ rowGap: '4px' }}>
                                        {text && (
                                            <pre
                                                tw="w-full text-[#202733] my-0"
                                                lang={
                                                    hasTranslatedCardPatternFeature(features) ? 'zh-CN' : 'ja-JP'
                                                }
                                                style={{
                                                    fontFamily: textFontFamily,
                                                    fontSize: CARD_TEXT_SIZE.sm,
                                                    lineHeight: CARD_LINE_HEIGHT.sm,
                                                    whiteSpace: 'pre-wrap',
                                                    fontWeight: 400,
                                                    overflowWrap: 'anywhere',
                                                    wordBreak: 'break-word',
                                                }}
                                            >
                                                {sanitizeCardText(`${item.index ? `【${item.index}】\n` : ''}${text}`)}
                                            </pre>
                                        )}
                                        {media.length > 0 && (
                                            <MediaGroup
                                                media={media}
                                                level={level + 1}
                                                features={features}
                                                marker={
                                                    item.mediaLabel || (item.index ? `#${item.index} 图集` : '图集')
                                                }
                                            />
                                        )}
                                    </div>
                                )
                            })}
                            {Number(group.omitted || 0) > 0 && (
                                <div
                                    tw="text-[#64748b]"
                                    lang="zh-CN"
                                    style={{
                                        fontFamily: CARD_TRANSLATION_FONT_FAMILY,
                                        fontSize: CARD_TEXT_SIZE.xs,
                                        lineHeight: CARD_LINE_HEIGHT.xs,
                                    }}
                                >
                                    {`另有 ${group.omitted} 条更新已合并`}
                                </div>
                            )}
                        </div>
                    </div>
                    {groupIndex < (meta.groups?.length || 0) - 1 && (
                        <div tw="flex w-full justify-center">
                            <div
                                style={{
                                    width: '68%',
                                    borderTop: '1px dashed #cbd5e1',
                                }}
                            />
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}

function Metaline({ article }: { article: Article }) {
    return (
        <div
            tw="flex"
            style={{
                fontSize: CARD_TEXT_SIZE.base,
                lineHeight: CARD_LINE_HEIGHT.tightBase,
                maxWidth: '100%',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
            }}
        >
            <span
                tw="font-normal text-[#46556a]"
                lang="zh-CN"
                style={{ fontFamily: CARD_UI_FONT_FAMILY, fontWeight: 700 }}
            >
                {sanitizeCardText(formatCardHeaderLine(article))}
            </span>
        </div>
    )
}

function isTranslatedMarkedCard(article: Article, features: CardRenderFeatures) {
    if (!hasTranslatedCardPatternFeature(features)) {
        return false
    }

    const translatedLabel = (article.extra?.data as MessagePackMeta | undefined)?.translated_badge_label
    return Boolean(translatedLabel || getMessagePackMeta(article)?.translated_badge_label)
}

function TranslatedPatternShape({
    shape,
    color,
    left,
    top,
}: {
    shape: 'circle' | 'square' | 'triangle' | 'diamond'
    color: string
    left: number
    top: number
}) {
    const strokeOpacity = 0.25
    const strokeWidth = 4
    const svgByShape = {
        circle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="none" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}"/></svg>`,
        square: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="7" y="7" width="34" height="34" fill="none" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}"/></svg>`,
        triangle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 7 L42 39 H6 Z" fill="none" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`,
        diamond: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="10" y="10" width="28" height="28" transform="rotate(45 24 24)" fill="none" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${strokeWidth}"/></svg>`,
    } satisfies Record<typeof shape, string>

    return (
        <div
            data-translated-pattern-shape={shape}
            data-translated-pattern-color={color}
            data-translated-pattern-stroke-opacity={strokeOpacity}
            data-translated-pattern-stroke-width={strokeWidth}
            tw="absolute flex"
            style={{
                left,
                top,
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <img
                data-translated-pattern-image={shape}
                src={`data:image/svg+xml;utf8,${encodeURIComponent(svgByShape[shape])}`}
                width={48}
                height={48}
            />
        </div>
    )
}

const TRANSLATED_MARKER_BAR_COLORS = ['#29B6F6', '#FDD835', '#EC407A', '#FFB300', '#66BB6A', '#AD1457', '#29B6F6']

function TranslatedMarkerBar({
    width,
    height,
    dataAttr,
}: {
    width: number
    height: number
    dataAttr: 'translated-card-bar' | 'translated-block-bar'
}) {
    const segmentProps = { [`data-${dataAttr}`]: 'true' } as Record<string, string>
    return (
        <div
            {...segmentProps}
            tw="absolute flex flex-col"
            style={{
                left: 0,
                top: 0,
                width,
                height,
                overflow: 'hidden',
            }}
        >
            {TRANSLATED_MARKER_BAR_COLORS.map((color, index) => (
                <div
                    key={index}
                    tw="flex"
                    style={{
                        flex: 1,
                        width,
                        backgroundColor: color,
                    }}
                />
            ))}
        </div>
    )
}

function TranslatedCardPattern({ cardHeight }: { cardHeight: number }) {
    const shapes: Array<'circle' | 'square' | 'triangle' | 'diamond'> = ['triangle', 'square', 'circle', 'diamond']
    const colors = ['#facc15', '#38bdf8', '#fde047', '#22c55e', '#ec4899']
    const shapeSize = 48
    const leftStart = 28
    const topStart = 34
    const diagonalGap = 76
    const columnGap = diagonalGap * 2
    const rowGap = diagonalGap
    const rowCount = Math.max(1, Math.ceil((cardHeight - topStart) / rowGap))
    const patternShapes = Array.from({ length: rowCount }).flatMap((_, rowIndex) => {
        const rowTop = topStart + rowIndex * rowGap
        const rowOffset = rowIndex % 2 === 0 ? 0 : diagonalGap
        const columnCount = Math.ceil((CARD_WIDTH - leftStart + columnGap) / columnGap)
        return Array.from({ length: columnCount })
            .map((__, columnIndex) => {
                const left = leftStart + rowOffset + columnIndex * columnGap
                return {
                    left,
                    top: Math.min(rowTop, Math.max(topStart, cardHeight - shapeSize - 22)),
                    shape: shapes[(rowIndex * 3 + columnIndex) % shapes.length],
                }
            })
            .filter((item) => item.left <= CARD_WIDTH - shapeSize - 18)
    })
    return (
        <div
            data-translated-pattern="true"
            tw="absolute flex"
            style={{
                left: 0,
                top: 0,
                width: CARD_WIDTH,
                height: cardHeight,
                opacity: 1,
            }}
        >
            {patternShapes.map((item, index) => (
                <TranslatedPatternShape
                    key={index}
                    shape={item.shape}
                    color={colors[index % colors.length]}
                    left={item.left}
                    top={item.top}
                />
            ))}
        </div>
    )
}

function TranslationTextBlockPattern({ width, height }: { width: number; height: number }) {
    const shapes: Array<'circle' | 'square' | 'triangle' | 'diamond'> = ['triangle', 'square', 'circle', 'diamond']
    const colors = ['#facc15', '#38bdf8', '#fde047', '#22c55e', '#ec4899']
    const shapeSize = 48
    const leftStart = 8
    const topStart = 8
    const diagonalGap = 68
    const columnGap = diagonalGap * 2
    const rowGap = diagonalGap
    const rowCount = Math.max(1, Math.ceil((height - topStart) / rowGap))
    const patternShapes = Array.from({ length: rowCount }).flatMap((_, rowIndex) => {
        const rowTop = topStart + rowIndex * rowGap
        const rowOffset = rowIndex % 2 === 0 ? 0 : diagonalGap
        const columnCount = Math.ceil((width - leftStart + columnGap) / columnGap)
        return Array.from({ length: columnCount })
            .map((__, columnIndex) => {
                const left = leftStart + rowOffset + columnIndex * columnGap
                return {
                    left,
                    top: Math.min(rowTop, Math.max(topStart, height - shapeSize - 6)),
                    shape: shapes[(rowIndex * 3 + columnIndex) % shapes.length],
                }
            })
            .filter((item) => item.left <= width - shapeSize - 4)
    })

    return (
        <div
            data-translated-block-pattern="true"
            tw="absolute flex"
            style={{
                left: 0,
                top: 0,
                width,
                height,
                opacity: 1,
            }}
        >
            {patternShapes.map((item, index) => (
                <TranslatedPatternShape
                    key={index}
                    shape={item.shape}
                    color={colors[index % colors.length]}
                    left={item.left}
                    top={item.top}
                />
            ))}
        </div>
    )
}

function AttributionLine({ article }: { article: Article }) {
    if (isMessagePackArticle(article)) {
        return null
    }

    return (
        <div
            tw="flex text-[#64748b]"
            style={{
                fontSize: CARD_TEXT_SIZE.xs,
                lineHeight: CARD_LINE_HEIGHT.xs,
                fontWeight: 700,
                maxWidth: '100%',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
            }}
        >
            <span lang="zh-CN" style={{ fontFamily: CARD_UI_FONT_FAMILY }}>
                {sanitizeCardText(formatArticleAttributionLine(article))}
            </span>
        </div>
    )
}

function Divider({ text, dash }: { text?: string; dash?: boolean }) {
    return (
        <div tw="flex items-center px-5 h-3" style={{ fontSize: CARD_TEXT_SIZE.xs, lineHeight: '14px' }}>
            <div
                tw="border-t border-idol-tertiary flex-grow"
                style={{
                    borderTopStyle: dash ? 'dashed' : 'solid',
                }}
            />
            {text && (
                <span tw="mx-2 text-idol-tertiary" lang="zh-CN" style={{ fontFamily: CARD_UI_FONT_FAMILY }}>
                    {sanitizeCardText(text)}
                </span>
            )}
            {text && (
                <div
                    tw="border-t border-idol-tertiary flex-grow"
                    style={{
                        borderTopStyle: dash ? 'dashed' : 'solid',
                    }}
                />
            )}
        </div>
    )
}

function ImageTile({
    url,
    alt,
    width,
    height,
    contain,
}: {
    url: string
    alt?: string
    width: number
    height: number
    contain: boolean
}) {
    return (
        <div
            tw="flex overflow-hidden bg-[#f7f9fc]"
            style={{
                width,
                height,
                flexBasis: `${width}px`,
            }}
        >
            <img
                src={url}
                style={{
                    width,
                    height,
                    objectFit: contain ? 'contain' : 'cover',
                }}
                alt={alt}
            />
        </div>
    )
}

function MediaGroup({
    media: _media,
    level,
    features,
    marker,
}: {
    media: Exclude<Article['media'], null>
    level: number
    features: CardRenderFeatures
    marker?: string
}) {
    const media = _media.filter((m) => m.type === 'photo' || m.type === 'video_thumbnail')
    const rows = layoutMediaRows(media, level)
    const contain = hasFeature(features, 'media-contain')
    return (
        <div tw="flex flex-col" style={{ rowGap: '3px' }}>
            {marker && (
                <div
                    tw="flex self-start rounded-sm px-1.5 py-0.5 text-[#64748b] bg-[#f1f5f9]"
                    style={{
                        fontSize: 10,
                        lineHeight: '10px',
                        fontWeight: 700,
                    }}
                >
                    {marker}
                </div>
            )}
            <div
                tw="flex flex-col rounded-lg overflow-hidden shadow-sm"
                style={{
                    rowGap: `${MEDIA_GAP}px`,
                }}
            >
                {rows.map((row, rowIndex) => (
                    <div
                        key={rowIndex}
                        tw="flex"
                        style={{
                            columnGap: `${MEDIA_GAP}px`,
                            justifyContent: row.length === 1 ? 'center' : 'flex-start',
                        }}
                    >
                        {row.map((tile, tileIndex) => (
                            <ImageTile
                                key={tileIndex}
                                url={tile.media.url}
                                alt={tile.media.alt}
                                width={tile.width}
                                height={tile.height}
                                contain={contain}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    )
}

function InlineWebsiteContent({
    article,
    blocks,
    level,
    features,
}: {
    article: Article
    blocks: Array<InlineContentBlock>
    level: number
    features: CardRenderFeatures
}) {
    const title = getWebsiteTitle(article)
    return (
        <div tw="flex flex-col" style={{ rowGap: '4px' }}>
            {title && (
                <pre
                    tw="w-full text-[#202733] my-0"
                    style={{
                        fontSize: CARD_TEXT_SIZE.base,
                        lineHeight: CARD_LINE_HEIGHT.base,
                        whiteSpace: 'pre-wrap',
                        fontWeight: 700,
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                    }}
                >
                    {sanitizeCardText(title)}
                </pre>
            )}
            {blocks.map((block, index) =>
                block.type === 'text' ? (
                    <pre
                        key={index}
                        tw="w-full text-[#202733] my-0"
                        style={{
                            fontSize: CARD_TEXT_SIZE.base,
                            lineHeight: CARD_LINE_HEIGHT.base,
                            whiteSpace: 'pre-wrap',
                            fontWeight: 400,
                            overflowWrap: 'anywhere',
                            wordBreak: 'break-word',
                        }}
                    >
                        {sanitizeCardText(block.text)}
                    </pre>
                ) : (
                    <MediaGroup
                        key={index}
                        media={[{ type: 'photo', url: block.url, alt: block.alt }]}
                        level={level}
                        features={features}
                    />
                ),
            )}
        </div>
    )
}

function estimateTextLayout(text: string, fontSize: number, containerWidth: number) {
    text = text.trim()
    if (!text) {
        return { paragraphCount: 0, totalLines: 0 }
    }
    // 1. 处理硬换行符 - 分割文本成行
    const paragraphs = text.split('\n')

    // 2. 估算每个字符的平均宽度 - 一个粗略的估计
    // 英文字符约为字体大小的0.6倍，中日韩字符约为字体大小的1.0倍
    const avgCharWidthLatin = fontSize * 0.66 // 拉丁字符(英文、数字等)
    const avgCharWidthCJK = fontSize * 1.02 // 中日韩字符、emoji 和装饰符号需要更保守的估算

    let totalLines = 0

    // 3. 处理每个段落
    for (const paragraph of paragraphs) {
        if (paragraph.length === 0) {
            // 空行计为一行
            totalLines += 1
            continue
        }

        // 估算这个段落的总宽度
        let paragraphWidth = 0

        for (const char of paragraph) {
            // 判断字符是拉丁字符还是CJK字符
            // 这是一个简化的判断，实际情况可能更复杂
            const charCode = char.charCodeAt(0)
            if (charCode > 0x3000 || charCode < 0x20) {
                // 粗略判断是否为CJK字符
                paragraphWidth += avgCharWidthCJK
            } else {
                paragraphWidth += avgCharWidthLatin
            }
        }
        // 计算此段落需要的行数
        const linesNeeded = Math.max(1, Math.ceil(paragraphWidth / containerWidth))
        totalLines += linesNeeded
    }
    return { paragraphCount: paragraphs.length, totalLines }
}

/**
 * 在Node.js环境中估算文本在指定容器宽度和字体大小下的行数
 * @param {string} text - 要计算的文本内容
 * @param {number} fontSize - 字体大小(px)
 * @param {number} containerWidth - 容器宽度(px)
 * @return {number} 估算的文本高度
 */
function estimateTextLinesHeight(text: string, fontSize: number, containerWidth: number) {
    const { paragraphCount, totalLines } = estimateTextLayout(text, fontSize, containerWidth)
    return totalLines * fontSize * 1.42 + paragraphCount * 2
}

function estimateRenderedTextBlockHeight(text: string, fontSize: number, lineHeight: number, containerWidth: number) {
    return estimateTextLayout(text, fontSize, containerWidth).totalLines * lineHeight
}

function estimateImagesHeight(media: Exclude<Article['media'], null>, level: number = 0) {
    if (!media || media.length === 0) {
        return 0
    }
    const rows = layoutMediaRows(media, level)
    if (rows.length === 0) {
        return 0
    }
    return (
        rows.reduce((sum, row) => sum + Math.max(...row.map((tile) => tile.height)), 0) +
        Math.max(0, rows.length - 1) * MEDIA_GAP
    )
}

function estimateInlineWebsiteHeight(article: Article, level: number, features: CardRenderFeatures) {
    const blocks = getWebsiteInlineBlocks(article, features)
    if (blocks.length === 0) {
        return null
    }
    const title = getWebsiteTitle(article)
    const textHeight = blocks.reduce(
        (sum, block) => {
            if (block.type === 'image') {
                return sum + estimateImagesHeight([{ type: 'photo', url: block.url, alt: block.alt }], level)
            }
            return sum + estimateTextLinesHeight(sanitizeCardText(block.text), BASE_FONT_SIZE, getContentWidth(level))
        },
        title ? estimateTextLinesHeight(title, BASE_FONT_SIZE, getContentWidth(level)) : 0,
    )
    return textHeight + Math.max(0, blocks.length - 1) * 4
}

function estimateMessagePackHeight(article: Article, level: number) {
    const meta = getMessagePackMeta(article)
    if (!meta?.groups?.length) {
        return null
    }

    const contentWidth = getContentWidth(level) - 34
    return meta.groups.reduce((sum, group, groupIndex) => {
        const columnBlocks: number[] = []
        const titleHeight = group.title
            ? estimateRenderedTextBlockHeight(sanitizeCardText(group.title), 12, 16, contentWidth)
            : 0
        if (titleHeight > 0) {
            columnBlocks.push(titleHeight)
        }

        for (const item of group.items || []) {
            const rawText = String(item.text || '').trim()
            const text = rawText ? `${item.index ? `【${item.index}】\n` : ''}${rawText}` : ''
            const textHeight = text ? estimateRenderedTextBlockHeight(sanitizeCardText(text), 14, 19, contentWidth) : 0
            const mediaHeight = item.media?.length ? estimateImagesHeight(item.media, level + 1) : 0
            const itemHeight = textHeight + mediaHeight + (textHeight > 0 && mediaHeight > 0 ? 4 : 0)
            if (itemHeight > 0) {
                columnBlocks.push(itemHeight)
            }
        }

        if (Number(group.omitted || 0) > 0) {
            columnBlocks.push(16)
        }

        const shownAvatarCount = Math.min(5, Math.max(1, group.avatars?.length || 0))
        const avatarHeight = shownAvatarCount * 26 + Math.max(0, shownAvatarCount - 1) * 2
        const columnHeight =
            columnBlocks.reduce((blockSum, blockHeight) => blockSum + blockHeight, 0) +
            Math.max(0, columnBlocks.length - 1) * 5
        const groupHeight = Math.max(avatarHeight, columnHeight)
        const separatorAndGapHeight = groupIndex < (meta.groups?.length || 0) - 1 ? 17 : 0
        return sum + groupHeight + separatorAndGapHeight
    }, 0)
}

function ArticleContent({
    article,
    level = 0,
    features,
}: {
    article: Article
    level: number
    features: CardRenderFeatures
}) {
    const inlineWebsiteBlocks = getWebsiteInlineBlocks(article, features)
    const useInlineWebsiteBlocks = inlineWebsiteBlocks.length > 0
    const messagePackMeta = getMessagePackMeta(article)
    const useMessagePackBlocks = Boolean(messagePackMeta)
    const translationText = sanitizeCardText(parseTranslationContent(article))
    const translationBlockWidth = getContentWidth(level)
    const translationPatternHeight = Math.max(
        62,
        Math.ceil(estimateTextLinesHeight(translationText, BASE_FONT_SIZE, translationBlockWidth) + 8),
    )
    const shouldRenderMedia = Boolean(
        article.media && article.media.length > 0 && !useInlineWebsiteBlocks && !useMessagePackBlocks,
    )
    function Content() {
        return (
            <div
                tw={clsx('flex flex-col', {
                    'pb-6': level === 0 && isConversationType(article.type),
                })}
                style={{
                    rowGap: '4px',
                    width: `${level === 0 ? CONTENT_WIDTH : CONTENT_WIDTH - 2 * 16 * level}px`,
                }}
            >
                {level === 0 && <Metaline article={article} />}
                {level !== 0 && (
                    <div
                        tw="flex flex-row"
                        style={{
                            columnGap: '4px',
                        }}
                    >
                        <Avatar article={article} size={32} />
                        <div tw="flex flex-shrink">
                            <Metaline article={article} />
                        </div>
                    </div>
                )}
                {article.translation && (
                    <div
                        tw="relative flex flex-col w-full overflow-hidden"
                        style={{
                            borderRadius: 6,
                        }}
                    >
                        <TranslationTextBlockPattern
                            width={translationBlockWidth}
                            height={translationPatternHeight}
                        />
                        <TranslatedMarkerBar width={1} height={translationPatternHeight} dataAttr="translated-block-bar" />
                        <pre
                            tw="relative w-full my-0 text-[#1f2937]"
                            lang="zh-CN"
                            style={{
                                fontFamily: CARD_TRANSLATION_FONT_FAMILY,
                                fontSize: CARD_TEXT_SIZE.base,
                                lineHeight: CARD_LINE_HEIGHT.base,
                                whiteSpace: 'pre-wrap',
                                fontWeight: 400,
                                paddingLeft: 3,
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                            }}
                        >
                            {translationText}
                        </pre>
                    </div>
                )}
                {article.translation && <Divider text="译文 / 原文" />}
                {article.content && !useInlineWebsiteBlocks && !useMessagePackBlocks && (
                    <pre
                        tw="w-full text-[#202733] my-0"
                        lang="ja-JP"
                        style={{
                            fontFamily: CARD_FONT_FAMILY,
                            fontSize: CARD_TEXT_SIZE.base,
                            lineHeight: CARD_LINE_HEIGHT.base,
                            whiteSpace: 'pre-wrap',
                            fontWeight: 400,
                            overflowWrap: 'anywhere',
                            wordBreak: 'break-word',
                        }}
                    >
                        {sanitizeCardText(parseRawContent(article))}
                    </pre>
                )}
                {useMessagePackBlocks && <MessagePackContent article={article} level={level} features={features} />}
                {useInlineWebsiteBlocks && (
                    <InlineWebsiteContent
                        article={article}
                        blocks={inlineWebsiteBlocks}
                        level={level}
                        features={features}
                    />
                )}
                <AttributionLine article={article} />
                {shouldRenderMedia && <Divider dash />}
                {shouldRenderMedia && article.media && (
                    <MediaGroup
                        media={article.media}
                        level={level}
                        features={features}
                        marker={level > 0 ? `引用层 ${level} 图集` : undefined}
                    />
                )}
                {article.ref && typeof article.ref === 'object' && (
                    <ArticleContent article={article.ref} level={level + 1} features={features} />
                )}
            </div>
        )
    }
    return level === 0 ? (
        <div
            tw="flex flex-row"
            style={{
                columnGap: '12px',
            }}
        >
            <div tw="flex flex-col items-center" style={{ rowGap: '6px' }}>
                <Avatar article={article} size={64} />
                {isConversationType(article.type) && <div tw="flex-grow bg-idol-tertiary w-[2px] rounded-full"></div>}
            </div>
            <Content />
        </div>
    ) : (
        <div tw="flex border border-idol-tertiary rounded-lg p-4 shadow-md">
            <Content />
        </div>
    )
}

function isConversationType(type: Article['type']): boolean {
    return ([X.ArticleTypeEnum.CONVERSATION] as Array<Article['type']>).includes(type)
}

function flatArticle(article: Article): Array<Article> {
    const articles: Array<Article> = []
    let currentArticle: Article | null = article
    while (currentArticle && isConversationType(currentArticle.type)) {
        articles.push({
            ...currentArticle,
            ref: null,
        })
        if (currentArticle.ref && typeof currentArticle.ref === 'object') {
            currentArticle = currentArticle.ref
        } else {
            currentArticle = null
        }
    }
    currentArticle && articles.push(currentArticle)
    return articles
}

function articleHasVisualMedia(article: Article) {
    return flatArticle(article).some((item) =>
        item.media?.some((media) => ['photo', 'video', 'video_thumbnail'].includes(media.type)),
    )
}

function BaseCard({
    article,
    paddingHeight,
    features,
    cardHeight,
}: {
    article: Article
    paddingHeight: number
    features: CardRenderFeatures
    cardHeight: number
}) {
    const flattedArticle = flatArticle(article)
    const badge = getPlatformBadge(article)
    const hasVisualMedia = articleHasVisualMedia(article)
    const translatedMarkedCard = isTranslatedMarkedCard(article, features)
    return (
        <div
            tw={clsx('p-4 bg-white shadow-sm h-full w-full flex flex-col relative', {
                'pb-5': hasVisualMedia,
                'pb-3': !hasVisualMedia,
            })}
            lang="ja-JP"
            style={{
                fontFamily: CARD_FONT_FAMILY,
                rowGap: '6px',
                background: '#ffffff',
                overflow: 'hidden',
            }}
        >
            {translatedMarkedCard && <TranslatedCardPattern cardHeight={cardHeight} />}
            {translatedMarkedCard && <TranslatedMarkerBar width={3} height={cardHeight} dataAttr="translated-card-bar" />}
            {badge.layers.map((layer, index) => (
                <img
                    key={`${layer.icon}-${index}`}
                    tw="absolute"
                    style={{
                        right: `${layer.right}px`,
                        top: `${layer.top}px`,
                        transform: `rotate(${layer.rotate}deg)`,
                        opacity: layer.opacity,
                    }}
                    width={layer.width}
                    height={layer.width * layer.ratio}
                    src={layer.icon}
                />
            ))}
            {flattedArticle.map((item, index) => (
                <ArticleContent key={index} article={item} level={0} features={features} />
            ))}
            {/* {paddingHeight > 0 && (
                <div tw="flex justify-center items-center opacity-20">
                    <img src={KOZUE} width={paddingHeight}/>
                </div>
            )} */}
        </div>
    )
}

function estimatedArticleHeight(article: Article, level: number = 0, features: CardRenderFeatures): number {
    const basePadding = 16 * 2
    const inlineWebsiteHeight = estimateInlineWebsiteHeight(article, level, features)
    const messagePackHeight = estimateMessagePackHeight(article, level)
    const shouldEstimateStandaloneMedia = inlineWebsiteHeight === null && messagePackHeight === null
    const articleHeightArray = [
        estimateTextLinesHeight(
            sanitizeCardText(formatCardHeaderLine(article)),
            BASE_FONT_SIZE,
            getContentWidth(level) - (level === 0 ? 0 : 32), // maybe subtract the avatar width
        ), // metaline
        estimateTextLinesHeight(
            sanitizeCardText(parseTranslationContent(article)),
            BASE_FONT_SIZE,
            getContentWidth(level),
        ), // translation
        article.translation ? 12 : 0, // translation divider
        messagePackHeight ??
            inlineWebsiteHeight ??
            estimateTextLinesHeight(sanitizeCardText(parseRawContent(article)), BASE_FONT_SIZE, getContentWidth(level)), // content
        article.has_media && shouldEstimateStandaloneMedia ? 12 : 0, // media or extra divider
        shouldEstimateStandaloneMedia ? estimateImagesHeight(article.media ?? [], level) : 0, // media
        isMessagePackArticle(article)
            ? 0
            : estimateTextLinesHeight(
                  sanitizeCardText(formatArticleAttributionLine(article)),
                  12,
                  getContentWidth(level),
              ),
        article.ref && typeof article.ref === 'object'
            ? estimatedArticleHeight(article.ref, level + 1, features) + basePadding * (level + 1)
            : 0, // ref
    ]
    return _(articleHeightArray)
        .filter((item) => item > 0)
        .flatMap((item) => [item, 4])
        .dropRight(1)
        .reduce((a, b) => a + b, 0)
}

function articleParser(
    article: Article,
    options?: RenderParserOptions,
): {
    component: JSX.Element
    height: number
} {
    const features = resolveCardFeatures(options)
    const hasVisualMedia = articleHasVisualMedia(article)
    let flattedArticleHeightArray = flatArticle(article).map((item) => estimatedArticleHeight(item, 0, features))
    let estimatedHeight = [
        16, // padding top
        _(flattedArticleHeightArray)
            .filter((item) => item > 0)
            .flatMap((item) => [item, 24 + 6])
            .dropRight(1) // content
            .reduce((a, b) => a + b, 0),
        hasVisualMedia ? 20 : 12, // padding bottom
    ]
        .flat()
        .reduce((a, b) => a + b, 0)
    const isMessagePack = isMessagePackArticle(article)
    estimatedHeight = Math.ceil(estimatedHeight * (isMessagePack ? 1.025 : 1.08) + (isMessagePack ? 6 : 10))

    let paddingHeight = 0
    const minimumCardRatio = hasVisualMedia ? 1 / 3 : 0.27
    if (estimatedHeight / CARD_WIDTH < minimumCardRatio) {
        paddingHeight = CARD_WIDTH * minimumCardRatio - estimatedHeight
    }
    const cardHeight = Math.ceil(estimatedHeight + paddingHeight)
    return {
        component: (
            <BaseCard article={article} paddingHeight={paddingHeight} features={features} cardHeight={cardHeight} />
        ),
        height: cardHeight,
    }
}

export { estimateImagesHeight, estimateTextLinesHeight, layoutMediaRows, BaseCard, articleParser }
export { BASE_FONT_SIZE, CARD_WIDTH, CONTENT_WIDTH }
