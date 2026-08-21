import { spawn } from 'child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Component } from '../core/types'
import type { Bus } from './bus'
import type { KyestuDb } from './db'
import type { BrowserSessionPool, BrowserPageRequest } from './browser-pool'
import {
  SessionHealthBoard,
  backoffDelayMs,
  staggerDelayMs,
  DEFAULT_STAGGER_MAX_MS,
  type SessionHealthSnapshot,
} from '../pipeline/session-health'
import { ServiceStateStore, sessionHealthStore } from '../pipeline/service-state'
import { ExpiringLatch, checkupJar, type JarCheckup } from '../pipeline/jar-checkup'

/**
 * app/cookie-keepalive: session health guard.
 *
 * Cordis mapping (paper: "Cordis: ..." — see scratch report for the table):
 *
 * 1. Reactive coeffects (§3.2.2, Def 25/26; realized as fiber.inject +
 *    Root.notify, Table 2 rows "d : 𝔇Γ → fiber.inject" and
 *    "L-Leave refresh marking the fiber UNLOADING"):
 *    The component declares `inject: ['db', 'bus', 'browser']` (db backs the
 *    board's write-through persistence via service_state). While browser-pool
 *    is not ACTIVE the fiber stays INACTIVE — "a component whose dependency
 *    is unavailable stays inactive until it appears, without erroring"
 *    (§6.1 case study wording). A pool rebuild (config change) swaps the
 *    providing fiber; notify classifies the change as activating for this
 *    fiber and the lifecycle reloads it — with every timer recovered first
 *    by the accumulator (LIFO), so no timer leaks across reloads.
 *
 * 2. The health board is a coeffect value (Def 24; §3.3.1 "Σ subsumes all
 *    shared mutable states"): ctx.set('cookie-health', board) publishes the
 *    board with an operation set (guard/record/resume/snapshot); crawlers
 *    consume it through those operations only. Value-level changes do not
 *    trigger refresh (the runtime compares providers, not values — Table 2:
 *    target recomputed by refresh identifies a binding by its provider
 *    fiber), which is the desired granularity: health flips gate rounds via
 *    guard() and announce via the bus, instead of unloading consumers'
 *    timers (§6.1 per-location boundary: withdraw-all would be the wrong
 *    scope).
 *
 * 3. All acquisitions go through ctx.effect (§5.1.1; Table 2 "O-Insert,
 *    O-Retire ... ctx.use and the inverse of its callback"): every timer is
 *    created inside ctx.effect(() => {...}) so its inverse lands in the
 *    fiber's accumulator. No bare setInterval anywhere in this component.
 *
 * 4. System boundary (§6.1 acquisition vs emission): the profile directory
 *    and cookie jar are acquisitions inside the boundary (recoverable: tmp
 *    copy + atomic rename, backup kept); navigation/spawning are emissions
 *    crossing the boundary. Quarantine = *withholding the emission*: when
 *    the board blocks a key, browser jobs stop createPage/goto and ytdlp
 *    jobs stop spawning — only state queries remain.
 */

export interface YtdlpKeepaliveJob {
  name?: string
  kind: 'ytdlp'
  cookie_file: string
  url: string
  interval_seconds?: number
  ytdlp_path?: string
  extra_args?: string[]
  /** crawler names that consume this jar (informational, set by the importer) */
  sources?: string[]
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
  /** login probe (default true): detect logged-out pages after goto settle */
  expect_login?: boolean
  /** optional extra JS probe expression evaluated in the page; falsy = logged out */
  probe_js?: string
}

export type KeepaliveJob = YtdlpKeepaliveJob | BrowserKeepaliveJob

export interface CookieKeepaliveConfig {
  jobs?: KeepaliveJob[]
  /** consecutive failures before a key is quarantined (default 2) */
  broken_threshold?: number
  /** auto-lift quarantine after this many seconds; absent = manual resume only */
  resume_after_seconds?: number
  /** jar expiring warning threshold in seconds (default 7 days) */
  expiring_threshold_seconds?: number
  /** max first-round stagger in ms to avoid multi-job salvo (default 90s) */
  stagger_max_ms?: number
}

