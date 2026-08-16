import { readFileSync } from 'fs'
import type { MediaStore } from './media'

/**
 * Summary-card rendering: build a message_pack article from a flushed window
 * and render it with the SAME DefaultCard template idol-bbq uses.
 */

const PLATFORM_ENUM: Record<string, number> = { twitter: 1, instagram: 2, tiktok: 3, youtube: 4, website: 5 }
const PLATFORM_LABEL: Record<string, string> = { twitter: 'X', instagram: 'IG', tiktok: 'TikTok', youtube: 'YT', website: '官网' }

export interface SummaryItem {
  text?: string
  username?: string
  u_avatar?: string | null
  created_at?: number
  platform?: string
  media?: Array<{ type: string; url?: string; path?: string }>
}

function formatRange(items: SummaryItem[]): string {
  const times = items.map((i) => i.created_at).filter((v): v is number => typeof v === 'number' && v > 0)
  if (!times.length) return ''
  const min = new Date(Math.min(...times) * 1000)
  const max = new Date(Math.max(...times) * 1000)
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${fmt(min)}~${fmt(max)}`
}

/** build the synthetic message_pack article, same shape as idol-bbq's buildSyntheticSummaryArticle */
export function buildSummaryArticle(items: SummaryItem[], options: { maxItemsPerGroup?: number; title?: string } = {}): any {
  const maxItems = options.maxItemsPerGroup ?? 14
  const shown = items.slice(0, maxItems)
  const avatars: Array<Record<string, string>> = []
  const seen = new Set<string>()
  for (const item of shown) {
    const key = item.u_avatar || item.username
    if (key && !seen.has(key) && avatars.length < 5) {
      seen.add(key)
      const avatar: Record<string, string> = {}
      if (item.u_avatar) avatar.url = item.u_avatar
      if (item.username) avatar.name = item.username
      avatars.push(avatar)
    }
  }
  const group = {
    title: `消息串 ${formatRange(items)}`.trim(),
    omitted: Math.max(0, items.length - shown.length),
    avatars,
    items: shown.map((item, index) => {
      const media = (item.media ?? [])
        .filter((m) => m.type === 'photo')
        .slice(0, 4)
        .map((m) => ({ type: 'photo', url: m.url ?? m.path }))
      return {
        index: index + 1,
        text: item.text ?? '',
        avatar: { url: item.u_avatar ?? undefined, name: item.username },
        media,
        mediaLabel: media.length ? `#${index + 1} 图集` : undefined,
      }
    }),
  }
  const now = Math.floor(Date.now() / 1000)
  return {
    id: -now,
    platform: PLATFORM_ENUM[shown[0]?.platform ?? ''] ?? 1,
    a_id: `summary-card-${now}`,
    u_id: 'message_pack',
    username: '22/7消息聚合',
    created_at: now,
    content: options.title ?? `22/7消息聚合 新消息${formatRange(items)} ${items.length}条`.trim(),
    url: '',
    type: 'message_pack',
    ref: null,
    has_media: false,
    media: null,
    extra: {
      extra_type: 'message_pack_meta',
      data: {
        total: items.length,
        range: formatRange(items),
        groups: [group],
      },
    },
    u_avatar: null,
  }
}

/** hydrate item photos to dataURLs so satori renders them without network */
async function hydrateSummaryMedia(article: any, mediaStore: MediaStore | null): Promise<any> {
  if (!mediaStore) return article
  const groups = article.extra?.data?.groups
  if (!Array.isArray(groups)) return article
  for (const group of groups) {
    for (const item of group.items ?? []) {
      for (const media of item.media ?? []) {
        if (!media?.url || media.url.startsWith('data:')) continue
        try {
          const path = await mediaStore.download(media.url)
          media.url = `data:image/${path.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(path).toString('base64')}`
        } catch {
          // leave the URL; satori will try the network
        }
      }
    }
  }
  return article
}

export async function renderSummaryCard(article: any, mediaStore: MediaStore | null): Promise<Buffer | null> {
  try {
    process.env.RENDER_REMOTE_ASSETS ||= '0'
    const { ImgConverter } = await import('@kyestu/render')
    const converter = new ImgConverter()
    return await converter.articleToImg(await hydrateSummaryMedia(article, mediaStore))
  } catch {
    return null
  }
}

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform
}
