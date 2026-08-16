import { test, expect } from 'bun:test'
import { KyestuDb, defaultMigrationsDir } from '../src/components/db'
import { ArticleStore } from '../src/pipeline/articles'
import { ShortVideoDedup, buildTextFingerprint, isLikelySameText } from '../src/pipeline/short-video-dedup'

function setup() {
  const db = new KyestuDb(':memory:')
  db.migrate(defaultMigrationsDir)
  return { db, dedup: new ShortVideoDedup(db), articles: new ArticleStore(db) }
}

const NOW = Math.floor(Date.now() / 1000)

function seedArticle(articles: ArticleStore, platform: any, aId: string, content: string, createdAt = NOW) {
  articles.save({ platform, a_id: aId, u_id: 'm', username: 'm', url: `https://${platform}/${aId}`, content, created_at: createdAt, has_media: true } as any)
}

test('minutes-apart IG/TT cross-post with different captions is still caught', () => {
  const { db, dedup, articles } = setup()
  seedArticle(articles, 'instagram', 'ig1', '新曲「明日の风」公開中！#ナナニジ https://example.com/mv')
  dedup.claim({ platform: 'instagram', a_id: 'ig1', content: '新曲「明日の风」公開中！#ナナニジ https://example.com/mv', created_at: NOW })
  // TT version: 3 minutes later, caption rewritten with TT-style hashtags
  const dup = dedup.check({ platform: 'tiktok', a_id: 'tt1', content: '明日の风 #新曲 #22/7 #TikTok', created_at: NOW + 180 })
  expect(dup).not.toBeNull()
  expect(dup!.marker).toBe('instagram:ig1')
  db.close()
})

test('days-apart posts within the 7d window are caught (idol-bbq missed beyond ±12h)', () => {
  const { db, dedup, articles } = setup()
  const earlier = NOW - 3 * 24 * 3600
  seedArticle(articles, 'tiktok', 'tt9', '生放送ありがとうございました', earlier)
  dedup.claim({ platform: 'tiktok', a_id: 'tt9', content: '生放送ありがとうございました', created_at: earlier })
  const dup = dedup.check({ platform: 'instagram', a_id: 'ig9', content: '生放送ありがとうございました！', created_at: NOW })
  expect(dup?.marker).toBe('tiktok:tt9')
  db.close()
})

test('unrelated articles on the same pair are not flagged', () => {
  const { db, dedup, articles } = setup()
  seedArticle(articles, 'instagram', 'ig1', '今日の写真です、猫と遊んだ')
  dedup.claim({ platform: 'instagram', a_id: 'ig1', content: '今日の写真です、猫と遊んだ', created_at: NOW })
  expect(dedup.check({ platform: 'tiktok', a_id: 'tt2', content: '新作料理のレシピ公開', created_at: NOW })).toBeNull()
  db.close()
})

test('outside the time window is not flagged', () => {
  const { db, dedup, articles } = setup()
  const old = NOW - 30 * 24 * 3600
  seedArticle(articles, 'instagram', 'ig1', '同じテキスト', old)
  dedup.claim({ platform: 'instagram', a_id: 'ig1', content: '同じテキスト', created_at: old })
  // claim rows carry the claim time, so simulate an old claim row directly
  db.db.query("UPDATE media_hashes SET created_at = ? WHERE a_id = 'instagram:ig1'").run(old)
  expect(dedup.check({ platform: 'tiktok', a_id: 'tt1', content: '同じテキスト', created_at: NOW })).toBeNull()
  db.close()
})

test('self-marker never self-flags; claim-before-upload blocks the second concurrent arrival', () => {
  const { db, dedup, articles } = setup()
  const content = '同時投稿の動画テスト'
  seedArticle(articles, 'tiktok', 'tt1', content)
  expect(dedup.checkOrClaim({ platform: 'tiktok', a_id: 'tt1', content, created_at: NOW })).toBeNull()
  // the simultaneous IG twin arrives while the TT upload is still running:
  // keys are already claimed -> flagged before its own upload starts
  const dup = dedup.check({ platform: 'instagram', a_id: 'ig1', content, created_at: NOW })
  expect(dup?.marker).toBe('tiktok:tt1')
  // the TT article itself can retry its own upload freely
  expect(dedup.check({ platform: 'tiktok', a_id: 'tt1', content, created_at: NOW })).toBeNull()
  db.close()
})

test('youtube only participates as shorts; youtube-youtube same-platform dedup works', () => {
  const { db, dedup, articles } = setup()
  seedArticle(articles, 'youtube', 'yt0', 'ミュージックビデオ「曇り空の向こう側」公開中')
  dedup.claim({ platform: 'youtube', a_id: 'yt0', type: 'shorts', content: 'ミュージックビデオ「曇り空の向こう側」公開中', created_at: NOW })
  expect(dedup.check({ platform: 'youtube', a_id: 'yt1', type: 'video', content: 'ミュージックビデオ「曇り空の向こう側」公開中', created_at: NOW })).toBeNull()
  expect(dedup.check({ platform: 'youtube', a_id: 'yt2', type: 'shorts', content: '曇り空の向こう側 MV #新曲', created_at: NOW })?.marker).toBe('youtube:yt0')
  db.close()
})

test('text fingerprint: boilerplate stripped, similarity judgment', () => {
  const a = buildTextFingerprint(['新曲公開中！#ナナニジ #22/7'])
  expect(a.distilledCompact).not.toContain('公開中')
  expect(a.distilledCompact).toContain('新曲')
  const b = buildTextFingerprint(['ミュージックビデオ「曇り空の向こう側」公開中'])
  const c = buildTextFingerprint(['曇り空の向こう側 MV #新曲 #TikTok'])
  expect(isLikelySameText(b, c)).toBe(true) // 8-char shared phrase
  const d = buildTextFingerprint(['全然違う話題のテキスト'])
  expect(isLikelySameText(a, d)).toBe(false)
})
