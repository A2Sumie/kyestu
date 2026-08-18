import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot, Loader, createRegistry, NodeHandle, nodeKey } from '../src/index'
import { defineAll } from '../src/components'
import { CookieKeepaliveService } from '../src/components/cookie-keepalive'
import {
  SessionHealthBoard,
  backoffDelayMs,
  staggerDelayMs,
} from '../src/pipeline/session-health'
import { checkupJar, ExpiringLatch, parseNetscapeCookieLine } from '../src/pipeline/jar-checkup'
import type { Bus } from '../src/components/bus'

// ---------------------------------------------------------------------------
// ① inject:['browser'] lifecycle: INACTIVE without a pool, ACTIVE after the
// pool loads, cascade reload on pool rebuild with no timer leak.
// Paper: Def 25/26 (reactive coeffect specification & notify), realized by
// fiber.inject + Root.notify (Table 2); L-Leave/L-Unload ordering (Alg 5).
// ---------------------------------------------------------------------------

/** tmp dir with a no-op yt-dlp stub prepended to PATH (jobs must not spawn the real tool) */
function makeStubDir(label: string): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), label))
  writeFileSync(join(dir, 'yt-dlp'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'yt-dlp'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  return { dir, restore: () => { process.env.PATH = prevPath } }
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met before deadline: ${what}`)
    await Bun.sleep(10)
  }
}

/**
 * keepalive entry driven by a ytdlp job (browser jobs would launch real
 * Chrome through the real pool; the ytdlp kind exercises the same scheduler
 * path with a PATH-stubbed tool).
 */
function keepaliveEntry(jar: string, extra?: Record<string, unknown>) {
  return {
    id: 'cookie-keepalive',
    use: 'app/cookie-keepalive',
    with: {
      jobs: [{ kind: 'ytdlp', name: 'yt-life', cookie_file: jar, url: 'https://www.youtube.com/@example', interval_seconds: 3600 }],
      stagger_max_ms: 1,
      ...extra,
    },
  }
}

test('① lifecycle: without browser-pool the keepalive fiber stays INACTIVE', async () => {
  const { dir, restore } = makeStubDir('kyestu-ka-inactive-')
  const jar = join(dir, 'ycookies.txt')
  writeFileSync(jar, '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n')
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  try {
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      keepaliveEntry(jar),
    ])
    await root.idle()
    const fiber = loader.fiber('cookie-keepalive')
    expect(fiber).not.toBeNull()
    // "a component whose dependency is unavailable stays inactive until it
    // appears, without erroring" — no taint, no crash, just INACTIVE
    expect(fiber!.state).toBe('INACTIVE')
    expect(fiber!.taints).toEqual([])
    // the board is not provided while inactive
    expect(root.ctx.get('cookie-health')).toBeUndefined()
    await root.dispose()
  } finally {
    restore()
  }
})

test('① lifecycle: pool load activates keepalive; pool rebuild cascades and leaks no timer', async () => {
  const { dir, restore } = makeStubDir('kyestu-ka-life-')
  const jar = join(dir, 'ycookies.txt')
  writeFileSync(jar, '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n')
  // pin stagger determinism: a stubbed rand makes the first arm land at 0ms,
  // so the "runs === 1" wait below cannot race a random delay
  const realRandom = Math.random
  Math.random = () => 0
  try {
    const root = createRoot({ unloadGuardTimeoutMs: 2000 })
    const loader = new Loader(root, defineAll(createRegistry()))

    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      keepaliveEntry(jar),
      { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: dir } },
    ])
    await root.idle()
    const fiber = loader.fiber('cookie-keepalive')!
    expect(fiber.state).toBe('ACTIVE')
    expect(root.ctx.get<SessionHealthBoard>('cookie-health')).toBeInstanceOf(SessionHealthBoard)

    // the scheduler armed its job timers (1 job; the resume ticker is not a job timer)
    const serviceOf = () => {
      const handle = root.ctx.get<NodeHandle>(nodeKey('cookie-keepalive'))
      return handle?.api<CookieKeepaliveService>()
    }
    // first round fires at once (stagger 0); runs increments at run START,
    // so the trustworthy "first round done and re-armed" observation is the
    // conjunction: runs===1 (round happened) AND armedTimers===1 (the
    // post-run re-arm on the 1h interval already landed)
    await until(
      () => {
        const service = serviceOf()
        return service?.status().find((s) => s.name === 'yt-life')?.runs === 1 && service.armedTimers === 1
      },
      5000,
      'first job run + re-arm',
    )
    expect(serviceOf()!.armedTimers).toBe(1)

    // pool rebuild (with-change) → keepalive must cascade reload; the runtime
    // swaps the provider fiber identity, which refreshes dependents directly
    // (Root.notify on the coeffect key). Observable as a new generation of
    // the keepalive fiber and a fresh board — NOT as a loader entry change
    // (the loader reconciles entries; the cascade happens below it).
    const generationBefore = loader.fiber('cookie-keepalive')!.generation
    const boardBefore = root.ctx.get<SessionHealthBoard>('cookie-health')
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      keepaliveEntry(jar),
      { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: dir, extra: 'rebuild-me' } },
    ])
    await root.idle()
    expect(loader.fiber('cookie-keepalive')!.state).toBe('ACTIVE')
    expect(loader.fiber('cookie-keepalive')!.generation).toBeGreaterThan(generationBefore)
    expect(root.ctx.get<SessionHealthBoard>('cookie-health')).not.toBe(boardBefore)
    // fresh generation re-armed exactly its own timers — the old generation's
    // timers were recovered by the accumulator before the reload (LIFO, Alg 5)
    await until(() => serviceOf()!.armedTimers === 1, 2000, 're-armed after cascade')
    expect(loader.fiber('cookie-keepalive')!.taints).toEqual([])

    // dispose retires the fiber and leaves zero armed timers (no leak);
    // loader.dispose() is what prunes the entry table
    await root.dispose()
    expect(serviceOf()?.armedTimers ?? 0).toBe(0)
    await loader.dispose()
    expect(loader.fiber('cookie-keepalive')).toBeNull()
  } finally {
    Math.random = realRandom
    restore()
  }
}, 20_000)

// ---------------------------------------------------------------------------
// ② probe → broken → quarantine → guard blocks the crawler → resume restores
// Paper: §6.1 withholding (emission withheld while acquisition stays); the
// guard() coeffect operation (Def 24) is the consumers' only gate.
// ---------------------------------------------------------------------------

test('② login probe: positive evidence quarantines the session; guard blocks; resume restores', async () => {
  const board = new SessionHealthBoard({ brokenThreshold: 2 })
  const probes: string[] = []
  const page = {
    goto: async (url: string) => probes.push(url),
    // login entrypoint present → probe reports logged-out
    evaluate: async () => true,
    close: async () => {},
  }
  const pool = { createPage: async () => page }
  const service = new CookieKeepaliveService(
    [{ kind: 'browser', session_profile: 'ig-main', url: 'https://www.instagram.com/', settle_ms: 1 }],
    { browser: pool as any, board, bus: null, sleep: async () => {} },
  )

  // 1st probe failure → suspect
  await service.runNow()
  expect(board.guard('ig-main').blocked).toBe(false)
  expect(board.snapshot()[0]!.state).toBe('suspect')
  // 2nd consecutive failure → broken → quarantined immediately
  await service.runNow()
  const verdict = board.guard('ig-main')
  expect(verdict.blocked).toBe(true)
  expect(board.snapshot()[0]!.state).toBe('quarantined')

  // guard blocks → runNow withholds the emission (no goto at all)
  const gotosBefore = probes.length
  const states = await service.runNow()
  expect(probes.length).toBe(gotosBefore) // no navigation happened
  expect(states[0]!.lastError).toContain('skipped')

  // resume lifts the quarantine; the next run touches the page again
  board.resume('ig-main')
  expect(board.guard('ig-main').blocked).toBe(false)
  await service.runNow()
  expect(probes.length).toBeGreaterThan(gotosBefore)
})

test('② probe conservatism: selector miss on a healthy page is NOT logged-out (宁漏勿误)', async () => {
  const board = new SessionHealthBoard()
  const page = { goto: async () => {}, evaluate: async () => false, close: async () => {} }
  const pool = { createPage: async () => page }
  const service = new CookieKeepaliveService(
    [{ kind: 'browser', session_profile: 'sane', url: 'https://x.com/home', settle_ms: 1 }],
    { browser: pool as any, board, bus: null, sleep: async () => {} },
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(true)
  expect(board.guard('sane').blocked).toBe(false)
})

test('② probe conservatism: evaluate throwing degrades to fresh, not broken', async () => {
  const board = new SessionHealthBoard()
  const page = {
    goto: async () => {},
    evaluate: async () => {
      throw new Error('detached frame')
    },
    close: async () => {},
  }
  const pool = { createPage: async () => page }
  const service = new CookieKeepaliveService(
    [{ kind: 'browser', session_profile: 'flaky', url: 'https://x.com/home', settle_ms: 1 }],
    { browser: pool as any, board, bus: null, sleep: async () => {} },
  )
  await service.runNow()
  expect(board.guard('flaky').blocked).toBe(false)
  expect(board.snapshot()[0]!.state).toBe('fresh')
})

// ---------------------------------------------------------------------------
// ③ crawler feedback: auth failure → record → suspect → broken + bus events
// ---------------------------------------------------------------------------

function poolEntry(cacheRoot: string, extra?: Record<string, unknown>) {
  return { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: cacheRoot, ...extra } }
}

test('③ crawler auth failures escalate through the board and emit bus transitions', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-ka-auth-'))
  await loader.load([
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    poolEntry(dir),
    {
      id: 'cookie-keepalive',
      use: 'app/cookie-keepalive',
      with: { jobs: [], stagger_max_ms: 1 },
    },
  ])
  await root.idle()
  const bus = root.ctx.get<Bus>('bus')!
  const board = root.ctx.get<SessionHealthBoard>('cookie-health')!

  const events: any[] = []
  bus.on('session', (e) => events.push(e))

  const { setCrawlDriverForTest } = require('../src/components/crawler')
  try {
    let fail = true
    setCrawlDriverForTest(async () => {
      if (fail) throw new Error('401 login required')
      return []
    })
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      poolEntry(dir),
      {
        id: 'cookie-keepalive',
        use: 'app/cookie-keepalive',
        with: { jobs: [], stagger_max_ms: 1 },
      },
      {
        id: 'ig-crawler',
        use: 'crawler/instagram',
        with: {
          origin: 'https://www.instagram.com',
          paths: ['example_member'],
          session_profile: 'ig-main',
          interval_time: { min: 0, max: 0 },
        },
      },
    ])
    await root.idle()
    expect(loader.fiber('ig-crawler')!.state).toBe('ACTIVE')
    // first round fires immediately: one auth failure recorded through the
    // crawler feedback path (driver threw '401 login required' →
    // classifyCrawlError → 'auth' → board.record(false))
    await until(
      () => board.snapshot().find((s) => s.key === 'ig-main')?.state === 'suspect',
      5000,
      'first auth failure → suspect',
    )
    expect(events.some((e) => e.kind === 'transition' && e.key === 'ig-main' && e.to === 'suspect')).toBe(true)
  } finally {
    setCrawlDriverForTest(null)
    await root.dispose()
  }

  // The escalation ladder itself is board semantics, not crawler wiring (a
  // second crawler round cannot drive it: the auth-class cooldown parks the
  // URL for hours and the 5-minute default reschedule dominates the tick —
  // by design, the 8-16 lesson). Continue on the board directly.
  const ladder: Array<{ to: string; from: string }> = []
  const ladderBoard = new SessionHealthBoard({
    brokenThreshold: 2,
    onTransition: (e) => ladder.push({ from: e.from, to: e.to }),
  })
  ladderBoard.record('ig-main', false, new Error('403 login required')) // → suspect
  ladderBoard.record('ig-main', false, new Error('403 login required')) // → broken → quarantined
  const snap = ladderBoard.snapshot().find((s) => s.key === 'ig-main')
  expect(snap?.state).toBe('quarantined')
  expect(ladderBoard.guard('ig-main').blocked).toBe(true)
  // fresh->suspect->broken->quarantined all announced in order
  expect(ladder.map((t) => t.to)).toEqual(['suspect', 'broken', 'quarantined'])
  // success heals: the strongest recovery signal resets any degraded state
  ladderBoard.resume('ig-main')
  ladderBoard.record('ig-main', true)
  expect(ladderBoard.guard('ig-main').blocked).toBe(false)
  expect(ladderBoard.snapshot().find((s) => s.key === 'ig-main')?.state).toBe('fresh')
})

// guard-blocked crawler round: driver must not be invoked at all
test('③ quarantined session: crawler round skips the driver entirely', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-ka-skip-'))
  await loader.load([
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    poolEntry(dir),
    { id: 'cookie-keepalive', use: 'app/cookie-keepalive', with: { jobs: [], stagger_max_ms: 1 } },
  ])
  await root.idle()
  const board = root.ctx.get<SessionHealthBoard>('cookie-health')!

  const { setCrawlDriverForTest } = require('../src/components/crawler')
  let driverCalls = 0
  try {
    setCrawlDriverForTest(async () => {
      driverCalls += 1
      return []
    })
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      poolEntry(dir),
      { id: 'cookie-keepalive', use: 'app/cookie-keepalive', with: { jobs: [], stagger_max_ms: 1 } },
      {
        id: 'x-crawler',
        use: 'crawler/x',
        with: { origin: 'https://x.com', paths: ['example_member'], session_profile: 'x-main' },
      },
    ])
    await root.idle()
    expect(loader.fiber('x-crawler')!.state).toBe('ACTIVE')
    await Bun.sleep(100)
    expect(driverCalls).toBeGreaterThan(0)

    // force-quarantine the session the crawler feeds back to
    board.record('x-main', false, new Error('403 login'))
    board.record('x-main', false, new Error('403 login'))
    expect(board.guard('x-main').blocked).toBe(true)

    driverCalls = 0
    await Bun.sleep(16_000) // at least one full tick round must be skipped
    expect(driverCalls).toBe(0)
  } finally {
    setCrawlDriverForTest(null)
    await root.dispose()
  }
}, 60_000)

// ---------------------------------------------------------------------------
// ④ jar checkup: expiring event fires once per below-threshold episode
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000

test('④ Netscape parsing tolerates #HttpOnly_ and counts session vs expiring cookies', () => {
  expect(parseNetscapeCookieLine('# just a comment')).toBeNull()
  expect(parseNetscapeCookieLine('')).toBeNull()
  expect(parseNetscapeCookieLine('#HttpOnly_no-fields')).toBeNull()
  const httpOnly = parseNetscapeCookieLine('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx')
  expect(httpOnly).toEqual({ name: 'SID', expiresAtSeconds: null })
  const httpOnlyExpiring = parseNetscapeCookieLine(`#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t${NOW + 50}\tHSID\tx`)
  expect(httpOnlyExpiring).toEqual({ name: 'HSID', expiresAtSeconds: NOW + 50 })
  const expiring = parseNetscapeCookieLine(`.youtube.com\tTRUE\t/\tTRUE\t${NOW + 100}\tVISITOR_DATA\ty`)
  expect(expiring).toEqual({ name: 'VISITOR_DATA', expiresAtSeconds: NOW + 100 })
})

