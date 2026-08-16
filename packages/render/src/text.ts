import { platformArticleMapToActionText, platformNameMap } from '@kyestu/spider/const'
import type { Article } from './types'
import { type GenericFollows, Platform } from '@kyestu/spider/types'
import { orderBy } from 'lodash'

type Follows = GenericFollows & {
    created_at: number
}

type ArticleTextOptions = {
    collapsedArticleIds?: Set<string | number>
    /** When set, the rendered text omits the translation block and keeps the original text only. */
    textOriginalOnly?: boolean
}

const RENDER_TIMEZONE_OFFSET_MINUTES = 9 * 60
const SHORT_PLATFORM_LABELS: Partial<Record<Platform, string>> = {
    [Platform.Instagram]: 'IG',
    [Platform.TikTok]: 'TT',
    [Platform.YouTube]: 'YT',
    [Platform.Website]: 'Web',
}
const SHORT_ACTION_LABELS: Partial<Record<Platform, Record<string, string>>> = {
    [Platform.X]: {
        tweet: '发推',
        retweet: '转推',
        reply: '回复',
        conversation: '回复',
        quoted: '引用',
    },
    [Platform.Instagram]: {
        post: '发帖',
        story: '故事',
        highlight: '精选',
    },
    [Platform.TikTok]: {
        post: '视频',
    },
    [Platform.YouTube]: {
        video: '视频',
        shorts: '短视频',
    },
    [Platform.Website]: {
        article: '更新',
    },
}
const SYNTHETIC_ACTION_LABELS: Record<string, string> = {
    message_pack: '合并',
    summary: '合并',
}
const WEBSITE_FEED_LABELS: Record<string, string> = {
    'official-blog': '博客',
    'official-news': '新闻',
    'fc-news': 'FC新闻',
    'live-report': 'LIVE REPORT',
    photo: 'PHOTO',
    movie: 'MOVIE',
    radio: 'RADIO',
    ticket: 'TICKET',
}
const SUPERSCRIPT_DIGITS: Record<string, string> = {
    '+': '⁺',
    '-': '⁻',
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
}
const SUBSCRIPT_DIGITS: Record<string, string> = {
    '0': '₀',
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '₇',
    '8': '₈',
    '9': '₉',
}

function mapDigits(value: string, digits: Record<string, string>) {
    return value
        .split('')
        .map((char) => digits[char] || char)
        .join('')
}

function toSuperscript(value: string) {
    return mapDigits(value, SUPERSCRIPT_DIGITS)
}

function toSubscript(value: string) {
    return mapDigits(value, SUBSCRIPT_DIGITS)
}

function formatTimezoneSuffix(offsetMinutes: number = RENDER_TIMEZONE_OFFSET_MINUTES) {
    if (offsetMinutes === 0) {
        return SUPERSCRIPT_DIGITS['0']
    }

    const absoluteMinutes = Math.abs(offsetMinutes)
    const hours = Math.floor(absoluteMinutes / 60)
    const minutes = absoluteMinutes % 60
    const zone = minutes === 0 ? `${hours}` : `${hours}${String(minutes).padStart(2, '0')}`
    return `${SUPERSCRIPT_DIGITS[offsetMinutes < 0 ? '-' : '+']}${toSuperscript(zone)}`
}

function getRenderDate(unixTimestamp: number) {
    return new Date((unixTimestamp + RENDER_TIMEZONE_OFFSET_MINUTES * 60) * 1000)
}

function pad2(value: number) {
    return String(value).padStart(2, '0')
}

function formatTime(unix_timestamp: number) {
    const time = getRenderDate(unix_timestamp)
    const date = `${pad2(time.getUTCFullYear() % 100)}${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}`
    const clock = `${pad2(time.getUTCHours())}${pad2(time.getUTCMinutes())}`
    return `${date} ${clock}${formatTimezoneSuffix()}`
}

