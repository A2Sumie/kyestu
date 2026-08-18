import type { KyestuDb } from '../components/db'

/** Article persistence over the per-platform tables vendored from idol-bbq. */

export type Platform = 'twitter' | 'instagram' | 'tiktok' | 'youtube' | 'website'

export interface StoredArticle {
  platform: Platform
  a_id: string
  u_id: string
  username?: string
  created_at?: number
  content?: string | null
  translation?: string | null
  translated_by?: string | null
  url: string
  type?: string
  ref?: number | null
  has_media?: boolean
  media?: unknown
  extra?: unknown
  u_avatar?: string | null
}

const TABLES: Record<Platform, string> = {
  twitter: 'twitter_article',
  instagram: 'instagram_article',
  tiktok: 'tiktok_article',
  youtube: 'youtube_article',
  website: 'website_article',
}

export class ArticleStore {
  constructor(private readonly store: KyestuDb) {}

  table(platform: Platform): string {
    return TABLES[platform]
  }

  exists(platform: Platform, aId: string): boolean {
    const row = this.store.db
      .query(`SELECT id FROM ${TABLES[platform]} WHERE a_id = ? LIMIT 1`)
      .get(aId) as { id: number } | null
    return row !== null
  }

  /** save an article with its ref chain (parents first); returns the new row id, or null if it already existed
   *  (an existing row with an empty u_avatar is self-healed from the fresh article first) */
  save(article: StoredArticle): number | null {
    const refId = this.saveRefs(article)
    if (this.exists(article.platform, article.a_id)) {
      this.healMissingAvatar(article)
      return null
    }
    const result = this.store.db
      .query(
        `INSERT INTO ${TABLES[article.platform]}
         (a_id, u_id, username, created_at, content, translation, translated_by, url, type, ref, has_media, media, extra, u_avatar)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        article.a_id,
        article.u_id,
        article.username ?? article.u_id,
        article.created_at ?? Math.floor(Date.now() / 1000),
        article.content ?? null,
        article.translation ?? null,
        article.translated_by ?? null,
        article.url,
        article.type ?? 'post',
        refId,
        article.has_media ? 1 : 0,
        article.media === undefined ? null : JSON.stringify(article.media),
        article.extra === undefined ? null : JSON.stringify(article.extra),
        article.u_avatar ?? null,
      )
    return Number(result.lastInsertRowid)
  }

  private saveRefs(article: StoredArticle): number | null {
    const refs = (article as any).refs as StoredArticle[] | undefined
    if (!refs?.length) return article.ref ?? null
    // only single-level chains are used in production (quote/retweet of one parent)
    const parent = refs[0]!
    return this.save(parent) ?? this.lookupId(parent.platform, parent.a_id)
  }

  /** fill-when-missing: articles persisted while IG payloads dropped avatar
   *  fields stay avatar-less forever because save() never updates existing
   *  rows; backfill the gap when the fresh crawl carries what the row lacks */
  private healMissingAvatar(article: StoredArticle): void {
    if (!article.u_avatar) return
    this.store.db
      .query(
        `UPDATE ${TABLES[article.platform]} SET u_avatar = ? WHERE a_id = ? AND (u_avatar IS NULL OR u_avatar = '')`,
      )
      .run(article.u_avatar, article.a_id)
  }

  lookupId(platform: Platform, aId: string): number | null {
    const row = this.store.db
      .query(`SELECT id FROM ${TABLES[platform]} WHERE a_id = ? LIMIT 1`)
      .get(aId) as { id: number } | null
    return row ? Number(row.id) : null
  }

  /** cross-platform lookup by canonical url (bilibili archives match on the source url) */
  findByUrl(url: string): { id: number; platform: Platform; a_id: string } | null {
    for (const [platform, table] of Object.entries(TABLES)) {
      const row = this.store.db.query(`SELECT id, a_id FROM ${table} WHERE url = ? LIMIT 1`).get(url) as
        | { id: number; a_id: string }
        | null
      if (row) return { id: Number(row.id), platform: platform as Platform, a_id: row.a_id }
    }
    return null
  }

  /** full row by platform + a_id (short-video dedup compares candidate text) */
  getByAId(platform: Platform, aId: string): { id: number; a_id: string; content: string | null; translation: string | null; created_at: number } | null {
    const row = this.store.db
      .query(`SELECT id, a_id, content, translation, created_at FROM ${TABLES[platform]} WHERE a_id = ? LIMIT 1`)
      .get(aId) as any
    return row ? { id: Number(row.id), a_id: row.a_id, content: row.content, translation: row.translation, created_at: row.created_at } : null
  }

  get(platform: Platform, id: number): (StoredArticle & { id: number }) | null {
    const row = this.store.db.query(`SELECT * FROM ${TABLES[platform]} WHERE id = ?`).get(id) as any
    if (!row) return null
    return {
      ...row,
      platform, // per-platform tables carry no platform column; inject it
      has_media: Boolean(row.has_media),
      media: row.media ? JSON.parse(row.media) : null,
      extra: row.extra ? JSON.parse(row.extra) : null,
    }
  }

  /** load an article with its ref chain resolved one level */
  getWithRefs(platform: Platform, id: number): (StoredArticle & { id: number; refs: StoredArticle[] }) | null {
    const article = this.get(platform, id)
    if (!article) return null
    const refs: StoredArticle[] = []
    if (article.ref) {
      const parent = this.get(platform, article.ref)
      if (parent) refs.push(parent)
    }
    return { ...article, refs }
  }

  setTranslation(platform: Platform, id: number, translation: string, translatedBy: string): void {
    this.store.db
      .query(`UPDATE ${TABLES[platform]} SET translation = ?, translated_by = ? WHERE id = ?`)
      .run(translation, translatedBy, id)
  }
}
