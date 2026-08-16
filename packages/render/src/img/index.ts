import type { Article, FontConfig } from '../types'
import { getIconCode, loadEmoji, type apis } from './utils/twemoji'
import { FontDetector, languageFontMap } from './utils/font'
import { articleParser, CARD_WIDTH } from '../../template/img/DefaultCard'
import { TemplateRegistry } from '../registry'
import satori, { type Font } from 'satori'
import tailwindConfig from '../../template/img/DefaultTailwindConfig'
import { Resvg } from '@resvg/resvg-js'
import fs from 'fs'
import { Buffer } from 'buffer'

const jaSymbols = ['～', '┈', '─', '╮', '╯', '╰', '╭', '━', '┏', '┓', '┗', '┛', '＼', '＞', '＜', '゜']
const SYMBOL_FONT_FALLBACK_PATTERN = /[\u2100-\u214F\u2460-\u24FF\u3200-\u33FF]/u
const TRANSPARENT_SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    'utf8',
).toString('base64')}`

function withCache(fn: Function, maxEntries = 300) {
    const cache = new Map()
    return async (...args: string[]) => {
        const key = args.join(':')
        if (cache.has(key)) {
            // Refresh recency so hot assets survive the LRU eviction.
            const value = cache.get(key)
            cache.delete(key)
            cache.set(key, value)
            return value
        }
        const result = await fn(...args)
        cache.set(key, result)
        if (cache.size > maxEntries) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) {
                cache.delete(oldest)
            }
        }
        return result
    }
}

function isFalseEnvValue(value: string | undefined) {
    return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase())
}

function isRemoteRenderAssetEnabled() {
    return !isFalseEnvValue(process.env.RENDER_REMOTE_ASSETS)
}

function shouldLogRemoteAssetFailure() {
    return !isFalseEnvValue(process.env.RENDER_LOG_REMOTE_ASSET_FAILURES)
}

function logRemoteAssetFailure(message: string, text: string, error: unknown) {
    if (shouldLogRemoteAssetFailure()) {
        console.error(message, text, '. Error:', error)
    }
}

const detector = new FontDetector()
// Satori's `lang` prop accepts a much smaller list than our fallback-font map.
// Keep loading wider script-specific fonts, but only pass language tags Satori
// accepts; unsupported tags such as `mongolian` make the whole card render fail.
const SATORI_FONT_LANG_CODES = new Set([
    'ja-JP',
    'ko-KR',
    'zh-CN',
    'zh-TW',
    'zh-HK',
    'th-TH',
    'bn-IN',
    'ar-AR',
    'ta-IN',
    'ml-IN',
    'he-IL',
    'te-IN',
    'devanagari',
    'kannada',
    'emoji',
    'symbol',
    'math',
])

function resolveSatoriFontLang(languageCode: string) {
    return SATORI_FONT_LANG_CODES.has(languageCode) ? languageCode : undefined
}
const SYSTEM_FALLBACK_FONTS: Array<FontConfig & { paths: Array<string> }> = [
    {
        name: 'Noto Sans CJK SC',
        font_file_name: '',
        style: 'normal',
        weight: 400,
        paths: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'],
    },
    {
        name: 'Noto Sans CJK SC',
        font_file_name: '',
        style: 'normal',
        weight: 700,
        paths: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'],
    },
    {
        name: 'Noto Sans SC',
        font_file_name: '',
        style: 'normal',
        weight: 400,
        paths: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'],
    },
    {
        name: 'Noto Sans SC',
        font_file_name: '',
        style: 'normal',
        weight: 700,
        paths: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'],
    },
    {
        name: 'Noto Sans CJK JP',
        font_file_name: '',
        style: 'normal',
        weight: 400,
        paths: [
            '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
            '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
            '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
        ],
    },
    {
        name: 'Noto Sans CJK JP',
        font_file_name: '',
        style: 'normal',
        weight: 700,
        paths: [
            '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf',
            '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
        ],
    },
    {
        name: 'Noto Sans JP',
        font_file_name: '',
        style: 'normal',
        weight: 400,
        paths: [
            '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
            '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
            '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
        ],
    },
    {
        name: 'Noto Sans JP',
        font_file_name: '',
        style: 'normal',
        weight: 700,
        paths: [
            '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf',
            '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
        ],
    },
]
const BASE_FONT_EXCLUDED_NAMES = new Set(['Unifont'])
const UNIFONT_FALLBACK_CODES = new Set(['unknown', 'symbol', 'math', 'zh-CN', 'ja-JP'])
const SYMBOL_FALLBACK_FONT_NAMES = ['Noto Sans Symbols 2', 'Noto Sans Symbols', 'Unifont']

// Our own encoding of multiple fonts and their code, so we can fetch them in one request. The structure is:
// [1 byte = X, length of language code][X bytes of language code string][4 bytes = Y, length of font][Y bytes of font data]
// Note that:
// - The language code can't be longer than 255 characters.
// - The language code can't contain non-ASCII characters.
// - The font data can't be longer than 4GB.
// When there are multiple fonts, they are concatenated together.
function encodeFontInfoAsArrayBuffer(code: string, fontData: ArrayBuffer) {
    // 1 byte per char
    const buffer = new ArrayBuffer(1 + code.length + 4 + fontData.byteLength)
    const bufferView = new Uint8Array(buffer)
    // 1 byte for the length of the language code
    bufferView[0] = code.length
    // X bytes for the language code
    for (let i = 0; i < code.length; i++) {
        bufferView[i + 1] = code.charCodeAt(i)
    }

    // 4 bytes for the length of the font data
    new DataView(buffer).setUint32(1 + code.length, fontData.byteLength, false)

    // Y bytes for the font data
    bufferView.set(new Uint8Array(fontData), 1 + code.length + 4)

    return buffer
}

async function fetchFont(text: string, font: string, weight: number = 400): Promise<ArrayBuffer | null> {
    const API = `https://fonts.googleapis.com/css2?family=${font}:wght@${weight}&text=${encodeURIComponent(text)}`
    const css = await (
        await fetch(API, {
            headers: {
                // Make sure it returns TTF.
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1',
            },
        })
    ).text()

    const resource = css.match(/src: url\((.+)\) format\('(opentype|truetype)'\)/)

    if (!resource || !resource[1]) return null

    const res = await fetch(resource[1])
    const buffer = await res.arrayBuffer()

    return isSupportedOpenTypeFont(buffer) ? buffer : null
}