test('④ jar checkup: min remaining seconds + expired counting', () => {
  const content = [
    `.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsession`,
    `.youtube.com\tTRUE\t/\tTRUE\t${NOW + 100}\tSHORT\tsoon`,
    `.youtube.com\tTRUE\t/\tTRUE\t${NOW + 10 * 24 * 3600}\tLONG\tlater`,
    `.youtube.com\tTRUE\t/\tTRUE\t${NOW - 5}\tDEAD\tgone`,
  ].join('\n')
  const checkup = checkupJar('/jar', content, NOW)
  expect(checkup.cookies).toBe(4)
  expect(checkup.sessionCookies).toBe(1)
  expect(checkup.expired).toBe(1)
  expect(checkup.minRemainingSeconds).toBe(0) // the dead cookie pins the floor at 0
})

test('④ expiring latch: one event per episode; re-arms only after recovery', () => {
  const latch = new ExpiringLatch(7 * 24 * 3600)
  const low = checkupJar('/j', `.d\tTRUE\t/\tTRUE\t${NOW + 3600}\tX\t1`, NOW)
  const high = checkupJar('/j', `.d\tTRUE\t/\tTRUE\t${NOW + 30 * 24 * 3600}\tX\t1`, NOW)

  expect(latch.shouldFire('/j', low)).toBe(true) // first dip: fire
  expect(latch.shouldFire('/j', low)).toBe(false) // still low: silence
  expect(latch.shouldFire('/j', low)).toBe(false)
  expect(latch.shouldFire('/j', high)).toBe(false) // recovered: re-arm quietly
  expect(latch.shouldFire('/j', low)).toBe(true) // second episode: fire again
})

