import { test, expect } from 'bun:test'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { setCrawlDriverForTest } from '../src/components/crawler'

/**
 * Short-circuit full-pipeline smoke: every external system (LLM, OneBot,
 * Bilibili, media CDN) is a local mock; crawling is a fixture driver; cards
 * render for real with the vendored fonts. Nothing here touches the network.
 */

process.env.RENDER_REMOTE_ASSETS = '0'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_MAGIC = '89504e470d0a1a0a'

function article(aId: string, content: string, mediaUrl?: string) {
  return {
    platform: 1,
    a_id: aId,
    u_id: 'example_member',
    username: 'example_member',
    created_at: Math.floor(Date.now() / 1000),
    content,
    url: `https://x.com/example_member/status/${aId}`,
    type: 'post',
    ref: null,
    has_media: Boolean(mediaUrl),
    media: mediaUrl ? [{ type: 'photo', url: mediaUrl }] : null,
    extra: null,
    u_avatar: null,
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await Bun.sleep(50)
  }
  throw new Error(`timeout waiting for: ${what}`)
}

interface Mocks {
  onebotCalls: any[]
  biliCalls: Array<{ path: string; body: any }>
  llmCalls: () => number
  onebotBase: string
  llmBase: string
  biliEndpoints: { uploadPhoto: string; createDynamic: string }
  mediaUrl: string
  stop: () => void
}

function startMocks(): Mocks {
  const onebotCalls: any[] = []
  const biliCalls: Array<{ path: string; body: any }> = []
  let llmCalls = 0
  const onebot = Bun.serve({
    port: 0,
    async fetch(req) {
      onebotCalls.push({ action: new URL(req.url).pathname, payload: await req.json() })
      return Response.json({ status: 'ok', retcode: 0, data: { message_id: onebotCalls.length } })
    },
  })
  const bili = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = path.includes('upload_bfs') ? '<multipart>' : await req.json().catch(() => null)
      biliCalls.push({ path, body })
      if (path.includes('upload_bfs')) {
        return Response.json({
          code: 0,
          data: { image_url: 'https://i0.hdslb.com/x.png', image_width: 100, image_height: 100, img_size: 1 },
        })
      }
      return Response.json({ code: 0, data: { dynamic_id: '1' } })
    },
  })
  const llm = Bun.serve({
    port: 0,
    fetch() {
      llmCalls++
      return Response.json({ choices: [{ message: { content: '【译文】' } }] })
    },
  })
  const media = Bun.serve({ port: 0, fetch: () => new Response(PNG_1PX, { headers: { 'Content-Type': 'image/png' } }) })
  return {
    onebotCalls,
    biliCalls,
    llmCalls: () => llmCalls,
    onebotBase: `http://127.0.0.1:${onebot.port}`,
    llmBase: `http://127.0.0.1:${llm.port}`,
    biliEndpoints: {
      uploadPhoto: `http://127.0.0.1:${bili.port}/x/dynamic/feed/draw/upload_bfs`,
      createDynamic: `http://127.0.0.1:${bili.port}/x/dynamic/feed/create/dyn`,
    },
    mediaUrl: `http://127.0.0.1:${media.port}/photo.png`,
    stop: () => {
      onebot.stop(true)
      bili.stop(true)
      llm.stop(true)
      media.stop(true)
    },
  }
}

interface BootOptions {
  formatters: Array<{ id: string; renderType: string }>
  targets: Array<{ id: string; use: string; with: Record<string, any> }>
  routes: any[]
}

async function boot(tag: string, mocks: Mocks, opts: BootOptions) {
  const dir = mkdtempSync(join(tmpdir(), `kyestu-sc-${tag}-`))
  const root = createRoot({ unloadGuardTimeoutMs: 500 })
  const loader = new Loader(root, defineAll(createRegistry()))
  await loader.load([
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    { id: 'media-store', use: 'infra/media-store', with: { cache_root: join(dir, 'cache') } },
    { id: 'onebot', use: 'infra/onebot', with: { http_url: mocks.onebotBase } },
    {
      id: 'ja-zh',
      use: 'processor/openai',
      with: { api_key: 'k', base_url: `${mocks.llmBase}/v1/chat_completions`, wire_api: 'chat_completions' },
    },
    {
      id: 'x-main',
      use: 'crawler/x',
      with: { origin: 'https://x.com', paths: ['example_member'], interval_time: { min: 1, max: 2 } },
      needs: ['ja-zh'],
    },
    ...opts.formatters.map((f) => ({ id: f.id, use: `formatter/${f.renderType}` })),
    ...opts.targets.map((t) => ({ id: t.id, use: t.use, with: t.with })),
    { id: 'router', use: 'app/router', with: { routes: opts.routes } },
  ])
  await root.idle()
  return { root, cacheDir: join(dir, 'cache') }
}

function groupMsgs(calls: any[]) {
  return calls.filter((c) => c.action === '/send_group_msg').map((c) => c.payload)
}

