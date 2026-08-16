/**
 * Default timeout for a single upstream HTTP fetch. Keeping it bounded prevents a hung
 * request from silently blocking a crawler slot and from defeating retry/cooldown logic.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 20000

/**
 * Error raised when an upstream HTTP fetch returns a non-2xx status. Carries the status so
 * callers (and crawl-error classification) can distinguish auth / rate-limit / transient cases.
 */
class HttpStatusError extends Error {
    readonly status: number
    readonly url: string
    constructor(status: number, url: string) {
        super(`HTTP ${status} for ${url}`)
        this.name = 'HttpStatusError'
        this.status = status
        this.url = url
    }
}

/**
 * Error raised when an upstream HTTP fetch exceeds the timeout budget.
 */
class HttpTimeoutError extends Error {
    readonly url: string
    readonly timeoutMs: number
    constructor(url: string, timeoutMs: number) {
        super(`HTTP request timed out after ${timeoutMs}ms for ${url}`)
        this.name = 'HttpTimeoutError'
        this.url = url
        this.timeoutMs = timeoutMs
    }
}

interface DownloadWebpageOptions {
    /** Per-request timeout in milliseconds. Defaults to DEFAULT_FETCH_TIMEOUT_MS. */
    timeout?: number
    /** When true (default), a non-2xx response throws HttpStatusError instead of returning it. */
    throwOnError?: boolean
}

namespace HTTPClient {
    export async function download_webpage(
        url: string,
        headers: Record<string, string> = {},
        options: DownloadWebpageOptions = {},
    ): Promise<Response> {
        const timeout = Math.max(1, options.timeout ?? DEFAULT_FETCH_TIMEOUT_MS)
        const throwOnError = options.throwOnError ?? true
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)
        let response: Response
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {
                    'user-agent': UserAgent.CHROME,
                    ...headers,
                },
                signal: controller.signal,
            })
        } catch (error) {
            if (controller.signal.aborted) {
                throw new HttpTimeoutError(url, timeout)
            }
            throw error
        } finally {
            clearTimeout(timeoutId)
        }
        if (throwOnError && response.status >= 400) {
            throw new HttpStatusError(response.status, url)
        }
        return response
    }

    /**
     * GET via the system curl binary. Some platforms (Instagram, TikTok) fingerprint and 429 the
     * TLS/HTTP2 stack of runtime fetch implementations while leaving curl-like clients alone; use
     * this transport for those endpoints.
     */
    export async function download_webpage_curl(
        url: string,
        headers: Record<string, string> = {},
        options: DownloadWebpageOptions = {},
    ): Promise<Response> {
        const timeout = Math.max(1, options.timeout ?? DEFAULT_FETCH_TIMEOUT_MS)
        const throwOnError = options.throwOnError ?? true
        const args = ['-sS', '-L', '--max-time', String(Math.ceil(timeout / 1000)), '-o', '-', '-w', '\n%{http_code}']
        for (const [name, value] of Object.entries(headers)) {
            args.push('-H', `${name}: ${value}`)
        }
        args.push(url)
        let stdout: string
        try {
            const { execFile } = await import('child_process')
            stdout = await new Promise<string>((resolve, reject) => {
                execFile(
                    'curl',
                    args,
                    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeout + 5000 },
                    (error, stdout) => {
                        if (error) {
                            reject(error)
                            return
                        }
                        resolve(String(stdout))
                    },
                )
            })
        } catch (error) {
            if (error && typeof error === 'object' && (error as { killed?: boolean }).killed) {
                throw new HttpTimeoutError(url, timeout)
            }
            throw error
        }
        const statusMatch = stdout.match(/\n(\d{3})\s*$/)
        const status = statusMatch ? Number(statusMatch[1]) : 0
        const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout
        if (throwOnError && (status >= 400 || status === 0)) {
            throw new HttpStatusError(status || 0, url)
        }
        return new Response(body, { status: status || 599 })
    }
}

const UserAgent = {
    CHROME: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    LINUX_CHROME:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    FIREFOX: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
    SAFARI: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15',
    MOBILE_IOS_SAFARI:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    MOBILE_ANDROID_CHROME:
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
}

export { HTTPClient, UserAgent, HttpStatusError, HttpTimeoutError, DEFAULT_FETCH_TIMEOUT_MS }
export type { DownloadWebpageOptions }
