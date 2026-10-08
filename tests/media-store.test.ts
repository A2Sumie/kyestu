import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { MediaStore } from '../src/pipeline/media'

/**
 * Media store resource policy (daybreak 2026-10-08 finding 1): remote responses
 * are streamed through a hard per-object byte counter, the cache volume has a
 * budget, and refused downloads leave neither a cache entry nor a *.part-* file.
 *
 * These cases drive the store against a local test server, so they opt into the
 * allow-private URL policy; the block-private behaviour itself is covered by
 * tests/net-guard.test.ts.
 */

function storeDir(): string {
  return mkdtempSync(join(tmpdir(), 'kyestu-media-store-'))
}

function listObjects(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(root)
  return out
}

async function withServer(
  body: () => BodyInit,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: () => new Response(body()) })
  try {
    await run(`http://127.0.0.1:${server.port}`)
  } finally {
    server.stop(true)
  }
}

test('media store: downloads within budget and serves cache hits', async () => {
  const dir = storeDir()
  const store = new MediaStore(dir, { urlPolicy: 'allow-private', maxObjectBytes: 1024 })
  await withServer(() => 'hello-media', async (base) => {
    const path = await store.download(`${base}/a.jpg`)
    expect(readFileSync(path, 'utf8')).toBe('hello-media')
    expect(store.has(`${base}/a.jpg`)).toBe(path)
    expect(store.contentHashOf(path)).toBe(createHash('sha256').update('hello-media').digest('hex'))
    // second call is a pure cache hit: the server sees no second request
    expect(await store.download(`${base}/a.jpg`)).toBe(path)
  })
  rmSync(dir, { recursive: true, force: true })
})

test('media store: rejects a declared oversized response and leaves nothing behind', async () => {
  const dir = storeDir()
  const store = new MediaStore(dir, { urlPolicy: 'allow-private', maxObjectBytes: 1024 })
  await withServer(() => 'x'.repeat(4096), async (base) => {
    await expect(store.download(`${base}/big.bin`)).rejects.toThrow('media too large')
    expect(store.has(`${base}/big.bin`)).toBeNull()
  })
  expect(listObjects(join(dir, 'media', 'store'))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})

test('media store: streams without a content-length and still hits the byte counter', async () => {
  const dir = storeDir()
  const store = new MediaStore(dir, { urlPolicy: 'allow-private', maxObjectBytes: 1024 })
  // chunked transfer: no content-length header to lean on, so only the
  // streamed counter can stop it
  await withServer(
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(512))
          controller.close()
        },
      }),
    async (base) => {
      await expect(store.download(`${base}/chunked.bin`)).rejects.toThrow('media too large')
    },
  )
  expect(listObjects(join(dir, 'media', 'store'))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})

test('media store: evicts stale objects to stay inside the cache budget', async () => {
  const dir = storeDir()
  const store = new MediaStore(dir, { urlPolicy: 'allow-private', maxObjectBytes: 4096, maxTotalBytes: 2048, retentionDays: 1 })
  const stalePath = store.pathFor('stale-object')
  mkdirSync(join(stalePath, '..'), { recursive: true })
  writeFileSync(stalePath, Buffer.alloc(1800))
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  utimesSync(stalePath, tenDaysAgo, tenDaysAgo)

  await withServer(() => 'y'.repeat(1500), async (base) => {
    const path = await store.download(`${base}/fresh.jpg`)
    expect(existsSync(path)).toBeTrue()
  })
  expect(existsSync(stalePath)).toBeFalse()
  rmSync(dir, { recursive: true, force: true })
})

test('media store: refuses a download the cache budget cannot hold', async () => {
  const dir = storeDir()
  const store = new MediaStore(dir, { urlPolicy: 'allow-private', maxObjectBytes: 4096, maxTotalBytes: 1024, retentionDays: 1 })
  await withServer(() => 'z'.repeat(1500), async (base) => {
    await expect(store.download(`${base}/too-big-for-budget.jpg`)).rejects.toThrow('media cache budget exceeded')
    expect(store.has(`${base}/too-big-for-budget.jpg`)).toBeNull()
  })
  expect(listObjects(join(dir, 'media', 'store'))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})
