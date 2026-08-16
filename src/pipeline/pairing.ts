import { createHash } from 'crypto'
import type { KyestuDb } from '../components/db'

/**
 * X-teaser <-> main-platform video pairing (90min default window):
 * an X post with a video teaser plus a TikTok/IG link is held; when the main
 * platform's video arrives, the two are merged into one upload.
 */

export interface PairingConfig {
  enabled?: boolean
  join_platforms?: string[]
  window_seconds?: number
}

export class VideoPairings {
  constructor(private readonly store: KyestuDb) {}

  private windowMs(config: PairingConfig): number {
    return (config.window_seconds ?? 90 * 60) * 1000
  }

  pairingKey(targetId: string, sourceAId: string): string {
    return createHash('sha256').update(`${targetId}:${sourceAId}`).digest('hex').slice(0, 32)
  }

  /** hold an X teaser for later merging; returns the pairing key */
  hold(targetId: string, article: { a_id: string; u_id: string; username?: string; created_at?: number; url: string }, teaserMedia: unknown, joinPlatform: string, config: PairingConfig): string {
    const key = this.pairingKey(targetId, article.a_id)
    const now = Date.now()
    this.store.db
      .query(
        `INSERT INTO video_pairings
         (pairing_key, target_id, status, source_article_key, source_platform, source_a_id, source_u_id, source_username, source_created_at, join_platform, teaser_media, expires_at, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, 'twitter', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pairing_key) DO UPDATE SET teaser_media = excluded.teaser_media, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(
        key,
        targetId,
        `twitter:${article.a_id}`,
        article.a_id,
        article.u_id,
        article.username ?? article.u_id,
        article.created_at ?? Math.floor(now / 1000),
        joinPlatform,
        JSON.stringify(teaserMedia ?? null),
        now + this.windowMs(config),
        now,
        now,
      )
    return key
  }

  /** find the pending pairing a main-platform video should merge into */
  findPending(targetId: string, joinPlatform: string, uId: string): { pairing_key: string; teaser_media: any } | null {
    const now = Date.now()
    const row = this.store.db
      .query(
        `SELECT pairing_key, teaser_media FROM video_pairings
         WHERE target_id = ? AND join_platform = ? AND source_u_id = ? AND status = 'pending' AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(targetId, joinPlatform, uId, now) as { pairing_key: string; teaser_media: string } | null
    if (!row) return null
    return { pairing_key: row.pairing_key, teaser_media: row.teaser_media ? JSON.parse(row.teaser_media) : null }
  }

  mark(pairingKey: string, status: 'merged' | 'dropped' | 'expired', mergeResult?: unknown): void {
    this.store.db
      .query('UPDATE video_pairings SET status = ?, merge_result = ?, finished_at = ?, updated_at = ? WHERE pairing_key = ?')
      .run(status, mergeResult === undefined ? null : JSON.stringify(mergeResult), Date.now(), Date.now(), pairingKey)
  }

  sweepExpired(): number {
    const result = this.store.db
      .query(`UPDATE video_pairings SET status = 'expired', finished_at = ?, updated_at = ? WHERE status = 'pending' AND expires_at <= ?`)
      .run(Date.now(), Date.now(), Date.now())
    return Number(result.changes)
  }
}

/** does this article look like an X teaser carrying a join-platform link? */
export function teaserJoinPlatform(content: string | null | undefined, joinPlatforms: string[]): string | null {
  if (!content) return null
  for (const platform of joinPlatforms) {
    if (platform === 'tiktok' && /tiktok\.com\//i.test(content)) return 'tiktok'
    if (platform === 'instagram' && /instagram\.com\//i.test(content)) return 'instagram'
  }
  return null
}
