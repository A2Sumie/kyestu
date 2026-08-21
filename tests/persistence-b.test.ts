import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot, Loader, createRegistry } from '../src/index'
import { defineAll } from '../src/components'
import { KyestuDb, defaultMigrationsDir } from '../src/components/db'
import type { Component } from '../src/core/types'
import { ServiceStateStore, llmCircuitStore, routerQueueStore, digestStateStore } from '../src/pipeline/service-state'
import { CircuitOpenError, OpenAiProcessorClient } from '../src/components/llm-openai'
import { ArticleStore } from '../src/pipeline/articles'
import { OutboundStore } from '../src/pipeline/outbound'
import { TargetRuntime, type TargetRuntimeConfig } from '../src/pipeline/target-runtime'
import { NodeHandle, nodeKey } from '../src/loader/loader'
import type { Bus } from '../src/components/bus'
import type { SendInput } from '../src/components/target-qq'

// ---------------------------------------------------------------------------
// service_state wiring, batch 3 (REVIEW §4.2): the remaining pure-memory
// states — LLM circuit breaker, router pending queue, digest buffer +
// firstSentWindows — are written through to service_state and rehydrated on
// apply/construct, so a fiber rebuild or a process restart neither resets
// risk control nor loses/duplicates outbound.
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

// connection-refused endpoint: fast failures without a mock server
const DEAD_LLM = 'http://127.0.0.1:9/v1/chat/completions'

// ---------------------------------------------------------------------------
// LLM circuit breaker (llm-circuit:<entry-id>)
// ---------------------------------------------------------------------------

test('llm-circuit: open state + failure counter survive a db reopen; expired open never revives', async () => {
  const path = tmpDbPath('kyestu-pb-circuit-')
  const config = { api_key: 'k', base_url: DEAD_LLM, circuit: { failure_threshold: 2, cooldown_seconds: 300 } }

  let { db, kv } = openKv(path)
  const first = new OpenAiProcessorClient(config, { store: llmCircuitStore(kv, 'ja-zh') })
  await expect(first.process('hello')).rejects.toThrow()
  expect(first.status().state).toBe('closed')
  expect(first.status().consecutive_failures).toBe(1)
  await expect(first.process('hello')).rejects.toThrow()
  expect(first.status().state).toBe('open')
  const openUntil = first.status().open_until
  expect(openUntil).not.toBeNull()
  // the breaker short-circuits without touching the network
  await expect(first.process('hello')).rejects.toThrow(CircuitOpenError)
  db.close()

  // second "process": the fresh client hydrates already open, with the same
  // absolute open-until timestamp — no provider hammering after a restart
  ;({ db, kv } = openKv(path))
  const revived = new OpenAiProcessorClient(config, { store: llmCircuitStore(kv, 'ja-zh') })
  expect(revived.status().state).toBe('open')
  expect(revived.status().open_until).toBe(openUntil)
  expect(revived.status().consecutive_failures).toBe(2)
  await expect(revived.process('hello')).rejects.toThrow(CircuitOpenError)

  // an expired open never revives, but the failure counter survives until the
  // next success (same convention as CooldownMap's escalations)
  kv.set('llm-circuit:old', JSON.stringify({ consecutiveFailures: 1, openUntil: Date.now() - 1000, lastError: 'boom' }))
  const expired = new OpenAiProcessorClient(config, { store: llmCircuitStore(kv, 'old') })
  expect(expired.status().state).toBe('closed')
  expect(expired.status().consecutive_failures).toBe(1)
  // one more failure reaches the threshold and re-opens immediately
  await expect(expired.process('hello')).rejects.toThrow()
  expect(expired.status().state).toBe('open')

  // a corrupt row must never block boot; the in-memory default wins
  kv.set('llm-circuit:bad', '{corrupt')
  const fallback = new OpenAiProcessorClient(config, { store: llmCircuitStore(kv, 'bad') })
  expect(fallback.status().state).toBe('closed')
  expect(fallback.status().consecutive_failures).toBe(0)
  db.close()
})

