/**
 * Session health state machine shared by cookie-keepalive (the producer) and
 * crawlers (the consumers).
 *
 * Cordis mapping:
 * - The board is the coeffect value bound at key `cookie-health`; its public
 *   methods are the coeffect operations 𝒜ₖ of Def 24 (§3.2.1): consumers may
 *   only act on the board through these operations, never by reaching into
 *   its internals. Each operation is an endofunction on the hidden state
 *   (Eq. 22) — record()/resume() transition the state, guard()/snapshot()
 *   read outcomes.
 * - "Σ subsumes all shared mutable states, not just inter-component
 *   dependencies" (§3.3.1, Def 32): session health is exactly such a shared
 *   mutable state, so hosting it in the coeffect context is the paradigm-
 *   conforming move, not a hack.
 * - Values held at a key are compared up to ≃ₖ (Def 24 / Def 33, §3.3.2); the
 *   runtime compares only the *providing fiber* when deciding refresh (Table 2:
 *   target(γ,n) recomputed by refresh), so in-place mutations of the board do
 *   NOT reload consumers. This is a deliberate granularity choice: consumers
 *   gate through guard() at each round and hear about transitions through the
 *   bus, instead of tearing down their own timers on every health flip.
 *   Withdrawing the key to force a reactive deactivation (Def 26
 *   "deactivating") would unload the consumers' own effects (timers, relay
 *   capture) — the wrong granularity, cf. the per-location boundary argument
 *   of §6.1.
 *
 * Production lessons baked in (idol-bbq 8-16/8-17 IG incident):
 * - a dead session must STOP BEING TOUCHED: every 60s nav against a logged-out
 *   session only accrues platform risk score → quarantine withholds emission.
 * - state transitions must enter an event channel (cookie 409s went unnoticed
 *   for 2 days) → every transition emits on the bus.
 */

export type SessionHealthState = 'fresh' | 'suspect' | 'broken' | 'quarantined'

export interface GuardVerdict {
  blocked: boolean
  reason?: string
  untilMs?: number
}

export interface SessionHealthSnapshot {
  key: string
  state: SessionHealthState
  /** consecutive failures feeding the fresh→suspect→broken escalation */
  consecutiveFailures: number
  lastOkAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  quarantinedAt: number | null
  /** set when quarantine lifts itself after resume_after_seconds */
  autoResumeAt: number | null
  reason: string | null
}

export interface SessionHealthTransitionEvent {
  key: string
  from: SessionHealthState
  to: SessionHealthState
  detail?: string
}

export interface SessionHealthBoardOptions {
  /** consecutive failures required for fresh/suspect -> broken (default 2) */
  brokenThreshold?: number
  /** auto-lift quarantine after this many ms; 0/undefined = manual resume only */
  resumeAfterMs?: number
  now?: () => number
  /** transition sink (the bus emit in the component); kept injectable for tests */
  onTransition?: (event: SessionHealthTransitionEvent) => void
}

interface Slot {
  state: SessionHealthState
  consecutiveFailures: number
  lastOkAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  quarantinedAt: number | null
  autoResumeAt: number | null
  reason: string | null
}

/** broken enters quarantine immediately in the default policy (see below). */
function freshSlot(): Slot {
  return {
    state: 'fresh',
    consecutiveFailures: 0,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
    quarantinedAt: null,
    autoResumeAt: null,
    reason: null,
  }
}

/**
 * Escalation ladder: fresh -1 fail-> suspect -1 fail-> broken -> quarantined.
 * With brokenThreshold = 2 (default) the ladder is fresh -> suspect (first
 * failure) -> broken (second consecutive failure) -> quarantined.
 */
export function escalate(state: SessionHealthState, consecutiveFailures: number, threshold: number): SessionHealthState {
  if (consecutiveFailures >= threshold) return 'broken'
  if (consecutiveFailures >= 1) return state === 'fresh' ? 'suspect' : state
  return 'fresh'
}

/** keepalive self-backoff: interval × 2^n capped at 24h (pure, unit-testable). */
export const BACKOFF_CAP_MS = 24 * 3600 * 1000

export function backoffDelayMs(baseIntervalMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  const raw = baseIntervalMs * 2 ** Math.min(consecutiveFailures, 16)
  return Math.min(raw, BACKOFF_CAP_MS)
}

