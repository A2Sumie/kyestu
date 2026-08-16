import { test, expect } from 'bun:test'
import { writeFileSync, chmodSync, readFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { createRoot } from '../src/index'
import { KyestuDb, defaultMigrationsDir } from '../src/components/db'
import { Aggregator } from '../src/pipeline/aggregation'
import { TargetRuntime } from '../src/pipeline/target-runtime'
import { MediaVisibility, parseDurationMs, applyTextPolicies, gateByKeywords, gateByAge } from '../src/pipeline/policies'
import { VideoPairings, teaserJoinPlatform } from '../src/pipeline/pairing'
import { uploadVideo } from '../src/pipeline/biliup'
import { LiveRelay } from '../src/pipeline/live-relay'

function memDb() {
  const db = new KyestuDb(':memory:')
  db.migrate(defaultMigrationsDir)
  return db
}

// ---------- aggregation ----------

test('aggregation: enqueue, window alignment, due detection, cap', () => {
  const db = memDb()
  const agg = new Aggregator(db)
  const cfg = { enabled: true, interval_seconds: 3600, threshold: 3, max_items: 5, align_to_hour: true }
  const id = agg.enqueue('t1', 'r|f|t1', { key: 'twitter:1', rowId: 1, platform: 'twitter', payload: { text: 'a' } }, cfg)
  agg.enqueue('t1', 'r|f|t1', { key: 'twitter:2', rowId: 2, platform: 'twitter', payload: { text: 'b' } }, cfg)
  expect(agg.itemCount(id)).toBe(2)
  // same window: same id
  const id2 = agg.enqueue('t1', 'r|f|t1', { key: 'twitter:3', rowId: 3, platform: 'twitter', payload: null }, cfg)
  expect(id2).toBe(id)
  expect(agg.due('t1').length).toBe(0) // window not ended
  agg.close(id)
  expect(agg.due('t1').length).toBe(0)
  db.close()
})

// ---------- target runtime ----------

function runtimeSetup(config: any) {
  const db = memDb()
  const root = createRoot()
  const sent: string[] = []
  const runtime = new TargetRuntime(
    root.ctx,
    db,
    't1',
    config,
    async (_input, text) => {
      sent.push(text)
    },
  )
  return { db, root, sent, runtime }
}

const article = (aId: string, content = '正文') => ({
  article: { platform: 'twitter', a_id: aId, content, created_at: Math.floor(Date.now() / 1000) },
  rendered: { text: content, media: [] },
  route: { crawler: 'c', formatter: 'f', target: 't1' },
})

test('target runtime: direct send when no aggregation configured', async () => {
  const { sent, runtime } = runtimeSetup({})
  await runtime.send(article('1') as any)
  expect(sent).toEqual(['正文'])
})

test('target runtime: keyword gate / age gate / text replace', async () => {
  const { sent, runtime } = runtimeSetup({
    blocked_keywords: ['广告'],
    replace_regex: [['foo', 'bar']],
  })
  await runtime.send(article('1', 'foo 广告') as any)
  expect(sent).toEqual([])
  await runtime.send(article('2', 'foo 正常') as any)
  expect(sent).toEqual(['bar 正常'])

  const { sent: sent2, runtime: rt2 } = runtimeSetup({ block_until: '1h' })
  const old = article('3')
  old.article.created_at = Math.floor(Date.now() / 1000) - 7200
  await rt2.send(old as any)
  expect(sent2).toEqual([])
})

test('target runtime: threshold digest merges into one message', async () => {
  const { sent, runtime } = runtimeSetup({ digest_threshold: 3 })
  await runtime.send(article('1', 'a') as any)
  await runtime.send(article('2', 'b') as any)
  expect(sent).toEqual([])
  await runtime.send(article('3', 'c') as any)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('a')
  expect(sent[0]).toContain('c')
})

test('target runtime: summary card queues then flushes at threshold', async () => {
  const { sent, runtime } = runtimeSetup({ summary_card: { enabled: true, threshold: 2, send_first_immediately: false } })
  await runtime.send(article('1', 'x') as any)
  expect(sent).toEqual([])
  await runtime.send(article('2', 'y') as any) // hits threshold -> flush
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('聚合')
})

test('target runtime: summary send_first_immediately sends the first item natively', async () => {
  const { sent, runtime } = runtimeSetup({ summary_card: { enabled: true, threshold: 5, send_first_immediately: true } })
  await runtime.send(article('1', 'first') as any)
  expect(sent).toEqual(['first'])
  await runtime.send(article('2', 'queued') as any)
  expect(sent).toEqual(['first'])
})

test('media visibility: repeated media downgraded per duplicate_behavior', async () => {
  const db = memDb()
  const vis = new MediaVisibility(db)
  const cfg = { window_seconds: 3600, max_visible: 1, duplicate_behavior: 'text_only' as const }
  expect(vis.check('t1', 'hashA', cfg)).toBe('visible')
  vis.record('t1', 'hashA', 'a1')
  expect(vis.check('t1', 'hashA', cfg)).toBe('text_only')
  expect(vis.check('t1', 'hashA', { ...cfg, duplicate_behavior: 'skip' })).toBe('skip')
  db.close()
})

test('policies: duration parse + keyword/age gates', () => {
  expect(parseDurationMs('32h')).toBe(32 * 3600_000)
  expect(parseDurationMs('90m')).toBe(90 * 60_000)
  expect(applyTextPolicies('a.com/1', { replace_regex: [['a\\.com', '🌐']] })).toBe('🌐/1')
  expect(gateByKeywords('hello', { allowed_keywords: ['x'] })).toBe(false)
  expect(gateByAge(Math.floor(Date.now() / 1000) - 100, { block_until: '1h' })).toBe(true)
})

// ---------- video pairing ----------

test('video pairing: hold teaser, find pending for main platform, merge and mark', () => {
  const db = memDb()
  const pairings = new VideoPairings(db)
  const cfg = { enabled: true, join_platforms: ['tiktok'], window_seconds: 5400 }
  const key = pairings.hold('bili', { a_id: '100', u_id: 'member', url: 'https://x.com/member/status/100' }, [{ path: '/t.mp4', type: 'video' }], 'tiktok', cfg)
  const pending = pairings.findPending('bili', 'tiktok', 'member')
  expect(pending?.pairing_key).toBe(key)
  expect(pending?.teaser_media?.[0]?.path).toBe('/t.mp4')
  pairings.mark(key, 'merged', { bvid: 'BV1xx411c7mD' })
  expect(pairings.findPending('bili', 'tiktok', 'member')).toBeNull()
  db.close()
})

test('teaserJoinPlatform detects join links', () => {
  expect(teaserJoinPlatform('看这里 https://www.tiktok.com/@m/video/1', ['tiktok'])).toBe('tiktok')
  expect(teaserJoinPlatform('no link', ['tiktok'])).toBeNull()
})

// ---------- biliup ----------

test('biliup: builds helper args and parses the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-fake-biliup-'))
  const helper = join(dir, 'helper.py')
  writeFileSync(helper, 'import sys\nprint("args:", " ".join(sys.argv[1:]))\nprint("done bvid=BV1xx411c7mD aid=12345")\n')
  chmodSync(helper, 0o755)
  const cookie = join(dir, 'cookies.json')
  writeFileSync(cookie, JSON.stringify({ cookie_info: { cookies: [{ name: 'SESSDATA', value: 'x' }, { name: 'bili_jct', value: 'y' }] } }))
  const video = join(dir, 'v.mp4')
  writeFileSync(video, 'fake')
  const result = await uploadVideo(
    { cookie_file: cookie, helper_path: helper, tid: 138, tags: ['t1'] },
    { videoPaths: [video], article: { a_id: '9', u_id: 'member', username: '成员', url: 'https://x.com/m/9', content: '标题内容', platform: 'tiktok' } },
  )
  expect(result.bvid).toBe('BV1xx411c7mD')
  expect(result.aid).toBe(12345)
})

