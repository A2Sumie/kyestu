import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, type EntryDef } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { Bus } from '../src/components/bus'
import type { KyestuDb } from '../src/components/db'
import { ArticleStore } from '../src/pipeline/articles'
import { ServiceStateStore } from '../src/pipeline/service-state'
import type { SendInput } from '../src/types/api'

// ---------------------------------------------------------------------------
// Router reliability paths that had zero coverage (router.ts:103, 111-117 —
// the two uncovered regions are exactly the failure semantics docs/bus.md
// promises): defer-cap drop, dispatch-error handling, rotation fairness.
// ---------------------------------------------------------------------------

const DB: EntryDef = { id: 'db', use: 'infra/db', with: { path: ':memory:' } }
const BUS_ENTRY: EntryDef = { id: 'bus', use: 'infra/bus' }
const routerEntry = (routes: unknown[], retry = 50): EntryDef => ({
  id: 'router',
  use: 'app/router',
  with: { routes, retry_interval_ms: retry },
})

async function boot(entries: EntryDef[], defineExtra?: (registry: ReturnType<typeof createRegistry>) => void) {
  const root = createRoot()
  const registry = defineAll(createRegistry())
  defineExtra?.(registry)
  const loader = new Loader(root, registry)
  await loader.load(entries)
  await root.idle()
  return {
    root,
    loader,
    bus: root.ctx.get<Bus>('bus')!,
    db: root.ctx.get<KyestuDb>('db')!,
  }
}

test('router: event whose target never comes up is dropped with a taint after the defer cap', async () => {
  const { root, loader, bus, db } = await boot([DB, BUS_ENTRY, routerEntry([{ from: 'c1', to: ['ghost-target'] }])])
  bus.emit('article', { platform: 'twitter', id: 1, a_id: 'a1', crawlerId: 'c1' })

  const fiber = loader.fiber('router')!
  const deadline = Date.now() + 12_000
  const isDropTaint = () =>
    fiber.taints.some((t) => String(t.error instanceof Error ? t.error.message : t.error).includes('dropping article'))
  while (!isDropTaint()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the drop taint')
    await Bun.sleep(50)
  }
  // the drop is loud (taint) and the persisted queue no longer resurrects it
  expect(new ServiceStateStore(db).get('router:router:queue')).toBeNull()
  await root.dispose()
}, 15_000)

test('router: a throwing target send taints the router fiber and the event is NOT retried (at-least-once boundary pin)', async () => {
  let calls = 0
  const { root, loader, bus, db } = await boot(
    [DB, BUS_ENTRY, { id: 't1', use: 'target/throwing' }, routerEntry([{ from: 'c1', to: ['t1'] }])],
    (registry) =>
      registry.define('target/throwing', {
        apply: (ctx) => {
          ctx.expose({
            send: async (_input: SendInput) => {
              calls++
              throw new Error('send boom')
            },
          })
        },
      }),
  )
  const id = new ArticleStore(db).save({ platform: 'twitter', a_id: 'a1', u_id: 'u', url: 'https://x/1' })!
  bus.emit('article', { platform: 'twitter', id, a_id: 'a1', crawlerId: 'c1' })

  const fiber = loader.fiber('router')!
  const deadline = Date.now() + 5000
  while (!fiber.taints.some((t) => String(t.error instanceof Error ? t.error.message : t.error).includes('send boom'))) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the dispatch-error taint')
    await Bun.sleep(20)
  }
  await Bun.sleep(250) // several sweeps pass: the dropped event is gone for good
  expect(calls).toBe(1)
  expect(new ServiceStateStore(db).get('router:router:queue')).toBeNull()
  // NOTE (design observation, not a bug verdict): the router queue is the only
  // re-dispatch source, and dispatch errors drop from it — a failed send
  // relies on the taint being seen, not on retry. Target-missing defers,
  // target-throwing does not. Asymmetry is deliberate-looking but undocumented.
  await root.dispose()
}, 10_000)

test('router: a deferred event rotates to the back and cannot head-of-line block later events', async () => {
  const sent: string[] = []
  const { root, bus, db } = await boot(
    [
      DB,
      BUS_ENTRY,
      { id: 'live', use: 'target/recording' },
      routerEntry([
        { from: 'c1', to: ['ghost-target'] },
        { from: 'c2', to: ['live'] },
      ]),
    ],
    (registry) =>
      registry.define('target/recording', {
        apply: (ctx) => {
          ctx.expose({
            send: async (input: SendInput) => {
              sent.push(String(input.article.a_id))
            },
          })
        },
      }),
  )
  const id2 = new ArticleStore(db).save({ platform: 'twitter', a_id: 'a2', u_id: 'u', url: 'https://x/2' })!
  bus.emit('article', { platform: 'twitter', id: 1, a_id: 'a1', crawlerId: 'c1' }) // deferred (ghost target)
  bus.emit('article', { platform: 'twitter', id: id2, a_id: 'a2', crawlerId: 'c2' }) // routable now

  const deadline = Date.now() + 5000
  while (sent.length === 0 && Date.now() < deadline) await Bun.sleep(20)
  expect(sent).toEqual(['a2']) // c2's event passed the deferred c1 event in the same drain pass
  expect(new ServiceStateStore(db).get('router:router:queue')).not.toBeNull() // c1 still queued
  await root.dispose()
}, 10_000)

test('router: event for a pruned article row is consumed silently (no send, no taint)', async () => {
  const sent: string[] = []
  const { root, loader, bus, db } = await boot(
    [DB, BUS_ENTRY, { id: 'live', use: 'target/recording' }, routerEntry([{ from: 'c1', to: ['live'] }])],
    (registry) =>
      registry.define('target/recording', {
        apply: (ctx) => {
          ctx.expose({ send: async (input: SendInput) => void sent.push(String(input.article.a_id)) })
        },
      }),
  )
  // no article row for id 999 (db-archive prunes old rows; the bus event outlives them)
  bus.emit('article', { platform: 'twitter', id: 999, a_id: 'gone', crawlerId: 'c1' })
  await Bun.sleep(200)
  expect(sent).toEqual([])
  expect(loader.fiber('router')!.taints).toEqual([])
  expect(new ServiceStateStore(db).get('router:router:queue')).toBeNull()
  await root.dispose()
}, 10_000)
