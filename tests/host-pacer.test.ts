import { test, expect } from 'bun:test'
import { HostPacer } from '../src/pipeline/host-pacer'

/**
 * HostPacer: per-host minimum-interval budget for probe requests
 * (sa7 §4: TikTok live-page hydration trips the WAF above ~1 req / 8s).
 */

function fakeClock(start = 1_000_000) {
    let now = start
    const sleeps: number[] = []
    return {
        now: () => now,
        sleep: async (ms: number) => {
            sleeps.push(ms)
            now += ms
        },
        sleeps,
        advance: (ms: number) => {
            now += ms
        },
    }
}

test('host pacer: first turn is immediate, second waits out the remaining interval', async () => {
    const clock = fakeClock()
    const pacer = new HostPacer(8_000, clock.now, clock.sleep)
    const stamps: number[] = []
    await pacer.waitTurn('example.com').then(() => stamps.push(clock.now()))
    clock.advance(3_000)
    await pacer.waitTurn('example.com').then(() => stamps.push(clock.now()))
    expect(stamps[1]! - stamps[0]!).toBe(8_000)
    expect(clock.sleeps).toEqual([5_000])
})

test('host pacer: concurrent callers on one host are serialized at >= the interval', async () => {
    const clock = fakeClock()
    const pacer = new HostPacer(8_000, clock.now, clock.sleep)
    const stamps: number[] = []
    await Promise.all([
        pacer.waitTurn('example.com').then(() => stamps.push(clock.now())),
        pacer.waitTurn('example.com').then(() => stamps.push(clock.now())),
        pacer.waitTurn('example.com').then(() => stamps.push(clock.now())),
    ])
    expect(stamps[1]! - stamps[0]!).toBe(8_000)
    expect(stamps[2]! - stamps[1]!).toBe(8_000)
})

test('host pacer: different hosts carry independent budgets', async () => {
    const clock = fakeClock()
    const pacer = new HostPacer(8_000, clock.now, clock.sleep)
    await pacer.waitTurn('a.example.com')
    await pacer.waitTurn('b.example.com')
    expect(clock.sleeps).toEqual([])
})

test('host pacer: a faulted sleep does not poison the queue for later callers', async () => {
    const clock = fakeClock()
    let failOnce = true
    const pacer = new HostPacer(8_000, clock.now, async (ms) => {
        if (failOnce) {
            failOnce = false
            throw new Error('sleep exploded')
        }
        clock.sleeps.push(ms)
    })
    await pacer.waitTurn('example.com') // stamps the host
    await expect(pacer.waitTurn('example.com')).rejects.toThrow('sleep exploded')
    await expect(pacer.waitTurn('example.com')).resolves.toBeUndefined()
    expect(clock.sleeps).toEqual([8_000])
})
