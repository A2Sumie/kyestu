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

// ---------- regression: aggregation window reuse after close ----------

test('aggregation: closed window is not reused for later items in the same interval', () => {
  const db = memDb()
  const agg = new Aggregator(db)
  const cfg = { enabled: true, interval_seconds: 3600 }
  const id1 = agg.enqueue('t1', 'r|f|t1', { key: 'twitter:1', rowId: 1, platform: 'twitter', payload: { text: 'a' } }, cfg)
  agg.close(id1)
  const id2 = agg.enqueue('t1', 'r|f|t1', { key: 'twitter:2', rowId: 2, platform: 'twitter', payload: { text: 'b' } }, cfg)
  expect(id2).not.toBe(id1)
  expect(agg.itemCount(id2)).toBe(1)
  db.close()
})

// ---------- regression: aggregation items payload round-trips as an object ----------

test('aggregation: items() returns parsed payloads', () => {
  const db = memDb()
  const agg = new Aggregator(db)
  const cfg = { enabled: true, interval_seconds: 3600 }
  const id = agg.enqueue('t1', 'r|f|t1', { key: 'twitter:1', rowId: 1, platform: 'twitter', payload: { text: 'hello', username: 'u' } }, cfg)
  const items = agg.items(id)
  expect(items[0]!.payload).toEqual({ text: 'hello', username: 'u' })
  db.close()
})

// ---------- regression: flush below threshold sends item text natively ----------

test('target runtime: flush below threshold sends the queued item text, not the article key', async () => {
  const db = memDb()
  const root = createRoot()
  const sent: string[] = []
  const runtime = new TargetRuntime(root.ctx, db, 't1', { summary_card: { enabled: true, threshold: 8 } }, async (_i, text) => {
    sent.push(text)
  })
  const agg = new Aggregator(db)
  const win = agg.enqueue('t1', 'r|f|t1', { key: 'twitter:1', rowId: 1, platform: 'twitter', payload: { text: 'native1', media: [] } }, { enabled: true, interval_seconds: 1 })
  await runtime.flush(win)
  expect(sent).toEqual(['native1'])
  db.close()
})

// ---------- regression: expired video pairings are swept by the flush loop ----------

test('target runtime: flush loop sweeps expired video pairings', async () => {
  const db = memDb()
  const root = createRoot()
  const runtime = new TargetRuntime(root.ctx, db, 't1', {}, async () => {})
  const pairings = new VideoPairings(db)
  pairings.hold('t1', { a_id: '100', u_id: 'm', url: 'https://x.com/m/100' }, [{ path: '/t.mp4', type: 'video' }], 'tiktok', { window_seconds: -1 })
  const stop = runtime.startFlushLoop(10)
  await Bun.sleep(60)
  stop()
  const row = db.db.query('SELECT status FROM video_pairings').get() as any
  expect(row.status).toBe('expired')
  db.close()
})

// ---------- regression: biliup timezone robustness + code-point truncation ----------

test('biliup: invalid timezone falls back to JST instead of aborting the upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-biliup-tz-'))
  const helper = join(dir, 'helper.py')
  writeFileSync(helper, 'import sys\nprint("done bvid=BV1xx411c7mD aid=1")\n')
  const cookie = join(dir, 'cookies.json')
  writeFileSync(cookie, JSON.stringify({ cookie_info: { cookies: [{ name: 'SESSDATA', value: 'x' }, { name: 'bili_jct', value: 'y' }] } }))
  const video = join(dir, 'v.mp4')
  writeFileSync(video, 'fake')
  const result = await uploadVideo(
    { cookie_file: cookie, helper_path: helper, timezone: 'Not/AZone' },
    { videoPaths: [video], article: { a_id: '9', u_id: 'm', username: 'member', url: 'https://x.com/m/9', content: 'c', platform: 'tiktok', created_at: 1760000000 } },
  )
  expect(result.bvid).toBe('BV1xx411c7mD')
})

test('biliup: headline and title truncation are surrogate-pair safe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-biliup-uni-'))
  const helper = join(dir, 'helper.py')
  writeFileSync(helper, 'import os, sys\nopen(os.environ["ARGV_OUT"], "w").write("\\n".join(sys.argv[1:]))\nprint("done bvid=BV1xx411c7mD aid=1")\n')
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
          a_id: '9', u_id: 'm', username: 'member', url: 'https://x.com/m/9',
          content: '标题😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀', platform: 'tiktok',
          created_at: Date.parse('2026-08-16T12:00:00+09:00') / 1000,
        },
      },
    )
    const argv = readFileSync(argvOut, 'utf8').split('\n')
    const title = argv[argv.indexOf('--title') + 1]!
    expect(title).not.toMatch(/[\uD800-\uDBFF]$/) // no lone high surrogate
    expect([...title].length).toBeLessThanOrEqual(80)
  } finally {
    delete process.env.ARGV_OUT
  }
})

// ---------- regression: env refs resolve to undefined when unset ----------

test('main env resolution: unset env: refs drop the key instead of keeping a literal', async () => {
  const { resolveEnvStrings } = await import('../src/config/env')
  expect(resolveEnvStrings('env:KYESTU_DEFINITELY_UNSET_12345')).toBeUndefined()
  expect(resolveEnvStrings({ a: 'env:KYESTU_DEFINITELY_UNSET_12345', b: 'plain' })).toEqual({ b: 'plain' })
  process.env.KYESTU_TEST_SET = 'v1'
  expect(resolveEnvStrings('env:KYESTU_TEST_SET')).toBe('v1')
  delete process.env.KYESTU_TEST_SET
})

// ---------- regression: stale outbound claims are reclaimed, exhausted ones are not ----------

test('outbound: crashed sending claim is reclaimed after the stale window; capped at 5 attempts', async () => {
  const { OutboundStore } = await import('../src/pipeline/outbound')
  const db = memDb()
  const outbound = new OutboundStore(db)
  const key = 'c|f|t|twitter:1'
  const first = outbound.claim(key, { text: 'a' })
  // simulate crash: leave status 'sending', backdate updated_at beyond the stale window
  db.db.query('UPDATE outbound_messages SET updated_at = ? WHERE id = ?').run(Date.now() - 31 * 60 * 1000, first.id)
  const reclaimed = outbound.claim(key, { text: 'a' })
  expect(reclaimed.duplicate).toBeNull()
  expect(reclaimed.id).toBe(first.id)
  // fresh 'sending' claim is still duplicate-in-progress
  const inProgress = outbound.claim(key, { text: 'a' })
  expect(inProgress.duplicate).toBe('in_progress')
  // attempt exhaustion: 5 total attempts -> permanent in_progress
  db.db.query('UPDATE outbound_messages SET attempt_count = 5, updated_at = ? WHERE id = ?').run(Date.now() - 31 * 60 * 1000, first.id)
  const exhausted = outbound.claim(key, { text: 'a' })
  expect(exhausted.duplicate).toBe('in_progress')
  // failed rows are retried regardless of age until cap
  outbound.mark(first.id, 'failed', 'err')
  db.db.query('UPDATE outbound_messages SET attempt_count = 3, updated_at = ? WHERE id = ?').run(Date.now() - 31 * 60 * 1000, first.id)
  const retried = outbound.claim(key, { text: 'a' })
  expect(retried.duplicate).toBeNull()
  db.close()
})
