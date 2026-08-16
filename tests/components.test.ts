import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot, createRegistry, Loader, NodeHandle, nodeKey } from '../src/index'
import { KyestuDb, dbComponent, defaultMigrationsDir } from '../src/components/db'
import { BrowserSessionPool } from '../src/components/browser-pool'
import { OneBotClient, OneBotNonRetryableError } from '../src/components/onebot'
import { OpenAiProcessorClient } from '../src/components/llm-openai'
import { defineInfra } from '../src/components'

// ---------- db ----------

test('db: migrations apply once and produce the production schema', () => {
  const db = new KyestuDb(':memory:')
  const applied = db.migrate(defaultMigrationsDir)
  expect(applied.length).toBe(9)
  expect(db.migrate(defaultMigrationsDir)).toEqual([])
  const tables = (db.db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  )
  for (const table of ['task_queue', 'outbound_messages', 'media_hashes', 'video_pairings', 'service_state', 'target_health']) {
    expect(tables).toContain(table)
  }
  db.close()
})

test('db component: provides db coeffect and closes on unload', async () => {
  const root = createRoot()
  const registry = createRegistry()
  defineInfra(registry)
  const loader = new Loader(root, registry)
  await loader.load([{ id: 'db', use: 'infra/db', with: { path: ':memory:' } }])
  await root.idle()
  const db = root.ctx.get<KyestuDb>('db')
  expect(db).toBeInstanceOf(KyestuDb)
  const handle = root.ctx.get<NodeHandle>(nodeKey('db'))
  expect(handle?.api<KyestuDb>()).toBe(db)
  await root.dispose()
  expect(root.ctx.get('db')).toBeUndefined()
})

// ---------- browser pool ----------

function fakeBrowser(launches: string[]) {
  const listeners = new Map<string, Array<() => void>>()
  const page = new Proxy(
    {},
    {
      get: (_t, prop) => {
        // never thenable: an async createPage return unwraps `then` and would hang forever
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
        if (prop === 'close') return async () => {}
        return async () => undefined
      },
    },
  )
  const browser = {
    connected: true,
    newPage: async () => page,
    close: async () => {
      browser.connected = false
    },
    process: () => undefined,
    once: (event: string, cb: () => void) => {
      listeners.set(event, [cb])
      return browser
    },
    disconnect: () => {
      browser.connected = false
      for (const cb of listeners.get('disconnected') ?? []) cb()
    },
  }
  return browser
}

test('browser pool: same profile reuses one launch; concurrent createPage dedups the launch', async () => {
  const launches: string[] = []
  const pool = new BrowserSessionPool({
    cacheRoot: mkdtempSync(join(tmpdir(), 'kyestu-browser-')),
    skipBackoff: true,
    launcher: async (_mode, userDataDir) => {
      launches.push(userDataDir)
      return fakeBrowser(launches) as any
    },
  })
  const [p1, p2] = await Promise.all([pool.createPage({ session_profile: 'x-main' }), pool.createPage({ session_profile: 'x-main' })])
  expect(launches.length).toBe(1)
  await pool.closeAll()
})

test('browser pool: disconnect evicts; next createPage relaunches', async () => {
  const launches: string[] = []
  let browser = fakeBrowser(launches)
  const pool = new BrowserSessionPool({
    cacheRoot: mkdtempSync(join(tmpdir(), 'kyestu-browser-')),
    skipBackoff: true,
    launcher: async () => {
      browser = fakeBrowser(launches)
      launches.push('launch')
      return browser as any
    },
  })
  await pool.createPage({ session_profile: 'ig' })
  expect(pool.size).toBe(1)
  browser.disconnect()
  await Bun.sleep(5)
  expect(pool.size).toBe(0)
  await pool.createPage({ session_profile: 'ig' })
  expect(launches.length).toBe(2)
  await pool.closeAll()
})

// ---------- onebot ----------

async function withMockOneBot(respond: (action: string, payload: any) => any, fn: (url: string) => Promise<void>) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const action = new URL(req.url).pathname.slice(1)
      const payload = await req.json()
      return Response.json(respond(action, payload))
    },
  })
  try {
    await fn(`http://127.0.0.1:${server.port}`)
  } finally {
    server.stop(true)
  }
}

