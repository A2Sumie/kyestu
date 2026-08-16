import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import type { Component } from '../core/types'
import type { MediaStore } from '../pipeline/media'

process.env.FONTS_DIR ||= fileURLToPath(new URL('../../assets/fonts', import.meta.url))

export interface RenderedMedia {
  path: string
  type: 'photo' | 'video'
}

export interface RenderedPayload {
  text: string
  media: RenderedMedia[]
}

export interface FormatterApi {
  renderType: string
  render: (article: any) => Promise<RenderedPayload>
}

const VIDEO_RENDER_FALLBACK = new Set(['img-tag', 'img-tag-dynamic'])
// production exempts the whole platform (TikTok/YouTube) for img/img-with-meta,
// and platform OR type for the img-tag family
function isVideoArticle(article: any): boolean {
  return (
    article.platform === 'tiktok' ||
    article.platform === 'youtube' ||
    (Array.isArray(article.media) && article.media.some((m: any) => m?.type === 'video'))
  )
}

async function toRenderArticle(article: any, mediaStore: MediaStore | null): Promise<any> {
  const media = Array.isArray(article.media) ? article.media : []
  const hydrated = []
  for (const item of media) {
    if (!item?.url) continue
    if (item.type !== 'photo') {
      hydrated.push(item)
      continue
    }
    try {
      const path = await mediaStore!.download(item.url)
      const dataUrl = `data:image/${path.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(path).toString('base64')}`
      hydrated.push({ ...item, url: dataUrl })
    } catch {
      hydrated.push(item)
    }
  }
  return { ...article, media: hydrated }
}

async function renderCard(article: any, mediaStore: MediaStore | null): Promise<Buffer | null> {
  try {
    const { ImgConverter } = await import('@kyestu/render')
    const converter = new ImgConverter()
    return await converter.articleToImg(await toRenderArticle(article, mediaStore))
  } catch {
    return null
  }
}

export function makeFormatterComponent(renderType: string): Component<Record<string, any>> {
  return {
    inject: ['media-store'],
    apply: (ctx, config) => {
      const mediaStore = ctx.get<MediaStore>('media-store') ?? null
      const api: FormatterApi = {
        renderType,
        async render(article) {
          const {
            articleToText,
            compactArticleToText,
            formatWebsiteCardText,
            extractArticleHeadline,
          } = await import('@kyestu/render')
          const isVideo = isVideoArticle(article)

          const fullText = () =>
            renderType.startsWith('text-compact') ? compactArticleToText(article) : articleToText(article)

          const downloadMedia = async (): Promise<RenderedMedia[]> => {
            if (!mediaStore || !Array.isArray(article.media)) return []
            const out: RenderedMedia[] = []
            for (const item of article.media) {
              if (!item?.url) continue
              try {
                out.push({ path: await mediaStore.download(item.url), type: item.type === 'video' ? 'video' : 'photo' })
              } catch {
                // failed media is dropped from the payload
              }
            }
            return out
          }

          switch (renderType) {
            case 'raw-text':
              return { text: article.content ?? '', media: [] }
            case 'text':
            case 'text-compact':
              return { text: fullText(), media: await downloadMedia() }
            case 'text-card':
            case 'text-compact-card': {
              let text = article.platform === 'website' ? formatWebsiteCardText(article) : fullText()
              if ((article.content?.length ?? 0) > 1000) text = extractArticleHeadline(article) ?? text
              const card = await renderCard(article, mediaStore)
              const media = await downloadMedia()
              if (card) media.push({ path: await persistCard(card), type: 'photo' })
              return { text, media }
            }
            case 'img':
            case 'img-tag':
            case 'img-tag-dynamic':
            case 'img-with-meta': {
              const videoExempt = isVideo && (VIDEO_RENDER_FALLBACK.has(renderType) || renderType === 'img' || renderType === 'img-with-meta')
              if (videoExempt) {
                return { text: fullText(), media: await downloadMedia() }
              }
              const card = await renderCard(article, mediaStore)
              const media: RenderedMedia[] = []
              if (card) media.push({ path: await persistCard(card), type: 'photo' })
              if (isVideo) media.push(...(await downloadMedia()))
              // a failed card render must never yield an empty message: keep the
              // full text as the fallback body (production articleToImgSuccess)
              if (!card) return { text: fullText(), media }
              const tag = `${article.username ?? article.u_id} ${article.created_at ? new Date(article.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''} ${article.platform}`.trim()
              const text = renderType === 'img' ? '' : tag
              return { text, media }
            }
            case 'tag': {
              if (!article.has_media) return { text: '', media: [] }
              return { text: `From ${article.platform}`, media: await downloadMedia() }
            }
            default:
              return { text: fullText(), media: await downloadMedia() }
          }
        },
      }
      ctx.expose(api)
    },
  }
}

async function persistCard(card: Buffer): Promise<string> {
  const { createHash } = await import('crypto')
  const { mkdirSync, writeFileSync } = await import('fs')
  const { join } = await import('path')
  const dir = fileURLToPath(new URL('../../cache/cards', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${createHash('sha256').update(card).digest('hex')}.png`)
  writeFileSync(path, card)
  return path
}