function isSupportedOpenTypeFont(buffer: ArrayBuffer | Buffer | null | undefined) {
    if (!buffer || buffer.byteLength < 4) {
        return false
    }
    const bytes = buffer instanceof Buffer ? buffer : Buffer.from(buffer)
    const signature = bytes.subarray(0, 4)
    const asciiSignature = signature.toString('ascii')
    return (
        asciiSignature === 'OTTO' ||
        asciiSignature === 'true' ||
        asciiSignature === 'typ1' ||
        signature.equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))
    )
}

async function loadGoogleFont(fonts: string[], text: string) {
    const textByFont = await detector.detect(text, fonts)
    const _fonts = Object.keys(textByFont)

    async function getFontResponseBuffer(weight: number) {
        const encodedFontBuffers: ArrayBuffer[] = []
        let fontBufferByteLength = 0
        ;(
            await Promise.all(
                _fonts.map((font) => {
                    if (!textByFont[font]) return
                    return fetchFont(textByFont[font], font, weight)
                }),
            )
        )
            .filter(Boolean)
            .forEach((fontData, i) => {
                if (fontData) {
                    // TODO: We should be able to directly get the language code here :)
                    const langCode = Object.entries(languageFontMap).find(([, v]) => v.includes(_fonts[i] || ''))?.[0]
                    if (langCode) {
                        const buffer = encodeFontInfoAsArrayBuffer(langCode, fontData)
                        encodedFontBuffers.push(buffer)
                        fontBufferByteLength += buffer.byteLength
                    }
                }
            })
        const responseBuffer = new ArrayBuffer(fontBufferByteLength)
        const responseBufferView = new Uint8Array(responseBuffer)
        let offset = 0
        encodedFontBuffers.forEach((buffer) => {
            responseBufferView.set(new Uint8Array(buffer), offset)
            offset += buffer.byteLength
        })
        return responseBuffer
    }
    return await Promise.all([getFontResponseBuffer(400), getFontResponseBuffer(700)])
}