test('④ jar checkup: all-session-cookie jar stays quiet (null min)', () => {
  const latch = new ExpiringLatch()
  const sessions = checkupJar('/j', `.d\tTRUE\t/\tTRUE\t0\tSID\t1`, NOW)
  expect(sessions.minRemainingSeconds).toBeNull()
  expect(latch.shouldFire('/j', sessions)).toBe(false)
})

// ---------------------------------------------------------------------------
// ⑤ backoff + stagger pure logic
// ---------------------------------------------------------------------------

test('⑤ backoff: interval × 2^n capped at 24h; success resets', () => {
  const hour = 3600_000
  expect(backoffDelayMs(hour, 0)).toBe(0)
  expect(backoffDelayMs(hour, 1)).toBe(hour * 2)
  expect(backoffDelayMs(hour, 2)).toBe(hour * 4)
  expect(backoffDelayMs(hour, 3)).toBe(hour * 8)
  expect(backoffDelayMs(hour, 10)).toBe(24 * 3600_000) // 3600s * 1024 > 24h → cap
  expect(backoffDelayMs(hour, 40)).toBe(24 * 3600_000) // deep failure stays at cap
})

test('⑤ stagger: uniform in [0, max), deterministic under injected rand', () => {
  expect(staggerDelayMs(0)).toBe(0)
  expect(staggerDelayMs(90_000, () => 0)).toBe(0)
  expect(staggerDelayMs(90_000, () => 0.5)).toBe(45_000)
  expect(staggerDelayMs(90_000, () => 0.999999)).toBe(89_999)
  expect(staggerDelayMs(1000, () => 0.9999)).toBe(999) // rand() contract [0,1) → result < max
  const values = new Set(Array.from({ length: 50 }, () => staggerDelayMs(1000)))
  expect(values.size).toBeGreaterThan(10) // actually random, not constant
})