function formatClock(unix_timestamp: number) {
    const time = getRenderDate(unix_timestamp)
    return `${pad2(time.getUTCHours())}${pad2(time.getUTCMinutes())}${formatTimezoneSuffix()}`
}

function formatBareClock(unix_timestamp: number) {
    const time = getRenderDate(unix_timestamp)
    return `${pad2(time.getUTCHours())}${pad2(time.getUTCMinutes())}`
}

function formatDateKey(unixTimestamp: number) {
    const time = getRenderDate(unixTimestamp)
    return `${time.getUTCFullYear()}-${pad2(time.getUTCMonth() + 1)}-${pad2(time.getUTCDate())}`
}

function formatDisplayDate(unix_timestamp: number) {
    const time = getRenderDate(unix_timestamp)
    return `${pad2(time.getUTCFullYear() % 100)}${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}`
}

function formatArticleTimeToken(unix_timestamp: number) {
    const time = getRenderDate(unix_timestamp)
    const monthDay = `${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}`
    const year = toSubscript(pad2(time.getUTCFullYear() % 100))
    return `${formatClock(unix_timestamp)}(${monthDay}${year})`
}

function formatArticlePlainTimeToken(unix_timestamp: number) {
    const time = getRenderDate(unix_timestamp)
    const monthDay = `${pad2(time.getUTCMonth() + 1)}${pad2(time.getUTCDate())}`
    const year = pad2(time.getUTCFullYear() % 100)
    return `${formatBareClock(unix_timestamp)}+9(${monthDay}_${year})`
}

function formatArticleAttributionTimeToken(unix_timestamp: number) {
    return `${formatClock(unix_timestamp)}（${formatDisplayDate(unix_timestamp)}）`
}

function getWebsiteTimeSource(article: Article) {
    if (article.platform !== Platform.Website || article.extra?.extra_type !== 'website_meta') {
        return null
    }
    return String((article.extra.data as any)?.time_source || '').trim()
}

function formatArticleDisplayClock(article: Article) {
    const timeSource = getWebsiteTimeSource(article)
    if (timeSource === 'estimated_publish') {
        return `${formatBareClock(article.created_at)} EST.`
    }
    if (timeSource === 'crawl_observed') {
        return `抓取于 ${formatClock(article.created_at)}`
    }
    return formatClock(article.created_at)
}

function formatArticleDisplayAttributionTime(article: Article) {
    const timeSource = getWebsiteTimeSource(article)
    if (timeSource === 'estimated_publish') {
        return `${formatBareClock(article.created_at)} EST.`
    }
    if (timeSource === 'crawl_observed') {
        return `抓取于 ${formatArticleAttributionTimeToken(article.created_at)}`
    }
    return formatArticleAttributionTimeToken(article.created_at)
}

function formatArticleUserId(article: Pick<Article, 'u_id' | 'username' | 'a_id'>) {
    const id = String(article.u_id || article.username || article.a_id || '').trim()
    if (!id) {
        return ''
    }
    if (id.startsWith('@') || id.includes(':')) {
        return id
    }
    return `@${id}`
}

function formatArticlePlatformLabel(article: Pick<Article, 'platform'>) {
    return SHORT_PLATFORM_LABELS[article.platform] || platformNameMap[article.platform]
}

function formatArticleActionLabel(article: Pick<Article, 'platform' | 'type'>) {
    return (
        SHORT_ACTION_LABELS[article.platform]?.[article.type] ||
        platformArticleMapToActionText[article.platform]?.[article.type] ||
        SYNTHETIC_ACTION_LABELS[article.type] ||
        article.type
    )
}

function formatArticleSourceActionLabel(article: Pick<Article, 'platform' | 'type'>) {
    return `${formatArticlePlatformLabel(article)}${formatArticleActionLabel(article)}`
}

