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
  if (/429|rate.?limit|too many requests/i.test(message)) return 'rate_limit'
  if (/login|auth|csrf|cookie|403|401/i.test(message)) return 'auth'
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/format may have changed|parse/i.test(message)) return 'parser'
  if (/network|econn|socket|fetch failed|502|503|504/i.test(message)) return 'transient'
  return 'unknown'
}

export function shouldRetry(klass: CrawlErrorClass, platform?: string): boolean {
  if (platform === 'instagram' && klass === 'timeout') return false
  return !NO_RETRY.has(klass)
}

export class CooldownMap {
  private entries = new Map<string, { expiresAt: number; classification: CrawlErrorClass }>()
  private escalations = new Map<string, number>()

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
    const base =
      retryAfterMs ??
      (platform === 'instagram' ? (IG_OVERRIDES[classification] ?? RISK_COOLDOWN_MS[classification]) : RISK_COOLDOWN_MS[classification])
    if (base <= 0) return 0
    const escalation = Math.min(this.escalations.get(key) ?? 0, 3)
    const duration = Math.min(base * 2 ** escalation, 6 * 60 * 60 * 1000)
    this.escalations.set(key, escalation + 1)
    this.entries.set(key, { expiresAt: this.now() + duration, classification })
    return duration
  }

  succeed(key: string): void {
    this.entries.delete(key)
    this.escalations.delete(key)
  }
}
