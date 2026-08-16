import { test, expect } from 'bun:test'
import { DigestRules, parseDigestArticles, normalizeUrl, parseTimestamp } from '../src/pipeline/digest-rules'
import { RulesProcessorClient } from '../src/components/processor-rules'

const digest = `[2026-08-16 21:05:33]
Article DB ID: 11
Article ID: a1
Platform: x
User ID: shiina
Username: 椎名桜月
URL: https://x.com/shiina/status/1
Content:
生放送始まるよ https://example.com/live?utm_source=x&id=42#frag

---
[2026-08-16 21:10:00]
Article DB ID: 12
Article ID: a2
Platform: x
User ID: sally
Username: 天城サリー
URL: https://x.com/sally/status/2
Content:
動画みて https://video.example.com/clip.mp4
Extra Content:
https://example.com/live?id=42

---
[2026-08-16 21:12:00]
Article DB ID: 13
Article ID: a3
Platform: instagram
User ID: shiina
Username: 椎名桜月
URL: https://instagram.com/p/3
Content:
写真あげた`

test('parseTimestamp handles digest labels', () => {
  expect(parseTimestamp('2026-08-16 21:05:33')).toBe(Math.floor(Date.parse('2026-08-16T21:05:33') / 1000))
  expect(parseTimestamp('not a date')).toBeNull()
})

test('parseDigestArticles splits blocks and extracts fields', () => {
  const articles = parseDigestArticles(digest)
  expect(articles.length).toBe(3)
  expect(articles[0]).toMatchObject({ db_id: 11, article_id: 'a1', platform: 'x', user_id: 'shiina', url: 'https://x.com/shiina/status/1' })
  expect(articles[0]!.created_at).not.toBeNull()
  expect(articles[1]!.extra_content).toBe('https://example.com/live?id=42')
})

test('parseDigestArticles falls back to a single article when no markers exist', () => {
  const articles = parseDigestArticles('ただのテキスト\nマーカーなし')
  expect(articles.length).toBe(1)
  expect(articles[0]!.content).toBe('ただのテキスト\nマーカーなし')
})

test('normalizeUrl strips trackers, hash, and lowercases host', () => {
  expect(normalizeUrl('HTTPS://Example.COM/a/?utm_source=x&id=1#top')).toBe('https://example.com/a/?id=1')
  expect(normalizeUrl('not-a-url')).toBeNull()
})

test('extract: collects webpage candidates, filters media, linked before source', () => {
  const result = new DigestRules().runExtract(digest)
  expect(result.total_articles).toBe(3)
  const urls = result.webpages.map((w) => w.normalized_url)
  expect(urls).not.toContain('https://video.example.com/clip.mp4')
  const live = result.webpages.find((w) => w.normalized_url === 'https://example.com/live?id=42')!
  expect(live.source_kinds).toEqual(['linked'])
  expect(live.occurrences).toBe(2) // content of a1 + extra_content of a2
  expect(live.usernames).toContain('椎名桜月')
  expect(live.usernames).toContain('天城サリー')
  expect(result.webpages[0]!.source_kinds).toContain('linked') // linked sorts first
})

test('extract: allow/block patterns and max_results', () => {
  const blocked = new DigestRules({ url_block_patterns: 'example\\.com' }).runExtract(digest)
  expect(blocked.webpages.map((w) => w.domain)).not.toContain('example.com')
  const limited = new DigestRules({ max_results: 1 }).runExtract(digest)
  expect(limited.webpages.length).toBe(1)
})

test('merge: groups by window with user/platform boundaries and min size', () => {
  // a1 (x/shiina 21:05) -> a3 (instagram/shiina 21:12) differs by platform; a2 is sally
  const result = new DigestRules({ merge_window_minutes: 15, min_group_size: 1 }).runMerge(digest)
  expect(result.groups.length).toBe(3) // no two adjacent articles share user+platform
  const dense = `[2026-08-16 21:00:00]
Platform: x
User ID: u
URL: https://x.com/u/1
Content:
one

---
[2026-08-16 21:05:00]
Platform: x
User ID: u
URL: https://x.com/u/2
Content:
two https://linked.example.com/page

---
[2026-08-16 21:40:00]
Platform: x
User ID: u
URL: https://x.com/u/3
Content:
three`
  const merged = new DigestRules({ merge_window_minutes: 15 }).runMerge(dense)
  expect(merged.groups.length).toBe(2)
  expect(merged.groups[0]!.count).toBe(2)
  expect(merged.groups[0]!.combined_text).toContain('one')
  expect(merged.groups[0]!.combined_text).toContain('two')
  expect(merged.groups[0]!.items[1]!.linked_urls).toEqual(['https://linked.example.com/page'])
})

test('rules processor client: process() json output, unknown action throws', async () => {
  const client = new RulesProcessorClient({ action: 'extract', extended_payload: { max_results: 2 } })
  const out = JSON.parse(await client.process(digest))
  expect(out.action).toBe('extract')
  expect(out.webpages.length).toBeLessThanOrEqual(2)
  const bad = new RulesProcessorClient({ action: 'translate' as any })
  await expect(bad.process('x')).rejects.toThrow('does not support action')
})
