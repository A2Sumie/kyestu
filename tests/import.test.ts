import { test, expect } from 'bun:test'
import { convertIdolBbqConfig } from '../src/import/idol-bbq'
import { compileConfig } from '../src/config/schema'

const sample = {
  crawlers: [
    { name: 'X主列表', origin: 'https://x.com/i/lists', paths: ['123'], cfg_crawler: { session_profile: 'x-main' } },
    { name: 'IG高频', origin: 'https://www.instagram.com', paths: ['user_a'], cfg_crawler: { cookie_file: 'ig.txt' } },
  ],
  processors: [
    { id: 'ja-zh', name: '日中翻译', provider: 'DeepSeekV4Flash', api_key: 'env:DEEPSEEK_API_KEY', cfg_processor: { action: 'translate', model_id: 'deepseek-v4-flash', wire_api: 'responses' } },
    { id: 'old-google', provider: 'Google', cfg_processor: { action: 'translate' } },
    { id: 'hy3', provider: 'Hy3Free', cfg_processor: { action: 'translate', base_url: 'https://hunyuan.example.com/v1' } },
  ],
  formatters: [
    { id: 'fmt-card', name: '卡片', render_type: 'img-tag', deduplication: true },
    { id: 'fmt-text', name: '文本', render_type: 'text-card', deduplication: true },
  ],
  forward_targets: [
    { platform: 'qq', id: '群1', cfg_platform: { group_id: 111 } },
    { platform: 'bilibili', id: 'b站', cfg_platform: { mid: 222 } },
  ],
  cfg_crawler: { interval_time: { min: 9000, max: 18000 } },
  cfg_forward_target: { block_until: '32h' },
  api: { port: 3000, secret: 'env:API_SECRET' },
  connections: {
    'crawler-processor': { X主列表: 'ja-zh', IG高频: 'ja-zh' },
    'crawler-formatter': { X主列表: ['fmt-card', 'fmt-text'], IG高频: ['fmt-card'] },
    'formatter-target': { 'fmt-card': ['群1'], 'fmt-text': ['群1', 'b站'] },
  },
}

test('converts crawlers/processors/formatters/targets with kind detection and defaults', () => {
  const config = convertIdolBbqConfig(sample)
  const byId = new Map(config.components.map((c) => [c.id, c]))

  expect(byId.get('X主列表')!.use).toBe('crawler/x-list')
  expect(byId.get('X主列表')!.with).toMatchObject({ session_profile: 'x-main' })
  expect(byId.get('IG高频')!.use).toBe('crawler/instagram')
  expect(byId.get('ja-zh')!.use).toBe('processor/openai')
  expect(byId.get('ja-zh')!.with).toMatchObject({ action: 'translate', api_key: 'env:DEEPSEEK_API_KEY', wire_api: 'responses' })
  expect(byId.has('old-google')).toBe(false) // dropped legacy provider
  expect(byId.get('hy3')!.use).toBe('processor/openai')
  expect(byId.get('hy3')!.with!.wire_api).toBe('chat_completions') // Hy3 = chat completions protocol
  expect(byId.get('fmt-card')!.use).toBe('formatter/img-tag')
  expect(byId.get('群1')!.use).toBe('target/qq')
  expect(byId.get('api')!.use).toBe('app/api')
  expect(config.defaults).toMatchObject({ crawler: { interval_time: { min: 9000 } }, target: { block_until: '32h' } })
})

test('connections compile to routes with service edges for processors', () => {
  const config = convertIdolBbqConfig(sample)
  const routes = config.routes!

  expect(routes).toContainEqual({ from: 'X主列表', via: ['fmt-card'], to: ['群1'] })
  expect(routes).toContainEqual({ from: 'X主列表', via: ['fmt-text'], to: ['群1', 'b站'] })
  expect(routes).toContainEqual({ from: 'IG高频', via: ['fmt-card'], to: ['群1'] })
  expect(routes).toContainEqual({ from: 'ja-zh', to: ['X主列表', 'IG高频'] })
})

test('imported config compiles to entries with correct needs', () => {
  const entries = compileConfig(convertIdolBbqConfig(sample))
  const needs = Object.fromEntries(entries.map((e) => [e.id, e.needs ?? []]))
  expect(needs['ja-zh']).toEqual([])
  expect(needs['X主列表']).toEqual(['ja-zh'])
  expect(needs['IG高频']).toEqual(['ja-zh'])
  expect(needs['fmt-card']).toEqual(['X主列表', 'IG高频'].sort())
  expect(needs['fmt-text']).toEqual(['X主列表'])
  expect(needs['群1']).toEqual(['fmt-card', 'fmt-text'].sort())
  expect(needs['b站']).toEqual(['fmt-text'])
  expect(needs['api']).toEqual([])
})

