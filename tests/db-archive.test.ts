import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exportDb, importDb, detectCodec, isSqliteFile, hasZstd } from '../src/pipeline/db-archive'

function seedDb(path: string): void {
  const db = new Database(path)
  db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  db.run("INSERT INTO t (v) VALUES ('hello-迁移')")
  db.close()
}

function readRow(path: string): string {
  const db = new Database(path, { readonly: true })
  const row = db.query('SELECT v FROM t WHERE id = 1').get() as { v: string }
  db.close()
  return row.v
}

test('gzip roundtrip: export compresses, import restores queryable db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-dbarc-'))
  const src = join(dir, 'src.db')
  const archive = join(dir, 'out.db.gz')
  const restored = join(dir, 'restored.db')
  seedDb(src)
  const result = await exportDb(src, archive, { codec: 'gzip' })
  expect(result.codec).toBe('gzip')
  expect(result.archive_bytes).toBeGreaterThan(0)
  expect(detectCodec(archive)).toBe('gzip')
  await importDb(archive, restored)
  expect(readRow(restored)).toBe('hello-迁移')
})

test('zstd roundtrip when the CLI is available; default codec prefers zstd', async () => {
  if (!hasZstd()) return
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-dbarc-'))
  const src = join(dir, 'src.db')
  const archive = join(dir, 'out.db.zst')
  const restored = join(dir, 'restored.db')
  seedDb(src)
  const result = await exportDb(src, archive)
  expect(result.codec).toBe('zstd')
  expect(detectCodec(archive)).toBe('zstd')
  await importDb(archive, restored)
  expect(readRow(restored)).toBe('hello-迁移')
})

test('import refuses to overwrite a non-empty db without force; force keeps a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-dbarc-'))
  const src = join(dir, 'src.db')
  const archive = join(dir, 'out.db.gz')
  const target = join(dir, 'target.db')
  seedDb(src)
  await exportDb(src, archive, { codec: 'gzip' })
  seedDb(target)
  await expect(importDb(archive, target)).rejects.toThrow('refusing to overwrite')
  await importDb(archive, target, { force: true })
  expect(readRow(target)).toBe('hello-迁移')
  expect(readdirSync(dir).some((f) => f.startsWith('target.db.bak-'))).toBe(true)
})

test('import rejects garbage and non-sqlite payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-dbarc-'))
  const garbage = join(dir, 'garbage.bin')
  writeFileSync(garbage, 'not an archive at all')
  await expect(importDb(garbage, join(dir, 'x.db'))).rejects.toThrow('unknown archive format')
  expect(isSqliteFile(garbage)).toBe(false)
  await expect(exportDb(garbage, join(dir, 'o.gz'))).rejects.toThrow('not a sqlite database')
})
