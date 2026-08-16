/**
 * Tag-storm digest (detection logic only — deliberately NOT wired into the
 * send path yet): when >= threshold distinct authors post the same hashtag
 * inside the detection window, the target enters digest mode for the digest
 * window; matching articles during digest mode are merged.
 */

export interface TagDigestConfig {
  tag_digest_threshold?: number
  tag_digest_detection_window_seconds?: number
  tag_digest_window_seconds?: number
  tag_digest_min_authors?: number
}

interface TagEvent {
  tag: string
  author: string
  at: number
}

export class TagStormDetector {
  private events: TagEvent[] = []
  private digestUntil = new Map<string, number>()

  constructor(
    private readonly config: Required<TagDigestConfig>,
    private readonly now: () => number = Date.now,
  ) {}

  static from(config: TagDigestConfig, now?: () => number): TagStormDetector | null {
    const threshold = config.tag_digest_threshold ?? 0
    if (threshold < 2) return null
    return new TagStormDetector(
      {
        tag_digest_threshold: threshold,
        tag_digest_detection_window_seconds: config.tag_digest_detection_window_seconds ?? 600,
        tag_digest_window_seconds: config.tag_digest_window_seconds ?? 3600,
        tag_digest_min_authors: config.tag_digest_min_authors ?? 2,
      },
      now,
    )
  }

  private prune(): void {
    const cutoff = this.now() - this.config.tag_digest_detection_window_seconds * 1000
    this.events = this.events.filter((e) => e.at >= cutoff)
    for (const [tag, until] of this.digestUntil) {
      if (until <= this.now()) this.digestUntil.delete(tag)
    }
  }

  /** record an article's tags; returns the tags currently in digest mode */
  observe(tags: string[], author: string): string[] {
    this.prune()
    const active: string[] = []
    for (const tag of tags) {
      if ((this.digestUntil.get(tag) ?? 0) > this.now()) {
        active.push(tag)
        continue
      }
      this.events.push({ tag, author, at: this.now() })
      const recent = this.events.filter((e) => e.tag === tag)
      const authors = new Set(recent.map((e) => e.author))
      if (recent.length >= this.config.tag_digest_threshold && authors.size >= this.config.tag_digest_min_authors) {
        this.digestUntil.set(tag, this.now() + this.config.tag_digest_window_seconds * 1000)
        this.events = this.events.filter((e) => e.tag !== tag)
        active.push(tag)
      }
    }
    return active
  }

  inDigest(tag: string): boolean {
    this.prune()
    return (this.digestUntil.get(tag) ?? 0) > this.now()
  }
}

export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return []
  const matches = text.match(/#[^\s#]+/g) ?? []
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))]
}
