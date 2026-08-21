import { test, expect } from 'bun:test'
import { parseLiveRoomFromHtml, pickHlsPullUrl, probeTikTokLiveStatus } from '../src/spiders/tiktok-live'

/**
 * Synthetic fixtures only: structure mirrors the sa7 evidence sample
 * (SIGI_STATE.LiveRoom.liveRoomUserInfo.{user,liveRoom}, stream_data as a
 * stringified JSON of {data: {<sdk_key>: {main: {flv, hls, ...}}}}), but all
 * hosts/ids/signs are fake — no real stream urls or credentials in the repo.
 */

function sigiStateHtml(sigi: unknown) {
    return `<html><body><script id="SIGI_STATE" type="application/json">${JSON.stringify(sigi)}</script></body></html>`
}

function pullData(qualities: Array<{ sdk_key: string; level: number; name: string }>, data: Record<string, any>) {
    return {
        options: { default_quality: qualities[qualities.length - 1], qualities },
        stream_data: JSON.stringify({ common: { session_id: 'fake-session' }, data }),
    }
}

function hlsUrl(gear: string) {
    return `https://pull-hls-example.invalid/game/stream-1000000000000000001${gear}/index.m3u8?expire=1000000000&sign=0123456789abcdef0123456789abcdef`
}

function liveSigi(overrides: { user?: Record<string, any>; room?: Record<string, any>; pull_data?: any } = {}) {
    return {
        LiveRoom: {
            loadingState: { getUserInfo: 2 },
            needLogin: false,
            liveRoomStatus: 0,
            liveRoomUserInfo: {
                user: {
                    uniqueId: 'examplelive',
                    nickname: 'Example Live',
                    roomId: '7600000000000000001',
                    status: 2,
                    ...overrides.user,
                },
                stats: { followerCount: 100 },
                liveRoom: {
                    title: 'Synthetic Live Title',
                    startTime: 1700000000,
                    status: 2,
                    streamData: {
                        pull_data:
                            overrides.pull_data ??
                            pullData(
                                [
                                    { sdk_key: 'sd', level: 1, name: '480p' },
                                    { sdk_key: 'hd', level: 3, name: '720p' },
                                ],
                                {
                                    ao: { main: { flv: 'https://pull-example.invalid/a.flv?sign=x', hls: '' } },
                                    sd: { main: { flv: 'https://pull-example.invalid/s.flv?sign=x', hls: hlsUrl('_sd') } },
                                    hd: { main: { flv: 'https://pull-example.invalid/h.flv?sign=x', hls: hlsUrl('_hd') } },
                                },
                            ),
                    },
                    ...overrides.room,
                },
            },
        },
    }
}

test('parseLiveRoomFromHtml: live room yields best-level HLS url + title', () => {
    const result = parseLiveRoomFromHtml(sigiStateHtml(liveSigi()))
    expect(result.live).toBe(true)
    expect(result.m3u8).toBe(hlsUrl('_hd'))
    expect(result.title).toBe('Synthetic Live Title')
})

test('parseLiveRoomFromHtml: falls back to a lower gear when the top gear has no hls', () => {
    const pd = pullData(
        [
            { sdk_key: 'sd', level: 1, name: '480p' },
            { sdk_key: 'hd', level: 3, name: '720p' },
        ],
        {
            sd: { main: { hls: hlsUrl('_sd') } },
            hd: { main: { hls: '', flv: 'https://pull-example.invalid/h.flv?sign=x' } },
        },
    )
    const result = parseLiveRoomFromHtml(sigiStateHtml(liveSigi({ pull_data: pd })))
    expect(result.live).toBe(true)
    expect(result.m3u8).toBe(hlsUrl('_sd'))
})

test('parseLiveRoomFromHtml: gear missing from qualities metadata is still usable', () => {
    const pd = pullData([{ sdk_key: 'hd', level: 3, name: '720p' }], {
        hd: { main: { hls: '' } },
        uhd: { main: { hls: hlsUrl('_uhd') } },
    })
    expect(parseLiveRoomFromHtml(sigiStateHtml(liveSigi({ pull_data: pd }))).m3u8).toBe(hlsUrl('_uhd'))
})

test('parseLiveRoomFromHtml: room.status=4 means off air', () => {
    const result = parseLiveRoomFromHtml(sigiStateHtml(liveSigi({ room: { status: 4 } })))
    expect(result.live).toBe(false)
    expect(result.reason).toContain('not live')
})

