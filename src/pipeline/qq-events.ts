/**
 * Inbound QQ event layer (pure, no I/O): dual-dialect normalization of OneBot v11
 * event payloads (SnowLuma + NapCat), webhook request authentication, stable
 * dedupe keys, and the normalized event contract consumed by the reaction
 * engine (pipeline/qq-reactions.ts) and the `qq` bus channel.
 *
 * Dialect notes (REPORT_snowluma_capabilities §3.2):
 *  - SnowLuma and NapCat both speak OneBot v11 `post_type` events; they differ
 *    in *which* notice subtypes exist (SnowLuma adds `bot_offline`, `essence`,
 *    `group_card`, `notify/input_status`, `group_msg_emoji_like`) and in the
 *    `message` field shape (`array` segments vs `string` CQ codes, configured
 *    per adapter as `messageFormat`). Both shapes are normalized here.
 *  - SnowLuma `httpClients` webhooks sign the raw body as
 *    `X-Signature: sha1=<hmac-sha1-hex(secret, rawBody)>` (secret = the
 *    adapter's accessToken) and set `X-Self-ID` to the sending UIN.
 *  - The SnowLuma account notifications webhook (config/notifications.json,
 *    templated body) is accepted in the minimal `{uin|self_id, event:
 *    'online'|'offline'}` JSON shape and normalized as kind `notification`.
 */
import { createHmac, timingSafeEqual } from 'crypto'

export type QqEventKind = 'message' | 'message_sent' | 'notice' | 'request' | 'meta_event' | 'notification' | 'unknown'

export type QqEventScope = 'group' | 'friend' | null

/** normalized inbound event: what rules match on and the `qq` bus payload */
export interface QqInboundEvent {
  /** stable dedupe key — webhook re-deliveries map to the same key */
  key: string
  kind: QqEventKind
  /** 'group' | 'friend' | null — reply destination scope */
  scope: QqEventScope
  groupId: number | null
  /** sender / acting user */
  userId: number | null
  /** bot UIN the event belongs to (multi-UIN attribution) */
  selfId: number | null
  senderName: string | null
  senderRole: string | null
  messageId: number | null
  /** OneBot epoch seconds (0 when absent) */
  time: number
  text: string
  /** @-targets extracted from the message field */
  mentions: number[]
  noticeType: string | null
  noticeSubType: string | null
  requestType: string | null
  metaEventType: string | null
  /** true when replayed from history backfill instead of live-reported */
  recovered: boolean
  raw: unknown
}

function intOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function strOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value)
}

/** CQ-code unescape (OneBot string format) */
function cqUnescape(value: string): string {
  return value.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

/**
 * Flatten a OneBot `message` field (segment array | CQ string | object) into
 * plain text plus @-mentions. Kept in sync with pipeline/qq-messages.messageText
 * but also decodes CQ strings and collects mentions for rule matching.
 */
export function parseMessageField(message: unknown): { text: string; mentions: number[] } {
  const mentions: number[] = []
  if (typeof message === 'string') {
    // CQ string: literal text around [CQ:type,k=v,...] codes
    let text = ''
    const re = /\[CQ:([a-z_]+)(?:,([^\]]*))?\]/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(message))) {
      text += cqUnescape(message.slice(last, match.index))
      last = match.index + match[0].length
      const type = match[1]!
      const params = new Map<string, string>()
      for (const pair of (match[2] ?? '').split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) params.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
      if (type === 'at') {
        const qq = intOrNull(params.get('qq'))
        if (qq !== null) mentions.push(qq)
        text += params.get('text') ?? `@${qq ?? ''}`
      } else if (type === 'text') {
        text += cqUnescape(params.get('text') ?? '')
      }
    }
    text += cqUnescape(message.slice(last))
    return { text, mentions }
  }
  if (Array.isArray(message)) {
    let text = ''
    for (const segment of message as any[]) {
      const type = String(segment?.type ?? '')
      const data = segment?.data ?? segment ?? {}
      if (type === 'text') text += String(data.text ?? '')
      else if (type === 'at') {
        const qq = intOrNull(data.qq ?? data.user_id)
        if (qq !== null) mentions.push(qq)
        text += String(data.text ?? `@${qq ?? ''}`)
      }
    }
    return { text, mentions }
  }
  return { text: '', mentions }
}

/** `sha1=<hmac-sha1-hex(secret, rawBody)>` — the SnowLuma/NapCat httpClients signature */
export function signEventBody(secret: string, rawBody: string): string {
  return `sha1=${createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex')}`
}

/**
 * Verify `X-Signature` (or `sha1=<hex>` without prefix) over the exact raw
 * body string. Timing-safe compare; a length mismatch is a plain false.
 */