test('llm-circuit: success clears the persisted row; fallback breaker persists under its own key', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ choices: [{ message: { content: 'ok' } }] }),
  })
  const { db, kv } = openKv(':memory:')
  try {
    const base = `http://127.0.0.1:${server.port}/v1/chat/completions`
    kv.set('llm-circuit:p', JSON.stringify({ consecutiveFailures: 1, openUntil: 0, lastError: 'boom' }))
    const healed = new OpenAiProcessorClient({ api_key: 'k', base_url: base }, { store: llmCircuitStore(kv, 'p') })
    expect(healed.status().consecutive_failures).toBe(1)
    expect(await healed.process('hi')).toBe('ok')
    expect(kv.get('llm-circuit:p')).toBeNull()
    expect(healed.status().consecutive_failures).toBe(0)

    const withFallback = new OpenAiProcessorClient(
      { api_key: 'k', base_url: DEAD_LLM, circuit: { failure_threshold: 1, cooldown_seconds: 300 }, fallback: { base_url: DEAD_LLM } },
      { store: llmCircuitStore(kv, 'f1'), fallbackStore: llmCircuitStore(kv, 'f1:fallback') },
    )
    await expect(withFallback.process('x')).rejects.toThrow()
    expect(kv.get('llm-circuit:f1')).not.toBeNull()
    expect(kv.get('llm-circuit:f1:fallback')).not.toBeNull()
  } finally {
    server.stop()
    db.close()
  }
})

test('llm-circuit: processor fiber rebuild keeps the breaker open (same process)', async () => {
  const root = createRoot()
  const loader = new Loader(root, defineAll(createRegistry()))
  const entries = (note: string) => [
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    {
      id: 'llm',
      use: 'processor/openai',
      with: { api_key: 'k', base_url: DEAD_LLM, circuit: { failure_threshold: 1, cooldown_seconds: 300 }, note },
    },
  ]
  try {
    await loader.load(entries('a'))
    await root.idle()
    const before = root.ctx.get<NodeHandle>(nodeKey('llm'))!.api<OpenAiProcessorClient>()!
    await expect(before.process('x')).rejects.toThrow()
    expect(before.status().state).toBe('open')

    // with-change rebuilds the processor fiber: the fresh client must come up
    // already open, hydrated from service_state before expose
    await loader.load(entries('b'))
    await root.idle()
    const after = root.ctx.get<NodeHandle>(nodeKey('llm'))!.api<OpenAiProcessorClient>()!
    expect(after).not.toBe(before)
    expect(after.status().state).toBe('open')
    await expect(after.process('x')).rejects.toThrow(CircuitOpenError)
  } finally {
    await root.dispose()
  }
})

// ---------------------------------------------------------------------------
// router pending queue (router:<entry-id>:queue)
// ---------------------------------------------------------------------------

/** minimal TargetApi stand-in that records sends and marks forwarded like the real targets */
function recorderComponent(sent: SendInput[]): Component<Record<string, any>> {
  return {
    inject: ['db'],
    apply: (ctx) => {
      const db = ctx.get<KyestuDb>('db')!
      const outbound = new OutboundStore(db)
      ctx.expose({
        send: async (input: SendInput) => {
          sent.push(input)
          outbound.markForwarded(input.article.platform as any, input.article.a_id, String(input.route.target))
        },
      })
    },
  }
}

const ROUTE = { from: 'x-main', to: ['t1'] }

function saveArticle(db: KyestuDb, aId: string, content: string): number {
  const id = new ArticleStore(db).save({ platform: 'twitter', a_id: aId, u_id: 'u1', url: `https://x.com/u1/status/${aId}`, content })
  if (id === null) throw new Error(`article already exists: ${aId}`)
  return id
}

