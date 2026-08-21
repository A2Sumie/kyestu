import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot, Loader, createRegistry } from '../src/index'
import type { KyestuEvent } from '../src/index'
import { defineAll } from '../src/components'
import { statusView } from '../src/components/api'
import { Bus } from '../src/components/bus'
import { SessionHealthBoard } from '../src/pipeline/session-health'

// ---------------------------------------------------------------------------
// Observability surface (review §2.5/§3.3): the runtime event stream must
// reach an onEvent subscriber, and /api/status must expose taints + FAILED
// outcomes — otherwise a muted fiber is invisible in production.
// ---------------------------------------------------------------------------

test('onEvent receives taint events when a fiber inverse fails during unload', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ onEvent: (e) => events.push(e) })
  const fiber = root.ctx.use({
    name: 'leaky',
    apply: () => () => {
      throw new Error('inverse boom')
    },
  })
  await root.idle()
  await fiber.dispose()
  expect(events.some((e) => e.type === 'taint' && e.fiber === 'leaky' && e.phase === 'inverse')).toBe(true)
  await root.dispose()
})

test('onEvent receives unload-guard timeout events naming the stuck dependents', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ unloadGuardTimeoutMs: 100, onEvent: (e) => events.push(e) })
  root.ctx.use({
    name: 'stuck-consumer',
    inject: ['svc'],
    apply: () => () => new Promise<void>(() => {}),
  })
  const provider = root.ctx.use({ name: 'provider', apply: (ctx) => void ctx.set('svc', 'v1') })
  await root.idle()
  await provider.dispose()
  const timeout = events.find((e) => e.type === 'timeout')
  expect(timeout).toMatchObject({ type: 'timeout', fiber: 'provider', waiting: ['stuck-consumer'] })
  // no root.dispose(): the stuck consumer's inverse never resolves by design
  // (same pattern as lifecycle.test.ts guard-timeout test)
})

test('/api/status shape: taints and FAILED outcome are exposed, with the force-reload hint', async () => {
  const root = createRoot()
  const failed = root.ctx.use({
    name: 'boom',
    apply: () => {
      throw new Error('kaboom')
    },
  })
  const noisy = root.ctx.use({ name: 'noisy', apply: () => {} })
  await root.idle()
  expect(failed.state).toBe('FAILED')
  // the production send-failure path (router reports taints on its own fiber)
  root.reportTaint(noisy, 'apply', new Error('send failed'))

  const view = statusView(root, 2)
  expect(view.entries).toBe(2)
  const failedView = view.fibers.find((f) => f.name === 'boom')!
  expect(failedView.state).toBe('FAILED')
  expect(failedView.outcome).toBe('kaboom')
  expect(failedView.hint).toContain('POST /api/reload?force=1')
  const noisyView = view.fibers.find((f) => f.name === 'noisy')!
  expect(noisyView.outcome).toBeUndefined()
  expect(noisyView.hint).toBeUndefined()
  expect(noisyView.taints).toHaveLength(1)
  expect(noisyView.taints[0]).toMatchObject({ phase: 'apply', message: 'send failed' })
  expect(typeof noisyView.taints[0]!.at).toBe('number')
  await root.dispose()
})

// ---------------------------------------------------------------------------
// bus semantics (docs/bus.md): emit with zero subscribers is a no-op, and a
// throwing handler is isolated from both its peers and the publisher.
// ---------------------------------------------------------------------------

test('bus: emit with no subscribers is a no-op on every channel', () => {
  const bus = new Bus()
  expect(() => {
    bus.emit('article', { platform: 'x', id: 1, a_id: 'a1', crawlerId: 'c' })
    bus.emit('live', { type: 'live', handle: 'h', crawlerId: 'c' })
    bus.emit('session', { kind: 'transition', key: 'k', from: 'fresh', to: 'suspect' })
  }).not.toThrow()
})

test('bus: a throwing handler neither reaches the publisher nor stops peer handlers', () => {
  const bus = new Bus()
  const seen: string[] = []
  bus.on('article', () => {
    throw new Error('consumer boom')
  })
  bus.on('article', (event) => seen.push(event.a_id))
  expect(() => bus.emit('article', { platform: 'x', id: 2, a_id: 'a2', crawlerId: 'c' })).not.toThrow()
  expect(seen).toEqual(['a2'])
})

// ---------------------------------------------------------------------------
// session channel regression: kept (option b — it has a load-bearing
// subscriber since 2447a8a: keepalive re-arms quarantined jobs on
// transition->fresh). The added observability subscriber must surface
// escalations and jar-expiring events on the process log (8-17 lesson).
// ---------------------------------------------------------------------------

test('session channel: keepalive logs broken/quarantined transitions and expiring events', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-obs-session-'))
  const warns: string[] = []
  const logs: string[] = []
  const realWarn = console.warn
  const realLog = console.log
  console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(' '))
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  try {
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: dir } },
      { id: 'cookie-keepalive', use: 'app/cookie-keepalive', with: { jobs: [], stagger_max_ms: 1 } },
    ])
    await root.idle()
    const board = root.ctx.get<SessionHealthBoard>('cookie-health')!
    const bus = root.ctx.get<Bus>('bus')!

    // fresh -> suspect -> broken -> quarantined (default brokenThreshold 2)
    board.record('sess-a', false, new Error('401 login required'))
    board.record('sess-a', false, new Error('401 login required'))
    expect(board.snapshot().find((s) => s.key === 'sess-a')!.state).toBe('quarantined')
    expect(warns.some((l) => l.includes('[cookie-keepalive] session') && l.includes('-> broken') && l.includes('sess-a'))).toBe(true)
    expect(warns.some((l) => l.includes('-> quarantined') && l.includes('sess-a'))).toBe(true)

    // manual resume: transition -> fresh is announced (info level) — this is
    // the same event the re-arm subscriber consumes, so it also pins the
    // pre-existing subscriber contract after the channel was kept
    board.resume('sess-a')
    expect(logs.some((l) => l.includes('-> fresh') && l.includes('sess-a'))).toBe(true)

    // jar-expiring events (published by runYtdlp post-rotation) warn too
    bus.emit('session', { kind: 'expiring', key: '/tmp/jar.txt', minRemainingSeconds: 3600, cookies: 7 })
    expect(warns.some((l) => l.includes('jar expiring') && l.includes('/tmp/jar.txt'))).toBe(true)
  } finally {
    console.warn = realWarn
    console.log = realLog
    await root.dispose()
  }
})