function formatArticleSourceActionAttribution(article: Pick<Article, 'platform' | 'type'>) {
    return `${formatArticlePlatformLabel(article)} ${formatArticleActionLabel(article)}`
}

function formatArticleHeaderLine(article: Article) {
    return [formatArticleUserId(article), formatArticleDisplayClock(article), formatArticleSourceActionLabel(article)]
        .filter(Boolean)
        .join(' ')
}

function formatArticleAttributionLine(article: Article) {
    return [
        article.username,
        formatArticleDisplayAttributionTime(article),
        formatArticleSourceActionAttribution(article),
    ]
        .filter(Boolean)
        .join(' ')
}

const PASSTHROUGH_CARD_DEFERRED_MARKER = '---（余下见卡片）---'

function formatPassthroughTitleLine(
    article: Pick<Article, 'u_id' | 'username' | 'a_id' | 'created_at' | 'platform'>,
) {
    const username = String(article.username || '').trim()
    const name = username || formatArticleUserId(article)
    const timeToken = article.created_at ? formatArticleTimeToken(article.created_at) : ''
    return [name, timeToken, formatArticlePlatformLabel(article)].filter(Boolean).join(' ').trim()
}

function formatPassthroughAttributionLine(
    article: Pick<Article, 'u_id' | 'username' | 'a_id' | 'created_at' | 'platform' | 'type'>,
) {
    const userId = formatArticleUserId(article)
    const username = String(article.username || '').trim()
    const showUsername = username && normalizeIdentityToken(username) !== normalizeIdentityToken(userId)
    return [
        userId,
        showUsername ? username : '',
        article.created_at ? formatArticlePlainTimeToken(article.created_at) : '',
        formatArticleSourceActionLabel(article),
    ]
        .filter(Boolean)
        .join(' ')
}

function formatTranslationPassthrough(
    article: Pick<Article, 'u_id' | 'username' | 'a_id' | 'created_at' | 'platform' | 'type' | 'ref'>,
    translation: string,
): string {
    const attributionLine = formatPassthroughAttributionLine(article)
    const body = String(translation || '').trim()
    if (!body) {
        return attributionLine
    }
    const titleLine = formatPassthroughTitleLine(article)
    const deferredMarker = article.ref && typeof article.ref === 'object' ? ['', PASSTHROUGH_CARD_DEFERRED_MARKER] : []
    return [titleLine, body, ...deferredMarker, '', attributionLine].join('\n')
}

function normalizeIdentityToken(value: string | null | undefined) {
    return String(value || '')
        .trim()
        .replace(/^@+/, '')
        .toLocaleLowerCase()
}

function formatEmptyBodyArticleLine(article: Article) {
    const userId = formatArticleUserId(article)
    const username = String(article.username || '').trim()
    const shouldShowUsername = username && normalizeIdentityToken(username) !== normalizeIdentityToken(userId)
    return [
        shouldShowUsername ? username : '',
        userId,
        formatArticleDisplayClock(article),
        formatArticleSourceActionLabel(article),
    ]
        .filter(Boolean)
        .join(' ')
}

function parseTranslationContent(article: Article) {
    /***** 翻译原文 *****/
    let content = article.translation || ''
    /***** 翻译原文结束 *****/

    /***** 图片描述翻译 *****/
    let media_translations: Array<string> = []
    for (const [idx, media] of (article.media || []).entries()) {
        if (media.type === 'photo' && media.translation) {
            media_translations.push(`图片${idx + 1} alt: ${media.translation as string}`)
        }
    }
    if (media_translations.length > 0) {
        content = `${content}\n\n${media_translations.join(`\n---\n`)}`
    }
    /***** 图片描述结束 *****/

    /***** extra描述 *****/
    if (article.extra) {
        const extra = article.extra
        if (extra.translation) {
            content = `${content}\n~~~\n${extra.translation}`
        }
    }
    /***** extra描述结束 *****/
    return content
}

