#!/usr/bin/env bun
import { exportDb, importDb } from '../src/pipeline/db-archive'

/** usage: bun scripts/db-archive.ts export <db> <out> [--gzip|--zstd] | import <archive> <db> [--force] */

async function main() {
  const [cmd, src, dst, ...flags] = process.argv.slice(2)
  if (!cmd || !src || !dst || !['export', 'import'].includes(cmd)) {
    console.error('usage: bun scripts/db-archive.ts export <db> <out> [--gzip|--zstd] | import <archive> <db> [--force]')
    process.exit(1)
  }
  if (cmd === 'export') {
    const codec = flags.includes('--gzip') ? 'gzip' : flags.includes('--zstd') ? 'zstd' : undefined
    const result = await exportDb(src, dst, { codec })
    const ratio = result.raw_bytes > 0 ? ((1 - result.archive_bytes / result.raw_bytes) * 100).toFixed(1) : '?'
    console.log(`exported ${src} -> ${dst} (${result.codec}, ${result.raw_bytes} -> ${result.archive_bytes} bytes, -${ratio}%)`)
    return
  }
  await importDb(src, dst, { force: flags.includes('--force') })
  console.log(`imported ${src} -> ${dst}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
