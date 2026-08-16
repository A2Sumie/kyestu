import { spawn } from 'child_process'
import { chmodSync, copyFileSync, existsSync, renameSync, rmSync, statSync } from 'fs'
import type { Component } from '../core/types'
import { BrowserSessionPool, type BrowserPageRequest } from './browser-pool'

/**
 * app/cookie-keepalive: in-runtime cookie/session freshness, replacing the
 * external ops cron (tools/youtube-cookie-keepalive.sh). Two job kinds:
 * - ytdlp: refresh a Netscape cookie jar via yt-dlp --simulate, rotating the
 *   jar atomically only on success (jar.bak-keepalive kept, like the script)
 * - browser: warm a persistent browser session (X/IG/TikTok) so platform
 *   cookies/localStorage stay fresh between crawls and trips less risk control
 */

export interface YtdlpKeepaliveJob {
  name?: string
  kind: 'ytdlp'
  cookie_file: string
  url: string
  interval_seconds?: number
  ytdlp_path?: string
  extra_args?: string[]
}

export interface BrowserKeepaliveJob {
  name?: string
  kind: 'browser'
  session_profile: string
  url: string
  interval_seconds?: number
  browser_mode?: string
  device_profile?: string
  settle_ms?: number
}

export type KeepaliveJob = YtdlpKeepaliveJob | BrowserKeepaliveJob

export interface CookieKeepaliveConfig {
  jobs?: KeepaliveJob[]
}

export interface KeepaliveJobState {
  name: string
  kind: string
  runs: number
  lastRunAt: number | null
  lastOk: boolean | null
  lastError: string | null
}

const DEFAULT_INTERVAL_SECONDS = 6 * 3600

function jobName(job: KeepaliveJob, index: number): string {
  return job.name ?? `${job.kind}:${'cookie_file' in job ? job.cookie_file : job.session_profile}#${index}`
}

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-500)}`))
    })
  })
}

export class CookieKeepaliveService {
  private readonly states = new Map<string, KeepaliveJobState>()
  private readonly running = new Set<string>()

  constructor(
    private readonly jobs: KeepaliveJob[],
    private readonly browser: BrowserSessionPool | null,
  ) {
    jobs.forEach((job, index) => {
      const name = jobName(job, index)
      this.states.set(name, { name, kind: job.kind, runs: 0, lastRunAt: null, lastOk: null, lastError: null })
    })
  }

  status(): KeepaliveJobState[] {
    return [...this.states.values()]
  }

  async runNow(name?: string): Promise<KeepaliveJobState[]> {
    for (const [index, job] of this.jobs.entries()) {
      const n = jobName(job, index)
      if (name && n !== name) continue
      await this.runJob(job, n)
    }
    return this.status()
  }

  private async runJob(job: KeepaliveJob, name: string): Promise<void> {
    if (this.running.has(name)) return
    const state = this.states.get(name)!
    this.running.add(name)
    state.runs += 1
    state.lastRunAt = Date.now()
    try {
      if (job.kind === 'ytdlp') await this.runYtdlp(job)
      else await this.runBrowser(job)
      state.lastOk = true
      state.lastError = null
    } catch (error) {
      state.lastOk = false
      state.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      this.running.delete(name)
    }
  }

  private async runYtdlp(job: YtdlpKeepaliveJob): Promise<void> {
    if (!existsSync(job.cookie_file) || statSync(job.cookie_file).size === 0) {
      throw new Error(`cookie jar missing or empty: ${job.cookie_file}`)
    }
    const tmp = `${job.cookie_file}.tmp-keepalive-${process.pid}`
    copyFileSync(job.cookie_file, tmp)
    chmodSync(tmp, 0o600)
    try {
      await exec(job.ytdlp_path ?? 'yt-dlp', [
        '--cookies',
        tmp,
        '--simulate',
        '--playlist-items',
        '1',
        '--print',
        '%(id)s',
        ...(job.extra_args ?? []),
        job.url,
      ])
      copyFileSync(job.cookie_file, `${job.cookie_file}.bak-keepalive`)
      renameSync(tmp, job.cookie_file)
      chmodSync(job.cookie_file, 0o600)
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  private async runBrowser(job: BrowserKeepaliveJob): Promise<void> {
    if (!this.browser) throw new Error('browser pool unavailable')
    const page = await this.browser.createPage({
      session_profile: job.session_profile,
      browser_mode: job.browser_mode as BrowserPageRequest['browser_mode'],
      device_profile: job.device_profile as BrowserPageRequest['device_profile'],
    })
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await Bun.sleep(job.settle_ms ?? 5_000)
    } finally {
      await page.close().catch(() => null)
    }
  }
}

export const cookieKeepaliveComponent: Component<CookieKeepaliveConfig> = {
  apply: (ctx, config) => {
    const browser = ctx.get<BrowserSessionPool>('browser') ?? null
    const jobs = config.jobs ?? []
    const service = new CookieKeepaliveService(jobs, browser)
    ctx.expose(service)
    const timers = jobs.map((job, index) => {
      const intervalMs = (job.interval_seconds ?? DEFAULT_INTERVAL_SECONDS) * 1000
      const name = jobName(job, index)
      return setInterval(() => {
        void service.runNow(name).catch(() => null)
      }, intervalMs)
    })
    return () => {
      for (const timer of timers) clearInterval(timer)
    }
  },
}
