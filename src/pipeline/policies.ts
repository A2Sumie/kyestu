import type { KyestuDb } from '../components/db'

/**
 * Per-target media visibility dedup ("seen this media recently -> text_only or skip")
 * and age gating, keyword gating, and text replacement.
 * Semantics follow idol-bbq's media_visibility / block_rules / replace_regex.
 */

export type PolicyVerdict = 'send' | 'skip' | 'text_only'

export interface TargetPolicyConfig {
  block_until?: string | number
  blocked_keywords?: string[]
  allowed_keywords?: string[]
  replace_regex?: [string, string][]
  media_visibility?: {
    window_seconds?: number
    max_visible?: number
    duplicate_behavior?: 'skip' | 'text_only'
  }
}

export function parseDurationMs(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return value * 1000
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2] ?? 's'
  const scale = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000
  return amount * scale
}

export function applyTextPolicies(text: string, config: TargetPolicyConfig): string {
  let out = text
  for (const [pattern, replacement] of config.replace_regex ?? []) {
    out = out.replace(new RegExp(pattern, 'g'), replacement)
  }
  return out
}

export function gateByKeywords(text: string, config: TargetPolicyConfig): boolean {
  const haystack = text
  for (const keyword of config.blocked_keywords ?? []) {
    if (keyword && haystack.includes(keyword)) return false
  }
  const allowed = config.allowed_keywords ?? []
  if (allowed.length > 0 && !allowed.some((k) => haystack.includes(k))) return false
  return true
}

export function gateByAge(articleCreatedAt: number | undefined, config: TargetPolicyConfig, now = Date.now()): boolean {
  const windowMs = parseDurationMs(config.block_until)
  if (windowMs === null || !articleCreatedAt) return true
  return articleCreatedAt * 1000 >= now - windowMs
}

export class MediaVisibility {
  constructor(private readonly store: KyestuDb) {}

  private seenCount(targetId: string, hash: string, windowSeconds: number): number {
    const since = Math.floor(Date.now() / 1000) - windowSeconds
    const row = this.store.db
      .query('SELECT COUNT(*) AS c FROM media_hashes WHERE hash = ? AND platform = ? AND created_at >= ?')
      .get(hash, `target:${targetId}`, since) as { c: number }
    return Number(row.c)
  }

  /** decide for one media hash; records visibility when the verdict is send/text_only */
  check(targetId: string, hash: string, config: TargetPolicyConfig['media_visibility']): 'visible' | 'text_only' | 'skip' {
    if (!config) return 'visible'
    const windowSeconds = config.window_seconds ?? 24 * 3600
    const maxVisible = config.max_visible ?? 1
    const count = this.seenCount(targetId, hash, windowSeconds)
    if (count < maxVisible) return 'visible'
    return config.duplicate_behavior === 'skip' ? 'skip' : 'text_only'
  }

  record(targetId: string, hash: string, aId: string): void {
    this.store.db
      .query('INSERT INTO media_hashes (platform, hash, a_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`target:${targetId}`, hash, aId, Math.floor(Date.now() / 1000))
  }
}
