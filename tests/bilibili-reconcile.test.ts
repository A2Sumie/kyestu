import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KyestuDb, defaultMigrationsDir } from '../src/components/db'
import { ArticleStore } from '../src/pipeline/articles'
import {
  bilibiliCookieHeader,
  fetchBilibiliArchives,
  reconcileBilibiliSubmissions,
} from '../src/pipeline/bilibili-reconcile'

function cookieFile(dir: string): string {
  const path = join(dir, 'bili-cookies.json')
  writeFileSync(path, JSON.stringify({ cookie_info: { cookies: [{ name: 'SESSDATA', value: 's1' }, { name: 'bili_jct', value: 'j1' }] } }))
  return path
}

function seededDb(): KyestuDb {
  const db = new KyestuDb(':memory:')
  db.migrate(defaultMigrationsDir)
  const articles = new ArticleStore(db)
  articles.save({ platform: 'tiktok', a_id: '9', u_id: 'm', username: 'm', url: 'https://www.tiktok.com/@m/video/9', content: 'x', created_at: 1, has_media: true } as any)
  return db
}

function archivesResponse(items: any[], count: number) {
  return Response.json({ code: 0, data: { arc_audits: items.map((a) => ({ Archive: a })), page: { count } } })
}

test('ArticleStore.save self-heals a missing avatar without overwriting an existing one', () => {
  const db = new KyestuDb(':memory:')
  db.migrate(defaultMigrationsDir)
  const articles = new ArticleStore(db)
  const base = {
    platform: 'instagram',
    a_id: 'DAVATAR1',
    u_id: 'member_a',
    username: 'Member A',
    url: 'https://www.instagram.com/p/DAVATAR1/',
    content: 'post',
    created_at: 1,
    has_media: false,
  }
  const first = articles.save({ ...base, u_avatar: null } as any)
  expect(first).toBeGreaterThan(0)
  // re-save of an already-present article returns null (unchanged contract)
  const second = articles.save({ ...base, u_avatar: 'https://cdn.example.com/a.jpg' } as any)
  expect(second).toBeNull()
  const healed = db.db
    .query("SELECT u_avatar FROM instagram_article WHERE a_id = 'DAVATAR1'")
    .get() as { u_avatar: string | null }
  expect(healed.u_avatar).toBe('https://cdn.example.com/a.jpg')
  // an existing avatar is never overwritten by a later save
  articles.save({ ...base, u_avatar: 'https://cdn.example.com/b.jpg' } as any)
  const kept = db.db
    .query("SELECT u_avatar FROM instagram_article WHERE a_id = 'DAVATAR1'")
    .get() as { u_avatar: string | null }
  expect(kept.u_avatar).toBe('https://cdn.example.com/a.jpg')
})

test('cookie header: JSON cookie file, sessdata fallback, missing throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-recon-'))
  expect(bilibiliCookieHeader({ id: 't', cookie_file: cookieFile(dir) })).toBe('SESSDATA=s1; bili_jct=j1')
  expect(bilibiliCookieHeader({ id: 't', sessdata: 's2', bili_jct: 'j2' })).toBe('SESSDATA=s2; bili_jct=j2')
  expect(() => bilibiliCookieHeader({ id: 't' })).toThrow('no cookie_file or sessdata')
})

test('fetchBilibiliArchives pages until short page and unwraps Archive', async () => {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push(`${url.searchParams.get('pn')}:${req.headers.get('cookie')}`)
      const page = Number(url.searchParams.get('pn'))
      if (page === 1) return archivesResponse([{ bvid: 'BV1', source: 'https://a/1' }, { bvid: 'BV2', source: 'https://a/2' }], 3)
      return archivesResponse([{ bvid: 'BV3', source: 'https://a/3' }], 3)
    },
  })
  try {
    const archives = await fetchBilibiliArchives('SESSDATA=s1', { pageSize: 2, baseUrl: `http://127.0.0.1:${server.port}/x/web/archives` })
    expect(archives.map((a) => a.bvid)).toEqual(['BV1', 'BV2', 'BV3'])
    expect(seen[0]).toBe('1:SESSDATA=s1')
    expect(seen[1]).toBe('2:SESSDATA=s1')
  } finally {
    server.stop(true)
  }
})

test('reconcile: seeds sent state by source url, consumes marker, skips unmatched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-recon-'))
  const marker = join(dir, 'db-recovered.json')
  writeFileSync(marker, JSON.stringify({ recovered_at: new Date().toISOString() }))
  const db = seededDb()
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      archivesResponse(
        [
          { bvid: 'BV9', title: 't', source: 'https://www.tiktok.com/@m/video/9' },
          { bvid: 'BVx', title: 'no source' },
          { bvid: 'BVy', title: 'unknown', source: 'https://www.tiktok.com/@m/video/unknown' },
        ],
        3,
      ),
  })
  try {
    const result = await reconcileBilibiliSubmissions(
      db,
      [{ id: 'bili-target', cookie_file: cookieFile(dir) }],
      { markerPath: marker, baseUrl: `http://127.0.0.1:${server.port}/x` },
    )
    expect(result).toMatchObject({ archives: 3, matched: 1, seeded: 1, skippedNoSource: 1, skippedNoArticle: 1 })
    // dedup state seeded: article now counts as forwarded to this target
    const row = db.db.query('SELECT * FROM forward_by WHERE ref_id = ? AND bot_id = ?').get('9', 'bili-target')
    expect(row).not.toBeNull()
    const outbound = db.db.query("SELECT status FROM outbound_messages WHERE target_id = 'bili-target'").get() as any
    expect(outbound.status).toBe('sent')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(`${marker}.bilibili-reconciled`)).toBe(true)
    const done = JSON.parse(readFileSync(`${marker}.bilibili-reconciled`, 'utf8'))
    expect(done.seeded).toBe(1)

    // already-seeded article is not re-seeded on a second run
    writeFileSync(marker, '{}')
    const second = await reconcileBilibiliSubmissions(db, [{ id: 'bili-target', cookie_file: cookieFile(dir) }], {
      markerPath: marker,
      baseUrl: `http://127.0.0.1:${server.port}/x`,
    })
    expect(second!.matched).toBe(1)
    expect(second!.seeded).toBe(0)
  } finally {
    server.stop(true)
    db.close()
  }
})

test('reconcile: no marker is a no-op; zero targets leaves the marker for retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-recon-'))
  const missing = join(dir, 'nope.json')
  const db = seededDb()
  expect(await reconcileBilibiliSubmissions(db, [], { markerPath: missing })).toBeNull()
  const marker = join(dir, 'marker.json')
  writeFileSync(marker, '{}')
  const result = await reconcileBilibiliSubmissions(db, [], { markerPath: marker })
  expect(result!.targets).toBe(0)
  expect(existsSync(marker)).toBe(true) // left for retry
  db.close()
})
