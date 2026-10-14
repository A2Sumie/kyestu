/**
 * Media source selection for OneBot media segments — pure decision table.
 *
 * Historical kyestu behaviour: segments are built as `file://${path}`, which
 * hard-couples the bridge to kyestu's filesystem (docs/decisions.md D16 layer
 * 4). SnowLuma's `pickMediaSource` (packages/onebot/src/event-converter/
 * element-codecs.ts) accepts, in `file`/`url`/`path` fields: inline
 * `base64://` / `data:`, `http(s)://` URLs (the bridge downloads them),
 * `file://` and plain paths. `upload_file_stream` (chunked base64 upload keyed
 * by `stream_id`, returns a bot-local path) removes the shared-filesystem
 * assumption for arbitrarily large files.
 *
 * Decision table (`mode: auto`), first match wins:
 *
 * | # | condition                          | source | wire value                  |
 * |---|------------------------------------|--------|-----------------------------|
 * | 1 | dialect napcat / generic           | file   | `file://<abs path>` (legacy)|
 * | 2 | `url_base` configured              | url    | `<url_base>/<rel path>`     |
 * | 3 | photo and size <= inline_max_bytes | inline | `base64://<b64>`            |
 * | 4 | stream upload capable              | stream | (upload first → bot path)   |
 * | 5 | file fallback allowed              | file   | `file://<abs path>`         |
 *
 * Rows 1 is the compatibility rule: NapCat (legacy production) and unknown
 * bridges keep the byte-identical `file://` behaviour unless the operator
 * forces a mode; only SnowLuma (which documents URL / base64 / stream
 * support) takes the decoupled path automatically.
 *
 * Forced modes (`file`/`url`/`base64`/`stream`) pick that source directly and
 * fail loudly instead of silently substituting another one.
 */
import { createHmac, timingSafeEqual } from 'crypto'

export type MediaSourceMode = 'auto' | 'file' | 'url' | 'base64' | 'stream'
export type MediaSourceKind = 'url' | 'inline' | 'stream' | 'file'

/** default inline cap: SnowLuma's HTTP body cap is 2 MB; leave headroom for the JSON envelope */
export const DEFAULT_INLINE_MAX_BYTES = 1_500_000

export interface MediaDecisionInput {
  /** local absolute path of the media file (MediaStore / summary card) */
  path: string
  /** file size in bytes */
  size: number
  /** 'photo' | 'video' — inline base64 is photo-only */
  type: 'photo' | 'video'
  dialect: 'napcat' | 'snowluma' | 'generic'
  mode?: MediaSourceMode
  /** externally reachable base URL for the media root (e.g. https://host:3000/media) */
  urlBase?: string
  /** root the URL maps to; required to derive the relative URL path */
  mediaRoot?: string
  inlineMaxBytes?: number
  /** last-resort `file://` (shared-filesystem coupling); default true */
  allowFileFallback?: boolean
  /** `upload_file_stream` available on this bridge */
  streamCapable?: boolean
}

export interface MediaDecision {
  kind: MediaSourceKind
  /** wire value for the segment `file` field (for 'stream': the *local* path to upload) */
  value: string
  /** for 'url': the relative name under the media base (for signed URL building) */
  name?: string
}

export class MediaSourceError extends Error {}

function relativeUrlPath(path: string, mediaRoot?: string): string {
  if (!mediaRoot) return path.split('/').pop() ?? path
  const root = mediaRoot.replace(/\/+$/, '')
  if (path.startsWith(root + '/')) return path.slice(root.length + 1)
  return path.split('/').pop() ?? path
}

export function decideMediaSource(input: MediaDecisionInput): MediaDecision {
  const mode = input.mode ?? 'auto'
  const inlineMax = input.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES
  const fileFallback = input.allowFileFallback ?? true

  const asFile = (): MediaDecision => {
    if (!fileFallback && mode === 'auto') {
      throw new MediaSourceError(`no media source available for ${input.path}: file:// fallback disabled`)
    }
    return { kind: 'file', value: `file://${input.path}` }
  }

  const asUrl = (): MediaDecision => {
    const name = relativeUrlPath(input.path, input.mediaRoot)
    return { kind: 'url', value: `${input.urlBase!.replace(/\/+$/, '')}/${name}`, name }
  }

  if (mode === 'file') return { kind: 'file', value: `file://${input.path}` }
  if (mode === 'url') {
    if (!input.urlBase) throw new MediaSourceError('media mode "url" requires url_base')
    return asUrl()
  }
  if (mode === 'base64') {
    return { kind: 'inline', value: input.path }
  }
  if (mode === 'stream') {
    return { kind: 'stream', value: input.path }
  }

  // auto: unknown (generic) and NapCat bridges keep the legacy file:// source —
  // compatibility first; only SnowLuma's documented media surface decouples
  if (input.dialect !== 'snowluma') return asFile()
  if (input.urlBase) return asUrl()
  if (input.type === 'photo' && input.size <= inlineMax) return { kind: 'inline', value: input.path }
  if (input.streamCapable) return { kind: 'stream', value: input.path }
  return asFile()
}

// ── signed media URLs (opt-in serving via app/api) ─────────────────────────

/** HMAC token binding a media name to an expiry; verified by verifyMediaToken */
export function signMediaToken(name: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`${name}:${expiresAt}`).digest('hex')
}

export function verifyMediaToken(name: string, expiresAt: number, token: string, secret: string, now = Date.now()): boolean {
  // expiresAt is unix seconds (query-param friendly); now is ms
  if (!secret || !Number.isFinite(expiresAt) || expiresAt * 1000 <= now) return false
  const expected = signMediaToken(name, expiresAt, secret)
  if (token.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

/** `/media/<name>?exp=<exp>&sig=<hex>` — the bridge fetches this plain GET URL */
export function buildSignedMediaUrl(base: string, name: string, secret: string, ttlSeconds = 600, now = Date.now()): string {
  const exp = Math.floor((now + ttlSeconds * 1000) / 1000)
  const sig = signMediaToken(name, exp, secret)
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`
}
