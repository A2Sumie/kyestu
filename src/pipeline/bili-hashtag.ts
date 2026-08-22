/**
 * X (Twitter) hashtag -> Bilibili hashtag conversion (port of
 * idol-bbq-utils app/tweet-forwarder/src/utils/bili-hashtag.ts).
 *
 * Bilibili topics use the paired form `#content#`; X hashtags are single-leading
 * (`#tag`, terminated by the first invalid character). Follows the twitter-text
 * autolink spec (VALID_HASHTAG):
 *
 * - Marker: `#` or full-width `＃`; the preceding character must be text/line start
 *   or a non-word character (`text#tag` is NOT a hashtag; boundary excludes Unicode
 *   letters, marks, decimal digits, `_` and `&`).
 * - Tag characters: `\p{L}` + `\p{M}` + `\p{Nd}` + `_` + twitter-text specials
 *   (Hebrew maqaf/geresh/gershayim, `・`, `ー`, ZWNJ/ZWJ). ASCII `-` is invalid, so
 *   `#COVID-19` parses as `#COVID` only.
 * - The tag must contain at least one letter; `#1234` is left untouched.
 * - Idempotent: a tag immediately followed by `#`/`＃` is treated as already paired.
 * - Tag characters never include whitespace: a newline can never enter `#...#`.
 */

const HASHTAG_SPECIALS = '־׳״・ー‌‍'
const HASHTAG_CHAR_CLASS = `[\\p{L}\\p{M}\\p{Nd}_${HASHTAG_SPECIALS}]`
const HASHTAG_BOUNDARY_CLASS = `[^\\p{L}\\p{M}\\p{Nd}_&]`

const X_HASHTAG_REGEX = new RegExp(`(^|${HASHTAG_BOUNDARY_CLASS})[#＃](${HASHTAG_CHAR_CLASS}+)`, 'gu')
const X_HASHTAG_LETTER_REGEX = /[\p{L}\p{M}]/u
const CLOSING_MARKERS = new Set(['#', '＃'])

export function convertXHashtagsToBiliFormat(text: string): string {
  if (!text || (!text.includes('#') && !text.includes('＃'))) return text
  return text.replace(X_HASHTAG_REGEX, (match, boundary: string, tag: string, offset: number, whole: string) => {
    if (!X_HASHTAG_LETTER_REGEX.test(tag)) return match
    if (CLOSING_MARKERS.has(whole[offset + match.length] || '')) return match
    return `${boundary}#${tag}#`
  })
}
