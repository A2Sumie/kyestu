type UnicodeRange = Array<number | number[]>

export class FontDetector {
    private rangesByLang: {
        [font: string]: UnicodeRange
    } = {}

    public async detect(
        text: string,
        fonts: string[],
    ): Promise<{
        [lang: string]: string
    }> {
        await this.load(fonts)

        const result: {
            [lang: string]: string
        } = {}

        for (const segment of text) {
            const lang = this.detectSegment(segment, fonts)
            if (lang) {
                result[lang] = result[lang] || ''
                result[lang] += segment
            }
        }

        return result
    }

    private detectSegment(segment: string, fonts: string[]): string | null {
        for (const font of fonts) {
            const range = this.rangesByLang[font]
            if (range && checkSegmentInRange(segment, range)) {
                return font
            }
        }

        return null
    }

    private async load(fonts: string[]): Promise<void> {
        let params = ''

        const existingLang = Object.keys(this.rangesByLang)
        const langNeedsToLoad = fonts.filter((font) => !existingLang.includes(font))

        if (langNeedsToLoad.length === 0) {
            return
        }

        for (const font of langNeedsToLoad) {
            params += `family=${font}&`
        }
        params += 'display=swap'

        const API = `https://fonts.googleapis.com/css2?${params}`

        const fontFace = await (
            await fetch(API, {
                headers: {
                    // Make sure it returns TTF.
                    'User-Agent':
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
                },
            })
        ).text()

        this.addDetectors(fontFace)
    }

    private addDetectors(input: string) {
        const regex = /font-family:\s*'(.+?)';.+?unicode-range:\s*(.+?);/gms
        const matches = input.matchAll(regex)
        for (const [, _lang, range] of matches) {
            if (!_lang) continue
            if (!range) continue
            const lang = _lang.replaceAll(' ', '+')

            if (!this.rangesByLang[lang]) {
                this.rangesByLang[lang] = []
            }

            this.rangesByLang[lang].push(...convert(range))
        }
    }
}

function convert(input: string): UnicodeRange {
    return input
        .split(', ')
        .map((range) => {
            range = range.replaceAll('U+', '')
            const [start, end] = range.split('-').map((hex) => parseInt(hex, 16))
            if ((end === undefined || (end !== undefined && isNaN(end))) && start) {
                return start
            }
            if (start !== undefined && end !== undefined && !isNaN(start) && !isNaN(end)) {
                return [start, end]
            }
        })
        .filter((v) => v !== undefined)
}

function checkSegmentInRange(segment: string, range: UnicodeRange): boolean {
    const codePoint = segment.codePointAt(0)
    if (!codePoint) return false

    return range.some((val) => {
        if (typeof val === 'number') {
            return codePoint === val
        } else {
            const [start, end] = val
            if (!start || !end) return false
            return start <= codePoint && codePoint <= end
        }
    })
}

// @TODO: Support font style and weights, and make this option extensible rather
// than built-in.
// @TODO: Cover most languages with Noto Sans.
export const languageFontMap = {
    'ja-JP': 'Noto+Sans+JP',
    'ko-KR': 'Noto+Sans+KR',
    'zh-CN': 'Noto+Sans+SC',
    'zh-TW': 'Noto+Sans+TC',
    'zh-HK': 'Noto+Sans+HK',
    'th-TH': 'Noto+Sans+Thai',
    'lo-LA': 'Noto+Sans+Lao',
    'bn-IN': 'Noto+Sans+Bengali',
    'ar-AR': 'Noto+Sans+Arabic',
    'hy-AM': 'Noto+Sans+Armenian',
    'ta-IN': 'Noto+Sans+Tamil',
    'ml-IN': 'Noto+Sans+Malayalam',
    'he-IL': 'Noto+Sans+Hebrew',
    'te-IN': 'Noto+Sans+Telugu',
    'km-KH': 'Noto+Sans+Khmer',
    devanagari: 'Noto+Sans+Devanagari',
    kannada: 'Noto+Sans+Kannada',
    armenian: 'Noto+Sans+Armenian',
    syriac: 'Noto+Sans+Syriac',
    tibetan: 'Noto+Serif+Tibetan',
    khmer: 'Noto+Sans+Khmer',
    ethiopic: 'Noto+Sans+Ethiopic',
    balinese: 'Noto+Sans+Balinese',
    egyptian: 'Noto+Sans+Egyptian+Hieroglyphs',
    linearA: 'Noto+Sans+Linear+A',
    vai: 'Noto+Sans+Vai',
    cherokee: 'Noto+Sans+Cherokee',
    mongolian: 'Noto+Sans+Mongolian',
    taiTham: 'Noto+Sans+Tai+Tham',
    batak: 'Noto+Sans+Batak',
    inscriptionalPahlavi: 'Noto+Sans+Inscriptional+Pahlavi',
    miao: 'Noto+Sans+Miao',
    bamum: 'Noto+Sans+Bamum',
    yi: 'Noto+Sans+Yi',
    lisu: 'Noto+Sans+Lisu',
    symbol: ['Noto+Sans+Symbols+2', 'Noto+Sans+Symbols'],
    math: 'Noto+Sans+Math',
    unknown: [
        'Noto+Sans',
        'Noto+Sans+Lisu',
        'Noto+Sans+Lao',
        'Noto+Sans+Yi',
        'Noto+Sans+Armenian',
        'Noto+Sans+Syriac',
        'Noto+Sans+Bengali',
        'Noto+Sans+Arabic',
        'Noto+Sans+Telugu',
        'Noto+Sans+Thai',
        'Noto+Sans+Tamil',
        'Noto+Sans+Malayalam',
        'Noto+Sans+Hebrew',
        'Noto+Sans+Devanagari',
        'Noto+Sans+Kannada',
        'Noto+Sans+Khmer',
        'Noto+Sans+Ethiopic',
        'Noto+Sans+Balinese',
        'Noto+Serif+Tibetan',
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
        'Noto+Sans+Symbols+2',
        'Noto+Sans+Symbols',
        'Noto+Sans+Canadian+Aboriginal',
        'Noto+Sans+Gujarati',
        'Noto+Sans+Georgian',
        'Noto+Sans+Oriya',
    ],
}
