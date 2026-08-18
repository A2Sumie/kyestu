import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CookieKeepaliveService, expandPath } from '../src/components/cookie-keepalive'
import { SessionHealthBoard } from '../src/pipeline/session-health'
import type { Bus } from '../src/components/bus'

function makeDeps(overrides: Partial<ConstructorParameters<typeof CookieKeepaliveService>[1]> = {}) {
  const board = new SessionHealthBoard()
  const bus: Bus = new (require('../src/components/bus').Bus)()
  return {
    deps: {
      browser: null,
      board,
      bus,
      sleep: async () => {},
      ...overrides,
    },
    board,
    bus,
  }
}

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
  const { deps } = makeDeps()
  const service = new CookieKeepaliveService(
    [{ kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: helper }],
    deps,
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
  const { deps } = makeDeps()
  const service = new CookieKeepaliveService(
    [{ kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: helper }],
    deps,
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
  const { deps } = makeDeps()
  const service = new CookieKeepaliveService(
    [{ kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: '/nonexistent/yt-dlp' }],
    deps,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(false)
  expect(states[0]!.lastError).toContain('missing or empty')
})

test('browser keepalive: warms the named session profile', async () => {
  const requests: any[] = []
  const page = { goto: async (url: string) => requests.push({ url }), evaluate: async () => false, close: async () => {} }
  const pool = { createPage: async (req: any) => (requests.push(req), page) }
  const { deps } = makeDeps({ browser: pool as any })
  const service = new CookieKeepaliveService(
    [{ kind: 'browser', session_profile: 'x-main', url: 'https://x.com/home', settle_ms: 1 }],
    deps,
  )
  const states = await service.runNow()
  expect(states[0]!.lastOk).toBe(true)
  expect(requests[0]).toMatchObject({ session_profile: 'x-main' })
  expect(requests[1]).toMatchObject({ url: 'https://x.com/home' })
})

test('expandPath expands env vars and ~', () => {
  expect(expandPath('$KA_DIR/cookies.txt', { KA_DIR: '/data' })).toBe('/data/cookies.txt')
  expect(expandPath('${KA_DIR}/c.txt', { KA_DIR: '/d' })).toBe('/d/c.txt')
  expect(expandPath('~/c.txt')).toContain('/c.txt')
  expect(expandPath('/abs/path.txt')).toBe('/abs/path.txt')
})

test('jarStatus reports freshness, sources, keepalive state and jar checkup; missing jar surfaces exists:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-jar-'))
  const jar = join(dir, 'cookies.txt')
  const expiresSoon = Math.floor(Date.now() / 1000) + 3600
  writeFileSync(jar, `.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tpersist\n.youtube.com\tTRUE\t/\tTRUE\t${expiresSoon}\tVISITOR\tsoon\n`)
  const helper = fakeYtdlp(dir, 0)
  const { deps } = makeDeps()
  const service = new CookieKeepaliveService(
    [
      { kind: 'ytdlp', cookie_file: jar, url: 'https://www.youtube.com/@x', ytdlp_path: helper, sources: ['YouTube抓取'] },
      { kind: 'ytdlp', cookie_file: join(dir, 'gone.txt'), url: 'https://www.youtube.com/@y' },
    ],
    deps,
  )
  await service.runNow()
  const jars = service.jarStatus()
  expect(jars.length).toBe(2)
  expect(jars[0]).toMatchObject({ path: jar, exists: true, size: expect.any(Number), sources: ['YouTube抓取'] })
  expect(jars[0]!.age_seconds).toBeGreaterThanOrEqual(0)
  expect(jars[0]!.keepalive?.lastOk).toBe(true)
  // jar checkup merged into the view (2e)
  expect(jars[0]!.checkup?.cookies).toBe(2)
  expect(jars[0]!.checkup?.sessionCookies).toBe(1)
  expect(jars[0]!.checkup?.minRemainingSeconds).toBeLessThanOrEqual(3600)
  expect(jars[1]!.exists).toBe(false)
  expect(jars[1]!.keepalive?.lastError).toContain('missing or empty')
})
