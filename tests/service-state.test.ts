import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot, Loader, createRegistry } from '../src/index'
import { defineAll } from '../src/components'
import { KyestuDb, defaultMigrationsDir } from '../src/components/db'
import { ServiceStateStore, sessionHealthStore, cooldownStore } from '../src/pipeline/service-state'
import { SessionHealthBoard } from '../src/pipeline/session-health'
import { CooldownMap } from '../src/pipeline/cooldown'
import { setCrawlDriverForTest } from '../src/components/crawler'

// ---------------------------------------------------------------------------
// service_state wiring (REVIEW §4.2): the risk-control states that used to be
// pure process memory — session quarantine and crawl cooldowns — are now
// written through to the service_state KV table and rehydrated on apply, so
// a fiber rebuild or a process restart does not reset risk control.
// ---------------------------------------------------------------------------

function tmpDbPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), label)), 'data.db')
}

function openKv(path: string): { db: KyestuDb; kv: ServiceStateStore } {
  const db = new KyestuDb(path)
  db.migrate(defaultMigrationsDir)
  return { db, kv: new ServiceStateStore(db) }
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met before deadline: ${what}`)
    await Bun.sleep(10)
  }
}

test('ServiceStateStore: CRUD + namespace listing with LIKE-escaped prefixes', () => {
  const { db, kv } = openKv(':memory:')
  try {
    expect(kv.get('missing')).toBeNull()
    kv.set('session-health:sess-a', '{"state":"quarantined"}')
    expect(kv.get('session-health:sess-a')).toBe('{"state":"quarantined"}')
    kv.set('session-health:sess-a', '{"state":"fresh"}')
    expect(kv.get('session-health:sess-a')).toBe('{"state":"fresh"}')
    kv.set('cooldown:c1:https://x/@a', '{}')
    kv.set('cooldown:c1:https://x/@b', '{}')
    kv.set('cooldown:c2:https://x/@a', '{}')
    expect(kv.list('cooldown:c1:').map((r) => r.key)).toEqual(['cooldown:c1:https://x/@a', 'cooldown:c1:https://x/@b'])
    // % and _ in a namespace are literals, not LIKE metacharacters
    kv.set('weird%:a', '1')
    kv.set('weirdX:a', '2')
    expect(kv.list('weird%:').map((r) => r.key)).toEqual(['weird%:a'])
    kv.delete('session-health:sess-a')
    expect(kv.get('session-health:sess-a')).toBeNull()
  } finally {
    db.close()
  }
})

test('session-health: quarantine survives a process restart (db file reopened)', () => {
  const path = tmpDbPath('kyestu-ss-board-')
  const now = 1_000_000

  // first "process": escalate to quarantine, then close the db
  let { db, kv } = openKv(path)
  const board = new SessionHealthBoard({ now: () => now, store: sessionHealthStore(kv) })
  board.record('sess-ig', false, new Error('login required'))
  board.record('sess-ig', false, new Error('login required'))
  expect(board.guard('sess-ig').blocked).toBe(true)
  db.close()

  // second "process": a fresh board over the same file must NOT touch the
  // dead session — the 8-16 lesson ("a dead session must STOP BEING TOUCHED")
  // held in memory before; now it holds across restarts
  ;({ db, kv } = openKv(path))
  const revived = new SessionHealthBoard({ now: () => now, store: sessionHealthStore(kv) })
  const verdict = revived.guard('sess-ig')
  expect(verdict.blocked).toBe(true)
  expect(verdict.reason).toContain('login required')
  expect(revived.guard('sess-other').blocked).toBe(false)

  // a manual resume persists the lift as well
  revived.resume('sess-ig')
  db.close()
  ;({ db, kv } = openKv(path))
  const third = new SessionHealthBoard({ now: () => now, store: sessionHealthStore(kv) })
  expect(third.guard('sess-ig').blocked).toBe(false)
  db.close()
})

test('session-health: quarantine survives a keepalive fiber rebuild (same process)', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-ss-rebuild-'))
  const entries = (stagger: number) => [
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: dir } },
    { id: 'cookie-keepalive', use: 'app/cookie-keepalive', with: { jobs: [], stagger_max_ms: stagger } },
  ]
  try {
    await loader.load(entries(1))
    await root.idle()
    expect(loader.fiber('cookie-keepalive')!.state).toBe('ACTIVE')
    const boardBefore = root.ctx.get<SessionHealthBoard>('cookie-health')!
    boardBefore.record('sess-x', false, new Error('401'))
    boardBefore.record('sess-x', false, new Error('401'))
    expect(boardBefore.guard('sess-x').blocked).toBe(true)

    // with-change rebuilds the keepalive fiber: a fresh board generation must
    // come up already quarantined, hydrated from service_state
    await loader.load(entries(2))
    await root.idle()
    expect(loader.fiber('cookie-keepalive')!.state).toBe('ACTIVE')
    const boardAfter = root.ctx.get<SessionHealthBoard>('cookie-health')!
    expect(boardAfter).not.toBe(boardBefore)
    expect(boardAfter.guard('sess-x').blocked).toBe(true)
  } finally {
    await root.dispose()
  }
})

test('cooldown: absolute expiry + backoff survive reopen; expired cooldowns never revive', () => {
  const path = tmpDbPath('kyestu-ss-cool-')
  let now = 0
  const url = 'https://www.tiktok.com/@a'
  const other = 'https://www.tiktok.com/@b'

  let { db, kv } = openKv(path)
  const map = new CooldownMap({ now: () => now, store: cooldownStore(kv, 'crawler-x') })
  expect(map.hit(url, 'auth', 'tiktok')).toBe(30 * 60 * 1000)
  expect(map.hit(url, 'auth', 'tiktok')).toBe(2 * 30 * 60 * 1000) // backoff 2^1
  expect(map.check(url).cooled).toBe(true)
  db.close()

  // restart: the live cooldown is still in force, sibling keys stay untouched
  ;({ db, kv } = openKv(path))
  const revived = new CooldownMap({ now: () => now, store: cooldownStore(kv, 'crawler-x') })
  expect(revived.check(url).cooled).toBe(true)
  expect(revived.check(other).cooled).toBe(false)
  db.close()

  // past the absolute expiry the cooldown does not revive, but the backoff
  // level survives (in-memory semantics: escalations outlive entries)
  now += 61 * 60 * 1000
  ;({ db, kv } = openKv(path))
  const expired = new CooldownMap({ now: () => now, store: cooldownStore(kv, 'crawler-x') })
  expect(expired.check(url).cooled).toBe(false)
  expect(expired.hit(url, 'auth', 'tiktok')).toBe(4 * 30 * 60 * 1000) // backoff 2^2
  db.close()

  // succeed() clears the row: backoff memory gone after a clean round
  ;({ db, kv } = openKv(path))
  const cleared = new CooldownMap({ now: () => now, store: cooldownStore(kv, 'crawler-x') })
  cleared.succeed(url)
  db.close()
  ;({ db, kv } = openKv(path))
  const fresh = new CooldownMap({ now: () => now, store: cooldownStore(kv, 'crawler-x') })
  expect(fresh.hit(url, 'auth', 'tiktok')).toBe(30 * 60 * 1000)
  db.close()
})

const TK_ORIGIN = 'https://tk.test'
const crawlerEntries = (dbPath: string, extra?: Record<string, unknown>) => [
  { id: 'db', use: 'infra/db', with: { path: dbPath } },
  { id: 'bus', use: 'infra/bus' },
  {
    id: 'tt-crawler',
    use: 'crawler/tiktok',
    with: { origin: TK_ORIGIN, paths: ['@a', '@b'], interval_time: { min: 0, max: 0 }, ...extra },
  },
]

test('cooldown: crawler fiber rebuild keeps cooled targets untouched (same process)', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const attempted: string[] = []
  try {
    setCrawlDriverForTest(async ({ url }) => {
      attempted.push(url)
      throw new Error('login required') // auth-class → 30min cooldown
    })
    await loader.load(crawlerEntries(':memory:'))
    await root.idle()
    await until(() => attempted.length >= 2, 5000, 'first round attempted both targets')

    // with-change rebuilds the crawler fiber; the fresh CooldownMap hydrates
    // from service_state, so the immediate first round skips cooled targets
    attempted.length = 0
    await loader.load(crawlerEntries(':memory:', { note: 'rebuild' }))
    await root.idle()
    await Bun.sleep(300)
    expect(attempted).toEqual([])
  } finally {
    setCrawlDriverForTest(null)
    await root.dispose()
  }
})

test('cooldown: process restart (new Root over the same db file) keeps cooled targets untouched', async () => {
  const dbPath = tmpDbPath('kyestu-ss-proc-')

  const root1 = createRoot()
  const loader1 = new Loader(root1, defineAll(createRegistry()))
  const attempted: string[] = []
  try {
    setCrawlDriverForTest(async ({ url }) => {
      attempted.push(url)
      throw new Error('login required')
    })
    await loader1.load(crawlerEntries(dbPath))
    await root1.idle()
    await until(() => attempted.length >= 2, 5000, 'first process attempted both targets')
  } finally {
    setCrawlDriverForTest(null)
    await root1.dispose()
  }

  // second "process": fresh Root, fresh connections, same db file
  const root2 = createRoot()
  const loader2 = new Loader(root2, defineAll(createRegistry()))
  const attemptedAfterRestart: string[] = []
  try {
    setCrawlDriverForTest(async ({ url }) => {
      attemptedAfterRestart.push(url)
      return []
    })
    await loader2.load(crawlerEntries(dbPath))
    await root2.idle()
    await Bun.sleep(300)
    // the restart must not immediately re-touch risk-cooled targets
    expect(attemptedAfterRestart).toEqual([])
  } finally {
    setCrawlDriverForTest(null)
    await root2.dispose()
  }
})
