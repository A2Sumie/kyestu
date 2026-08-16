import { afterEach, expect, test } from 'bun:test'
import { MessageBoardSpider, buildMessageBoardArticle, readMessageBoardMessages, MESSAGEBOARD_ENABLED_FLAG, UIE_PASSWORD_ENV, type MessageBoardMessage } from '../src/spiders/messageboard'
import { Platform } from '../src/types'

const ORIGINAL_ENV_FLAG = process.env[MESSAGEBOARD_ENABLED_FLAG]
const ORIGINAL_ENV_PASSWORD = process.env[UIE_PASSWORD_ENV]
// Test-only board password placeholder; set UIE_PASSWORD (or MESSAGEBOARD_TEST_VERBENA)
// to exercise the real deployment value. The protocol under test only needs the
// client and server values to match.
const TEST_VERBENA = process.env.MESSAGEBOARD_TEST_VERBENA || process.env[UIE_PASSWORD_ENV] || 'local-test-verbena'

afterEach(() => {
    if (ORIGINAL_ENV_FLAG === undefined) {
        delete process.env[MESSAGEBOARD_ENABLED_FLAG]
    } else {
        process.env[MESSAGEBOARD_ENABLED_FLAG] = ORIGINAL_ENV_FLAG
    }
    if (ORIGINAL_ENV_PASSWORD === undefined) {
        delete process.env[UIE_PASSWORD_ENV]
    } else {
        process.env[UIE_PASSWORD_ENV] = ORIGINAL_ENV_PASSWORD
    }
})

