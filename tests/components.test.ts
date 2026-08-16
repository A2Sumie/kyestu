import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot, createRegistry, Loader, NodeHandle, nodeKey } from '../src/index'
import { KyestuDb, dbComponent, defaultMigrationsDir } from '../src/components/db'
import { BrowserSessionPool } from '../src/components/browser-pool'
import { OneBotClient, OneBotNonRetryableError } from '../src/components/onebot'
import { OpenAiProcessorClient } from '../src/components/llm-openai'
import { defineInfra, defineAll } from '../src/components'

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

test('browser pool: on macOS without Xvfb, headed modes are downgraded to headless', async () => {
  if (process.platform !== 'darwin') return
  const modes: string[] = []
  const pool = new BrowserSessionPool({
    cacheRoot: mkdtempSync(join(tmpdir(), 'kyestu-browser-')),
    skipBackoff: true,
    launcher: async (mode) => {
      modes.push(mode)
      return fakeBrowser([]) as any
    },
  })
  delete process.env.ENABLE_XVFB
  await pool.createPage({ session_profile: 'guard', browser_mode: 'headed-xvfb' as any })
  expect(modes).toEqual(['headless'])
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

// ---------- regression: formatter img family video/fallback semantics ----------

async function renderWith(renderType: string, article: any): Promise<any> {
  const root = createRoot()
  const registry = createRegistry()
  defineAll(registry)
  const loader = new Loader(root, registry)
  await loader.load([
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'media-store', use: 'infra/media-store', with: { cache_root: mkdtempSync(join(tmpdir(), 'kyestu-fmt-')) } },
    { id: 'fmt', use: `formatter/${renderType}` },
  ])
  await root.idle()
  const api = root.ctx.get<NodeHandle>(nodeKey('fmt'))!.api<{ render: (a: any) => Promise<any> }>()!
  const out = await api.render(article)
  await root.dispose()
  return out
}

test('formatter: img falls back to full text when card render fails (no empty message)', async () => {
  // break the render package's font lookup -> renderCard catches and returns null
  const savedFonts = process.env.FONTS_DIR
  process.env.FONTS_DIR = '/nonexistent-fonts-dir'
  try {
    const out = await renderWith('img', {
      platform: 'twitter', a_id: '1', u_id: 'u', username: 'u', created_at: 1760000000,
      content: 'カード失敗時の本文', url: 'https://x/1', type: 'post', ref: null, has_media: false, media: [], extra: null, u_avatar: null,
    })
    expect(out.text).toContain('カード失敗時の本文')
  } finally {
    if (savedFonts) process.env.FONTS_DIR = savedFonts
  }
})

test('formatter: img/img-with-meta exempt video platforms (TikTok) to full text', async () => {
  const videoArticle = {
    platform: 'tiktok', a_id: '2', u_id: 'u', username: 'u', created_at: 1760000000,
    content: '動画です', url: 'https://tt/2', type: 'post', ref: null, has_media: true,
    media: [{ type: 'video', url: 'https://tt/2.mp4' }], extra: null, u_avatar: null,
  }
  const img = await renderWith('img', videoArticle)
  expect(img.text).toContain('動画です')
  const meta = await renderWith('img-with-meta', videoArticle)
  expect(meta.text).toContain('動画です')
})

// ---------- live player ----------

test('live-player: relays bus live events to the player sync endpoint only', async () => {
  const posts: Array<{ body: any; auth: string | null; waf: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      posts.push({
        body: await req.json(),
        auth: req.headers.get('authorization'),
        waf: req.headers.get('x-n2nj-pass'),
      })
      return Response.json({ ok: true })
    },
  })
  try {
    const root = createRoot()
    const registry = createRegistry()
    defineAll(registry)
    const loader = new Loader(root, registry)
    await loader.load([
      { id: 'bus', use: 'infra/bus' },
      {
        id: 'live-player',
        use: 'app/live-player',
        with: {
          targets: {
            shiina_satsuki227: {
              live_player_url: `http://127.0.0.1:${server.port}`,
              player_id: 'relay',
              player_name: '【IG Live】椎名桜月',
              auth_username: 'u',
              auth_password: 'p',
              waf_bypass_header: 'waf-token',
            },
          },
        },
      },
    ])
    await root.idle()
    const { Bus } = await import('../src/components/bus')
    const bus = root.ctx.get<InstanceType<typeof Bus>>('bus')!
    bus.emit('live', { type: 'live', handle: 'shiina_satsuki227', crawlerId: 'ig', title: 't', file: '/tmp/a.ts' })
    bus.emit('live', { type: 'live', handle: 'nobody', crawlerId: 'ig' })
    const deadline = Date.now() + 5000
    while (posts.length === 0 && Date.now() < deadline) await Bun.sleep(20)
    expect(posts.length).toBe(1)
    expect(posts[0]!.body).toMatchObject({
      player_id: 'relay',
      player_name: '【IG Live】椎名桜月',
      handle: 'shiina_satsuki227',
      status: 'live',
      title: 't',
      file: '/tmp/a.ts',
    })
    expect(posts[0]!.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    expect(posts[0]!.waf).toBe('waf-token')
    await root.dispose()
  } finally {
    server.stop(true)
  }
})

