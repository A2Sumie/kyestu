/**
 * Instagram CDN media-URL lifecycle helpers.
 *
 * Reverse-engineered ground truth (Android 443.0.0.48.82 / iOS 442.0.0, 2026-08):
 * - CDN URLs carry `oe` = hex-encoded epoch **seconds** marking the expiry of
 *   the signed URL (app parses it in 6 places, ×1000 → ms, with a 10-year
 *   sanity clamp). Liveness can be decided locally — no probe request needed.
 * - There is NO 403 → re-sign path in the client: `cdn_refresh_url_redirect`
 *   and `video/refresh_image` are dead code (zero callers). The only renewal
 *   is a fresh media model, or switching to a lower-width candidate from
 *   `image_versions2.candidates` (the app switches ~10s before expiry).
 * - Cache keys must strip `__gda__`, `oh`, `oe`, `hdnea`, `logcdn`, `efg` and
 *   every `_nc_*` param, or the same image behind rotating signatures defeats
 *   dedupe/failure caches.
 */

/** Params IG itself treats as per-request signing material, not content identity. */
const SIGNATURE_PARAM_NAMES = new Set(['__gda__', 'oh', 'oe', 'hdnea', 'logcdn', 'efg'])

const MAX_PLAUSIBLE_URL_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60 // 10-year sanity clamp (app parity)

function isSignatureParam(name: string): boolean {
    return SIGNATURE_PARAM_NAMES.has(name) || name.startsWith('_nc_')
}

/**
 * Parse the `oe` (offline/expiry) param of an Instagram CDN URL.
 * Returns epoch **seconds**, or null when the URL carries no decodable `oe`.
 * Nonsense values (0, negative, >10 years out) are clamped/treated as absent,
 * mirroring the app's defensive parse.
 */
export function instagramMediaUrlExpiryEpochSeconds(url: string, nowMs: number = Date.now()): number | null {
    let query: string
    try {
        query = new URL(url).search
    } catch {
        const queryStart = url.indexOf('?')
        if (queryStart < 0) {
            return null
        }
        query = url.slice(queryStart)
    }
    const oe = new URLSearchParams(query).get('oe')
    if (!oe || !/^[0-9a-f]+$/i.test(oe)) {
        return null
    }
    const epochSeconds = parseInt(oe, 16)
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
        return null
    }
    // Clamp absurd values the same way the app does: anything past the 10-year
    // horizon is treated as "no trustworthy expiry information".
    if (epochSeconds - Math.floor(nowMs / 1000) > MAX_PLAUSIBLE_URL_LIFETIME_SECONDS) {
        return null
    }
    return epochSeconds
}

/**
 * True when the URL's `oe` says the signed URL is already dead.
 * URLs without a decodable `oe` are conservatively considered alive.
 */
export function isInstagramMediaUrlExpired(url: string, nowMs: number = Date.now()): boolean {
    const expiresAt = instagramMediaUrlExpiryEpochSeconds(url, nowMs)
    if (expiresAt === null) {
        return false
    }
    return expiresAt <= Math.floor(nowMs / 1000)
}

/**
 * Normalize a media URL for failure/dedupe caching: drop all signature params
 * (`__gda__ oh oe hdnea logcdn efg _nc_*`), keep the pathname, and keep the
 * remaining identity-bearing query sorted. Two URLs for the same image with
 * different signatures collapse to the same key.
 */
export function normalizeInstagramMediaUrlForCache(url: string): string {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return url
    }
    const kept = Array.from(parsed.searchParams.entries())
        .filter(([name]) => !isSignatureParam(name))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const query = kept.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`
}
