import type { CookieData } from 'puppeteer-core'
import fs from 'fs'

type NetscapeCookieParseOptions = {
    includeExpired?: boolean
    now?: number
}

type NetscapeCookieFileAudit = {
    total_cookie_rows: number
    usable_cookie_count: number
    expired_cookie_count: number
    session_cookie_count: number
    malformed_cookie_count: number
    http_only_cookie_count: number
    domains: Array<string>
    cookie_names: Array<string>
}

function splitNetscapeCookieLine(line: string) {
    if (line.includes('\t')) {
        const fields = line.split('\t')
        return {
            fields: fields.slice(0, 6).concat(fields.slice(6).join('\t')),
        }
    }

    const fields = line.trim().split(/[ ]+/)
    return {
        fields: fields.slice(0, 6).concat(fields.slice(6).join(' ')),
    }
}

function isExpiredCookie(expires: number | undefined, now: number) {
    return typeof expires === 'number' && Number.isFinite(expires) && expires > 0 && expires <= now
}

function normalizeNetscapeCookieLine(line: string) {
    const trimmed = line.trimEnd()
    if (!trimmed.trim()) {
        return null
    }

    const trimmedLine = trimmed.trimStart()
    const httpOnly = trimmedLine.startsWith('#HttpOnly_')
    const cookieLine = httpOnly ? trimmedLine.replace('#HttpOnly_', '') : trimmedLine
    if (cookieLine.trimStart().startsWith('#')) {
        return null
    }

    return {
        line: cookieLine,
        httpOnly,
    }
}

function parseNetscapeCookieFields(line: string) {
    const { fields } = splitNetscapeCookieLine(line)
    const [domain = '', _includeSubdomain, path, secure, expiresRaw, name = '', value = ''] = fields
    if (!domain || !path || !name || !expiresRaw) {
        return null
    }
    const expires = Number(expiresRaw)
    const cookie: CookieData = {
        name,
        value: value.trim(),
        domain,
        path,
        secure: secure === 'TRUE',
    }
    if (Number.isFinite(expires) && expires > 0) {
        cookie.expires = expires
    }

    return {
        cookie,
    }
}

/**
 * @description convert netscape cookie file to puppeteer cookie like https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc?hl=en
 * @param cookie_file path to cookie file
 * @returns CookieParam[]
 */
function parseNetscapeCookieToPuppeteerCookie(
    cookie_file: string,
    options: NetscapeCookieParseOptions = {},
): Array<CookieData> {
    const now = options.now ?? Math.floor(Date.now() / 1000)
    const lines = fs.readFileSync(cookie_file, 'utf8').split('\n')
    const cookies = []
    for (let line of lines) {
        const normalized = normalizeNetscapeCookieLine(line)
        if (!normalized) {
            continue
        }

        const parsed = parseNetscapeCookieFields(normalized.line)
        if (!parsed) {
            continue
        }

        if (!options.includeExpired && isExpiredCookie(parsed.cookie.expires, now)) {
            continue
        }

        cookies.push({
            ...parsed.cookie,
            httpOnly: normalized.httpOnly,
        })
    }
    return cookies
}

function auditNetscapeCookieFile(
    cookie_file: string,
    options: Pick<NetscapeCookieParseOptions, 'now'> = {},
): NetscapeCookieFileAudit {
    const now = options.now ?? Math.floor(Date.now() / 1000)
    const lines = fs.readFileSync(cookie_file, 'utf8').split('\n')
    const domains = new Set<string>()
    const cookieNames = new Set<string>()
    const audit: NetscapeCookieFileAudit = {
        total_cookie_rows: 0,
        usable_cookie_count: 0,
        expired_cookie_count: 0,
        session_cookie_count: 0,
        malformed_cookie_count: 0,
        http_only_cookie_count: 0,
        domains: [],
        cookie_names: [],
    }

    for (const line of lines) {
        const normalized = normalizeNetscapeCookieLine(line)
        if (!normalized) {
            continue
        }
        audit.total_cookie_rows += 1

        const parsed = parseNetscapeCookieFields(normalized.line)
        if (!parsed) {
            audit.malformed_cookie_count += 1
            continue
        }

        if (normalized.httpOnly) {
            audit.http_only_cookie_count += 1
        }
        if (isExpiredCookie(parsed.cookie.expires, now)) {
            audit.expired_cookie_count += 1
            continue
        }

        audit.usable_cookie_count += 1
        const expires = parsed.cookie.expires
        if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
            audit.session_cookie_count += 1
        }
        domains.add(parsed.cookie.domain.replace(/^\./, '').toLowerCase())
        cookieNames.add(parsed.cookie.name)
    }

    audit.domains = Array.from(domains).filter(Boolean).sort()
    audit.cookie_names = Array.from(cookieNames).filter(Boolean).sort()
    return audit
}

function getCookieString(cookies: Array<CookieData>): string {
    const now = Math.floor(Date.now() / 1000)
    return cookies
        .filter((cookie) => !isExpiredCookie(cookie.expires, now))
        .map((cookie) => {
            return `${cookie.name}=${cookie.value}`.trim()
        })
        .join(';')
}

class SimpleExpiringCache {
    cache: Map<string, any>
    constructor() {
        this.cache = new Map()
    }

    /**
     * @param ttl seconds
     */
    set(key: string, value: any, ttl: number) {
        const ttlMs = Math.max(0, ttl * 1000)
        if (ttlMs <= 0) {
            this.cache.delete(key)
            return
        }
        const expiresAt = Date.now() + ttlMs
        this.cache.set(key, { value, expiresAt })

        if (ttlMs > 0) {
            setTimeout(
                () => {
                    if (this.cache.get(key)?.expiresAt <= Date.now()) {
                        this.cache.delete(key)
                    }
                },
                Math.min(ttlMs, 2_147_483_647),
            )
        }
    }

    get(key: string) {
        const item = this.cache.get(key)
        if (!item) return null

        if (Date.now() > item.expiresAt) {
            this.cache.delete(key)
            return null
        }

        return item.value
    }
}

export { parseNetscapeCookieToPuppeteerCookie, auditNetscapeCookieFile, getCookieString, SimpleExpiringCache }
export type { NetscapeCookieFileAudit }
export * from './http'
export * from './browser'
export * from './domain-breaker'
