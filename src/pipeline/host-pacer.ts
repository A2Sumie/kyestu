/**
 * Per-host minimum-interval pacer for out-of-band probe requests (e.g. the
 * TikTok live-page hydration probe). The crawl round's interval_time pacing
 * spaces targets inside one crawler, but it neither guarantees a floor for
 * probe-side requests nor coordinates across targets/crawlers hitting the
 * same host — the measured WAF threshold (sa7 §4: live-page hydration
 * <= 1 req / 8s on www.tiktok.com) is per-host, so the budget lives here.
 *
 * Style follows CooldownMap: small class, injectable clock/sleep for tests,
 * no persistence (a restart resetting the budget is acceptable — the first
 * request after boot is simply allowed).
 */

export class HostPacer {
  private readonly lastAt = new Map<string, number>()
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  /**
   * Wait until this caller's turn on `host`, then stamp the host's last-request
   * time. Callers are serialized per host (promise chain), so concurrent
   * probes queue up instead of racing the interval check.
   */
  waitTurn(host: string): Promise<void> {
    const tail = this.tails.get(host) ?? Promise.resolve()
    const turn = tail.then(async () => {
      const wait = this.minIntervalMs - (this.now() - (this.lastAt.get(host) ?? 0))
      if (wait > 0) await this.sleep(wait)
      this.lastAt.set(host, this.now())
    })
    // a faulted turn must not poison the queue for later callers
    this.tails.set(
      host,
      turn.catch(() => {}),
    )
    return turn
  }
}

/**
 * Process-wide pacer for TikTok live-page hydration probes (sa7 §4 measured
 * threshold: <= 1 req / 8s; faster bursts served the SlardarWAF challenge).
 * Module-level so every crawler instance shares the same per-host budget.
 */
export const tiktokLivePagePacer = new HostPacer(8_000)
