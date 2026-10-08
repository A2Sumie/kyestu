import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, type EntryDef } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { setCrawlDriverForTest, type CrawlResult } from '../src/components/crawler'
import { ServiceStateStore } from '../src/pipeline/service-state'
import type { KyestuDb } from '../src/components/db'

// ---------------------------------------------------------------------------
// Generation guard on the crawler round continuation (same ghost-write class
// router.ts pins with its `alive` flag): a crawl round that outlives its own
// fiber generation — a rebuild/reload landed while the fetch was in flight —
// must not write cooldowns or feed the health board. The cooldown store is
// shared with the new generation via service_state, so stale bookkeeping is
// a ghost write past the runtime's generation guard.
// ---------------------------------------------------------------------------

const DB: EntryDef = { id: 'db', use: 'infra/db', with: { path: ':memory:' } }
const BUS: EntryDef = { id: 'bus', use: 'infra/bus' }
const crawler = (extra: Record<string, unknown>): EntryDef => ({
  id: 'x-main',
  use: 'crawler/x',
  with: { origin: 'https://x.com', paths: ['a'], interval_time: { min: 0, max: 0 }, ...extra },
})

const COOLDOWN_KEY = 'cooldown:x-main:https://x.com/a'

const X_ARTICLE: CrawlResult = {
  platform: 1,
  a_id: '1890000000000000002',
  u_id: 'example_member',
  url: 'https://x.com/example_member/status/1890000000000000002',
}

function rateLimitError(): Error {
  return new Error('429 Too Many Requests')
}

async function untilOk(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await Bun.sleep(10)
  }
}

test('stale generation: a failed round that outlived a rebuild must not ghost-write cooldown rows', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  let calls = 0
  let releaseFirst!: (error: Error) => void
  const firstCall = new Promise<CrawlResult[]>((_resolve, reject) => {
    releaseFirst = reject
  })
  setCrawlDriverForTest(async () => {
    calls++
    if (calls === 1) return firstCall // gen1 initial round parks here
    return [] // gen2+ rounds succeed empty
  })
  try {
    await loader.load([DB, BUS, crawler({})])
    await root.idle()
    await untilOk(() => calls === 1, 3000, 'gen1 round in flight')

    // rebuild (with-change): gen1's round is still parked at the driver gate
    await loader.reconcile([DB, BUS, crawler({ label: 'gen2' })])
    await root.idle()
    await untilOk(() => calls === 2, 3000, 'gen2 initial round ran')

    // gen1's platform answer arrives only now: rate-limited. The fetch was
    // legitimately started by gen1, but its bookkeeping must not land in the
    // store gen2 already hydrated from.
    releaseFirst(rateLimitError())
    await Bun.sleep(50)

    const kv = new ServiceStateStore(root.ctx.get<KyestuDb>('db')!)
    expect(kv.get(COOLDOWN_KEY)).toBeNull()
    expect(calls).toBe(2) // the overlap itself (fetch not cancelled) is documented, not guarded
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
  }
}, 10_000)

test('stale generation: a succeeded round that outlived a rebuild must not ghost-delete the new cooldown row', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  let calls = 0
  let releaseFirst!: (articles: CrawlResult[]) => void
  const firstCall = new Promise<CrawlResult[]>((resolve) => {
    releaseFirst = resolve
  })
  setCrawlDriverForTest(async () => {
    calls++
    if (calls === 1) return firstCall // gen1 parks
    if (calls === 2) throw rateLimitError() // gen2 fails fast and writes a real cooldown
    return []
  })
  try {
    await loader.load([DB, BUS, crawler({})])
    await root.idle()
    await untilOk(() => calls === 1, 3000, 'gen1 round in flight')

    await loader.reconcile([DB, BUS, crawler({ label: 'gen2' })])
    await root.idle()
    const kv = new ServiceStateStore(root.ctx.get<KyestuDb>('db')!)
    await untilOk(() => kv.get(COOLDOWN_KEY) !== null, 3000, 'gen2 cooldown row persisted')

    // gen1's fetch completes successfully — its continuation's cooldowns.succeed
    // would delete the row gen2 just wrote (stale instance, shared store)
    releaseFirst([X_ARTICLE])
    await Bun.sleep(50)

    expect(kv.get(COOLDOWN_KEY)).not.toBeNull()
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
  }
}, 10_000)
