import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CookieKeepaliveService } from '../src/components/cookie-keepalive'

function fakeYtdlp(dir: string, exitCode: number, appendLine?: string): string {
  const script = join(dir, 'yt-dlp')
  const lines = ['#!/bin/sh']
  if (appendLine) {
    lines.push(`printf '%s\\n' '${appendLine}' >> "$2"`)
  }
  lines.push(`exit ${exitCode}`)
  writeFileSync(script, lines.join('\n') + '\n')
  chmodSync(script, 0o755)
  return script
}

test('ytdlp keepalive: rotates the jar atomically on success and keeps a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-keepalive-'))
  const jar = join(dir, 'cookies.txt')
  writeFileSync(jar, '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\told\n')
  const helper = fakeYtdlp(dir, 0, '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfresh')
  const service = new CookieKeepaliveService(
    [{ kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: helper }],
    null,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(true)
  expect(readFileSync(jar, 'utf8')).toContain('SID\tfresh')
  expect(readFileSync(`${jar}.bak-keepalive`, 'utf8')).toContain('SID\told')
  expect(existsSync(`${jar}.tmp-keepalive-${process.pid}`)).toBe(false)
})

test('ytdlp keepalive: failure keeps the original jar and records the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-keepalive-'))
  const jar = join(dir, 'cookies.txt')
  writeFileSync(jar, 'original-jar\n')
  const helper = fakeYtdlp(dir, 1)
  const service = new CookieKeepaliveService(
    [{ kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: helper }],
    null,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(false)
  expect(states[0]!.lastError).toContain('exited 1')
  expect(readFileSync(jar, 'utf8')).toBe('original-jar\n')
  expect(existsSync(`${jar}.bak-keepalive`)).toBe(false)
})

test('ytdlp keepalive: empty jar aborts before spawning yt-dlp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-keepalive-'))
  const jar = join(dir, 'cookies.txt')
  writeFileSync(jar, '')
  const service = new CookieKeepaliveService(
    [{ kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: '/nonexistent/yt-dlp' }],
    null,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(false)
  expect(states[0]!.lastError).toContain('missing or empty')
})

test('browser keepalive: warms the named session profile', async () => {
  const requests: any[] = []
  const page = { goto: async (url: string) => requests.push({ url }), close: async () => {} }
  const pool = { createPage: async (req: any) => (requests.push(req), page) }
  const service = new CookieKeepaliveService(
    [{ kind: 'browser', session_profile: 'x-main', url: 'https://x.com/home', settle_ms: 1 }],
    pool as any,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(true)
  expect(requests[0]).toMatchObject({ session_profile: 'x-main' })
  expect(requests[1]).toMatchObject({ url: 'https://x.com/home' })
})

test('browser keepalive without a pool reports unavailable instead of throwing', async () => {
  const service = new CookieKeepaliveService(
    [{ kind: 'browser', session_profile: 'x-main', url: 'https://x.com/home' }],
    null,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(false)
  expect(states[0]!.lastError).toContain('browser pool unavailable')
})
