import { test, expect } from 'bun:test'
import { createRoot, Loader, createRegistry } from '../src/index'
import { defineAll } from '../src/components'
import { setCrawlDriverForTest } from '../src/components/crawler'

// ---------------------------------------------------------------------------
// Regression: 2026-08-20 idol-bbq incident — risk control intermittently served
// a not-found page for @sally_amaki; each TiktokInvalidHandleError cooled the
// WHOLE TikTok session (~6h per episode) because crawlCooldownKey only carried
// a per-handle scope for Instagram (fixed in idol-bbq-utils 5693a86).
// kyestu keys CooldownMap by full target URL (crawler.ts round loop), which is
// the same isolation guarantee taken further. This test pins the observable
// behavior: one handle's invalid_handle must NOT skip sibling handles in the
// same round — with host-level keying the second URL would be cooled the
// moment the first one fails.
// ---------------------------------------------------------------------------

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met before deadline: ${what}`)
    await Bun.sleep(10)
  }
}

test('cooldown isolation: invalid_handle on one TikTok handle does not cool sibling handles', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const attempted: string[] = []
  try {
    setCrawlDriverForTest(async ({ url }) => {
      attempted.push(url)
      if (url.includes('sally_amaki')) {
        const err: any = new Error('TikTok handle @sally_amaki appears to not exist (tiktok_invalid_handle)')
        err.code = 'tiktok_invalid_handle'
        throw err
      }
      return []
    })
    await loader.load([
      { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
      { id: 'bus', use: 'infra/bus' },
      {
        id: 'tt-crawler',
        use: 'crawler/tiktok',
        with: {
          origin: 'https://www.tiktok.com',
          paths: ['@sally_amaki', '@227official'],
          interval_time: { min: 0, max: 0 },
        },
      },
    ])
    await root.idle()
    expect(loader.fiber('tt-crawler')!.state).toBe('ACTIVE')
    // first round fires immediately: the failing handle is hit first, and the
    // sibling MUST still be crawled afterwards (not skipped by its cooldown)
    await until(() => attempted.length >= 2, 5000, 'both handles attempted in the first round')
    expect(attempted[0]).toContain('sally_amaki')
    expect(attempted.some((u) => u.includes('227official'))).toBe(true)
  } finally {
    setCrawlDriverForTest(null)
    await root.dispose()
  }
})

test('cooldown isolation: CooldownMap keys stay per-target across classes', async () => {
  const { CooldownMap } = await import('../src/pipeline/cooldown')
  const map = new CooldownMap()
  const a = 'https://www.tiktok.com/@sally_amaki'
  const b = 'https://www.tiktok.com/@227official'
  map.hit(a, 'invalid_handle', 'tiktok')
  expect(map.check(a).cooled).toBe(true)
  expect(map.check(b).cooled).toBe(false)
  map.succeed(a)
  expect(map.check(a).cooled).toBe(false)
})