// ---------- regression: id-less forward targets get stable, collision-safe ids ----------

test('forward targets without ids derive from config content, not its length', () => {
  const config = convertIdolBbqConfig({
    forward_targets: [
      { platform: 'qq', cfg_platform: { group_id: 111, url: 'http://a' } }, // same-length cfgs
      { platform: 'qq', cfg_platform: { group_id: 222, url: 'http://b' } }, // would collide on length
      { platform: 'qq', cfg_platform: { group_id: 111, url: 'http://a' } }, // true duplicate
    ],
  })
  const targetIds = config.components.filter((c) => c.use.startsWith('target/')).map((c) => c.id)
  expect(new Set(targetIds).size).toBe(2)
  expect((config as any).warnings.some((w: string) => w.includes('duplicate forward_target id'))).toBe(true)
  expect((config as any).warnings.some((w: string) => w.includes('without id'))).toBe(true)
})

test('live_relay targets split into a standalone app/live-player plugin', () => {
  const config = convertIdolBbqConfig({
    crawlers: [
      {
        name: 'IG高频',
        origin: 'https://www.instagram.com',
        paths: ['shiina_satsuki227'],
        cfg_crawler: {
          live_relay: {
            enabled: true,
            archive_root: '/data/live',
            targets: {
              shiina_satsuki227: { player_id: 'relay', player_name: '【IG Live】椎名桜月', live_player_url: 'https://tv.n2nj.moe' },
            },
          },
        },
      },
      {
        name: 'IG重复',
        origin: 'https://www.instagram.com',
        paths: ['shiina_satsuki227'],
        cfg_crawler: { live_relay: { enabled: true, targets: { shiina_satsuki227: { live_player_url: 'https://other' } } } },
      },
    ],
  })
  const byId = new Map(config.components.map((c) => [c.id, c]))
  const crawler = byId.get('IG高频')!
  expect(crawler.with!.live_relay).toEqual({ enabled: true, archive_root: '/data/live' })
  const player = byId.get('live-player')!
  expect(player.use).toBe('app/live-player')
  expect(Object.keys(player.with!.targets!)).toEqual(['shiina_satsuki227'])
  expect(player.with!.targets!.shiina_satsuki227.live_player_url).toBe('https://tv.n2nj.moe') // first claim wins
  expect((config as any).warnings!.some((w: string) => w.includes("live_relay target 'shiina_satsuki227'"))).toBe(true)
})

test('youtube crawlers with cookie_file generate an in-runtime cookie-keepalive plugin', () => {
  const config = convertIdolBbqConfig({
    crawlers: [
      {
        name: 'YouTube抓取',
        origin: 'https://www.youtube.com',
        paths: ['@sallyamakiofficial', '@227SMEJ'],
        cfg_crawler: { cookie_file: '/app/assets/cookies/ycookies.txt', session_profile: 'youtube-main' },
      },
      {
        name: 'YouTube抓取 - 20:05',
        origin: 'https://www.youtube.com',
        paths: ['@227SMEJ'],
        cfg_crawler: { cookie_file: '/app/assets/cookies/ycookies.txt' },
      },
      { name: 'X主列表', origin: 'https://x.com/i/lists', paths: ['123'], cfg_crawler: {} },
    ],
  })
  const byId = new Map(config.components.map((c) => [c.id, c]))
  const keepalive = byId.get('cookie-keepalive')!
  expect(keepalive.use).toBe('app/cookie-keepalive')
  expect(keepalive.with!.jobs).toEqual([
    {
      name: 'yt-1',
      kind: 'ytdlp',
      cookie_file: '/app/assets/cookies/ycookies.txt',
      url: 'https://www.youtube.com/@sallyamakiofficial',
      interval_seconds: 21600,
      sources: ['YouTube抓取', 'YouTube抓取 - 20:05'],
    },
  ])
})

test('Mechanical processors map to processor/rules instead of being dropped', () => {
  const config = convertIdolBbqConfig({
    processors: [
      { id: 'digest-merge', provider: 'Mechanical', cfg_processor: { action: 'merge', extended_payload: { merge_window_minutes: 30, min_group_size: 2 } } },
    ],
  })
  const byId = new Map(config.components.map((c) => [c.id, c]))
  const rules = byId.get('digest-merge')!
  expect(rules.use).toBe('processor/rules')
  expect(rules.with).toMatchObject({ action: 'merge', extended_payload: { merge_window_minutes: 30 } })
  expect((config as any).warnings ?? []).toEqual([])
})