// ref: https://github.com/vercel/satori/blob/78182f836b67fff48f9b6e77b7251382c2779559/playground/pages/index.tsx#L97
function loadBundledFallbackFont(name: string): Font | null {
    const fontsDir = process.env.FONTS_DIR || './assets/fonts'
    const fonts: FontConfig[] = JSON.parse(fs.readFileSync(`${fontsDir}/fonts.json`, 'utf-8'))
    const font = fonts.find((candidate) => candidate.name === name && candidate.weight === 400)
    if (!font) {
        return null
    }

    try {
        const data = fs.readFileSync(`${fontsDir}/${font.font_file_name}`)
        if (!isSupportedOpenTypeFont(data)) {
            return null
        }
        return {
            name: font.name,
            data,
            weight: font.weight,
            style: font.style,
        }
    } catch {
        return null
    }
}

function loadBundledFallbackFonts(names: Array<string>): Font[] {
    return names.map((name) => loadBundledFallbackFont(name)).filter((font): font is Font => Boolean(font))
}

function needsBundledSymbolFallback(text: string) {
    return SYMBOL_FONT_FALLBACK_PATTERN.test(text)
}

async function loadDynamicAssetUncached(emojiType: keyof typeof apis, _code: string, text: string) {
    if (_code === 'emoji') {
        if (!isRemoteRenderAssetEnabled()) {
            return TRANSPARENT_SVG_DATA_URL
        }
        // It's an emoji, load the image.
        try {
            const svg = await loadEmoji(emojiType, getIconCode(text))
            return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
        } catch (error) {
            logRemoteAssetFailure('Failed to load emoji asset for', text, error)
            return TRANSPARENT_SVG_DATA_URL
        }
    }

    const codes = _code.split('|')
    // Some magic symbol
    if (codes.includes('symbol') && !codes.includes('ja-JP') && jaSymbols.some((s) => text.includes(s))) {
        codes.push('ja-JP')
    }
    if (needsBundledSymbolFallback(text) && !codes.includes('symbol')) {
        codes.push('symbol')
    }

    // Try to load from Google Fonts.
    const fonts = codes
        .map((code) => languageFontMap[code as keyof typeof languageFontMap])
        .filter(Boolean)
        .flat()

    if (!isRemoteRenderAssetEnabled()) {
        if (codes.includes('symbol')) {
            return loadBundledFallbackFonts(SYMBOL_FALLBACK_FONT_NAMES)
        }
        if (codes.some((code) => UNIFONT_FALLBACK_CODES.has(code))) {
            const unifont = loadBundledFallbackFont('Unifont')
            return unifont ? [unifont] : []
        }
        return []
    }

    if (fonts.length === 0) return []

    try {
        const [normalBuffer, boldBuffer] = await loadGoogleFont(fonts, text)

        const res_fonts: any[] = []

        // Decode the encoded font format.
        const decodeFontInfoFromArrayBuffer = (buffer: ArrayBuffer, weight: number) => {
            let offset = 0
            const bufferView = new Uint8Array(buffer)

            while (offset < bufferView.length) {
                // 1 byte for font name length.
                const languageCodeLength = bufferView[offset]
                offset += 1
                let languageCode = ''
                //@ts-ignore
                for (let i = 0; i < languageCodeLength; i++) {
                    //@ts-ignore
                    languageCode += String.fromCharCode(bufferView[offset + i])
                }
                //@ts-ignore
                offset += languageCodeLength

                // 4 bytes for font data length.
                const fontDataLength = new DataView(buffer).getUint32(offset, false)
                offset += 4
                const fontData = buffer.slice(offset, offset + fontDataLength)
                offset += fontDataLength

                res_fonts.push({
                    name: `satori_${languageCode}_fallback_${text}`,
                    data: fontData,
                    weight: weight,
                    style: 'normal',
                    lang: resolveSatoriFontLang(languageCode),
                })
            }
        }

        decodeFontInfoFromArrayBuffer(normalBuffer, 400)
        decodeFontInfoFromArrayBuffer(boldBuffer, 700)

        return res_fonts
    } catch (e) {
        logRemoteAssetFailure('Failed to load dynamic font for', text, e)
    }

    if (codes.some((code) => UNIFONT_FALLBACK_CODES.has(code))) {
        if (codes.includes('symbol')) {
            const bundledSymbolFonts = loadBundledFallbackFonts(SYMBOL_FALLBACK_FONT_NAMES)
            if (bundledSymbolFonts.length > 0) {
                return bundledSymbolFonts
            }
        }
        const unifont = loadBundledFallbackFont('Unifont')
        return unifont ? [unifont] : []
    }

    return []
}