export interface KeepaliveJobState {
  name: string
  kind: string
  runs: number
  lastRunAt: number | null
  lastOk: boolean | null
  lastError: string | null
  /** consecutive failures driving the exponential backoff */
  consecutiveFailures: number
  /** next scheduled run (epoch ms) after backoff; visible for observability */
  nextRunAt: number | null
  /** session-health state of this job's key, merged into the state view */
  health: string | null
}

export interface CookieJarStatus {
  path: string
  exists: boolean
  size: number | null
  age_seconds: number | null
  sources: string[]
  keepalive: KeepaliveJobState | null
  /** jar checkup: cookie counts + minimum remaining lifetime (2e) */
  checkup: JarCheckup | null
}

const DEFAULT_INTERVAL_SECONDS = 6 * 3600
const DEFAULT_BROKEN_THRESHOLD = 2
const DEFAULT_EXPIRING_THRESHOLD_SECONDS = 7 * 24 * 3600

/** expand $VAR/${VAR} and leading ~ in configured paths */
export function expandPath(p: string, env: Record<string, string | undefined> = process.env): string {
  const expanded = p.replace(/\$(\w+)|\$\{(\w+)\}/g, (_, a, b) => env[a ?? b] ?? '')
  if (expanded === '~' || expanded.startsWith('~/')) return join(homedir(), expanded.slice(2))
  return expanded
}

function jobName(job: KeepaliveJob, index: number): string {
  return job.name ?? `${job.kind}:${'cookie_file' in job ? job.cookie_file : job.session_profile}#${index}`
}

