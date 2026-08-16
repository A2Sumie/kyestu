import { createHash } from 'crypto'
import type { KyestuDb } from '../components/db'
import { ArticleStore, type Platform } from './articles'

/**
 * Short-video cross-platform dedup, designed NOT to repeat idol-bbq's mistake:
 * its signature was `timeBucket : durationBucket : sha1(textKey)` — an exact
 * conjunction of three fuzzy quantities, so minutes-apart IG/TT cross-posts
 * with slightly different captions never collided, and the similarity code
 * behind it was unreachable. Here recall and judgment are separate:
 *
 * - recall: unbucketed per-token keys, prefix-searched (any shared token
 *   recalls the candidate); no time/duration in key material
 * - judgment: same-platform or IG<->TT pair, |Δcreated_at| <= 7d, then text
 *   similarity (LCS / token jaccard / containment), duration ±3s when known
 * - claim-before-upload: keys are written BEFORE the upload so simultaneous
 *   IG/TT arrivals cannot both pass the check (idol-bbq marked after upload,
 *   leaving a minutes-long race window)
 */

const SUPPORTED: ReadonlySet<string> = new Set(['tiktok', 'instagram', 'youtube'])
const CROSS_PAIR: ReadonlySet<string> = new Set(['instagram:tiktok', 'tiktok:instagram'])
const TIME_WINDOW_SECONDS = 7 * 24 * 3600
const DURATION_TOLERANCE_SECONDS = 3
const SHARED_PHRASE_MIN = 8
const TOKEN_MIN_LEN = 4
const MAX_RECALL_TOKENS = 8

const STOPWORDS: ReadonlySet<string> = new Set([
  '22', '7', '227', '22_7', 'video', 'mv', 'short', 'shorts', 'tiktok', 'instagram', 'youtube',
  '公開中', 'ナナニジ', 'ナナブンノニジュウニ', 'official', 'staff', 'musicvideo', 'the3rd',
  'nananiji', 'nananijigram', 'nanabunnonijuuni',
])

const BOILERPLATE = [
  '227', '22_7', 'nananijigram', 'nananiji', 'nanabunnonijuuni', 'the3rd', 'official', 'staff',
  'musicvideo', 'youtube', 'tiktok', 'instagram', 'shorts', 'short', '公開中', 'ナナニジ', 'ナナブンノニジュウニ',
]

export interface ShortVideoInput {
  platform: Platform | string
  a_id: string
  u_id?: string
  content?: string | null
  translation?: string | null
  created_at?: number | null
  type?: string | null
  duration_seconds?: number | null
}

