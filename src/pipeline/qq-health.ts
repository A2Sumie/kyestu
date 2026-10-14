/**
 * QQ bridge health / circuit for the send path (FI-01 semantics: while the
 * bridge is down, sends are suppressed instead of piling up `failed` outbound
 * rows; when it recovers, queued articles resume automatically).
 *
 * State machine: `ok` ⇄ `down`. A failure class that means "the bridge or the
 * bot is not accepting sends right now" (transport errors, mute, risk control,
 * NapCat EventChecker refusal) opens the circuit with an escalating cooldown;
 * config-error classes (bad_request / unauthorized / …) never open it — they
 * fail the individual row and are fixed by an operator.
 *
 * Recovery is two-pronged:
 *  - passive: `gate()` starts allowing again once `openUntil` passes (the next
 *    send doubles as the probe),
 *  - active: `runProbe()` calls `get_status` (SnowLuma: `online` + `good`) and
 *    closes the circuit early on success / extends it on failure.
 *
 * Persistence follows the CooldownMap pattern (pipeline/service-state.ts):
 * memory is the runtime master copy, `qq-health:<scope>` is write-through on
 * state transitions and rehydrates at construction.
 */
import type { KyestuDb } from '../components/db'
import { ServiceStateStore } from './service-state'
import type { OneBotFailureClass, OneBotFailureKind } from './onebot-semantics'

export type QqHealthState = 'ok' | 'down'

export interface QqHealthSnapshot {
  state: QqHealthState
  /** absolute ms timestamp the circuit stays open until (0 = closed) */
  openUntil: number
  consecutiveFailures: number
  lastError: string | null
  lastFailureClass: OneBotFailureClass | null
  lastOkAt: number | null
  lastProbeAt: number | null
}

export interface QqHealthStore {
  load(): QqHealthSnapshot | null
  save(snapshot: QqHealthSnapshot): void
}

/** service_state adapter at `qq-health:<scope>` */
export function qqHealthStore(db: KyestuDb, scope: string): QqHealthStore {
  const kv = new ServiceStateStore(db)
  const key = `qq-health:${scope}`
  return {
    load(): QqHealthSnapshot | null {
      const raw = kv.get(key)
      if (!raw) return null
      try {
        const value = JSON.parse(raw) as QqHealthSnapshot
        if (!value || typeof value !== 'object' || typeof value.openUntil !== 'number') return null
        return value
      } catch {
        return null
      }
    },
    save(snapshot: QqHealthSnapshot): void {
      kv.set(key, JSON.stringify(snapshot))
    },
  }
}

/** failure classes that mean "stop sending for a while" */
const CIRCUIT_CLASSES: ReadonlySet<OneBotFailureClass> = new Set(['muted', 'risk_control', 'rate_limit', 'temporary'])
const CIRCUIT_KINDS: ReadonlySet<OneBotFailureKind> = new Set(['transport', 'internal', 'rejected'])

const BASE_COOLDOWN_MS = 30_000
const MAX_COOLDOWN_MS = 10 * 60 * 1000

export interface QqHealthOptions {
  store?: QqHealthStore
  now?: () => number
  baseCooldownMs?: number
  maxCooldownMs?: number
  probeIntervalMs?: number
}

export class QqHealthBoard {
  private snapshot: QqHealthSnapshot = {
    state: 'ok',
    openUntil: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastFailureClass: null,
    lastOkAt: null,
    lastProbeAt: null,
  }
  private readonly store?: QqHealthStore
  private readonly now: () => number
  private readonly baseCooldownMs: number
  private readonly maxCooldownMs: number
  private readonly probeIntervalMs: number

  constructor(options: QqHealthOptions = {}) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.baseCooldownMs = options.baseCooldownMs ?? BASE_COOLDOWN_MS
    this.maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS
    this.probeIntervalMs = options.probeIntervalMs ?? 30_000
    const restored = this.store?.load()
    if (restored && typeof restored === 'object') this.snapshot = { ...this.snapshot, ...restored }
  }

  snapshotOf(): QqHealthSnapshot {
    return { ...this.snapshot }
  }

  gate(): { allowed: true } | { allowed: false; until: number; reason: string; probeDue: boolean } {
    if (this.snapshot.state === 'ok' || this.snapshot.openUntil <= this.now()) {
      return { allowed: true }
    }
    return {
      allowed: false,
      until: this.snapshot.openUntil,
      reason: `qq target cooling down (${this.snapshot.lastFailureClass ?? 'unknown'}): ${this.snapshot.lastError ?? ''}`,
      probeDue: this.probeDue(),
    }
  }

  probeDue(): boolean {
    return this.snapshot.lastProbeAt === null || this.now() - this.snapshot.lastProbeAt >= this.probeIntervalMs
  }

  recordSuccess(): void {
    this.snapshot = {
      state: 'ok',
      openUntil: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastFailureClass: null,
      lastOkAt: this.now(),
      lastProbeAt: this.snapshot.lastProbeAt,
    }
    this.persist()
  }

  /** returns the circuit decision that was applied (for logging/tests) */
  recordFailure(
    kind: OneBotFailureKind,
    failureClass: OneBotFailureClass,
    message: string,
    opts: { cooldownMs?: number } = {},
  ): { opened: boolean; until: number } {
    const opens = CIRCUIT_CLASSES.has(failureClass) || CIRCUIT_KINDS.has(kind)
    const consecutive = this.snapshot.consecutiveFailures + 1
    const escalating = Math.min(this.baseCooldownMs * 2 ** Math.min(consecutive - 1, 6), this.maxCooldownMs)
    const cooldown = opens ? Math.max(opts.cooldownMs ?? 0, escalating) : 0
    const openUntil = opens ? this.now() + cooldown : this.snapshot.openUntil
    this.snapshot = {
      state: opens ? 'down' : this.snapshot.state,
      openUntil,
      consecutiveFailures: consecutive,
      lastError: message,
      lastFailureClass: failureClass,
      lastOkAt: this.snapshot.lastOkAt,
      lastProbeAt: this.snapshot.lastProbeAt,
    }
    this.persist()
    return { opened: opens, until: openUntil }
  }

  /**
   * Active recovery probe (`get_status`): healthy ⇒ close the circuit early,
   * unhealthy ⇒ extend it. Never throws — probe failures are themselves health
   * signals, and the gate keeps protecting the send path either way.
   */
  async runProbe(probe: () => Promise<{ online: boolean; good?: boolean }>): Promise<QqHealthSnapshot> {
    this.snapshot = { ...this.snapshot, lastProbeAt: this.now() }
    try {
      const status = await probe()
      if (status.online && status.good !== false) {
        this.recordSuccess()
      } else {
        this.recordFailure('internal', 'temporary', `get_status: online=${status.online} good=${status.good}`)
      }
    } catch (error) {
      this.recordFailure('transport', 'temporary', `get_status failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.snapshotOf()
  }

  private persist(): void {
    this.store?.save(this.snapshotOf())
  }
}
