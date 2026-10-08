import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'child_process'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { gzipSync, createGunzip } from 'node:zlib'
import { readFileSync, writeFileSync } from 'fs'

/**
 * DB migration/archive tooling: export a sqlite database as a compact,
 * compressed single file (VACUUM INTO -> zstd|gzip) and import it back on
 * another host. zstd via CLI when available, gzip (node:zlib) as the
 * always-available fallback. Import verifies the sqlite header and backs up
 * any existing target before replacing it.
 *
 * Import bounds (daybreak 2026-10-08 finding 10): the archive is operator
 * selected but not necessarily operator made — expansion is streamed through a
 * hard output cap (gzip) or watched and killed at the cap (zstd), and the
 * decompression has a wall-clock limit. A bomb dies before it can exhaust
 * memory or the database volume; the temp file is always cleaned up.
 */

export type ArchiveCodec = 'zstd' | 'gzip'

export interface ExportResult {
  codec: ArchiveCodec
  raw_bytes: number
  archive_bytes: number
}

export interface ImportOptions {
  force?: boolean
  /** hard cap on expanded bytes (default 2 GiB, env KYESTU_DB_IMPORT_MAX_BYTES) */
  maxExpandedBytes?: number
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const GZIP_MAGIC = [0x1f, 0x8b]
const SQLITE_HEADER = 'SQLite format 3'
const DEFAULT_MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
const DECOMPRESS_TIMEOUT_MS = 120_000

function maxExpandedBytes(explicit?: number): number {
  if (explicit && Number.isFinite(explicit) && explicit > 0) return explicit
  const raw = Number(process.env.KYESTU_DB_IMPORT_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_EXPANDED_BYTES
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-300)}`))
    })
  })
}

let zstdAvailable: boolean | null = null
export function hasZstd(): boolean {
  if (zstdAvailable === null) {
    const res = spawnSync('zstd', ['--version'], { stdio: 'ignore' })
    zstdAvailable = res.status === 0
  }
  return zstdAvailable
}

function readMagic(path: string, count: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(count)
    readSync(fd, buf, 0, count, 0)
    return buf
  } finally {
    closeSync(fd)
  }
}

export function detectCodec(path: string): ArchiveCodec | null {
  const magic = readMagic(path, 4)
  if (ZSTD_MAGIC.every((b, i) => magic[i] === b)) return 'zstd'
  if (GZIP_MAGIC.every((b, i) => magic[i] === b)) return 'gzip'
  return null
}

export function isSqliteFile(path: string): boolean {
  if (!existsSync(path)) return false
  return readMagic(path, SQLITE_HEADER.length).toString('latin1') === SQLITE_HEADER
}

async function compress(src: string, out: string, codec: ArchiveCodec): Promise<void> {
  if (codec === 'zstd') {
    await run('zstd', ['-q', '-19', '-f', '-o', out, src])
    return
  }
  writeFileSync(out, gzipSync(readFileSync(src), { level: 9 }))
}

/** stream gzip expansion through a hard byte counter; abort mid-stream at the cap */
async function gunzipBounded(src: string, out: string, maxBytes: number): Promise<void> {
  const input = createReadStream(src)
  const gunzip = createGunzip()
  const stream = input.pipe(gunzip)
  const fd = openSync(out, 'wx')
  let written = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      written += chunk.length
      if (written > maxBytes) {
        stream.destroy()
        input.destroy()
        throw new Error(`gzip archive expands beyond the ${maxBytes} byte limit: ${src}`)
      }
      writeSync(fd, chunk)
    }
  } finally {
    closeSync(fd)
    stream.destroy()
    input.destroy()
  }
}

/**
 * spawn a decompressor whose output file is watched: exceeding the byte cap or
 * the wall-clock budget kills it (zstd has no output-cap flag of its own)
 */
function runBounded(cmd: string, args: string[], watchPath: string, maxBytes: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearInterval(watch)
      clearTimeout(timeout)
      if (error) reject(error)
      else resolvePromise()
    }
    const overBudget = () => new Error(`${cmd} output exceeds the ${maxBytes} byte limit: ${watchPath}`)
    const watch = setInterval(() => {
      try {
        if (statSync(watchPath).size > maxBytes) {
          proc.kill('SIGKILL')
          finish(overBudget())
        }
      } catch {
        // output not created yet
      }
    }, 200)
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      finish(new Error(`${cmd} timed out after ${DECOMPRESS_TIMEOUT_MS}ms: ${watchPath}`))
    }, DECOMPRESS_TIMEOUT_MS)
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', (error) => finish(error))
    proc.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        finish(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-300)}`))
        return
      }
      try {
        if (statSync(watchPath).size > maxBytes) {
          finish(overBudget())
          return
        }
      } catch {
        // let the sqlite header check report the missing output
      }
      finish()
    })
  })
}

async function decompress(src: string, out: string, codec: ArchiveCodec, maxBytes: number): Promise<void> {
  if (codec === 'zstd') {
    await runBounded('zstd', ['-q', '-d', '-f', '-o', out, src], out, maxBytes)
    return
  }
  await gunzipBounded(src, out, maxBytes)
}

/** VACUUM INTO a scratch copy, compress, clean up. Defaults to zstd when the CLI exists. */
export async function exportDb(dbPath: string, outPath: string, options: { codec?: ArchiveCodec } = {}): Promise<ExportResult> {
  if (!isSqliteFile(dbPath)) throw new Error(`not a sqlite database: ${dbPath}`)
  const codec = options.codec ?? (hasZstd() ? 'zstd' : 'gzip')
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  const tmp = `${outPath}.tmp-raw-${process.pid}`
  rmSync(tmp, { force: true })
  try {
    const db = new Database(dbPath, { readonly: true })
    try {
      db.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    const rawBytes = statSync(tmp).size
    await compress(tmp, outPath, codec)
    return { codec, raw_bytes: rawBytes, archive_bytes: statSync(outPath).size }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** decompress (bounded), verify the sqlite header, back up any existing target, swap in */
export async function importDb(archivePath: string, dbPath: string, options: ImportOptions = {}): Promise<void> {
  const codec = detectCodec(archivePath)
  if (!codec) throw new Error(`unknown archive format (not zstd/gzip): ${archivePath}`)
  if (existsSync(dbPath) && statSync(dbPath).size > 0 && !options.force) {
    throw new Error(`refusing to overwrite non-empty database without force: ${dbPath}`)
  }
  mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const tmp = `${dbPath}.tmp-import-${process.pid}`
  rmSync(tmp, { force: true })
  try {
    await decompress(archivePath, tmp, codec, maxExpandedBytes(options.maxExpandedBytes))
    if (!isSqliteFile(tmp)) throw new Error(`decompressed payload is not a sqlite database: ${archivePath}`)
    if (existsSync(dbPath) && statSync(dbPath).size > 0) {
      copyFileSync(dbPath, `${dbPath}.bak-${Date.now()}`)
    }
    renameSync(tmp, dbPath)
  } finally {
    rmSync(tmp, { force: true })
  }
}