/** first-round stagger: uniform random in [0, maxMs) to avoid multi-job salvo. */
export function staggerDelayMs(maxMs: number, rand: () => number = Math.random): number {
  if (maxMs <= 0) return 0
  return Math.floor(rand() * maxMs)
}

export const DEFAULT_STAGGER_MAX_MS = 90_000

export class SessionHealthBoard {
  private readonly slots = new Map<string, Slot>()
  private readonly brokenThreshold: number
  private readonly resumeAfterMs: number
  private readonly now: () => number

  constructor(options: SessionHealthBoardOptions = {}) {
    this.brokenThreshold = Math.max(1, Math.trunc(options.brokenThreshold ?? 2))
    this.resumeAfterMs = Math.max(0, options.resumeAfterMs ?? 0)
    this.now = options.now ?? Date.now
    this.onTransition = options.onTransition
  }

  private readonly onTransition?: (event: SessionHealthTransitionEvent) => void

  private slot(key: string): Slot {
    let slot = this.slots.get(key)
    if (!slot) {
      slot = freshSlot()
      this.slots.set(key, slot)
    }
    return slot
  }

  private transition(slot: Slot, key: string, to: SessionHealthState, detail?: string): void {
    const from = slot.state
    if (from === to) return
    slot.state = to
    this.onTransition?.({ key, from, to, detail })
  }

  /**
   * Idempotent gate consulted before every round / keepalive job run.
   * §6.1 (acquisition vs emission): a blocked verdict means "withhold the
   * emission" (no navigation, no spawn) while the acquisition side (the
   * profile dir, the jar file) stays untouched and recoverable in-boundary.
   */
  guard(key: string): GuardVerdict {
    const slot = this.slot(key)
    this.maybeAutoResume(slot, key)
    if (slot.state === 'quarantined') {
      const verdict: GuardVerdict = {
        blocked: true,
        reason: slot.reason ?? 'session quarantined',
      }
      if (slot.autoResumeAt !== null) verdict.untilMs = slot.autoResumeAt
      return verdict
    }
    return { blocked: false }
  }

  /** consumer feedback: one auth-class failure or one success per round. */
  record(key: string, ok: boolean, error?: unknown): void {
    const slot = this.slot(key)
    if (ok) {
      slot.consecutiveFailures = 0
      slot.lastOkAt = this.now()
      slot.lastError = null
      // success is the strongest recovery signal: any degraded state heals
      this.transition(slot, key, 'fresh', 'consumer reported success')
      return
    }
    slot.consecutiveFailures += 1
    slot.lastFailureAt = this.now()
    slot.lastError = error instanceof Error ? error.message : error === undefined ? null : String(error)
    if (slot.state === 'quarantined') return // already at the floor
    const next = escalate(slot.state, slot.consecutiveFailures, this.brokenThreshold)
    if (next === 'broken') {
      this.transition(slot, key, 'broken', slot.lastError ?? undefined)
      this.quarantine(slot, key, slot.lastError ?? 'consecutive failures')
    } else if (next !== slot.state) {
      this.transition(slot, key, next, slot.lastError ?? undefined)
    }
  }

  /** manual lift of a quarantine (ops action); resets to fresh. */
  resume(key: string): void {
    const slot = this.slot(key)
    if (slot.state === 'quarantined') {
      slot.consecutiveFailures = 0
      slot.autoResumeAt = null
      slot.reason = null
      this.transition(slot, key, 'fresh', 'manual resume')
      return
    }
    // resume on a non-quarantined slot is an idempotent no-op reset
    slot.consecutiveFailures = 0
  }

  snapshot(): SessionHealthSnapshot[] {
    const out: SessionHealthSnapshot[] = []
    for (const [key, slot] of this.slots) {
      this.maybeAutoResume(slot, key)
      out.push({ key, ...slot })
    }
    return out
  }

  private quarantine(slot: Slot, key: string, reason: string): void {
    this.transition(slot, key, 'quarantined', reason)
    slot.quarantinedAt = this.now()
    slot.reason = reason
    slot.autoResumeAt = this.resumeAfterMs > 0 ? this.now() + this.resumeAfterMs : null
  }

  private maybeAutoResume(slot: Slot, key: string): void {
    if (slot.state !== 'quarantined' || slot.autoResumeAt === null) return
    if (this.now() < slot.autoResumeAt) return
    slot.consecutiveFailures = 0
    slot.autoResumeAt = null
    slot.reason = null
    this.transition(slot, key, 'fresh', 'auto resume window elapsed')
  }
}
