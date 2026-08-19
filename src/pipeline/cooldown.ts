/**
 * Crawl error classification + cooldowns, ported from idol-bbq spider-manager
 * (RISK_COOLDOWN_MS / escalation / IG overrides).
 */

export type CrawlErrorClass =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'transient'
  | 'parser'
  | 'unknown'
  | 'private_unfollowed'
  | 'invalid_handle'

const RISK_COOLDOWN_MS: Record<CrawlErrorClass, number> = {
  auth: 30 * 60 * 1000,
  rate_limit: 20 * 60 * 1000,
  timeout: 0,
  transient: 0,
  parser: 0,
  unknown: 0,
  private_unfollowed: 24 * 60 * 60 * 1000,
  invalid_handle: 24 * 60 * 60 * 1000,
}

const IG_OVERRIDES: Partial<Record<CrawlErrorClass, number>> = {
  timeout: 5 * 60 * 1000,
  rate_limit: 10 * 60 * 1000,
  auth: 6 * 60 * 60 * 1000,
}

const NO_RETRY: ReadonlySet<CrawlErrorClass> = new Set(['auth', 'rate_limit', 'parser', 'private_unfollowed', 'invalid_handle'])

export function classifyCrawlError(error: unknown): CrawlErrorClass {
  const code = (error as any)?.code as string | undefined
  if (code === 'instagram_private_unfollowed') return 'private_unfollowed'
  if (code === 'tiktok_invalid_handle') return 'invalid_handle'
  const message = error instanceof Error ? error.message : String(error)
  // Body-predicate session death (login_required / checkpoint_required /
  // two_factor_required with HTTP 200) — auth-class, no retry (intel §1.3).
  if (code === 'instagram_session_dead') return 'auth'
  if (/429|rate.?limit|too many requests/i.test(message)) return 'rate_limit'
  if (/login|auth|csrf|cookie|403|401/i.test(message)) return 'auth'
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/format may have changed|parse/i.test(message)) return 'parser'
  if (/network|econn|socket|fetch failed|502|503|504/i.test(message)) return 'transient'
  if (/instagram_session_dead/i.test(message)) return 'auth'
  return 'unknown'
}

/** extract a Retry-After hint the spider embedded in an error message (X 429s) */
export function retryAfterMillisFromMessage(message: string): number | null {
  const match = message.match(/\bretry_after=([^\s]+)/)
  if (!match) return null
  const value = match[1]
  if (!value || value === 'none') return null
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 24 * 60 * 60) return seconds * 1000
    return null
  }
  const timestamp = Date.parse(value.replace(/_/g, ' '))
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, timestamp - Date.now())
}

export function shouldRetry(klass: CrawlErrorClass, platform?: string): boolean {
  if (platform === 'instagram' && klass === 'timeout') return false
  return !NO_RETRY.has(klass)
}

export class CooldownMap {
  private entries = new Map<string, { expiresAt: number; classification: CrawlErrorClass }>()
  private escalations = new Map<string, number>()
  private lastMessage = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  check(key: string): { cooled: boolean; classification?: CrawlErrorClass; until?: number } {
    const entry = this.entries.get(key)
    if (!entry) return { cooled: false }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return { cooled: false }
    }
    return { cooled: true, classification: entry.classification, until: entry.expiresAt }
  }

  hit(key: string, classification: CrawlErrorClass, platform?: string, retryAfterMs?: number): number {
    let duration =
      retryAfterMs ??
      (platform === 'instagram' ? (IG_OVERRIDES[classification] ?? RISK_COOLDOWN_MS[classification]) : RISK_COOLDOWN_MS[classification])
    // rate-limit cooldowns apply even when the class has no base duration; a
    // Retry-After hint can only lengthen, never shorten, capped at 6h
    if (duration <= 0 && classification !== 'rate_limit') return 0
    if (classification === 'rate_limit' && retryAfterMs === undefined) {
      const hint = retryAfterMillisFromMessage(this.lastMessage.get(key) ?? '')
      if (hint !== null && hint > duration) duration = Math.min(hint, 6 * 60 * 60 * 1000)
    }
    if (duration <= 0) return 0
    const escalation = Math.min(this.escalations.get(key) ?? 0, 3)
    const total = Math.min(duration * 2 ** escalation, 6 * 60 * 60 * 1000)
    this.escalations.set(key, escalation + 1)
    this.entries.set(key, { expiresAt: this.now() + total, classification })
    return total
  }

  /** stash the last error message for this key so hit() can read Retry-After */
  recordMessage(key: string, message: string): void {
    this.lastMessage.set(key, message)
  }

  succeed(key: string): void {
    this.entries.delete(key)
    this.escalations.delete(key)
  }
}