// ---------- live relay ----------

test('live relay: starts recording + sync on live, stops + syncs on end', async () => {
  const posts: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      posts.push(await req.json())
      return Response.json({ ok: true })
    },
  })
  try {
    const procs: any[] = []
    const relay = new LiveRelay(
      {
        enabled: true,
        archive_root: mkdtempSync(join(tmpdir(), 'kyestu-live-')),
        targets: { member: { live_player_url: `http://127.0.0.1:${server.port}`, player_id: 'relay' } },
      },
      (() => {
        const proc = new EventEmitter() as any
        proc.kill = () => true
        procs.push(proc)
        return proc
      }) as any,
    )
    await relay.sync('member', { live: true, m3u8: 'https://x/live.m3u8', title: 't' })
    expect(relay.isRecording('member')).toBe(true)
    expect(procs.length).toBe(1)
    await relay.sync('member', { live: false })
    expect(relay.isRecording('member')).toBe(false)
    expect(posts.map((p) => p.status)).toEqual(['live', 'ended'])
    server.stop(true)
  } finally {
    server.stop(true)
  }
})

test('biliup title: production format, member name not repeated after [TT]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-fake-biliup-'))
  const helper = join(dir, 'helper.py')
  writeFileSync(
    helper,
    'import os, sys\nopen(os.environ["ARGV_OUT"], "w").write("\\n".join(sys.argv[1:]))\nprint("done bvid=BV1xx411c7mD aid=1")\n',
  )
  chmodSync(helper, 0o755)
  const cookie = join(dir, 'cookies.json')
  writeFileSync(cookie, JSON.stringify({ cookie_info: { cookies: [{ name: 'SESSDATA', value: 'x' }, { name: 'bili_jct', value: 'y' }] } }))
  const video = join(dir, 'v.mp4')
  writeFileSync(video, 'fake')
  const argvOut = join(dir, 'argv.txt')
  process.env.ARGV_OUT = argvOut
  try {
    await uploadVideo(
      { cookie_file: cookie, helper_path: helper },
      {
        videoPaths: [video],
        article: {
          a_id: '9',
          u_id: 'mochizuki_rino',
          username: '望月りの',
          url: 'https://www.tiktok.com/@mochizuki_rino/video/9',
          content: '元のキャプション',
          translation: '用粉丝送我的プリキット试着跳了舞',
          platform: 'tiktok',
          created_at: Date.parse('2026-08-16T12:00:00+09:00') / 1000,
        },
      },
    )
    const argv = readFileSync(argvOut, 'utf8').split('\n')
    const title = argv[argv.indexOf('--title') + 1]!
    expect(title).toBe('【22/7 望月りの】[TT] 08.16_26 用粉丝送我的プリキット试着跳了舞')
    expect(title).not.toContain('望月りの 08.16')
    expect(title).not.toContain('元のキャプション') // translated caption wins
  } finally {
    delete process.env.ARGV_OUT
  }
})