function base64urlEncode(value: Uint8Array | ArrayBuffer): string {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url')
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

test('MessageBoardSpider is disabled by default and throws a clear error', async () => {
    delete process.env[MESSAGEBOARD_ENABLED_FLAG]
    delete process.env[UIE_PASSWORD_ENV]

    expect(MessageBoardSpider.isEnabled()).toBeFalse()
    const spider = new MessageBoardSpider().init()
    await expect(
        (spider as any)._crawl('messageboard://read', undefined, { task_type: 'article', crawl_engine: 'api' }),
    ).rejects.toThrow('留言板 reader disabled')
})

test('MessageBoardSpider matches only the messageboard://read url and extracts the message identity', () => {
    expect(MessageBoardSpider._VALID_URL.test('messageboard://read')).toBeTrue()
    expect(MessageBoardSpider._VALID_URL.test('https://drop.n2nj.moe/ws')).toBeFalse()
    expect(MessageBoardSpider.extractBasicInfo('messageboard://read')).toEqual({ u_id: 'messageboard:message', platform: Platform.Website })
})

test('buildMessageBoardArticle maps message fields into a website article', () => {
    const article = buildMessageBoardArticle({
        id: '20260807120000_a1b2c3',
        ts: '2026-08-07T12:00:00+09:00',
        to: 'uie',
        anonymous: false,
        publicReply: true,
        read: false,
        name: '坂本',
        contactType: 'qq',
        contact: '123456',
        platform: '',
        body: 'お願いします！',
        remoteIp: '1.2.3.4',
        replyBiscuit: 'bk-igopfr-LAhchEipT',
        replyCode: 'k2x9vQnTzRwA',
        replyCount: 3,
    })

    expect(article).toMatchObject({
        platform: Platform.Website,
        a_id: '20260807120000_a1b2c3',
        u_id: 'messageboard:message',
        username: '坂本',
        type: 'article',
        url: 'https://drop.n2nj.moe/',
    })
    expect(article.content).toContain('【留言板 20260807120000_a1b2c3】')
    expect(article.content).toContain('时间: 2026-08-07T12:00:00+09:00')
    expect(article.content).toContain('匿名: 否')
    expect(article.content).toContain('允许公开: 是')
    expect(article.content).toContain('希望回复: 是')
    expect(article.content).toContain('署名: 坂本')
    expect(article.content).toContain('联系方式: qq / 123456')
    expect(article.content).toContain('追踪: 饼干=bk-igopfr-LAhchEipT 累计提交=3次')
    expect(article.content).not.toContain('k2x9vQnTzRwA')
    expect(article.content).toContain('正文:\nお願いします！')
    const data = (article.extra as any).data
    expect(data).toMatchObject({
        site: '留言板',
        host: 'drop.n2nj.moe',
        feed: 'messageboard',
        category: 'message',
        anonymous: false,
        public_reply: true,
        contact_type: 'qq',
        contact: '123456',
        time_source: 'explicit',
        reply_biscuit: 'bk-igopfr-LAhchEipT',
        reply_code: 'k2x9vQnTzRwA',
        reply_count: 3,
    })
    expect(article.created_at).toBeGreaterThan(0)
})

test('buildMessageBoardArticle handles anonymous messages', () => {
    const article = buildMessageBoardArticle({
        id: '20260807120001_ff00',
        ts: '2026-08-07T12:00:01+09:00',
        to: 'uie',
        anonymous: true,
        publicReply: false,
        read: true,
        name: null,
        contactType: null,
        contact: null,
        platform: '',
        body: '匿名のメッセージ',
        remoteIp: '5.6.7.8',
    })

    expect(article.username).toBe('匿名留言')
    expect(article.content).toContain('【留言板 20260807120001_ff00】')
    expect(article.content).toContain('匿名: 是')
    expect(article.content).toContain('允许公开: 否')
    expect(article.content).toContain('希望回复: 否')
    expect(article.content).toContain('正文:\n匿名のメッセージ')
    expect(article.content).not.toContain('署名:')
    expect(article.content).not.toContain('联系方式:')
    expect(article.content).not.toContain('追踪:')
    const data = (article.extra as any).data
    expect(data.anonymous).toBeTrue()
    expect(data.contact).toBeNull()
    expect(data.reply_biscuit).toBeNull()
    expect(data.reply_code).toBeNull()
    expect(data.reply_count).toBeNull()
})

test('readMessageBoardMessages completes the full sealed handshake against a local server', async () => {
    const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
    ])
    const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey))

    let clientSessionKey: CryptoKey | null = null
    const receivedClientMessages: Array<any> = []
    const serverMessages: Array<MessageBoardMessage> = [
        {
            id: '20260807120000_a1b2c3',
            ts: '2026-08-07T12:00:00+09:00',
            to: 'uie',
            anonymous: false,
            publicReply: true,
            read: false,
            name: '坂本',
            contactType: 'qq',
            contact: '123456',
            platform: '',
            body: 'お願いします！',
            remoteIp: '1.2.3.4',
        },
    ]

    const server = Bun.serve({
        port: 0,
        fetch(req, srv) {
            if (srv.upgrade(req)) {
                return
            }
            return new Response('upgrade required', { status: 426 })
        },
        websocket: {
            open(ws) {
                ws.send(
                    JSON.stringify({
                        type: 'azalea',
                        obsidian: base64urlEncode(serverPublicRaw),
                        paprika: 'test-fingerprint',
                        quicksand: 10 * 1024 * 1024,
                    }),
                )
            },
            async message(ws, raw) {
                const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
                const frame = JSON.parse(text)
                if (frame.type === 'bromide') {
                    const clientPublicRaw = base64urlDecode(frame.obsidian)
                    const clientKey = await crypto.subtle.importKey(
                        'raw',
                        clientPublicRaw,
                        { name: 'ECDH', namedCurve: 'P-256' },
                        false,
                        [],
                    )
                    const sharedBits = await crypto.subtle.deriveBits(
                        { name: 'ECDH', public: clientKey },
                        serverKeyPair.privateKey,
                        256,
                    )
                    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
                    clientSessionKey = await crypto.subtle.deriveKey(
                        {
                            name: 'HKDF',
                            hash: 'SHA-256',
                            salt: concatBytes(clientPublicRaw, serverPublicRaw),
                            info: new TextEncoder().encode('3f9a2c7e'),
                        },
                        hkdfKey,
                        { name: 'AES-GCM', length: 256 },
                        false,
                        ['encrypt', 'decrypt'],
                    )
                    ws.send(JSON.stringify({ type: 'cranberry' }))
                    return
                }
                if (frame.type === 'flannel') {
                    const nonce = base64urlDecode(frame.radish)
                    const cipher = base64urlDecode(frame.saffron)
                    const plain = JSON.parse(
                        new TextDecoder().decode(
                            await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, clientSessionKey!, cipher),
                        ),
                    )
                    receivedClientMessages.push(plain)
                    if (plain.type === 'daikon') {
                        expect(plain.verbena).toBe(TEST_VERBENA)
                        const sealed = await (async () => {
                            const n = crypto.getRandomValues(new Uint8Array(12))
                            const ct = await crypto.subtle.encrypt(
                                { name: 'AES-GCM', iv: n },
                                clientSessionKey!,
                                new TextEncoder().encode(JSON.stringify({ type: 'egret', ok: true })),
                            )
                            return JSON.stringify({
                                type: 'flannel',
                                radish: base64urlEncode(n),
                                saffron: base64urlEncode(new Uint8Array(ct)),
                            })
                        })()
                        ws.send(sealed)
                        return
                    }
                    if (plain.type === 'quail') {
                        const n = crypto.getRandomValues(new Uint8Array(12))
                        const ct = await crypto.subtle.encrypt(
                            { name: 'AES-GCM', iv: n },
                            clientSessionKey!,
                            new TextEncoder().encode(
                                JSON.stringify({ type: 'raccoon', unread: serverMessages.length, latest: '2026-08-07T12:00:00+09:00' }),
                            ),
                        )
                        ws.send(
                            JSON.stringify({
                                type: 'flannel',
                                radish: base64urlEncode(n),
                                saffron: base64urlEncode(new Uint8Array(ct)),
                            }),
                        )
                        return
                    }
                    if (plain.type === 'narcissus') {
                        const n = crypto.getRandomValues(new Uint8Array(12))
                        const ct = await crypto.subtle.encrypt(
                            { name: 'AES-GCM', iv: n },
                            clientSessionKey!,
                            new TextEncoder().encode(
                                JSON.stringify({ type: 'marmot', tangerine: serverMessages }),
                            ),
                        )
                        ws.send(
                            JSON.stringify({
                                type: 'flannel',
                                radish: base64urlEncode(n),
                                saffron: base64urlEncode(new Uint8Array(ct)),
                            }),
                        )
                        return
                    }
                    if (plain.type === 'opossum') {
                        ws.close()
                        return
                    }
                }
            },
        },
    })

    try {
        const wsUrl = `ws://127.0.0.1:${server.port}/ws`
        const messages = await readMessageBoardMessages({
            wsUrl,
            verbena: TEST_VERBENA,
            timeoutMs: 15000,
        })

        expect(messages).toHaveLength(1)
        expect(messages[0]?.id).toBe('20260807120000_a1b2c3')
        expect(messages[0]?.body).toBe('お願いします！')
        expect(receivedClientMessages.map((message) => message.type)).toEqual(['daikon', 'quail', 'narcissus', 'opossum'])
    } finally {
        server.stop()
    }
})