test('short-circuit: text-card renders a real PNG card + downloads photo media -> QQ image segments', async () => {
  const mocks = startMocks()
  try {
    setCrawlDriverForTest(async () => [article('2001', '今日の写真です！', mocks.mediaUrl)])
    const { root, cacheDir } = await boot('card', mocks, {
      formatters: [{ id: 'fmt', renderType: 'text-card' }],
      targets: [{ id: 'qq-1', use: 'target/qq', with: { group_id: 1001, min_interval: 0 } }],
      routes: [{ from: 'x-main', via: ['fmt'], to: ['qq-1'] }],
    })
    await waitFor(() => groupMsgs(mocks.onebotCalls).length > 0, 'QQ group message')
    const msgs = groupMsgs(mocks.onebotCalls)
    const segments = msgs.flatMap((m) => m.message)
    const text = segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join('')
    expect(text).toContain('今日の写真です')
    expect(text).toContain('【译文】')
    expect(mocks.llmCalls()).toBeGreaterThan(0)

    const images = segments.filter((s: any) => s.type === 'image').map((s: any) => String(s.data.file).replace('file://', ''))
    expect(images.length).toBeGreaterThanOrEqual(2) // downloaded photo + rendered card
    const buffers = images.map((p) => readFileSync(p))
    for (const b of buffers) expect(b.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC)
    const card = buffers.find((b) => b.length > 10_000)
    expect(card, 'one image should be the rendered card').toBeDefined()

    const downloaded = images.find((p) => p.startsWith(join(cacheDir, 'media', 'store')))
    expect(downloaded, 'photo should land in the media store').toBeDefined()
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
    mocks.stop()
  }
}, 30_000)

test('short-circuit: bilibili text dynamic (scene 1) via endpoint override', async () => {
  const mocks = startMocks()
  try {
    setCrawlDriverForTest(async () => [article('3001', 'お知らせです')])
    const { root } = await boot('bili-text', mocks, {
      formatters: [{ id: 'fmt', renderType: 'text' }],
      targets: [
        { id: 'bili', use: 'target/bilibili', with: { min_interval: 0, endpoints: mocks.biliEndpoints, sessdata: 's', bili_jct: 'j' } },
      ],
      routes: [{ from: 'x-main', via: ['fmt'], to: ['bili'] }],
    })
    await waitFor(() => mocks.biliCalls.some((c) => c.path.includes('create/dyn')), 'bilibili create/dyn')
    expect(mocks.biliCalls.some((c) => c.path.includes('upload_bfs'))).toBe(false)
    const create = mocks.biliCalls.find((c) => c.path.includes('create/dyn'))!
    expect(create.body.dyn_req.scene).toBe(1)
    expect(create.body.dyn_req.content.contents[0].raw_text).toContain('お知らせです')
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
    mocks.stop()
  }
}, 30_000)

test('short-circuit: bilibili photo dynamic uploads to bfs then creates scene 2', async () => {
  const mocks = startMocks()
  try {
    setCrawlDriverForTest(async () => [article('3002', '写真つき', mocks.mediaUrl)])
    const { root } = await boot('bili-photo', mocks, {
      formatters: [{ id: 'fmt', renderType: 'text' }],
      targets: [
        { id: 'bili', use: 'target/bilibili', with: { min_interval: 0, endpoints: mocks.biliEndpoints, sessdata: 's', bili_jct: 'j' } },
      ],
      routes: [{ from: 'x-main', via: ['fmt'], to: ['bili'] }],
    })
    await waitFor(() => mocks.biliCalls.some((c) => c.path.includes('create/dyn')), 'bilibili create/dyn')
    const paths = mocks.biliCalls.map((c) => c.path)
    expect(paths.some((p) => p.includes('upload_bfs'))).toBe(true)
    expect(paths.indexOf(paths.find((p) => p.includes('upload_bfs'))!)).toBeLessThan(
      paths.indexOf(paths.find((p) => p.includes('create/dyn'))!),
    )
    const create = mocks.biliCalls.find((c) => c.path.includes('create/dyn'))!
    expect(create.body.dyn_req.scene).toBe(2)
    expect(create.body.dyn_req.pics.length).toBe(1)
    expect(create.body.dyn_req.pics[0].img_src).toBe('https://i0.hdslb.com/x.png')
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
    mocks.stop()
  }
}, 30_000)

test('short-circuit: aggregation threshold flush sends a real summary-card PNG', async () => {
  const mocks = startMocks()
  try {
    setCrawlDriverForTest(async () => [article('4001', '一つ目'), article('4002', '二つ目')])
    const { root } = await boot('agg', mocks, {
      formatters: [{ id: 'fmt', renderType: 'text' }],
      targets: [
        {
          id: 'qq-1',
          use: 'target/qq',
          with: { group_id: 1001, min_interval: 0, summary_card: { enabled: true, threshold: 2, send_first_immediately: false } },
        },
      ],
      routes: [{ from: 'x-main', via: ['fmt'], to: ['qq-1'] }],
    })
    await waitFor(() => groupMsgs(mocks.onebotCalls).length > 0, 'summary flush message')
    const msgs = groupMsgs(mocks.onebotCalls)
    expect(msgs.length).toBe(1) // single flush, no per-item sends
    const segments = msgs[0]!.message
    const text = segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join('')
    expect(text).toContain('聚合')
    const images = segments.filter((s: any) => s.type === 'image').map((s: any) => String(s.data.file).replace('file://', ''))
    expect(images.length).toBe(1)
    const card = readFileSync(images[0]!)
    expect(card.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC)
    expect(card.length).toBeGreaterThan(10_000)
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
    mocks.stop()
  }
}, 30_000)