/** the board key a job reports under: jar path for ytdlp, profile for browser */
export function jobKey(job: KeepaliveJob): string {
  return job.kind === 'ytdlp' ? expandPath(job.cookie_file) : job.session_profile
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

/**
 * Login probe, deliberately conservative (8-16 production lesson: a false
 * "logged out" on a healthy session caused pointless re-login risk).
 * Broken is declared ONLY on positive evidence: the page shows a login
 * entrypoint, or (if configured) probe_js explicitly returns falsy.
 * A page that merely fails to match the selector stays fresh — prefer
 * missing a logout over breaking a live session.
 */
export const LOGIN_PROBE_SELECTOR = 'a[href*="/accounts/login"], a[href*="login"]'

export interface ProbePage {
  goto(url: string, options?: unknown): Promise<unknown>
  evaluate(fn: string): Promise<unknown>
  close(): Promise<unknown>
}

export async function probeLoginState(
  page: ProbePage,
  options: { expectLogin: boolean; probeJs?: string },
): Promise<{ loggedOut: boolean; evidence: string | null }> {
  if (!options.expectLogin) return { loggedOut: false, evidence: null }
  try {
    // probe failure ≠ job failure: a broken evaluate degrades to "fresh"
    const matched = await page.evaluate(`(() => Boolean(document.querySelector(${JSON.stringify(LOGIN_PROBE_SELECTOR)})))()`)
    if (matched === true) return { loggedOut: true, evidence: `login entrypoint matched: ${LOGIN_PROBE_SELECTOR}` }
    if (options.probeJs) {
      const verdict = await page.evaluate(options.probeJs)
      if (!verdict) return { loggedOut: true, evidence: `probe_js falsy: ${options.probeJs}` }
    }
    return { loggedOut: false, evidence: null }
  } catch {
    return { loggedOut: false, evidence: null }
  }
}

export interface KeepaliveDeps {
  browser: Pick<BrowserSessionPool, 'createPage'> | null
  board: SessionHealthBoard
  bus: Bus | null
  staggerMaxMs?: number
  now?: () => number
  /** test seam: override Bun.sleep-style settle */
  sleep?: (ms: number) => Promise<void>
}

export class CookieKeepaliveService {
  private readonly states = new Map<string, KeepaliveJobState>()
  private readonly running = new Set<string>()
  private readonly expiringLatch: ExpiringLatch
  private readonly deps: KeepaliveDeps
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly jobs: KeepaliveJob[],
    deps: KeepaliveDeps,
    private readonly options: Pick<CookieKeepaliveConfig, 'expiring_threshold_seconds'> & object = {},
  ) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms))
    this.expiringLatch = new ExpiringLatch(options.expiring_threshold_seconds ?? DEFAULT_EXPIRING_THRESHOLD_SECONDS)
    jobs.forEach((job, index) => {
      const name = jobName(job, index)
      this.states.set(name, {
        name,
        kind: job.kind,
        runs: 0,
        lastRunAt: null,
        lastOk: null,
        lastError: null,
        consecutiveFailures: 0,
        nextRunAt: null,
        health: null,
      })
    })
  }

  status(): KeepaliveJobState[] {
    const snapshots = new Map(this.deps.board.snapshot().map((s) => [s.key, s]))
    return [...this.states.values()].map((state) => ({
      ...state,
      health: snapshots.get(jobKey(this.jobByName(state.name)))?.state ?? state.health,
    }))
  }

  private jobByName(name: string): KeepaliveJob {
    const job = this.jobs.find((job, index) => jobName(job, index) === name)
    if (!job) throw new Error(`unknown keepalive job: ${name}`)
    return job
  }

  /**
   * Observability counter for the scheduler loop: how many job timers are
   * armed right now. The fiber-owned effect increments/decrements it; a
   * cascade reload must return it to the armed count of the fresh
   * generation (and root.dispose() must leave it at zero — no leaked timer).
   */
  armedTimers = 0

  /** jar-level management view: freshness + consuming crawlers + keepalive state + checkup */
  jarStatus(): CookieJarStatus[] {
    const out: CookieJarStatus[] = []
    for (const [index, job] of this.jobs.entries()) {
      if (job.kind !== 'ytdlp') continue
      const path = expandPath(job.cookie_file)
      let exists = false
      let size: number | null = null
      let ageSeconds: number | null = null
      let checkup: JarCheckup | null = null
      try {
        const stat = statSync(path)
        exists = true
        size = stat.size
        ageSeconds = Math.max(0, Math.floor((this.now() - stat.mtimeMs) / 1000))
        checkup = checkupJar(path, readFileSync(path, 'utf8'), Math.floor(this.now() / 1000))
      } catch {
        // missing jar surfaces as exists: false
      }
      out.push({
        path,
        exists,
        size,
        age_seconds: ageSeconds,
        sources: job.sources ?? [],
        keepalive: this.status().find((s) => s.name === jobName(job, index)) ?? null,
        checkup,
      })
    }
    return out
  }

  /** merged state view for the api surface (2g) */
  overview(): { jobs: KeepaliveJobState[]; jars: CookieJarStatus[]; sessions: SessionHealthSnapshot[] } {
    return { jobs: this.status(), jars: this.jarStatus(), sessions: this.deps.board.snapshot() }
  }

  /** interval for the next run after backoff; exposed for the scheduler loop */
  nextDelayMs(job: KeepaliveJob, name: string): number {
    const base = (job.interval_seconds ?? DEFAULT_INTERVAL_SECONDS) * 1000
    const state = this.states.get(name)
    const backoff = backoffDelayMs(base, state?.consecutiveFailures ?? 0)
    return base + backoff
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
    const key = jobKey(job)

    // §6.1 withholding: quarantine blocks the emission (spawn/navigation);
    // state queries below still work, so observability survives.
    const verdict = this.deps.board.guard(key)
    if (verdict.blocked) {
      state.lastRunAt = this.now()
      state.lastOk = null
      state.lastError = `skipped: ${verdict.reason}`
      state.health = 'quarantined'
      return
    }

    this.running.add(name)
    state.runs += 1
    state.lastRunAt = this.now()
    try {
      if (job.kind === 'ytdlp') await this.runYtdlp(job, key)
      else await this.runBrowser(job, key)
      state.lastOk = true
      state.lastError = null
      state.consecutiveFailures = 0
      this.deps.board.record(key, true)
    } catch (error) {
      state.lastOk = false
      state.lastError = error instanceof Error ? error.message : String(error)
      state.consecutiveFailures += 1
      this.deps.board.record(key, false, error)
    } finally {
      this.running.delete(name)
      state.nextRunAt = this.now() + this.nextDelayMs(job, name)
    }
  }

  private emitSession(event: Parameters<Bus['emit']>[1] extends never ? never : import('./bus').SessionBusEvent): void {
    this.deps.bus?.emit('session', event)
  }

  private async runYtdlp(job: YtdlpKeepaliveJob, key: string): Promise<void> {
    const cookieFile = expandPath(job.cookie_file)
    if (!existsSync(cookieFile) || statSync(cookieFile).size === 0) {
      throw new Error(`cookie jar missing or empty: ${cookieFile}`)
    }
    const tmp = `${cookieFile}.tmp-keepalive-${process.pid}`
    copyFileSync(cookieFile, tmp)
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
      copyFileSync(cookieFile, `${cookieFile}.bak-keepalive`)
      renameSync(tmp, cookieFile)
      chmodSync(cookieFile, 0o600)
    } finally {
      rmSync(tmp, { force: true })
    }
    // post-rotation jar checkup (2e); one-shot expiring event per jar
    const checkup = checkupJar(cookieFile, readFileSync(cookieFile, 'utf8'), Math.floor(this.now() / 1000))
    if (this.expiringLatch.shouldFire(cookieFile, checkup)) {
      this.emitSession({
        kind: 'expiring',
        key: cookieFile,
        minRemainingSeconds: checkup.minRemainingSeconds,
        cookies: checkup.cookies,
      })
    }
  }

  private async runBrowser(job: BrowserKeepaliveJob, key: string): Promise<void> {
    if (!this.deps.browser) throw new Error('browser pool unavailable')
    const page = (await this.deps.browser.createPage({
      session_profile: job.session_profile,
      browser_mode: job.browser_mode as BrowserPageRequest['browser_mode'],
      device_profile: job.device_profile as BrowserPageRequest['device_profile'],
    })) as unknown as ProbePage
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.sleep(job.settle_ms ?? 5_000)
      const probe = await probeLoginState(page, {
        expectLogin: job.expect_login !== false,
        probeJs: job.probe_js,
      })
      if (probe.loggedOut) {
        // probe hit ≠ job exception: runJob's catch already feeds the board
        // (record(key, false, error)); here we only surface the soft failure
        throw new Error(`logged out: ${probe.evidence}`)
      }
    } finally {
      await page.close().catch(() => null)
    }
  }
}