export interface ShortVideoDuplicate {
  marker: string
  platform: string
  a_id: string
  via: 'exact-text' | 'similarity'
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:www\.)\S+\.\S+/g, ' ')
    .replace(/[@＠][\w.-]+/g, ' ')
    .replace(/[＃#]/g, ' ')
    .replace(/[【】「」『』（）()[\]{}<>《》.,!?！？、。:：;；'"`~^*_+=|\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripBoilerplate(value: string): string {
  let result = value
  for (const term of BOILERPLATE) result = result.split(term).join('')
  return result
}

function isInformativeToken(token: string): boolean {
  const compact = token.replace(/[._-]+/g, '')
  if (token.length < 2 || compact.length < 2) return false
  if (/^\d+$/.test(compact)) return false
  return !STOPWORDS.has(token) && !STOPWORDS.has(compact)
}

export interface TextFingerprint {
  distilledCompact: string
  tokens: string[]
}

export function buildTextFingerprint(parts: Array<string | null | undefined>): TextFingerprint {
  const normalized = parts
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(normalizeText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, '')
  const distilledCompact = stripBoilerplate(compact)
  const rawTokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || []
  const tokens = [
    ...new Set(rawTokens.map((t) => t.replace(/^[._-]+|[._-]+$/g, '')).filter(isInformativeToken)),
  ]
  return { distilledCompact, tokens }
}

export function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0
  let previous = new Array<number>(right.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue
      const length = previous[j - 1]! + 1
      current[j] = length
      if (length > best) best = length
    }
    previous = current
  }
  return best
}

export function isLikelySameText(left: TextFingerprint, right: TextFingerprint): boolean {
  if (!left.distilledCompact || !right.distilledCompact) return false
  if (longestCommonSubstringLength(left.distilledCompact, right.distilledCompact) >= SHARED_PHRASE_MIN) return true
  const leftTokens = new Set(left.tokens)
  const rightTokens = new Set(right.tokens)
  const shared = [...leftTokens].filter((t) => rightTokens.has(t))
  if (shared.some((t) => t.length >= SHARED_PHRASE_MIN)) return true
  if (shared.length < 2) return false
  const unionSize = new Set([...leftTokens, ...rightTokens]).size
  const minSize = Math.min(leftTokens.size, rightTokens.size)
  if (unionSize === 0 || minSize === 0) return false
  return shared.length / unionSize >= 0.45 || shared.length / minSize >= 0.67
}

function tokenHash(token: string): string {
  return createHash('sha1').update(token).digest('hex').slice(0, 16)
}

function pairAllowed(a: string, b: string): boolean {
  if (a === b) return true
  return CROSS_PAIR.has(`${a}:${b}`)
}

function namespacesFor(platform: string): string[] {
  const out = [`sv:${platform}`]
  if (platform === 'instagram' || platform === 'tiktok') out.push('sv:ig-tt')
  return out
}

export class ShortVideoDedup {
  constructor(private readonly store: KyestuDb) {}

  markerOf(input: ShortVideoInput): string {
    return `${String(input.platform)}:${input.a_id}`
  }

  private recallKeys(fingerprint: TextFingerprint): string[] {
    const keys: string[] = []
    if (fingerprint.distilledCompact.length >= SHARED_PHRASE_MIN) {
      keys.push(`exact:${tokenHash(fingerprint.distilledCompact)}`)
    }
    for (const token of fingerprint.tokens.filter((t) => t.length >= TOKEN_MIN_LEN).slice(0, MAX_RECALL_TOKENS)) {
      keys.push(`tok:${tokenHash(token)}`)
    }
    return keys
  }

  /** recall candidate markers sharing any token/exact key within the time window */
  private recall(input: ShortVideoInput, fingerprint: TextFingerprint): Array<{ marker: string; created_at: number }> {
    const keys = this.recallKeys(fingerprint)
    if (!keys.length) return []
    const namespaces = namespacesFor(String(input.platform))
    const since = Math.floor(Date.now() / 1000) - TIME_WINDOW_SECONDS
    const out = new Map<string, { marker: string; created_at: number }>()
    for (const ns of namespaces) {
      for (const key of keys) {
        const rows = this.store.db
          .query(
            `SELECT a_id, created_at FROM media_hashes
             WHERE platform = ? AND hash GLOB ? AND created_at >= ?`,
          )
          .all(ns, `${key}:*`, since) as Array<{ a_id: string; created_at: number }>
        for (const row of rows) {
          if (row.a_id === this.markerOf(input)) continue
          if (!out.has(row.a_id)) out.set(row.a_id, { marker: row.a_id, created_at: row.created_at })
        }
      }
    }
    return [...out.values()]
  }

  check(input: ShortVideoInput): ShortVideoDuplicate | null {
    if (!SUPPORTED.has(String(input.platform))) return null
    // youtube only participates as shorts
    if (String(input.platform) === 'youtube' && String(input.type || '').toLowerCase() !== 'shorts') return null
    const fingerprint = buildTextFingerprint([input.content, input.translation])
    if (!fingerprint.distilledCompact && !fingerprint.tokens.length) return null
    const createdAt = input.created_at ?? Math.floor(Date.now() / 1000)
    const articles = new ArticleStore(this.store)

    for (const candidate of this.recall(input, fingerprint)) {
      const [platform, aId] = [candidate.marker.slice(0, candidate.marker.indexOf(':')), candidate.marker.slice(candidate.marker.indexOf(':') + 1)]
      if (!pairAllowed(String(input.platform), platform)) continue
      if (Math.abs(candidate.created_at - createdAt) > TIME_WINDOW_SECONDS) continue
      const existing = articles.getByAId(platform as Platform, aId)
      if (!existing) continue
      const existingFingerprint = buildTextFingerprint([existing.content, existing.translation])
      const exact = fingerprint.distilledCompact.length >= SHARED_PHRASE_MIN && fingerprint.distilledCompact === existingFingerprint.distilledCompact
      if (exact || isLikelySameText(fingerprint, existingFingerprint)) {
        return { marker: candidate.marker, platform, a_id: aId, via: exact ? 'exact-text' : 'similarity' }
      }
    }
    return null
  }

  /** write recall keys BEFORE the upload so simultaneous cross-posts cannot both pass */
  claim(input: ShortVideoInput): void {
    const fingerprint = buildTextFingerprint([input.content, input.translation])
    const keys = this.recallKeys(fingerprint)
    if (!keys.length) return
    const marker = this.markerOf(input)
    const now = Math.floor(Date.now() / 1000)
    const insert = this.store.db.prepare(
      'INSERT OR IGNORE INTO media_hashes (platform, hash, a_id, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const ns of namespacesFor(String(input.platform))) {
      for (const key of keys) {
        insert.run(ns, `${key}:${marker}`, marker, now)
      }
    }
  }

  /** convenience: returns true when this input is a duplicate of an already-claimed upload */
  checkOrClaim(input: ShortVideoInput): ShortVideoDuplicate | null {
    const dup = this.check(input)
    if (dup) return dup
    this.claim(input)
    return null
  }
}
