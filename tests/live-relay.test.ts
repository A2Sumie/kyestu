import { test, expect } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LiveRelay, stripStreamUrlQuery, type LiveRelayEvent } from '../src/pipeline/live-relay'

/**
 * LiveRelay stream-death recovery + credential hygiene (sa7 §6.3/§6.4):
 * pull urls die with the broadcast session, so an ffmpeg exit must free the
 * handle for the next probe round; and the signed query never leaves the
 * process via events.
 */

function fakeRelay(events: LiveRelayEvent[]) {
    const procs: Array<EventEmitter & { kill: () => boolean; args: string[] }> = []
    const relay = new LiveRelay(
        { enabled: true, archive_root: mkdtempSync(join(tmpdir(), 'kyestu-live-')) },
        ((args: string[]) => {
            const proc = new EventEmitter() as any
            proc.args = args
            proc.kill = () => true
            procs.push(proc)
            return proc
        }) as any,
        (event) => {
            events.push(event)
        },
    )
    return { relay, procs }
}

test('stripStreamUrlQuery: drops the signed query, keeps the path', () => {
    expect(stripStreamUrlQuery('https://pull-hls-example.invalid/s/index.m3u8?expire=1&sign=abc123')).toBe(
        'https://pull-hls-example.invalid/s/index.m3u8',
    )
    expect(stripStreamUrlQuery('https://pull-hls-example.invalid/s/index.m3u8')).toBe(
        'https://pull-hls-example.invalid/s/index.m3u8',
    )
})

test('live relay: ffmpeg gets the full signed url, the event carries the stripped one', async () => {
    const events: LiveRelayEvent[] = []
    const { relay, procs } = fakeRelay(events)
    const signed = 'https://pull-hls-example.invalid/s/index.m3u8?expire=1&sign=abc123'
    await relay.sync('member', { live: true, m3u8: signed, title: 't' })
    expect(procs[0]!.args).toContain(signed)
    expect(events[0]).toMatchObject({ type: 'live', m3u8: 'https://pull-hls-example.invalid/s/index.m3u8' })
    expect(JSON.stringify(events)).not.toContain('sign=')
})

test('live relay: unexpected ffmpeg exit clears the session and emits ended', async () => {
    const events: LiveRelayEvent[] = []
    const { relay, procs } = fakeRelay(events)
    await relay.sync('member', { live: true, m3u8: 'https://x/live.m3u8?sign=a' })
    expect(relay.isRecording('member')).toBe(true)
    procs[0]!.emit('exit', 1, null)
    expect(relay.isRecording('member')).toBe(false)
    // exit handler emits via a microtask
    await Bun.sleep(0)
    expect(events.map((e) => e.type)).toEqual(['live', 'ended'])
    // next probe round with a fresh url re-opens recording
    await relay.sync('member', { live: true, m3u8: 'https://x/live2.m3u8?sign=b' })
    expect(relay.isRecording('member')).toBe(true)
    expect(procs.length).toBe(2)
})

test('live relay: intentional stop (not live) does not double-emit ended on exit', async () => {
    const events: LiveRelayEvent[] = []
    const { relay, procs } = fakeRelay(events)
    await relay.sync('member', { live: true, m3u8: 'https://x/live.m3u8' })
    await relay.sync('member', { live: false })
    procs[0]!.emit('exit', 0, null)
    await Bun.sleep(0)
    expect(events.map((e) => e.type)).toEqual(['live', 'ended'])
})

test('live relay: stopAll kills quietly (no spurious ended events)', async () => {
    const events: LiveRelayEvent[] = []
    const { relay, procs } = fakeRelay(events)
    await relay.sync('member', { live: true, m3u8: 'https://x/live.m3u8' })
    await relay.stopAll()
    procs[0]!.emit('exit', 0, null)
    await Bun.sleep(0)
    expect(events.map((e) => e.type)).toEqual(['live'])
    expect(relay.isRecording('member')).toBe(false)
})

test('live relay: spawn error clears the session without an ended event', async () => {
    const events: LiveRelayEvent[] = []
    const { relay, procs } = fakeRelay(events)
    await relay.sync('member', { live: true, m3u8: 'https://x/live.m3u8' })
    procs[0]!.emit('error', new Error('spawn ffmpeg ENOENT'))
    procs[0]!.emit('exit', -2, null)
    await Bun.sleep(0)
    expect(relay.isRecording('member')).toBe(false)
    expect(events.map((e) => e.type)).toEqual(['live'])
})