test('onebot: group send posts correct payload; retcode 200 maps to non-retryable', async () => {
  const seen: any[] = []
  await withMockOneBot(
    (action, payload) => {
      seen.push({ action, payload })
      if (action === 'send_group_msg') return { status: 'ok', retcode: 0, data: { message_id: 1 } }
      return { status: 'failed', retcode: 200, message: 'EventChecker muted' }
    },
    async (url) => {
      const client = new OneBotClient({ http_url: url })
      const res = await client.sendGroupMsg(123, [{ type: 'text', data: { text: 'hi' } }])
      expect(res.message_id).toBe(1)
      await expect(client.sendPrivateMsg(42, 'x')).rejects.toBeInstanceOf(OneBotNonRetryableError)
    },
  )
  expect(seen[0]).toMatchObject({ action: 'send_group_msg', payload: { group_id: 123 } })
  expect(seen[1].action).toBe('send_private_msg')
})

// ---------- llm openai ----------

async function withMockLlm(handlers: Record<string, (payload: any) => Response | Promise<Response>>, fn: (base: string) => Promise<void>) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const handler = handlers[path]
      if (!handler) return new Response('not found', { status: 404 })
      return handler(await req.json())
    },
  })
  try {
    await fn(`http://127.0.0.1:${server.port}`)
  } finally {
    server.stop(true)
  }
}

const chatOk = (text: string) => (payload: any) =>
  Response.json({ choices: [{ message: { role: 'assistant', content: text } }] }, {
    headers: { 'content-type': 'application/json' },
  })

test('llm: chat_completions request shape and parse', async () => {
  const seen: any[] = []
  await withMockLlm(
    {
      '/v1/chat/completions': (payload) => {
        seen.push(payload)
        return chatOk('译文')(payload)
      },
    },
    async (base) => {
      const client = new OpenAiProcessorClient({
        api_key: 'k',
        base_url: `${base}/v1/chat/completions`,
        model_id: 'm1',
        wire_api: 'chat_completions',
        prompt: 'translate',
        temperature: 0.5,
      })
      expect(await client.process('原文')).toBe('译文')
      expect(seen[0]).toMatchObject({ model: 'm1', temperature: 0.5, messages: [{ role: 'system', content: 'translate' }, { role: 'user', content: '原文' }] })
    },
  )
})

test('llm: responses request shape and output_text parse', async () => {
  const seen: any[] = []
  await withMockLlm(
    {
      '/responses': (payload) => {
        seen.push(payload)
        return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'R' }] }] })
      },
    },
    async (base) => {
      const client = new OpenAiProcessorClient({
        api_key: 'k',
        base_url: `${base}/responses`,
        model_id: 'm2',
        wire_api: 'responses',
        max_tokens: 128,
      })
      expect(await client.process('x')).toBe('R')
      expect(seen[0]).toMatchObject({ model: 'm2', max_output_tokens: 128 })
      expect(seen[0].input[1]).toEqual({ role: 'user', content: 'x' })
    },
  )
})

test('llm: 5xx retries then succeeds; 4xx never retries; total failure delegates to fallback', async () => {
  let primaryCalls = 0
  await withMockLlm(
    {
      '/flaky': () => {
        primaryCalls++
        return primaryCalls < 3 ? new Response('err', { status: 500 }) : chatOk('ok')(null)
      },
      '/auth': () => new Response('no', { status: 401 }),
      '/backup': chatOk('fallback-result'),
    },
    async (base) => {
      const retryClient = new OpenAiProcessorClient({ api_key: 'k', base_url: `${base}/flaky`, wire_api: 'chat_completions' })
      expect(await retryClient.process('x')).toBe('ok')
      expect(primaryCalls).toBe(3)

      const authClient = new OpenAiProcessorClient({ api_key: 'k', base_url: `${base}/auth` })
      await expect(authClient.process('x')).rejects.toThrow('401')

      const fallbackClient = new OpenAiProcessorClient({
        api_key: 'k',
        base_url: `${base}/auth`,
        fallback: { base_url: `${base}/backup` },
      })
      expect(await fallbackClient.process('x')).toBe('fallback-result')
    },
  )
})

test('llm: env: api key resolution', async () => {
  process.env.KYESTU_TEST_KEY = 'secret'
  let auth = ''
  await withMockLlm(
    {
      '/v1/chat/completions': async () => {
        return chatOk('ok')(null)
      },
    },
    async (base) => {
      const client = new OpenAiProcessorClient({ api_key: 'env:KYESTU_TEST_KEY', base_url: `${base}/v1/chat/completions` })
      await client.process('x')
    },
  )
  delete process.env.KYESTU_TEST_KEY
  expect(() => new OpenAiProcessorClient({ api_key: 'env:KYESTU_MISSING_KEY' })).toThrow()
})