// ---------- llm provider management: circuit breaker + probe ----------

test('llm circuit: repeated 5xx opens the circuit, open state skips attempts, unfreeze resets', async () => {
  let calls = 0
  await withMockLlm(
    {
      '/down': () => {
        calls++
        return new Response('err', { status: 500 })
      },
    },
    async (base) => {
      const client = new OpenAiProcessorClient({
        api_key: 'k',
        base_url: `${base}/down`,
        wire_api: 'chat_completions',
        circuit: { failure_threshold: 2, cooldown_seconds: 600 },
      })
      await expect(client.process('x')).rejects.toThrow('500') // 3 attempts = 1 failure
      expect(client.status().state).toBe('closed')
      await expect(client.process('x')).rejects.toThrow('500') // second failure -> open
      expect(client.status().state).toBe('open')
      expect(client.status().consecutive_failures).toBe(2)
      const before = calls
      await expect(client.process('x')).rejects.toThrow('circuit open')
      expect(calls).toBe(before) // no attempts while open
      client.unfreeze()
      expect(client.status().state).toBe('closed')
      expect(client.status().consecutive_failures).toBe(0)
    },
  )
})

test('llm circuit: 4xx never trips the circuit; open primary delegates to fallback', async () => {
  await withMockLlm(
    {
      '/auth': () => new Response('no', { status: 401 }),
      '/down': () => new Response('err', { status: 500 }),
      '/backup': chatOk('fallback-ok'),
    },
    async (base) => {
      const auth = new OpenAiProcessorClient({
        api_key: 'k',
        base_url: `${base}/auth`,
        circuit: { failure_threshold: 1 },
      })
      await expect(auth.process('x')).rejects.toThrow('401')
      await expect(auth.process('x')).rejects.toThrow('401')
      expect(auth.status().state).toBe('closed') // 4xx does not count

      const withFallback = new OpenAiProcessorClient({
        api_key: 'k',
        base_url: `${base}/down`,
        circuit: { failure_threshold: 1 },
        fallback: { base_url: `${base}/backup` },
      })
      expect(await withFallback.process('x')).toBe('fallback-ok') // primary fails -> fallback
      expect(withFallback.status().state).toBe('open')
      expect(await withFallback.process('x')).toBe('fallback-ok') // open -> straight to fallback
    },
  )
})

test('llm probe: records reachability result without touching the circuit', async () => {
  await withMockLlm(
    {
      '/up': chatOk('pong'),
      '/down': () => new Response('err', { status: 500 }),
    },
    async (base) => {
      const up = new OpenAiProcessorClient({ api_key: 'k', base_url: `${base}/up` })
      const probe = await up.probe()
      expect(probe.ok).toBe(true)
      expect(up.status().last_probe?.ok).toBe(true)

      const down = new OpenAiProcessorClient({ api_key: 'k', base_url: `${base}/down`, circuit: { failure_threshold: 1 } })
      const badProbe = await down.probe()
      expect(badProbe.ok).toBe(false)
      expect(badProbe.error).toContain('500')
      expect(down.status().state).toBe('closed') // probe bypasses/does not feed the circuit
    },
  )
})

// ---------- llm extract -> schedule webhook write-back ----------

test('llm extract: result candidates post to schedule webhook; translate action does not', async () => {
  const webhookPosts: any[] = []
  const webhook = Bun.serve({
    port: 0,
    async fetch(req) {
      webhookPosts.push(await req.json())
      return Response.json({ ok: true })
    },
  })
  try {
    const candidates = JSON.stringify({
      plans: [
        { title: 'SR 生放送', executionTime: '2026-08-20T20:00:00+09:00', confidence: 0.9 },
        { title: '低置信', executionTime: '2026-08-21T20:00:00+09:00', confidence: 0.1 },
      ],
    })
    await withMockLlm(
      { '/v1/chat/completions': chatOk(candidates) },
      async (base) => {
        const extractor = new OpenAiProcessorClient({
          api_key: 'k',
          base_url: `${base}/v1/chat/completions`,
          action: 'extract',
          schedule_url: `http://127.0.0.1:${webhook.port}/api/schedules`,
          min_confidence: 0.5,
        })
        await extractor.process('出演情報本文', { sourceRef: 'a123' })
        expect(webhookPosts.length).toBe(1) // low-confidence filtered
        expect(webhookPosts[0].title).toBe('SR 生放送')
        expect(webhookPosts[0].externalKey).toMatch(/^a123:event:/)

        const translator = new OpenAiProcessorClient({
          api_key: 'k',
          base_url: `${base}/v1/chat/completions`,
          action: 'translate',
          schedule_url: `http://127.0.0.1:${webhook.port}/api/schedules`,
        })
        await translator.process('翻訳対象')
        expect(webhookPosts.length).toBe(1) // translate never writes schedules
      },
    )
  } finally {
    webhook.stop(true)
  }
})
