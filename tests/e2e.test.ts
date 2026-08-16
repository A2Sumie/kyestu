import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { setCrawlDriverForTest } from '../src/components/crawler'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const X_ARTICLE = {
  platform: 1,
  a_id: '1890000000000000001',
  u_id: 'example_member',
  username: 'example_member',
  created_at: Math.floor(Date.now() / 1000),
  content: '今日の写真です！',
  url: 'https://x.com/example_member/status/1890000000000000001',
  type: 'post',
  ref: null,
  has_media: false,
  media: null,
  extra: null,
  u_avatar: null,
}

async function boot(tag: string, onebotUrl: string, llmUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), `kyestu-e2e-${tag}-`))
  const root = createRoot({ unloadGuardTimeoutMs: 500 })
  const registry = defineAll(createRegistry())
  const loader = new Loader(root, registry)
  await loader.load([
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    { id: 'media-store', use: 'infra/media-store', with: { cache_root: join(dir, 'cache') } },
    { id: 'onebot', use: 'infra/onebot', with: { http_url: onebotUrl } },
    { id: 'ja-zh', use: 'processor/openai', with: { api_key: 'k', base_url: `${llmUrl}/v1/chat/completions`, wire_api: 'chat_completions' } },
    { id: 'x-main', use: 'crawler/x', with: { origin: 'https://x.com', paths: ['example_member'], interval_time: { min: 1, max: 2 } }, needs: ['ja-zh'] },
    { id: 'fmt', use: 'formatter/text' },
    { id: 'qq-1', use: 'target/qq', with: { group_id: 1001, min_interval: 0 } },
    { id: 'router', use: 'app/router', with: { routes: [{ from: 'x-main', via: ['fmt'], to: ['qq-1'] }] } },
  ])
  await root.idle()
  return { root, loader, dir }
}

test('e2e: crawl -> translate -> persist -> route -> render -> send (QQ)', async () => {
  const sent: any[] = []
  const onebot = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push({ action: new URL(req.url).pathname, payload: await req.json() })
      return Response.json({ status: 'ok', retcode: 0, data: { message_id: sent.length } })
    },
  })
  const llm = Bun.serve({
    port: 0,
    async fetch() {
      return Response.json({ choices: [{ message: { content: '今天的照片！' } }] })
    },
  })
  try {
    setCrawlDriverForTest(async () => [X_ARTICLE])
    const { root } = await boot('qq', `http://127.0.0.1:${onebot.port}`, `http://127.0.0.1:${llm.port}`)
    await Bun.sleep(200)
    expect(sent.length).toBeGreaterThan(0)
    const groupMsg = sent.find((s) => s.action === '/send_group_msg')
    expect(groupMsg).toBeDefined()
    expect(groupMsg.payload.group_id).toBe(1001)
    const text = groupMsg.payload.message.map((s: any) => (s.type === 'text' ? s.data.text : '')).join('')
    expect(text).toContain('今日の写真です')
    expect(text).toContain('今天的照片')
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
    onebot.stop(true)
    llm.stop(true)
  }
})

test('e2e: duplicate article is sent once (forward_by dedup)', async () => {
  const sent: any[] = []
  const onebot = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push(await req.json())
      return Response.json({ status: 'ok', retcode: 0, data: { message_id: 1 } })
    },
  })
  const llm = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: 'T' } }] }) })
  try {
    setCrawlDriverForTest(async () => [X_ARTICLE])
    const { root } = await boot('dedup', `http://127.0.0.1:${onebot.port}`, `http://127.0.0.1:${llm.port}`)
    await Bun.sleep(200)
    const before = sent.length
    expect(before).toBeGreaterThan(0)
    await Bun.sleep(150)
    expect(sent.length).toBe(before) // second tick finds the article already persisted/forwarded
    await root.dispose()
  } finally {
    setCrawlDriverForTest(null)
    onebot.stop(true)
    llm.stop(true)
  }
})
