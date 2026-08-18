/**
 * Netscape cookie-jar checkup: cookie count + minimum remaining lifetime.
 *
 * Pure parsing (unit-testable without touching the network); the keepalive
 * component runs it after each ytdlp rotation and on activation, emitting a
 * one-shot `session` bus event when a jar first crosses the expiring
 * threshold. "One-shot" means: no repeat emission for the same jar until it
 * recovers above the threshold and dips below again — the 8-17 lesson was
 * that repeated unseen warnings are worse than one seen warning.
 */

export interface JarCheckup {
  path: string
  exists: boolean
  cookies: number
  /** smallest remaining lifetime among expiring cookies; null when all are session/permanent cookies */
  minRemainingSeconds: number | null
  /** cookies whose expiry is in the past (yt-dlp keeps them until rotation cleans up) */
  expired: number
  /** per-cookie expiry = 0 (session cookie, dies with the browser) */
  sessionCookies: number
  error?: string
}

export const DEFAULT_EXPIRING_THRESHOLD_SECONDS = 7 * 24 * 3600

/** One Netscape line: domain \t includeSubdomains \t path \t secure \t expiry \t name \t value (7 fields). */
export function parseNetscapeCookieLine(line: string): { name: string; expiresAtSeconds: number | null } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // #HttpOnly_ prefix: real cookie, not a comment (curl/yt-dlp convention) —
  // must be tested BEFORE the generic '#' comment skip
  const isHttpOnly = trimmed.startsWith('#HttpOnly_')
  if (!isHttpOnly && trimmed.startsWith('#')) return null
  const body = isHttpOnly ? trimmed.slice('#HttpOnly_'.length) : trimmed
  const fields = body.split('\t')
  if (fields.length < 7) return null
  const name = fields[5] ?? ''
  if (!name) return null
  const rawExpiry = Number(fields[4])
  // expiry 0 = session cookie (no deadline to observe)
  const expiresAtSeconds = Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : null
  return { name, expiresAtSeconds }
}

export function checkupJar(path: string, content: string, nowSeconds: number = Math.floor(Date.now() / 1000)): JarCheckup {
  const result: JarCheckup = {
    path,
    exists: content.length > 0,
    cookies: 0,
    minRemainingSeconds: null,
    expired: 0,
    sessionCookies: 0,
  }
  for (const line of content.split('\n')) {
    const cookie = parseNetscapeCookieLine(line)
    if (!cookie) continue
    result.cookies += 1
    if (cookie.expiresAtSeconds === null) {
      result.sessionCookies += 1
      continue
    }
    const remaining = cookie.expiresAtSeconds - nowSeconds
    if (remaining <= 0) {
      result.expired += 1
      // expired cookies still count toward the minimum (it is <= 0), but a
      // jar whose whole floor is expired reports 0, not a negative number
      result.minRemainingSeconds = result.minRemainingSeconds === null ? 0 : Math.min(result.minRemainingSeconds, 0)
      continue
    }
    result.minRemainingSeconds = result.minRemainingSeconds === null ? remaining : Math.min(result.minRemainingSeconds, remaining)
  }
  return result
}

/**
 * Pure latching predicate for the one-shot expiring event.
 * state tracks { jar -> armed }: armed means "below threshold, event already
 * sent"; re-arming happens only when the jar recovers above the threshold.
 */
export class ExpiringLatch {
  private readonly armed = new Set<string>()

  constructor(private readonly thresholdSeconds: number = DEFAULT_EXPIRING_THRESHOLD_SECONDS) {}

  get threshold(): number {
    return this.thresholdSeconds
  }

  /** returns true exactly once per below-threshold episode per jar */
  shouldFire(jarPath: string, checkup: JarCheckup): boolean {
    const below =
      checkup.exists &&
      checkup.cookies > 0 &&
      // null min = all session cookies: nothing observed to expire, stay quiet
      checkup.minRemainingSeconds !== null &&
      checkup.minRemainingSeconds < this.thresholdSeconds
    if (!below) {
      this.armed.delete(jarPath)
      return false
    }
    if (this.armed.has(jarPath)) return false
    this.armed.add(jarPath)
    return true
  }
}
