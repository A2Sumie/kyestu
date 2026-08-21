import { HTTPClient } from '../utils'

/**
 * TikTok live status probe (chain B): GET https://www.tiktok.com/@<handle>/live
 * and read the embedded hydration JSON (`SIGI_STATE` script block, root module
 * `LiveRoom`). Field paths are from the 2026-08-21 sa7 e2e probe:
 *
 *   LiveRoom.liveRoomUserInfo.user.{uniqueId,roomId,status}   status 2 = live
 *   LiveRoom.liveRoomUserInfo.liveRoom.{status,title}         status 2 = live / 4 = off
 *   LiveRoom.liveRoomUserInfo.liveRoom.streamData.pull_data
 *     .options.qualities[]            {sdk_key, level, name} quality metadata
 *     .stream_data                    stringified JSON: {data: {<sdk_key>: {main: {flv, hls, ...}}}}
 *
 * A user that is not live (or an invalid handle) yields a SIGI_STATE without a
 * `LiveRoom` module (only `CurrentRoom` with null roomInfo); a WAF challenge
 * page has no SIGI_STATE at all. All non-live outcomes return {live:false}
 * with a human-readable `reason` for the caller to warn-log.
 */

const TIKTOK_LIVE_HTTP_TIMEOUT_MS = 15000

export interface TikTokLiveProbeResult {
    live: boolean
    m3u8?: string
    title?: string
    /** why live=false (not-live / invalid handle / challenge / parse failure) */
    reason?: string
}

const SIGI_STATE_RE = /<script\s+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/

function extractSigiState(html: string): string | null {
    return html.match(SIGI_STATE_RE)?.[1] || null
}

interface LiveQuality {
    sdk_key?: string
    level?: number
    name?: string
}

/**
 * Pick the best HLS (m3u8) pull url from pull_data: quality order comes from
 * options.qualities sorted by level desc; any remaining stream_data keys are
 * tried afterwards as a fallback. Audio-only entries have an empty hls and
 * are skipped naturally.
 */
export function pickHlsPullUrl(pullData: any): string | null {
    if (!pullData || typeof pullData !== 'object') return null
    let streamData: any = pullData.stream_data
    if (typeof streamData === 'string') {
        try {
            streamData = JSON.parse(streamData)
        } catch {
            return null
        }
    }
    const variants = streamData?.data
    if (!variants || typeof variants !== 'object') return null
    const hlsOf = (key: string): string | null => {
        const url = variants[key]?.main?.hls
        return typeof url === 'string' && url.includes('.m3u8') ? url : null
    }
    const qualities: Array<LiveQuality> = Array.isArray(pullData.options?.qualities) ? pullData.options.qualities : []
    const ordered = [...qualities]
        .filter((q) => typeof q?.sdk_key === 'string')
        .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
        .map((q) => q.sdk_key!)
    for (const key of Object.keys(variants)) {
        if (!ordered.includes(key)) ordered.push(key)
    }
    for (const key of ordered) {
        const url = hlsOf(key)
        if (url) return url
    }
    return null
}

/** parse the hydration HTML of a /@handle/live page into a probe verdict */
export function parseLiveRoomFromHtml(html: string): TikTokLiveProbeResult {
    const block = extractSigiState(html)
    if (!block) {
        return { live: false, reason: 'no SIGI_STATE hydration block (WAF challenge page or layout change)' }
    }
    let sigi: any
    try {
        sigi = JSON.parse(block)
    } catch (error) {
        return {
            live: false,
            reason: `SIGI_STATE JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
    const liveRoomModule = sigi?.LiveRoom
    if (!liveRoomModule) {
        return {
            live: false,
            reason: sigi?.CurrentRoom
                ? 'not live (hydration has CurrentRoom only, no LiveRoom module)'
                : 'unexpected SIGI_STATE shape (no LiveRoom/CurrentRoom module)',
        }
    }
    const user = liveRoomModule?.liveRoomUserInfo?.user
    if (!user?.uniqueId) {
        // sa7: misspelled / unofficial handles hydrate without uniqueId
        return { live: false, reason: 'invalid handle (hydration user has no uniqueId)' }
    }
    const room = liveRoomModule?.liveRoomUserInfo?.liveRoom
    if (!(user.status === 2 && room?.status === 2 && user.roomId)) {
        return {
            live: false,
            reason: `not live (user.status=${user.status ?? '?'}, room.status=${room?.status ?? '?'})`,
        }
    }
    const m3u8 = pickHlsPullUrl(room?.streamData?.pull_data)
    if (!m3u8) {
        return { live: false, reason: 'live but no HLS pull url in streamData.pull_data' }
    }
    return { live: true, m3u8, title: typeof room?.title === 'string' ? room.title : undefined }
}

export interface TikTokLiveProbeOptions {
    cookieString?: string
    /** test seam: replace the page fetch (must return response HTML) */
    fetchPage?: (url: string, headers: Record<string, string>) => Promise<string>
    timeoutMs?: number
}

/**
 * Probe one handle's live status. Pacing is NOT done here — the caller must
 * hold a per-host budget (WAF: live-page hydration <= 1 req / 8s, sa7 §4).
 */
export async function probeTikTokLiveStatus(
    handle: string,
    options: TikTokLiveProbeOptions = {},
): Promise<TikTokLiveProbeResult> {
    const clean = String(handle || '')
        .trim()
        .replace(/^@+/, '')
    if (!/^[A-Za-z0-9._]+$/.test(clean)) {
        return { live: false, reason: `invalid handle '${handle}'` }
    }
    const url = `https://www.tiktok.com/@${clean}/live`
    const headers: Record<string, string> = {
        'accept-language': 'en-US,en;q=0.9',
        referer: `https://www.tiktok.com/@${clean}`,
    }
    if (options.cookieString?.trim()) {
        headers.cookie = options.cookieString
    }
    let html: string
    try {
        if (options.fetchPage) {
            html = await options.fetchPage(url, headers)
        } else {
            const res = await HTTPClient.download_webpage(url, headers, {
                timeout: options.timeoutMs ?? TIKTOK_LIVE_HTTP_TIMEOUT_MS,
            })
            html = await res.text()
        }
    } catch (error) {
        return { live: false, reason: `live page fetch failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    return parseLiveRoomFromHtml(html)
}
