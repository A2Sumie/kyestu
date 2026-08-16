import { createHash } from 'crypto'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Media acquisition: default HTTP downloader into a content-addressed local
 * store. yt-dlp / gallery-dl wrappers land with the video paths in v1.1.
 */

export interface MediaItem {
  type: 'photo' | 'video'
  url: string
  path?: string
  media_type?: string
}

export class MediaStore {
  readonly root: string

  constructor(cacheRoot: string) {
    this.root = join(cacheRoot, 'media', 'store')
    mkdirSync(this.root, { recursive: true })
  }

  pathFor(url: string, ext?: string): string {
    const hash = createHash('sha256').update(url).digest('hex')
    const suffix = ext ?? guessExt(url) ?? 'bin'
    return join(this.root, `${hash.slice(0, 2)}`, `${hash}.${suffix}`)
  }

  has(url: string): string | null {
    const path = this.pathFor(url)
    return existsSync(path) ? path : null
  }

  async download(url: string, options: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
    const existing = this.has(url)
    if (existing) return existing
    const res = await fetch(url, {
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
    if (!res.ok) throw new Error(`media download failed: HTTP ${res.status} for ${url}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    const path = this.pathFor(url)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, buffer)
    return path
  }
}

function guessExt(url: string): string | null {
  const match = new URL(url, 'http://x').pathname.match(/\.([a-z0-9]{2,5})$/i)
  return match?.[1]?.toLowerCase() ?? null
}