export const cookieKeepaliveComponent: Component<CookieKeepaliveConfig> = {
  // §3.2.2 / Def 25: the declared coeffect specification d = {bus, browser}.
  // Satisfaction (Def 24 predicate σ ⊧ d) gates activation; notify (Def 26)
  // reloads this fiber when the browser provider fiber changes identity.
  inject: ['db', 'bus', 'browser'],
  apply: (ctx, config) => {
    const db = ctx.get<KyestuDb>('db')!
    const browser = ctx.get<BrowserSessionPool>('browser') ?? null
    const bus = ctx.get<Bus>('bus')!
    const jobs = config.jobs ?? []

    // §3.3.1: the board is a shared mutable state encoded as a coeffect
    // value; every transition is mirrored into the bus event channel (the
    // 8-17 lesson: state changes nobody sees are state changes nobody acts on)
    // and written through to service_state, so a quarantine survives fiber
    // rebuilds and process restarts — a dead session must STOP BEING TOUCHED
    // (8-16 lesson), including right after a restart. The constructor
    // rehydrates synchronously, before ctx.set publishes the board below.
    const board = new SessionHealthBoard({
      brokenThreshold: config.broken_threshold ?? DEFAULT_BROKEN_THRESHOLD,
      resumeAfterMs: config.resume_after_seconds ? config.resume_after_seconds * 1000 : 0,
      onTransition: (event) => bus.emit('session', { kind: 'transition', ...event }),
      store: sessionHealthStore(new ServiceStateStore(db)),
    })
    // ctx.set is itself an effect with an inverse (§5.1.2 Algorithm 2): the
    // board binding is withdrawn automatically when this fiber unloads, so
    // a pool reload never leaves a stale board bound at the key.
    // ctx.expose is a single-slot surface (Context.exposedValue): the service
    // facade below is the node-handle API (status/jarStatus/overview);
    // the board's paradigm-correct channel is the coeffect key itself
    // (consumers ctx.get('cookie-health') — Def 24), not the handle.
    ctx.set('cookie-health', board)

    const service = new CookieKeepaliveService(jobs, {
      browser,
      board,
      bus,
      staggerMaxMs: config.stagger_max_ms ?? DEFAULT_STAGGER_MAX_MS,
    })
    ctx.expose(service)

    // §5.1.1: every timer and subscription is a tracked acquisition with its
    // inverse in the accumulator; the fiber's unload path (Algorithm 5
    // L-Unload) runs them LIFO, so a pool-triggered reload cannot leak one.
    ctx.effect(() => {
      const timers = new Map<number, ReturnType<typeof setTimeout>>()
      const disarmed = new Set<number>() // job indices with no pending timer
      // ghost-guard: setTimeout callbacks can land after the inverse ran
      // (unref'd macrotask already dequeued); a disposed generation must
      // never arm a new timer nor touch the counter — this is what makes
      // armedTimers a trustworthy leak probe (it only counts live-generation
      // arms, so 0 after dispose proves no orphan re-armed itself)
      let disposed = false

      const arm = (job: KeepaliveJob, index: number, delayMs: number) => {
        if (timers.has(index)) return
        const name = jobName(job, index)
        const timer = setTimeout(() => {
          timers.delete(index)
          service.armedTimers -= 1
          if (disposed) return
          void service
            .runNow(name)
            .then(() => {
              if (disposed) return
              const state = service.status().find((s) => s.name === name)
              // quarantined: stop scheduling (§6.1 withholding — a dead
              // session must not be touched again, the 8-16 lesson: each
              // nav against a logged-out session only accrues risk score)
              if (state?.health === 'quarantined') {
                disarmed.add(index)
                return
              }
              arm(job, index, service.nextDelayMs(job, name))
            })
            .catch(() => {
              if (disposed) return
              arm(job, index, service.nextDelayMs(job, name))
            })
        }, Math.max(0, delayMs))
        timers.set(index, timer)
        service.armedTimers += 1
        disarmed.delete(index)
      }

      // first round: random stagger 0..staggerMax per job to avoid a salvo
      jobs.forEach((job, index) => arm(job, index, staggerDelayMs(config.stagger_max_ms ?? DEFAULT_STAGGER_MAX_MS)))

      // a quarantined job disarms itself; resume() (manual) is announced on
      // the bus session channel and re-arms immediately
      const offBus = bus.on('session', (event) => {
        if (event.kind !== 'transition' || event.to !== 'fresh') return
        for (const [index, job] of jobs.entries()) {
          if (!disarmed.has(index)) continue
          if (jobKey(job) !== event.key) continue
          arm(job, index, 0)
        }
      })

      // the 8-17 lesson made observable: escalation to broken/quarantined and
      // jar-expiring events must surface on the process log even before any
      // external alerting consumer exists (channel contract: docs/bus.md)
      const offLog = bus.on('session', (event) => {
        if (event.kind === 'transition') {
          const line = `[cookie-keepalive] session ${event.from} -> ${event.to}: ${event.key}${event.detail ? ` (${event.detail})` : ''}`
          if (event.to === 'broken' || event.to === 'quarantined') console.warn(line)
          else console.log(line)
        } else {
          const remaining = event.minRemainingSeconds === null ? 'unknown' : `${Math.floor(event.minRemainingSeconds / 3600)}h`
          console.warn(`[cookie-keepalive] session jar expiring: ${event.key} (${event.cookies} cookies, min remaining ${remaining})`)
        }
      })

      // auto-resume window: guard() is what lifts an expired quarantine
      // (maybeAutoResume); a slow ticker pings it so quarantined jobs with
      // resume_after_seconds come back without any external poke
      const resumeTicker = setInterval(() => {
        for (const [index, job] of jobs.entries()) {
          if (!disarmed.has(index)) continue
          if (!board.guard(jobKey(job)).blocked) arm(job, index, 0)
        }
      }, 15_000)

      return () => {
        disposed = true
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
        service.armedTimers = 0
        clearInterval(resumeTicker)
        offBus()
        offLog()
      }
    })
  },
}