test('parseLiveRoomFromHtml: empty roomId means not live even with status=2', () => {
    const result = parseLiveRoomFromHtml(sigiStateHtml(liveSigi({ user: { roomId: '' } })))
    expect(result.live).toBe(false)
    expect(result.reason).toContain('not live')
})

test('parseLiveRoomFromHtml: user without uniqueId is the invalid-handle shape', () => {
    const result = parseLiveRoomFromHtml(sigiStateHtml(liveSigi({ user: { uniqueId: undefined } })))
    expect(result.live).toBe(false)
    expect(result.reason).toContain('invalid handle')
})

test('parseLiveRoomFromHtml: live room without any hls pull url degrades to live:false', () => {
    const pd = pullData([{ sdk_key: 'hd', level: 3, name: '720p' }], {
        hd: { main: { hls: '', flv: 'https://pull-example.invalid/h.flv?sign=x' } },
    })
    const result = parseLiveRoomFromHtml(sigiStateHtml(liveSigi({ pull_data: pd })))
    expect(result.live).toBe(false)
    expect(result.reason).toContain('no HLS')
})

test('parseLiveRoomFromHtml: CurrentRoom-only SIGI_STATE (off-air / invalid handle page)', () => {
    const sigi = {
        CurrentRoom: { loadingState: { enterRoom: 0 }, roomInfo: null, anchorId: '', roomId: '' },
    }
    const result = parseLiveRoomFromHtml(sigiStateHtml(sigi))
    expect(result.live).toBe(false)
    expect(result.reason).toContain('CurrentRoom')
})

test('parseLiveRoomFromHtml: WAF challenge page has no SIGI_STATE block', () => {
    const challenge = '<html><head><script>window._slardar_challenge=true</script></head><body></body></html>'
    const result = parseLiveRoomFromHtml(challenge)
    expect(result.live).toBe(false)
    expect(result.reason).toContain('SIGI_STATE')
})

test('parseLiveRoomFromHtml: broken JSON in the block is a parse failure, not a crash', () => {
    const html = '<script id="SIGI_STATE" type="application/json">{not json</script>'
    const result = parseLiveRoomFromHtml(html)
    expect(result.live).toBe(false)
    expect(result.reason).toContain('parse failed')
})

test('pickHlsPullUrl: unparsable stream_data yields null', () => {
    expect(pickHlsPullUrl({ options: { qualities: [] }, stream_data: '{broken' })).toBeNull()
    expect(pickHlsPullUrl(null)).toBeNull()
    expect(pickHlsPullUrl({ stream_data: '{"data":{}}' })).toBeNull()
})

test('probeTikTokLiveStatus: full path with injected fetch, cookie header forwarded', async () => {
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    const result = await probeTikTokLiveStatus('examplelive', {
        cookieString: 'sessionid=fake; ttwid=fake2',
        fetchPage: async (url, headers) => {
            seenUrl = url
            seenHeaders = headers
            return sigiStateHtml(liveSigi())
        },
    })
    expect(result.live).toBe(true)
    expect(result.m3u8).toBe(hlsUrl('_hd'))
    expect(seenUrl).toBe('https://www.tiktok.com/@examplelive/live')
    expect(seenHeaders.cookie).toBe('sessionid=fake; ttwid=fake2')
})

test('probeTikTokLiveStatus: leading @ is stripped, invalid characters short-circuit without fetch', async () => {
    let fetched = 0
    const fetchPage = async () => {
        fetched += 1
        return sigiStateHtml(liveSigi())
    }
    const ok = await probeTikTokLiveStatus('@examplelive', { fetchPage })
    expect(ok.live).toBe(true)
    const bad = await probeTikTokLiveStatus('not a handle!', { fetchPage })
    expect(bad.live).toBe(false)
    expect(bad.reason).toContain('invalid handle')
    expect(fetched).toBe(1)
})

test('probeTikTokLiveStatus: fetch failure degrades to live:false with reason', async () => {
    const result = await probeTikTokLiveStatus('examplelive', {
        fetchPage: async () => {
            throw new Error('HTTP 403 for https://www.tiktok.com/@examplelive/live')
        },
    })
    expect(result.live).toBe(false)
    expect(result.reason).toContain('fetch failed')
})