const loadCachedDynamicAsset = withCache(loadDynamicAssetUncached)

async function loadDynamicAsset(emojiType: keyof typeof apis, _code: string, text: string) {
    if (!isRemoteRenderAssetEnabled()) {
        return loadDynamicAssetUncached(emojiType, _code, text)
    }
    return loadCachedDynamicAsset(emojiType, _code, text)
}

function resolveRasterScale(article: Article, height: number) {
    const isMessagePack = String((article as any).type || '') === 'message_pack'
    const isLongRenderedCard = height >= CARD_WIDTH * 1.5
    return isMessagePack || isLongRenderedCard ? 2 : 1.5
}

class ImgConverter {
    private fonts: Array<FontConfig>
    private cachedFontOptions: Font[] | null = null
    constructor() {
        const fontsDir = process.env.FONTS_DIR || './assets/fonts'
        const fonts: FontConfig[] = JSON.parse(fs.readFileSync(`${fontsDir}/fonts.json`, 'utf-8'))
        this.fonts = fonts
    }

    private loadBundledFonts(): Font[] {
        return this.fonts
            .filter((font) => !BASE_FONT_EXCLUDED_NAMES.has(font.name))
            .map((font) => {
                try {
                    const data = fs.readFileSync(`${process.env.FONTS_DIR || './assets/fonts'}/${font.font_file_name}`)
                    if (!isSupportedOpenTypeFont(data)) {
                        return undefined
                    }
                    return {
                        name: font.name,
                        data,
                        weight: font.weight,
                        style: font.style,
                    }
                } catch (e) {
                    return undefined
                }
            })
            .filter(Boolean) as Font[]
    }

    private loadSystemFallbackFonts(): Font[] {
        return SYSTEM_FALLBACK_FONTS.map((font) => {
            const path = font.paths.find((candidate) => fs.existsSync(candidate))
            if (!path) {
                return undefined
            }
            try {
                const data = fs.readFileSync(path)
                if (!isSupportedOpenTypeFont(data)) {
                    return undefined
                }
                return {
                    name: font.name,
                    data,
                    weight: font.weight,
                    style: font.style,
                }
            } catch {
                return undefined
            }
        }).filter(Boolean) as Font[]
    }

    /**
     * Every render used to re-read and re-parse the full bundled font set plus
     * the system fallback fonts (tens of MB per card in the container image).
     * satori treats Font.data as read-only, so the same buffers can be shared
     * across renders; cache them on the converter instance.
     */
    private getFontOptions(): Font[] {
        if (this.cachedFontOptions) {
            return this.cachedFontOptions
        }
        this.cachedFontOptions = [...this.loadBundledFonts(), ...this.loadSystemFallbackFonts()]
        return this.cachedFontOptions
    }

    public async articleToImg(
        article: Article,
        template?: string | { templateName?: string; features?: Array<string> },
    ) {
        const templateName = typeof template === 'string' ? template : template?.templateName
        const parser = TemplateRegistry.getInstance().getOrDefault(templateName)
        const { height, component: Card } = parser(article, typeof template === 'string' ? undefined : template)
        const fontsOptions: Font[] = this.getFontOptions()
        const svg = await satori(Card, {
            width: CARD_WIDTH,
            height: height,
            fonts: fontsOptions,
            loadAdditionalAsset: (code: string, text: string) => {
                const result = loadDynamicAsset('twemoji', code, text)
                // loadDynamicAsset returns Promise, need to handle await or ensure satori supports promises (it usually does for loadAdditionalAsset)
                // Checking usage in original code: return loadDynamicAsset(...)
                return result as Promise<string | import('satori').Font[]>
            },
            tailwindConfig,
        })
        const fontsDir = process.env.FONTS_DIR || './assets/fonts'
        const resvg = new Resvg(svg, {
            fitTo: {
                mode: 'width',
                value: Math.round(CARD_WIDTH * resolveRasterScale(article, height)),
            },
            font: {
                fontDirs: [fontsDir],
                loadSystemFonts: true,
                defaultFontFamily: 'Noto Sans',
            },
        })
        const data = resvg.render()
        const buffer = data.asPng()
        return buffer
    }
}

export { loadDynamicAsset, ImgConverter, isSupportedOpenTypeFont, resolveSatoriFontLang }