test('router queue store: corrupt/invalid rows never resurrect', () => {
  const { db, kv } = openKv(':memory:')
  try {
    kv.set('router:r1:queue', '{corrupt')
    expect(routerQueueStore(kv, 'r1').load()).toEqual([])
    kv.set('router:r1:queue', JSON.stringify([{ platform: 'twitter', id: 1, a_id: 'a', crawlerId: 'c' }, { nope: true }, null]))
    expect(routerQueueStore(kv, 'r1').load()).toEqual([{ platform: 'twitter', id: 1, a_id: 'a', crawlerId: 'c' }])
    routerQueueStore(kv, 'r1').save([])
    expect(kv.get('router:r1:queue')).toBeNull()
  } finally {
    db.close()
  }
})

test('router: event queued while the target is down survives a process restart and is dispatched exactly once', async () => {
  const dbPath = tmpDbPath('kyestu-pb-router-')

  // first "process": router without its target — the event defers and persists
  const root1 = createRoot()
  const loader1 = new Loader(root1, defineAll(createRegistry()))
  let rowId = 0
  try {
    await loader1.load([
      { id: 'db', use: 'infra/db', with: { path: dbPath } },
      { id: 'bus', use: 'infra/bus' },
      { id: 'router', use: 'app/router', with: { routes: [ROUTE], retry_interval_ms: 50 } },
    ])
    await root1.idle()
    const db = root1.ctx.get<KyestuDb>('db')!
    const kv = new ServiceStateStore(db)
    rowId = saveArticle(db, 'a1', 'hello')
    root1.ctx.get<Bus>('bus')!.emit('article', { platform: 'twitter', id: rowId, a_id: 'a1', crawlerId: 'x-main' })
    await until(() => kv.get('router:router:queue') !== null, 5000, 'queue persisted')
    await Bun.sleep(200) // a few deferred sweeps; the event must stay queued, not dropped
    expect(kv.get('router:router:queue')).not.toBeNull()
  } finally {
    await root1.dispose()
  }

  // second "process": the target is present — hydrate + drain, exactly one send
  const sent: SendInput[] = []
  const root2 = createRoot()
  const registry2 = defineAll(createRegistry())
  registry2.define('target/recorder', recorderComponent(sent))
  const loader2 = new Loader(root2, registry2)
  try {
    await loader2.load([
      { id: 'db', use: 'infra/db', with: { path: dbPath } },
      { id: 'bus', use: 'infra/bus' },
      { id: 't1', use: 'target/recorder' },
      { id: 'router', use: 'app/router', with: { routes: [ROUTE], retry_interval_ms: 50 } },
    ])
    await root2.idle()
    await until(() => sent.length === 1, 5000, 'hydrated event dispatched')
    await Bun.sleep(300)
    expect(sent.length).toBe(1) // no replay duplicates
    const db = root2.ctx.get<KyestuDb>('db')!
    expect(new ServiceStateStore(db).get('router:router:queue')).toBeNull() // queue row consumed

    // re-emitting the same article dedups via outbound.forwarded
    root2.ctx.get<Bus>('bus')!.emit('article', { platform: 'twitter', id: rowId, a_id: 'a1', crawlerId: 'x-main' })
    await Bun.sleep(200)
    expect(sent.length).toBe(1)
  } finally {
    await root2.dispose()
  }
})

test('router: fiber rebuild reconciles the persisted queue against outbound — no duplicate dispatch', async () => {
  const sent: SendInput[] = []
  const root = createRoot()
  const registry = defineAll(createRegistry())
  registry.define('target/recorder', recorderComponent(sent))
  const loader = new Loader(root, registry)
  const entries = (note: string) => [
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    { id: 't1', use: 'target/recorder' },
    { id: 'router', use: 'app/router', with: { routes: [ROUTE], retry_interval_ms: 50, note } },
  ]
  try {
    await loader.load(entries('a'))
    await root.idle()
    const db = root.ctx.get<KyestuDb>('db')!
    const rowId = saveArticle(db, 'a1', 'hello')
    root.ctx.get<Bus>('bus')!.emit('article', { platform: 'twitter', id: rowId, a_id: 'a1', crawlerId: 'x-main' })
    await until(() => sent.length === 1, 5000, 'first dispatch')

    // with-change rebuilds the router fiber: hydration must see the article
    // already forwarded and drop it instead of replaying
    await loader.load(entries('b'))
    await root.idle()
    await Bun.sleep(300)
    expect(sent.length).toBe(1)
  } finally {
    await root.dispose()
  }
})

