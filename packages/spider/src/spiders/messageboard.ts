import { Platform } from '../types'
import type { CrawlEngine, GenericArticle, TaskType, TaskTypeResult } from '../types'
import { BaseSpider } from './base'

/**
 * encrypted message board reader (X570 FileDrop internal service).
 *
 * Protocol (see tools/x570-filedrop/UIE-READ-API.md):
 *  - wss://drop.n2nj.moe/ws, full TLS via cloudflared
 *  - ECDH P-256 handshake -> HKDF-SHA256 (salt = clientPub || serverPub, info = "3f9a2c7e")
 *    -> AES-256-GCM session key; every business message is sealed flannel {radish: nonce, saffron: ct+tag}
 *  - auth: daikon {verbena: "stp<id><password>"} (password mode; no clock drift)
 *  - read: narcissus -> marmot {tangerine: [...]} (<=200, newest first); opossum marks read
 *
 * Gated by IDOL_BBQ_MESSAGEBOARD_ENABLED=1 (off by default; idol-bbq is public). The credential comes
 * from the UIE_PASSWORD env (full verbena string) and must never be committed.
 */

export enum ArticleTypeEnum {
    ARTICLE = 'article',
}

export const MESSAGEBOARD_ENABLED_FLAG = 'IDOL_BBQ_MESSAGEBOARD_ENABLED'
export const UIE_PASSWORD_ENV = 'UIE_PASSWORD'
export const MESSAGEBOARD_WS_URL = 'wss://drop.n2nj.moe/ws'
export const MESSAGEBOARD_KDF_INFO = '3f9a2c7e'
export const UIE_AUTH_PREFIX = 'stp'
export const MESSAGEBOARD_READ_TIMEOUT_MS = 20000
// Cloudflare edge rejects the WS upgrade without a browser-ish UA / matching Origin.
export const MESSAGEBOARD_WS_HEADERS: Record<string, string> = {
    'User-Agent': 'N2NJ-Stream-Bot/1.0',
    Origin: 'https://drop.n2nj.moe',
}

export interface MessageBoardMessage {
    id: string
    ts: string
    to?: string
    anonymous?: boolean
    publicReply?: boolean
    read?: boolean
    name?: string | null
    contactType?: string | null
    contact?: string | null
    platform?: string
    body?: string
    remoteIp?: string
    replyBiscuit?: string | null
    replyCode?: string | null
    replyCount?: number | null
}

export interface MessageBoardReadOptions {
    wsUrl?: string
    verbena?: string
    timeoutMs?: number
    markRead?: boolean
    connectImpl?: (url: string) => WebSocket
}

type MinimalLog = {
    debug?: (...args: any[]) => void
    info?: (...args: any[]) => void
    warn?: (...args: any[]) => void
}

function base64urlEncode(value: Uint8Array | ArrayBuffer): string {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
    return bytes as unknown as Uint8Array<ArrayBuffer>
}

function concatBytes(...parts: Array<Uint8Array>): Uint8Array<ArrayBuffer> {
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
        out.set(part, offset)
        offset += part.length
    }
    return out
}

async function importEcdhPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

async function deriveUieSessionKey(
    clientPublicRaw: Uint8Array,
    serverPublicRaw: Uint8Array,
    sharedBits: ArrayBuffer,
): Promise<CryptoKey> {
    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
    const salt = concatBytes(clientPublicRaw, serverPublicRaw)
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(MESSAGEBOARD_KDF_INFO) },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    )
}

async function sealMessageBoardMessage(sessionKey: CryptoKey, plain: unknown): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        sessionKey,
        new TextEncoder().encode(JSON.stringify(plain)),
    )
    return JSON.stringify({
        type: 'flannel',
        radish: base64urlEncode(nonce),
        saffron: base64urlEncode(new Uint8Array(ciphertext)),
    })
}

async function unsealMessageBoardMessage<T>(sessionKey: CryptoKey, raw: string): Promise<T> {
    const sealed = JSON.parse(raw) as { type?: string; radish?: string; saffron?: string }
    if (sealed?.type !== 'flannel' || !sealed.radish || !sealed.saffron) {
        throw new Error(`留言板 unexpected message: ${raw.slice(0, 120)}`)
    }
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64urlDecode(sealed.radish) },
        sessionKey,
        base64urlDecode(sealed.saffron),
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

/**
 * Connect, handshake, authenticate and pull messages. Returns the marmot list and marks
 * messages read (opossum) before closing, matching the recommended read-then-consume flow.
 */