function parseRawContent(article: Article) {
    let content = article.content ?? ''
    let raw_alts = []
    for (const [idx, media] of (article.media || []).entries()) {
        if (media.type === 'photo' && media.alt) {
            raw_alts.push(`photo${idx + 1} alt: ${media.alt as string}`)
        }
    }
    if (raw_alts.length > 0) {
        content = `${content}\n\n${raw_alts.join(`\n---\n`)}`
    }
    if (article.extra) {
        const extra = article.extra
        // card parser
        if (extra.content && !isDuplicateExtraContent(content, extra.content)) {
            content = `${content}\n~~~\n${extra.content}`
        }
    }
    return content
}

function normalizeComparableText(text: string | null | undefined) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[【】「」『』"'“”‘’\[\]()（）]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase()
}

function extractLeadingTitleCandidates(content: string) {
    const lines = content
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    const candidates = new Set<string>()
    const first = lines[0] || ''
    const bracketed = first.match(/^【(.+?)】$/)?.[1]
    if (bracketed) {
        candidates.add(bracketed)
    }
    if (first) {
        candidates.add(first)
    }
    return Array.from(candidates)
}

function isDuplicateExtraContent(content: string, extraContent: string) {
    const normalizedExtra = normalizeComparableText(extraContent)
    if (!normalizedExtra) {
        return true
    }

    if (
        extractLeadingTitleCandidates(content).some(
            (candidate) => normalizeComparableText(candidate) === normalizedExtra,
        )
    ) {
        return true
    }

    return content
        .split(/\n{2,}/)
        .map(normalizeComparableText)
        .some((block) => block === normalizedExtra)
}

function truncateCompactText(text: string, maxLength: number) {
    const normalized = text.trim()
    if (!normalized || normalized.length <= maxLength) {
        return normalized
    }

    const slice = normalized.slice(0, maxLength)
    const softCut = Math.max(
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('。'),
        slice.lastIndexOf('！'),
        slice.lastIndexOf('？'),
    )
    const cutIndex = softCut > Math.floor(maxLength * 0.6) ? softCut + 1 : maxLength
    return `${slice.slice(0, cutIndex).trimEnd()}……`
}

function extractTextHeadline(text: string, maxLength: number = 80) {
    const lines = text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

    if (lines.length === 0) {
        return ''
    }

    const headline =
        lines.find((line) => !/^[-~～—─＿=]+$/.test(line) && !/^(photo|图片)\d+\s+alt:/i.test(line)) || lines[0] || ''

    return truncateCompactText(headline.replace(/\s+/g, ' '), maxLength)
}

function extractArticleHeadline(article: Article, maxLength: number = 80) {
    const candidates = [
        article.content,
        article.translation,
        article.extra?.content,
        article.extra?.translation,
        `${article.username || ''} ${platformNameMap[article.platform] || ''}`.trim(),
    ]

    for (const candidate of candidates) {
        const headline = extractTextHeadline(String(candidate || ''), maxLength)
        if (headline) {
            return headline
        }
    }

    return truncateCompactText(formatCompactMetaline(article).replace(/\s+/g, ' '), maxLength)
}

function parseCompactRawContent(article: Article) {
    const raw = parseRawContent(article)
    if (article.platform !== Platform.YouTube) {
        return raw
    }

    const [title = '', ...rest] = raw.split(/\n{2,}/)
    const description = rest.join('\n\n').trim()
    if (!description) {
        return raw
    }

    const compactDescription = truncateCompactText(description, 360)
    if (compactDescription === description) {
        return raw
    }

    return `${title.trim()}\n\n${compactDescription}\n\n[描述过长，已截断，完整内容请打开链接查看]`
}

/**
 * 原文 -> 媒体文件alt -> extra
 */
function getArticleStableId(article: Article) {
    return (article as any).id ?? `${article.platform}:${article.a_id}`
}