export function verifyEventSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!secret || !header) return false
  const provided = header.trim().toLowerCase().replace(/^sha1=/, '')
  if (!/^[0-9a-f]{40}$/.test(provided)) return false
  const expected = signEventBody(secret, rawBody).slice('sha1='.length)
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function hashKey(prefix: string, raw: unknown): string {
  // JSON.parse preserves payload key order, so an identical re-delivery
  // serializes identically; a ~2^64 collision budget is plenty for an audit key
  const digest = createHmac('sha1', 'kyestu-qq-inbound').update(JSON.stringify(raw) ?? '').digest('hex').slice(0, 24)
  return `${prefix}:${digest}`
}

/** dedupe key for a payload we could not normalize at all (audit trail) */
export function junkDedupeKey(rawBody: string): string {
  return `bad:${createHmac('sha1', 'kyestu-qq-inbound').update(rawBody, 'utf8').digest('hex').slice(0, 24)}`
}

/** `group:<id>` / `friend:<id>` scope key — same format as qq_messages scopes */
export function eventScopeKey(event: Pick<QqInboundEvent, 'scope' | 'groupId' | 'userId'>): string | null {
  if (event.scope === 'group' && event.groupId !== null) return `group:${event.groupId}`
  if (event.scope === 'friend' && event.userId !== null) return `friend:${event.userId}`
  return null
}

/**
 * Normalize one decoded webhook body. Returns null for junk (not an object,
 * no recognizable event shape) — the ingress records it as `bad` and skips.
 */
export function normalizeQqEvent(raw: unknown): QqInboundEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const postType = strOrNull(body.post_type)
  const selfId = intOrNull(body.self_id ?? body.uin)

  // account notifications webhook (templated body): {uin|self_id, event}
  if (!postType && (body.event === 'online' || body.event === 'offline')) {
    return {
      key: hashKey('evt', raw),
      kind: 'notification',
      scope: null,
      groupId: null,
      userId: null,
      selfId,
      senderName: null,
      senderRole: null,
      messageId: null,
      time: intOrNull(body.time) ?? 0,
      text: '',
      mentions: [],
      noticeType: 'account',
      noticeSubType: String(body.event),
      requestType: null,
      metaEventType: null,
      recovered: false,
      raw,
    }
  }
  if (!postType) return null

  const messageType = strOrNull(body.message_type)
  const groupId = intOrNull(body.group_id)
  const userId = intOrNull(body.user_id)
  const messageId = intOrNull(body.message_id)
  const scope: QqEventScope = messageType === 'group' || groupId !== null ? 'group' : messageType === 'private' ? 'friend' : groupId === null && (postType === 'notice' || postType === 'request') && userId !== null && intOrNull((body as any).target_id) !== null ? 'friend' : null

  const base = {
    scope,
    groupId,
    userId,
    selfId,
    senderName: strOrNull((body.sender as any)?.card) ?? strOrNull((body.sender as any)?.nickname),
    senderRole: strOrNull((body.sender as any)?.role),
    messageId,
    time: intOrNull(body.time) ?? 0,
    recovered: false,
    raw,
  }

  if (postType === 'message' || postType === 'message_sent') {
    const parsed = parseMessageField(body.message ?? body.raw_message)
    const scopeKey = scope === 'group' && groupId !== null ? `group:${groupId}` : scope === 'friend' && userId !== null ? `friend:${userId}` : '?'
    return {
      ...base,
      key: messageId !== null ? `msg:${scopeKey}:${messageId}` : hashKey('evt', raw),
      kind: postType === 'message' ? 'message' : 'message_sent',
      text: parsed.text,
      mentions: parsed.mentions,
      noticeType: null,
      noticeSubType: null,
      requestType: null,
      metaEventType: null,
    }
  }
  if (postType === 'notice') {
    return {
      ...base,
      key: hashKey('evt', raw),
      kind: 'notice',
      text: '',
      mentions: [],
      noticeType: strOrNull(body.notice_type),
      noticeSubType: strOrNull(body.sub_type),
      requestType: null,
      metaEventType: null,
    }
  }
  if (postType === 'request') {
    return {
      ...base,
      key: hashKey('evt', raw),
      kind: 'request',
      text: strOrNull(body.comment) ?? '',
      mentions: [],
      noticeType: null,
      noticeSubType: null,
      requestType: strOrNull(body.request_type),
      metaEventType: null,
    }
  }
  return {
    ...base,
    key: hashKey('evt', raw),
    kind: postType === 'meta_event' ? 'meta_event' : 'unknown',
    text: '',
    mentions: [],
    noticeType: null,
    noticeSubType: null,
    requestType: null,
    metaEventType: strOrNull(body.meta_event_type),
  }
}
