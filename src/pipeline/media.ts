import { createHash } from 'crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { join } from 'path'

/**
 * Media acquisition: default HTTP downloader into a content-addressed local
 * store. yt-dlp / gallery-dl wrappers land with the video paths in v1.1.
 *
 * Resource discipline (daybreak 2026-10-08 finding 1): a remote response is
 * untrusted input. The body is streamed through a hard per-object byte counter
 * (never fully buffered in memory), the cache volume has a budget with
 * age-based eviction, and partial downloads never survive as cache entries.
 */

export interface MediaItem {
  type: 'photo' | 'video'
  url: string
  path?: string
  media_type?: string
}

export interface MediaStoreOptions {
  /** hard per-object budget; a longer response is aborted mid-stream */
  maxObjectBytes?: number
  /** cache volume budget (all stored objects); over budget: evict stale first, then refuse */
  maxTotalBytes?: number
  /** objects older than this are eviction candidates when the budget is tight */
  retentionDays?: number
}

const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 14
/** crashed runs leave *.part-* files behind; they are dead weight after an hour */
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

interface StoredObject {
  path: string
  size: number
  mtimeMs: number
}

export class MediaStore {
  readonly root: string
  private readonly contentHashes = new Map<string, string>()
  private readonly maxObjectBytes: number
  private readonly maxTotalBytes: number
  private readonly retentionDays: number
  private writeSeq = 0

  constructor(cacheRoot: string, options: MediaStoreOptions = {}) {
    this.root = join(cacheRoot, 'media', 'store')
    mkdirSync(this.root, { recursive: true })
    this.maxObjectBytes = options.maxObjectBytes ?? envInt('KYESTU_MEDIA_MAX_BYTES', DEFAULT_MAX_OBJECT_BYTES)
    this.maxTotalBytes = options.maxTotalBytes ?? envInt('KYESTU_MEDIA_CACHE_MAX_BYTES', DEFAULT_MAX_TOTAL_BYTES)
    this.retentionDays = options.retentionDays ?? envInt('KYESTU_MEDIA_RETENTION_DAYS', DEFAULT_RETENTION_DAYS)
    this.cleanupTempFiles()
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
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`media download failed: HTTP ${res.status} for ${url}`)
    }
    // declared size is a fast reject, not a guarantee: the real bound is the
    // streamed counter below (a chunked or lying response still hits it)
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.maxObjectBytes) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`media too large: ${declared} bytes > ${this.maxObjectBytes} limit for ${url}`)
    }
    const body = res.body
    if (!body) throw new Error(`media download failed: empty body for ${url}`)

    const path = this.pathFor(url)
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.part-${process.pid}-${++this.writeSeq}`
    const hash = createHash('sha256')
    let written = 0
    try {
      const fd = openSync(tmp, 'wx')
      try {
        const reader = body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          written += value.byteLength
          if (written > this.maxObjectBytes) {
            void reader.cancel().catch(() => {})
            throw new Error(`media too large: exceeded ${this.maxObjectBytes} bytes for ${url}`)
          }
          hash.update(value)
          writeSync(fd, value)
        }
      } finally {
        closeSync(fd)
      }
      // budget check runs while the bytes still live in the temp file, so a
      // refusal never leaves a cache entry behind
      this.makeRoom()
      renameSync(tmp, path)
      this.contentHashes.set(path, hash.digest('hex'))
      return path
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  }

  /**
   * content hash of a downloaded file (idol-bbq media identity prefers
   * content_hash over sourceUrl): URL-keyed storage is not a stable dedup key
   * because IG/TT CDN urls rotate signatures around the same bytes
   */
  contentHashOf(path: string): string | null {
    const memo = this.contentHashes.get(path)
    if (memo) return memo
    try {
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
      this.contentHashes.set(path, hash)
      return hash
    } catch {
      return null
    }
  }

  /** all stored objects (cache entries and in-flight *.part-* temporaries) */
  private listObjects(): StoredObject[] {
    const out: StoredObject[] = []
    const walk = (dir: string) => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const path = join(dir, name)
        let stat
        try {
          stat = statSync(path)
        } catch {
          continue
        }
        if (stat.isDirectory()) walk(path)
        else out.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
    walk(this.root)
    return out
  }

  /**
   * Enforce the cache-volume budget. Stale objects (older than retentionDays)
   * are evicted oldest first; if the budget is still exceeded the download is
   * refused loudly instead of silently dropping older media that a queued
   * outbound payload may still reference.
   */
  private makeRoom(): void {
    const objects = this.listObjects()
    let used = objects.reduce((sum, object) => sum + object.size, 0)
    if (used <= this.maxTotalBytes) return
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    for (const object of [...objects].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (used <= this.maxTotalBytes) break
      if (object.mtimeMs >= cutoff) continue
      try {
        unlinkSync(object.path)
        used -= object.size
        this.contentHashes.delete(object.path)
      } catch {
        // a concurrent reader/writer holds it; try the next candidate
      }
    }
    if (used > this.maxTotalBytes) {
      throw new Error(
        `media cache budget exceeded: ${used} bytes > ${this.maxTotalBytes} limit ` +
          `(raise KYESTU_MEDIA_CACHE_MAX_BYTES or clear ${this.root})`,
      )
    }
  }

  /** best-effort sweep of *.part-* files left behind by crashed runs */
  private cleanupTempFiles(): void {
    const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS
    for (const object of this.listObjects()) {
      if (!object.path.includes('.part-') || object.mtimeMs >= cutoff) continue
      try {
        unlinkSync(object.path)
      } catch {
        // leave it; the budget check will deal with it later
      }
    }
  }
}

function guessExt(url: string): string | null {
  const match = new URL(url, 'http://x').pathname.match(/\.([a-z0-9]{2,5})$/i)
  return match?.[1]?.toLowerCase() ?? null
}