function shouldCollapseArticle(article: Article, options?: ArticleTextOptions) {
    return options?.collapsedArticleIds?.has(getArticleStableId(article)) === true
}

function formatCollapsedReferenceId(article: Article) {
    const id = String(article.u_id || article.username || article.a_id || '').trim()
    if (!id) {
        return 'ref'
    }
    if (id.startsWith('@') || id.includes(':')) {
        return id
    }
    return `@${id}`
}

function formatCollapsedReferenceTime(article: Article, rootArticle: Article) {
    if (!article.created_at) {
        return ''
    }
    const sameRenderDate =
        rootArticle.created_at && formatDateKey(article.created_at) === formatDateKey(rootArticle.created_at)
    return sameRenderDate ? formatClock(article.created_at) : formatTime(article.created_at)
}

function formatCollapsedReferenceToken(article: Article, rootArticle: Article) {
    return [formatCollapsedReferenceId(article), formatCollapsedReferenceTime(article, rootArticle)]
        .filter(Boolean)
        .join(' ')
}

function formatCollapsedReferenceChain(article: Article, rootArticle: Article, options?: ArticleTextOptions) {
    const tokens: Array<string> = []
    let currentArticle: Article | null = article
    while (currentArticle && shouldCollapseArticle(currentArticle, options)) {
        tokens.push(formatCollapsedReferenceToken(currentArticle, rootArticle))
        currentArticle = currentArticle.ref && typeof currentArticle.ref === 'object' ? currentArticle.ref : null
    }

    return `${tokens.join('、')}（略）`
}

function articleToText(article: Article, options?: ArticleTextOptions) {
    let currentArticle: Article | null = article
    const rootArticle = article
    let format_article = ''
    let isRoot = true
    while (currentArticle) {
        if (!isRoot && shouldCollapseArticle(currentArticle, options)) {
            format_article += formatCollapsedReferenceChain(currentArticle, rootArticle, options)
            break
        }
        const segmentStart = format_article.length
        format_article += formatArticleHeaderLine(currentArticle)
        if (currentArticle.translated_by && !options?.textOriginalOnly) {
            let translation = parseTranslationContent(currentArticle)
            format_article += `\n\n${translation}\n${'-'.repeat(6)}↑译文--↓原文${'-'.repeat(6)}\n`
        }

        /* 原文 */
        let raw_article = parseRawContent(currentArticle)
        if (!currentArticle.translated_by && raw_article) {
            format_article += '\n\n'
        }
        format_article += raw_article
        if (raw_article || currentArticle.translated_by) {
            format_article += '\n\n'
            format_article += formatArticleAttributionLine(currentArticle)
        } else {
            format_article = `${format_article.slice(0, segmentStart)}${formatEmptyBodyArticleLine(currentArticle)}`
        }
        if (currentArticle.ref) {
            format_article += `\n${'-'.repeat(12)}\n`
        }
        // get ready for next run
        if (currentArticle.ref && typeof currentArticle.ref === 'object') {
            currentArticle = currentArticle.ref
            isRoot = false
        } else {
            currentArticle = null
        }
    }
    return format_article
}

function compactArticleToText(article: Article, options?: ArticleTextOptions) {
    let currentArticle: Article | null = article
    const rootArticle = article
    let format_article = ''
    let isRoot = true
    while (currentArticle) {
        if (!isRoot && shouldCollapseArticle(currentArticle, options)) {
            format_article += formatCollapsedReferenceChain(currentArticle, rootArticle, options)
            break
        }
        const segmentStart = format_article.length
        format_article += formatArticleHeaderLine(currentArticle)
        if (currentArticle.translated_by && !options?.textOriginalOnly) {
            const translation = parseTranslationContent(currentArticle)
            format_article += `\n\n${translation}\n${'-'.repeat(6)}↑译文--↓原文${'-'.repeat(6)}\n`
        }

        const raw_article = parseCompactRawContent(currentArticle)
        if (!currentArticle.translated_by && raw_article) {
            format_article += '\n\n'
        }
        format_article += raw_article
        if (raw_article || currentArticle.translated_by) {
            format_article += '\n\n'
            format_article += formatArticleAttributionLine(currentArticle)
        } else {
            format_article = `${format_article.slice(0, segmentStart)}${formatEmptyBodyArticleLine(currentArticle)}`
        }
        if (currentArticle.ref) {
            format_article += `\n${'-'.repeat(12)}\n`
        }
        if (currentArticle.ref && typeof currentArticle.ref === 'object') {
            currentArticle = currentArticle.ref
            isRoot = false
        } else {
            currentArticle = null
        }
    }
    return format_article
}

