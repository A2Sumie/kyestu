import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
    auditNetscapeCookieFile,
    getCookieString,
    HTTPClient,
    HttpStatusError,
    HttpTimeoutError,
    parseNetscapeCookieToPuppeteerCookie,
    SimpleExpiringCache,
} from '../src/utils'

function withCookieFile(content: string, run: (file: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'idol-bbq-cookie-test-'))
    try {
        const file = join(dir, 'cookies.txt')
        writeFileSync(file, content)
        run(file)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test('Netscape cookie parser skips comments, malformed rows, and expired cookies by default', () => {
    withCookieFile(
        [
            '# Netscape HTTP Cookie File',
            '.example.com\tTRUE\t/\tTRUE\t1000\texpired\told',
            '.example.com\tTRUE\t/\tTRUE\t4102444800\tvalid\tnew',
            'malformed row',
            '',
        ].join('\n'),
        (file) => {
            const cookies = parseNetscapeCookieToPuppeteerCookie(file, { now: 2000 })

            expect(cookies).toEqual([
                {
                    name: 'valid',
                    value: 'new',
                    domain: '.example.com',
                    path: '/',
                    expires: 4102444800,
                    httpOnly: false,
                    secure: true,
                },
            ])
            expect(getCookieString(cookies)).toBe('valid=new')
        },
    )
})

test('getCookieString skips expired cookies but keeps session and future cookies', () => {
    const now = Math.floor(Date.now() / 1000)
    const cookies = [
        { name: 'expired', value: 'old', domain: '.youtube.com', expires: now - 3600 },
        { name: 'session', value: 'session-value', domain: '.youtube.com', expires: -1 },
        { name: 'fresh', value: 'new', domain: '.youtube.com', expires: now + 3600 },
    ]
    expect(getCookieString(cookies)).toBe('session=session-value;fresh=new')
})

test('Netscape cookie parser preserves HttpOnly cookies and can include expired rows for audits', () => {
    withCookieFile(
        [
            '#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1000\tct0\tcsrf-token',
            '.x.com TRUE / FALSE 3000 auth_token auth value with spaces',
        ].join('\n'),
        (file) => {
            const cookies = parseNetscapeCookieToPuppeteerCookie(file, { includeExpired: true, now: 2000 })

            expect(cookies).toEqual([
                {
                    name: 'ct0',
                    value: 'csrf-token',
                    domain: '.x.com',
                    path: '/',
                    expires: 1000,
                    httpOnly: true,
                    secure: true,
                },
                {
                    name: 'auth_token',
                    value: 'auth value with spaces',
                    domain: '.x.com',
                    path: '/',
                    expires: 3000,
                    httpOnly: false,
                    secure: false,
                },
            ])
        },
    )
})

test('Netscape cookie parser keeps session cookies loadable by omitting expires', () => {
    withCookieFile(['.tiktok.com\tTRUE\t/\tTRUE\t0\ttt_csrf_token\tcsrf-token'].join('\n'), (file) => {
        const cookies = parseNetscapeCookieToPuppeteerCookie(file, { now: 2000 })

        expect(cookies).toEqual([
            {
                name: 'tt_csrf_token',
                value: 'csrf-token',
                domain: '.tiktok.com',
                path: '/',
                httpOnly: false,
                secure: true,
            },
        ])
        expect(cookies[0]).not.toHaveProperty('expires')
    })
})

test('Netscape cookie audit returns no-value metadata', () => {
    withCookieFile(
        [
            '# Netscape HTTP Cookie File',
            '#HttpOnly_.x.com\tTRUE\t/\tTRUE\t3000\tct0\tcsrf-token',
            '.x.com\tTRUE\t/\tTRUE\t1000\tgt\told-guest-token',
            '.x.com\tTRUE\t/\tFALSE\t0\tlang\tja',
            'malformed row',
        ].join('\n'),
        (file) => {
            const audit = auditNetscapeCookieFile(file, { now: 2000 })

            expect(audit).toEqual({
                total_cookie_rows: 4,
                usable_cookie_count: 2,
                expired_cookie_count: 1,
                session_cookie_count: 1,
                malformed_cookie_count: 1,
                http_only_cookie_count: 1,
                domains: ['x.com'],
                cookie_names: ['ct0', 'lang'],
            })
            expect(JSON.stringify(audit)).not.toContain('csrf-token')
            expect(JSON.stringify(audit)).not.toContain('old-guest-token')
        },
    )
})

test('SimpleExpiringCache treats ttl as seconds', async () => {
    const cache = new SimpleExpiringCache()

    cache.set('short', 'value', 0.01)
    expect(cache.get('short')).toBe('value')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(cache.get('short')).toBeNull()
})

test('SimpleExpiringCache ttl=0 deletes the key instead of storing a tombstone', () => {
    const cache = new SimpleExpiringCache()
    cache.set('gone', 'value', 0)
    expect(cache.get('gone')).toBeNull()
    expect((cache as any).cache.has('gone')).toBeFalse()
})

test('HTTPClient throws status errors for non-2xx responses by default', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('blocked', { status: 429 })) as any

    try {
        await expect(HTTPClient.download_webpage('https://example.com/rate-limited')).rejects.toBeInstanceOf(
            HttpStatusError,
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('HTTPClient bounds hanging requests with HttpTimeoutError', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                once: true,
            })
        })) as any

    try {
        await expect(
            HTTPClient.download_webpage('https://example.com/slow', {}, { timeout: 1 }),
        ).rejects.toBeInstanceOf(HttpTimeoutError)
    } finally {
        globalThis.fetch = originalFetch
    }
})