test('readMessageBoardMessages disconnects on raccoon unread=0 without pulling the list', async () => {
    const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
    ])
    const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey))

    let clientSessionKey: CryptoKey | null = null
    const receivedClientMessages: Array<any> = []

    const server = Bun.serve({
        port: 0,
        fetch(req, srv) {
            if (srv.upgrade(req)) {
                return
            }
            return new Response('upgrade required', { status: 426 })
        },
        websocket: {
            open(ws) {
                ws.send(
                    JSON.stringify({
                        type: 'azalea',
                        obsidian: base64urlEncode(serverPublicRaw),
                        paprika: 'test-fingerprint',
                        quicksand: 10 * 1024 * 1024,
                    }),
                )
            },
            async message(ws, raw) {
                const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
                const frame = JSON.parse(text)
                if (frame.type === 'bromide') {
                    const clientPublicRaw = base64urlDecode(frame.obsidian)
                    const clientKey = await crypto.subtle.importKey(
                        'raw',
                        clientPublicRaw,
                        { name: 'ECDH', namedCurve: 'P-256' },
                        false,
                        [],
                    )
                    const sharedBits = await crypto.subtle.deriveBits(
                        { name: 'ECDH', public: clientKey },
                        serverKeyPair.privateKey,
                        256,
                    )
                    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
                    clientSessionKey = await crypto.subtle.deriveKey(
                        {
                            name: 'HKDF',
                            hash: 'SHA-256',
                            salt: concatBytes(clientPublicRaw, serverPublicRaw),
                            info: new TextEncoder().encode('3f9a2c7e'),
                        },
                        hkdfKey,
                        { name: 'AES-GCM', length: 256 },
                        false,
                        ['encrypt', 'decrypt'],
                    )
                    ws.send(JSON.stringify({ type: 'cranberry' }))
                    return
                }
                if (frame.type === 'flannel') {
                    const nonce = base64urlDecode(frame.radish)
                    const cipher = base64urlDecode(frame.saffron)
                    const plain = JSON.parse(
                        new TextDecoder().decode(
                            await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, clientSessionKey!, cipher),
                        ),
                    )
                    receivedClientMessages.push(plain)
                    if (plain.type === 'daikon') {
                        const n = crypto.getRandomValues(new Uint8Array(12))
                        const ct = await crypto.subtle.encrypt(
                            { name: 'AES-GCM', iv: n },
                            clientSessionKey!,
                            new TextEncoder().encode(JSON.stringify({ type: 'egret', ok: true })),
                        )
                        ws.send(
                            JSON.stringify({
                                type: 'flannel',
                                radish: base64urlEncode(n),
                                saffron: base64urlEncode(new Uint8Array(ct)),
                            }),
                        )
                        return
                    }
                    if (plain.type === 'quail') {
                        const n = crypto.getRandomValues(new Uint8Array(12))
                        const ct = await crypto.subtle.encrypt(
                            { name: 'AES-GCM', iv: n },
                            clientSessionKey!,
                            new TextEncoder().encode(
                                JSON.stringify({ type: 'raccoon', unread: 0, latest: '' }),
                            ),
                        )
                        ws.send(
                            JSON.stringify({
                                type: 'flannel',
                                radish: base64urlEncode(n),
                                saffron: base64urlEncode(new Uint8Array(ct)),
                            }),
                        )
                        ws.close()
                        return
                    }
                }
            },
        },
    })

    try {
        const messages = await readMessageBoardMessages({
            wsUrl: `ws://127.0.0.1:${server.port}/ws`,
            verbena: TEST_VERBENA,
            timeoutMs: 15000,
        })

        expect(messages).toEqual([])
        expect(receivedClientMessages.map((message) => message.type)).toEqual(['daikon', 'quail'])
    } finally {
        server.stop()
    }
})