function followsToText(data: Array<[Platform, Array<[Follows, Follows | null]>]>) {
    // follows to texts
    const texts = [] as Array<string>
    // convert to string
    for (let [platform, follows] of data) {
        if (follows.length === 0) {
            continue
        }
        // 按粉丝数量大的排序
        follows = orderBy(follows, (f) => f[0].followers, 'desc')
        const follow = follows[0]
        if (!follow) {
            continue
        }
        const [cur, pre] = follow
        let text_to_send =
            `${platformNameMap[platform]}:\n${pre?.created_at ? `${formatTime(pre.created_at)}\n⬇️\n` : ''}${formatTime(cur.created_at)}\n\n` +
            follows
                .map(([cur, pre]) => {
                    let text = `${cur.username}\n`
                    if (pre?.followers) {
                        text += `${pre.followers.toString().padStart(2)}  --->  `
                    }
                    if (cur.followers) {
                        text += `${cur.followers.toString().padEnd(2)}`
                    }
                    const offset = (cur.followers || 0) - (pre?.followers || 0)
                    text += ` ${offset >= 0 ? '+' : ''}${offset.toString()}`
                    return text
                })
                .join('\n')
        texts.push(text_to_send)
    }
    return texts.join('\n\n')
}

function formatWebsiteCardText(article: Article) {
    const data = article.extra?.extra_type === 'website_meta' ? ((article.extra.data as any) ?? null) : null
    const feed = String(data?.feed || '').trim()
    const label = WEBSITE_FEED_LABELS[feed] || '更新'
    const headingLabel = feed === 'photo' ? `${label}📷` : label
    const author = String(data?.member || (feed === 'official-blog' ? article.username : '') || '').trim()
    const title = String(data?.title || extractArticleHeadline(article) || '').trim()
    const site = String(data?.site || '22/7').trim()
    const heading = `【${site} ${[headingLabel, author].filter(Boolean).join('｜')}】${title}`
    const attribution = [`${site}官网`, label, formatArticleDisplayAttributionTime(article)].filter(Boolean).join(' ')
    return [heading, '', attribution, article.url].filter((line) => line !== undefined).join('\n')
}

function formatMetaline(article: Article) {
    return formatArticleHeaderLine(article)
}

function formatCompactMetaline(article: Article) {
    return formatMetaline(article)
}

export {
    articleToText,
    compactArticleToText,
    type ArticleTextOptions,
    extractArticleHeadline,
    extractTextHeadline,
    followsToText,
    formatWebsiteCardText,
    formatArticleActionLabel,
    formatArticleAttributionLine,
    formatArticleAttributionTimeToken,
    formatArticleHeaderLine,
    formatArticlePlatformLabel,
    formatArticlePlainTimeToken,
    formatArticleSourceActionAttribution,
    formatArticleSourceActionLabel,
    formatArticleTimeToken,
    formatArticleUserId,
    formatCompactMetaline,
    formatMetaline,
    formatPassthroughAttributionLine,
    formatPassthroughTitleLine,
    formatTime,
    formatTranslationPassthrough,
    parseRawContent,
    parseTranslationContent,
    PASSTHROUGH_CARD_DEFERRED_MARKER,
}