export async function readMessageBoardMessages(
    options: MessageBoardReadOptions = {},
): Promise<Array<MessageBoardMessage>> {
    const wsUrl = options.wsUrl || MESSAGEBOARD_WS_URL
    const verbena = options.verbena || process.env[UIE_PASSWORD_ENV] || ''
    if (!verbena) {
        throw new Error('留言板 reader requires UIE_PASSWORD')
    }
    const timeoutMs = Math.max(5000, Number(options.timeoutMs) || MESSAGEBOARD_READ_TIMEOUT_MS)
    const connectImpl =
        options.connectImpl || ((url: string) => new WebSocket(url, { headers: MESSAGEBOARD_WS_HEADERS } as any))
    const ws = connectImpl(wsUrl)

    const messages: Array<MessageBoardMessage> = []
    let sessionKey: CryptoKey | null = null
    let handshakeDone = false
    let authed = false
    let listed = false
    let seenSealedFrame = false
    let thisPollUnread = 0
    let settleError: unknown = null
    let settled = false

    const settle = (error?: unknown) => {
        if (settled) {
            return
        }
        settled = true
        settleError = error || null
        try {
            ws.close()
        } catch {
            // ignore
        }
    }

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            settle(new Error(`留言板 read timed out after ${timeoutMs}ms`))
            reject(new Error(`留言板 read timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        ws.onopen = () => {
            // server sends azalea on connect; nothing to do here
        }

        ws.onmessage = async (event: MessageEvent) => {
            const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as any).toString('utf8')
            try {
                const frame = JSON.parse(raw) as Record<string, any>
                if (frame.type === 'azalea') {
                    const serverPublicRaw = base64urlDecode(String(frame.obsidian || ''))
                    const clientKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
                        'deriveBits',
                    ])
                    const clientPublicRaw = new Uint8Array(
                        await crypto.subtle.exportKey('raw', clientKeyPair.publicKey),
                    )
                    const serverKey = await importEcdhPublicKey(serverPublicRaw)
                    const sharedBits = await crypto.subtle.deriveBits(
                        { name: 'ECDH', public: serverKey },
                        clientKeyPair.privateKey,
                        256,
                    )
                    sessionKey = await deriveUieSessionKey(clientPublicRaw, serverPublicRaw, sharedBits)
                    ws.send(
                        JSON.stringify({
                            type: 'bromide',
                            obsidian: base64urlEncode(clientPublicRaw),
                        }),
                    )
                    return
                }
                if (frame.type === 'cranberry') {
                    handshakeDone = true
                    ws.send(
                        await sealMessageBoardMessage(sessionKey!, {
                            type: 'daikon',
                            verbena,
                        }),
                    )
                    return
                }
                if (frame.type === 'flannel') {
                    seenSealedFrame = true
                    const plain = await unsealMessageBoardMessage<Record<string, any>>(sessionKey!, raw)
                    if (plain.type === 'lattice') {
                        settle(new Error(`留言板 auth rejected: ${String(plain.albacore || 'Bad code')}`))
                        reject(new Error(`留言板 auth rejected: ${String(plain.albacore || 'Bad code')}`))
                        return
                    }
                    if (plain.type === 'egret') {
                        authed = true
                        // Poll first: cheap unread hint (a few dozen bytes) instead of always
                        // transferring the full list. Only pull the list when there is anything new.
                        ws.send(await sealMessageBoardMessage(sessionKey!, { type: 'quail' }))
                        return
                    }
                    if (plain.type === 'raccoon') {
                        const unread = Number(plain.unread)
                        if (!(unread > 0)) {
                            // Nothing new: disconnect without transferring any message bodies.
                            thisPollUnread = 0
                            settle()
                            resolve()
                            return
                        }
                        thisPollUnread = unread
                        ws.send(await sealMessageBoardMessage(sessionKey!, { type: 'narcissus' }))
                        return
                    }
                    if (plain.type === 'marmot') {
                        listed = true
                        const items = Array.isArray(plain.tangerine) ? plain.tangerine : []
                        for (const item of items) {
                            if (item && typeof item === 'object' && typeof (item as any).id === 'string') {
                                messages.push(item as MessageBoardMessage)
                            }
                        }
                        if (options.markRead !== false) {
                            ws.send(await sealMessageBoardMessage(sessionKey!, { type: 'opossum' }))
                            // Let the server observe opossum before we close: wait for the server
                            // to close the socket (protocol behavior) or a short grace period.
                            await delay(500)
                        }
                        settle()
                        resolve()
                        return
                    }
                    return
                }
            } catch (error) {
                settle(error)
                reject(error)
            }
        }

        ws.onerror = (error) => {
            clearTimeout(timer)
            const message = error instanceof Error ? error.message : String(error)
            settle(new Error(`留言板 websocket error: ${message}`))
            reject(new Error(`留言板 websocket error: ${message}`))
        }

        ws.onclose = () => {
            clearTimeout(timer)
            if (!settled && !listed) {
                if (seenSealedFrame) {
                    // The server can legitimately close right after a poll
                    // (raccoon unread=0) or drop mid-protocol. Never hang the
                    // crawl slot; an already-sealed poll that produced no marmot
                    // resolves to an empty list.
                    settle()
                    resolve()
                    return
                }
                const error = new Error('留言板 connection closed before marmot')
                settle(error)
                reject(error)
            }
        }
    })

    if (settleError) {
        throw settleError
    }
    return messages
}

export function buildMessageBoardArticle(message: MessageBoardMessage): GenericArticle<Platform.Website> {
    const rawBody = String(message.body || '').trim()
    const title = message.anonymous || !message.name ? '匿名留言' : String(message.name).trim()
    const createdAt = Date.parse(message.ts || '')
    const validCreatedAt = Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt / 1000) : 0
    const crawledAt = Math.floor(Date.now() / 1000)
    const contactParts = [message.contactType, message.contact, message.platform]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
    const content = [
        `【留言板 ${message.id}】`,
        `时间: ${message.ts || '未知'}`,
        `目标: ${message.to || 'uie'}`,
        `匿名: ${message.anonymous === true ? '是' : '否'}`,
        `允许公开: ${message.publicReply === true ? '是' : '否'}`,
        `希望回复: ${message.replyCode ? '是' : '否'}`,
        ...(!message.anonymous && message.name ? [`署名: ${String(message.name).trim()}`] : []),
        ...(!message.anonymous && contactParts.length > 0 ? [`联系方式: ${contactParts.join(' / ')}`] : []),
        message.replyCode
            ? `追踪: ${message.replyBiscuit ? `饼干=${message.replyBiscuit} ` : ''}累计提交=${message.replyCount ?? 0}次`
            : '',
        rawBody ? `正文:\n${rawBody}` : '正文: (空)',
    ].join('\n')

    return {
        platform: Platform.Website,
        a_id: String(message.id),
        u_id: 'messageboard:message',
        username: title,
        created_at: validCreatedAt || crawledAt,
        content,
        url: `https://drop.n2nj.moe/`,
        type: ArticleTypeEnum.ARTICLE,
        ref: null,
        has_media: false,
        media: null,
        extra: {
            data: {
                site: '留言板',
                host: 'drop.n2nj.moe',
                feed: 'messageboard',
                title,
                category: 'message',
                summary: null,
                raw_html: '',
                time_source: validCreatedAt ? 'explicit' : 'crawl_observed',
                date_text: message.ts || null,
                crawled_at: crawledAt,
                to: message.to || 'uie',
                anonymous: message.anonymous === true,
                public_reply: message.publicReply === true,
                read: message.read === true,
                contact_type: message.contactType || null,
                contact: message.contact || null,
                platform: message.platform || null,
                reply_biscuit: message.replyBiscuit || null,
                reply_code: message.replyCode || null,
                reply_count: message.replyCount ?? null,
            },
            content: title || undefined,
            media: undefined,
            extra_type: 'website_meta',
        },
        u_avatar: null,
    }
}

class MessageBoardSpider extends BaseSpider {
    static _VALID_URL = /^messageboard:\/\/read$/i
    static _PLATFORM = Platform.Website
    BASE_URL = 'messageboard://read'
    NAME = 'Message Board Spider'

    static isEnabled(): boolean {
        return process.env[MESSAGEBOARD_ENABLED_FLAG] === '1'
    }

    static extractBasicInfo(url: string) {
        if (!MessageBoardSpider._VALID_URL.test(url)) {
            return undefined
        }
        return {
            u_id: 'messageboard:message',
            platform: Platform.Website,
        }
    }

    async _crawl<T extends TaskType>(
        url: string,
        _page: unknown,
        config: {
            task_type: T
            crawl_engine: CrawlEngine
            sub_task_type?: Array<string>
            cookieString?: string
        },
    ): Promise<TaskTypeResult<T, Platform.Website>> {
        if (config.task_type !== 'article') {
            throw new Error('留言板 spider only supports article tasks')
        }
        if (!MessageBoardSpider.isEnabled()) {
            throw new Error(
                `留言板 reader disabled: set ${MESSAGEBOARD_ENABLED_FLAG}=1 and ${UIE_PASSWORD_ENV} to enable`,
            )
        }
        const messages = await readMessageBoardMessages()
        this.log?.info?.(`留言板 read ${messages.length} message(s)`)
        return messages.map(buildMessageBoardArticle) as TaskTypeResult<T, Platform.Website>
    }
}

export { MessageBoardSpider }