// ---------------------------------------------------------------------------
// ⑥ legacy-config compatibility smoke: importer-shaped config runs unchanged
// ---------------------------------------------------------------------------

test('⑥ legacy config (importer output shape) drives the service end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-ka-compat-'))
  const jar = join(dir, 'ycookies.txt')
  writeFileSync(jar, '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\told\n')
  // importer jobs carry no ytdlp_path: production resolves yt-dlp from PATH,
  // so the smoke test prepends a stub yt-dlp on PATH (exit 0)
  writeFileSync(join(dir, 'yt-dlp'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'yt-dlp'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`

  // exact shape the importer emits (tests/import.test.ts 'yt-1' fixture)
  const legacyJobs: Array<Record<string, any>> = [
    {
      name: 'yt-1',
      kind: 'ytdlp',
      cookie_file: jar,
      url: 'https://www.youtube.com/@sallyamakiofficial',
      interval_seconds: 21600,
      sources: ['YouTube抓取'],
    },
  ]

  try {
    const board = new SessionHealthBoard()
    const service = new CookieKeepaliveService(legacyJobs as any, {
      browser: null,
      board,
      bus: null,
      sleep: async () => {},
    })
    const states = await service.runNow()
    expect(states[0]!.name).toBe('yt-1')
    expect(states[0]!.lastOk).toBe(true)
    expect(service.jarStatus()[0]!.checkup?.cookies).toBe(1)

    // component accepts the importer `with` payload verbatim through the loader
    const root = createRoot()
    const loader = new Loader(root, defineAll(createRegistry()))
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      poolEntry(dir),
      { id: 'cookie-keepalive', use: 'app/cookie-keepalive', with: { jobs: legacyJobs } },
    ])
    await root.idle()
    expect(loader.fiber('cookie-keepalive')!.state).toBe('ACTIVE')
    // the board rides the coeffect key (Def 24 channel); the node handle
    // exposes the service facade (single-slot ctx.expose)
    expect(typeof root.ctx.get<SessionHealthBoard>('cookie-health')?.guard).toBe('function')
    const handle = root.ctx.get<NodeHandle>(nodeKey('cookie-keepalive'))
    expect(typeof handle?.api<CookieKeepaliveService>()?.overview).toBe('function')
    const overview = handle?.api<CookieKeepaliveService>()?.overview()
    expect(overview?.jobs[0]?.name).toBe('yt-1')
    await root.dispose()
  } finally {
    process.env.PATH = prevPath
  }
})