// ---------------------------------------------------------------------------
// digest buffer + firstSentWindows (digest:<target-entry-id>:…)
// ---------------------------------------------------------------------------

function digestInput(aId: string, text: string): SendInput {
  return {
    article: { platform: 'twitter', a_id: aId, created_at: Math.floor(Date.now() / 1000), content: text },
    rendered: { text, media: [] },
    route: { crawler: 'x-main', formatter: null, target: 't1' },
  }
}

test('digest store: corrupt/invalid rows never resurrect', () => {
  const { db, kv } = openKv(':memory:')
  try {
    kv.set('digest:t1:buffer', '{corrupt')
    expect(digestStateStore(kv, 't1').loadBuffer()).toEqual([])
    kv.set('digest:t1:buffer', JSON.stringify([{ text: 5 }, { input: null, text: 'x' }, { input: { article: { platform: 'twitter', a_id: 'a1' }, rendered: { text: 'ok', media: [] }, route: { crawler: 'c', target: 't1' } }, text: 'ok' }]))
    expect(digestStateStore(kv, 't1').loadBuffer()).toHaveLength(1)
    kv.set('digest:t1:first-sent-windows', '[1, "x", null, 2]')
    expect(digestStateStore(kv, 't1').loadFirstSentWindows()).toEqual([1, 2])
  } finally {
    db.close()
  }
})

test('digest: buffered items survive a db reopen and flush once, merged, at threshold', async () => {
  const path = tmpDbPath('kyestu-pb-digest-')
  const root = createRoot()
  let { db, kv } = openKv(path)
  try {
    const sentTexts: string[] = []
    const config: TargetRuntimeConfig = { digest_threshold: 2 }
    const first = new TargetRuntime(root.ctx, db, 't1', config, async (_input, text) => {
      sentTexts.push(text)
    })
    await first.send(digestInput('a1', 'first'))
    expect(sentTexts).toEqual([]) // still buffered
    expect(kv.get('digest:t1:buffer')).not.toBeNull()
    db.close()

    // reopen the same db file: the rebuilt runtime hydrates the pending batch
    ;({ db, kv } = openKv(path))
    const revived = new TargetRuntime(root.ctx, db, 't1', config, async (_input, text) => {
      sentTexts.push(text)
    })
    await revived.send(digestInput('a2', 'second'))
    expect(sentTexts).toEqual(['first\n———\nsecond'])
    expect(kv.get('digest:t1:buffer')).toBeNull() // buffer row consumed on flush
  } finally {
    db.close()
    await root.dispose()
  }
})

test('digest: first-sent window mark survives a restart — the open window is not re-sent immediately', async () => {
  const path = tmpDbPath('kyestu-pb-first-')
  const root = createRoot()
  let { db, kv } = openKv(path)
  try {
    const rawSent: string[] = []
    const config: TargetRuntimeConfig = { summary_card: { enabled: true, threshold: 8 } }
    const first = new TargetRuntime(root.ctx, db, 't1', config, async (_input, text) => {
      rawSent.push(text)
    })
    await first.send(digestInput('a1', 'first'))
    expect(rawSent).toEqual(['first']) // send_first_immediately defaults to true
    expect(kv.get('digest:t1:first-sent-windows')).not.toBeNull()
    db.close()

    // restart: the same aggregation window is still open (same idempotency
    // key), and its first item was already sent — the next article must join
    // the window instead of going out immediately a second time
    ;({ db, kv } = openKv(path))
    const revived = new TargetRuntime(root.ctx, db, 't1', config, async (_input, text) => {
      rawSent.push(text)
    })
    await revived.send(digestInput('a2', 'second'))
    expect(rawSent).toEqual(['first'])
    const items = db.db.query('SELECT COUNT(*) AS c FROM aggregation_items').get() as { c: number }
    expect(Number(items.c)).toBe(1)
  } finally {
    db.close()
    await root.dispose()
  }
})
