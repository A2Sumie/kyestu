import { test, expect } from 'bun:test'
import { fileURLToPath } from 'url'
import { createRoot } from '../src/index'
import { KyestuDb, defaultMigrationsDir } from '../src/components/db'
import { TargetRuntime } from '../src/pipeline/target-runtime'
import { buildSummaryArticle, renderSummaryCard } from '../src/pipeline/summary-card'
import { TagStormDetector, extractHashtags } from '../src/pipeline/tag-storm'

process.env.FONTS_DIR = fileURLToPath(new URL('../assets/fonts', import.meta.url))
process.env.RENDER_REMOTE_ASSETS = '0'

const items = [
  { text: '西條和の写真集発売！', username: 'nagomi_saijo', u_avatar: null, created_at: Math.floor(Date.now() / 1000) - 600 },
  { text: '今日のラジオ公開', username: 'sally_amaki', u_avatar: null, created_at: Math.floor(Date.now() / 1000) - 300 },
  { text: 'New single announced', username: '227official', u_avatar: null, created_at: Math.floor(Date.now() / 1000) },
]

test('summary card: message_pack article matches the template contract', () => {
  const article = buildSummaryArticle(items)
  expect(article.type).toBe('message_pack')
  expect(article.extra.extra_type).toBe('message_pack_meta')
  const data = article.extra.data
  expect(data.total).toBe(3)
  expect(data.groups.length).toBe(1)
  expect(data.groups[0].items.length).toBe(3)
  expect(data.groups[0].items[0].index).toBe(1)
  expect(data.range).toMatch(/\d{2}:\d{2}~\d{2}:\d{2}/)
})

test('summary card: renders a real PNG via the shared DefaultCard template', async () => {
  const card = await renderSummaryCard(buildSummaryArticle(items), null)
  expect(card).not.toBeNull()
  expect(card!.length).toBeGreaterThan(10_000)
  expect(card!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG magic
}, 20000)

test('summary card: runtime flush sends the card image, not a text digest', async () => {
  const db = new KyestuDb(':memory:')
  db.migrate(defaultMigrationsDir)
  const root = createRoot()
  const sent: Array<{ text: string; media: any[] }> = []
  const runtime = new TargetRuntime(
    root.ctx,
    db,
    't1',
    { summary_card: { enabled: true, threshold: 2, send_first_immediately: false } },
    async (input, text) => {
      sent.push({ text, media: input.rendered.media })
    },
  )
  const mk = (aId: string, content: string) => ({
    article: { platform: 'twitter', a_id: aId, content, created_at: Math.floor(Date.now() / 1000), username: 'm' },
    rendered: { text: content, media: [] },
    route: { crawler: 'c', formatter: 'f', target: 't1' },
  })
  await runtime.send(mk('1', 'a') as any)
  await runtime.send(mk('2', 'b') as any) // threshold -> flush
  expect(sent.length).toBe(1)
  expect(sent[0]!.media.length).toBe(1)
  expect(sent[0]!.media[0].type).toBe('photo')
  expect(sent[0]!.media[0].path).toMatch(/\.png$/)
  expect(sent[0]!.text).toContain('聚合')
  db.close()
}, 20000)

// ---------- tag storm (detection only, not wired into send path) ----------

test('tag storm: enters digest mode only at threshold with enough distinct authors', () => {
  let now = 1_000_000
  const detector = new TagStormDetector(
    { tag_digest_threshold: 3, tag_digest_detection_window_seconds: 600, tag_digest_window_seconds: 3600, tag_digest_min_authors: 2 },
    () => now,
  )
  expect(detector.observe(['live'], 'a')).toEqual([])
  expect(detector.observe(['live'], 'b')).toEqual([])
  // third post but same author pair doesn't reach 3 posts yet
  expect(detector.observe(['live'], 'a')).toEqual(['live'])
  expect(detector.inDigest('live')).toBe(true)
  // while in digest mode, further posts stay digested
  expect(detector.observe(['live'], 'c')).toEqual(['live'])
})

test('tag storm: single author spam never triggers; window expiry exits digest mode', () => {
  let now = 0
  const detector = new TagStormDetector(
    { tag_digest_threshold: 2, tag_digest_detection_window_seconds: 600, tag_digest_window_seconds: 3600, tag_digest_min_authors: 2 },
    () => now,
  )
  expect(detector.observe(['x'], 'a')).toEqual([])
  expect(detector.observe(['x'], 'a')).toEqual([]) // same author
  expect(detector.inDigest('x')).toBe(false)
  expect(detector.observe(['x'], 'b')).toEqual(['x'])
  now += 3601 * 1000
  expect(detector.inDigest('x')).toBe(false)
})

test('extractHashtags: dedup + case-insensitive', () => {
  expect(extractHashtags('a #Live 快看 #live #開演')).toEqual(['live', '開演'])
})
