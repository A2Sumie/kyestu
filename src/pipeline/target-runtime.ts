import type { Context } from '../core/runtime'
import type { KyestuDb } from '../components/db'
import { ServiceStateStore, digestStateStore } from '../pipeline/service-state'
import type { MediaStore } from '../pipeline/media'
import { Aggregator, type AggregationConfig } from '../pipeline/aggregation'
import { MediaVisibility, applyTextPolicies, gateByAge, gateByKeywords, type TargetPolicyConfig } from '../pipeline/policies'
import { VideoPairings } from '../pipeline/pairing'
import { buildSummaryArticle, renderSummaryCard, type SummaryItem } from '../pipeline/summary-card'
import type { RenderedPayload, SendInput } from '../types/api'

/**
 * Shared target send path: policies -> aggregation routing -> raw send.
 * The raw send is supplied by each target component (QQ / Bilibili).
 */

export interface TargetRuntimeConfig extends TargetPolicyConfig {
  digest_threshold?: number
  summary_card?: AggregationConfig | boolean
}

/** `with` keys consumed by TargetRuntime (policies + aggregation); each target component lists its own superset */
export const TARGET_RUNTIME_KNOWN_WITH_KEYS = [
  'digest_threshold',
  'summary_card',
  'block_until',
  'blocked_keywords',
  'allowed_keywords',
  'replace_regex',
  'media_visibility',
]

export interface PersistedDigestItem {
  input: SendInput
  text: string
}

/**
 * Persistent backing for the digest buffer + first-sent window marks
 * (service_state, keys `digest:<target-entry-id>:buffer` /
 * `digest:<target-entry-id>:first-sent-windows`); memory stays the runtime
 * master copy.
 */
export interface DigestStateStore {
  loadBuffer(): PersistedDigestItem[]
  saveBuffer(items: PersistedDigestItem[]): void
  loadFirstSentWindows(): number[]
  saveFirstSentWindows(ids: number[]): void
}

export class TargetRuntime {
  private readonly aggregator: Aggregator
  private readonly visibility: MediaVisibility
  private readonly pairings: VideoPairings
  private readonly digestState: DigestStateStore
  private digestBuffer: PersistedDigestItem[] = []
  private firstSentWindows = new Set<number>()

  constructor(
    private readonly ctx: Context,
    private readonly db: KyestuDb,
    private readonly targetId: string,
    private readonly config: TargetRuntimeConfig,
    private readonly rawSend: (input: SendInput, text: string) => Promise<void>,
  ) {
    this.aggregator = new Aggregator(db)
    this.visibility = new MediaVisibility(db)
    this.pairings = new VideoPairings(db)
    // rehydrate after a fiber rebuild / process restart: the digest batch is
    // not lost and an already-sent "first" of an open aggregation window is
    // not sent immediately a second time (window ids are stable — ensureWindow
    // reopens the open window by idempotency key)
    this.digestState = digestStateStore(new ServiceStateStore(db), targetId)
    this.digestBuffer = this.digestState.loadBuffer()
    this.firstSentWindows = new Set(this.digestState.loadFirstSentWindows())
  }

  private summaryConfig(): AggregationConfig | null {
    const raw = this.config.summary_card
    if (raw === true) return { enabled: true }
    if (raw && typeof raw === 'object' && raw.enabled !== false) return raw
    return null
  }

  async send(input: SendInput): Promise<void> {
    const article = input.article as any
    let text = applyTextPolicies(input.rendered.text, this.config)
    if (!gateByKeywords(`${text}\n${article.content ?? ''}`, this.config)) return
    if (!gateByAge(article.created_at, this.config)) return

    // media visibility: repeated media go text-only or skip entirely; keyed by
    // content hash (CDN urls rotate around the same bytes)
    let rendered = input.rendered
    const visibilityCfg = this.config.media_visibility
    if (visibilityCfg && rendered.media.length) {
      const kept = []
      for (const media of rendered.media) {
        const verdict = this.visibility.check(this.targetId, media.content_hash ?? media.path, visibilityCfg)
        if (verdict === 'visible') kept.push(media)
      }
      const hiddenCount = rendered.media.length - kept.length
      if (kept.length === 0 && rendered.media.length > 0) {
        if (visibilityCfg.duplicate_behavior === 'skip') return
        rendered = { ...rendered, media: [] }
      } else {
        rendered = { ...rendered, media: kept }
      }
      // production appends [图已发过] when media is hidden in non-skip mode
      if (hiddenCount > 0 && visibilityCfg.duplicate_behavior !== 'skip') {
        text = `${text}\n\n[图已发过]`
      }
    }

    const summary = this.summaryConfig()
    if (summary) {
      const routeKey = `${input.route.crawler}|${input.route.formatter ?? '-'}|${input.route.target}`
      const windowId = this.aggregator.ensureWindow(this.targetId, routeKey, summary)
      if (summary.send_first_immediately !== false && !this.firstSentWindows.has(windowId)) {
        await this.rawSend({ ...input, rendered }, text)
        this.firstSentWindows.add(windowId)
        this.digestState.saveFirstSentWindows([...this.firstSentWindows])
        this.recordVisibility(rendered)
        return
      }
      this.aggregator.enqueue(
        this.targetId,
        routeKey,
        {
          key: `${article.platform}:${article.a_id}`,
          rowId: (article as any).id ?? 0,
          platform: article.platform,
          payload: {
            text,
            username: article.username ?? article.u_id,
            u_avatar: article.u_avatar ?? null,
            created_at: article.created_at,
            media: rendered.media,
          },
        },
        summary,
      )
      if (summary.flush_on_threshold !== false && this.aggregator.itemCount(windowId) >= (summary.threshold ?? 8)) {
        await this.flush(windowId)
      }
      return
    }

    const digestThreshold = this.config.digest_threshold ?? 0
    if (digestThreshold >= 2) {
      this.digestBuffer.push({ input: { ...input, rendered }, text })
      this.digestState.saveBuffer(this.digestBuffer)
      if (this.digestBuffer.length >= digestThreshold) {
        const batch = this.digestBuffer.splice(0, this.digestBuffer.length)
        this.digestState.saveBuffer(this.digestBuffer)
        const mergedText = batch.map((b) => b.text).filter(Boolean).join('\n———\n')
        const mergedMedia = batch.flatMap((b) => b.input.rendered.media)
        await this.rawSend({ ...batch[0]!.input, rendered: { text: mergedText, media: mergedMedia } }, mergedText)
        for (const b of batch) this.recordVisibility(b.input.rendered)
      }
      return
    }

    await this.rawSend({ ...input, rendered }, text)
    this.recordVisibility(rendered)
  }

  private recordVisibility(rendered: RenderedPayload): void {
    for (const media of rendered.media) this.visibility.record(this.targetId, media.content_hash ?? media.path, '')
  }

  /** flush one due window: batch as summary text; under threshold items go natively */
  async flush(windowId: number): Promise<void> {
    const items = this.aggregator.items(windowId)
    if (items.length === 0) {
      this.aggregator.close(windowId, 'dropped')
      return
    }
    const summary = this.summaryConfig()
    const threshold = summary?.threshold ?? 8
    if (items.length >= threshold) {
      // summary card: render the message_pack card with the shared template; fall
      // back to a text digest only when rendering is unavailable
      const summaryItems: SummaryItem[] = items.map((item) => ({
        text: item.payload?.text,
        username: item.payload?.username,
        u_avatar: item.payload?.u_avatar,
        created_at: item.payload?.created_at,
        platform: item.platform,
        media: item.payload?.media,
      }))
      const synthetic = buildSummaryArticle(summaryItems, { maxItemsPerGroup: summary?.max_items ?? 14 })
      const mediaStore = this.ctx.get<MediaStore>('media-store') ?? null
      const card = await renderSummaryCard(synthetic, mediaStore)
      if (card) {
        const { persistCard } = await import('../pipeline/summary-card-util')
        const text = String(synthetic.content)
        await this.rawSend(
          {
            article: { platform: items[0]!.platform, a_id: `summary-${windowId}` },
            rendered: { text, media: [{ path: await persistCard(card), type: 'photo' }] },
            route: { crawler: 'summary', formatter: null, target: this.targetId },
          },
          text,
        )
      } else {
        const lines = items.map((item, index) => `${index + 1}. ${item.payload?.text ?? item.article_key}`)
        const text = `📰 本窗口摘要（${items.length} 条）\n\n${lines.join('\n')}`
        await this.rawSend(
          {
            article: { platform: items[0]!.platform, a_id: `summary-${windowId}` },
            rendered: { text, media: [] },
            route: { crawler: 'summary', formatter: null, target: this.targetId },
          },
          text,
        )
      }
      this.aggregator.close(windowId, 'sent')
      return
    }
    // below threshold at due time: each item goes out natively with its original media
    for (const item of items) {
      const text = String(item.payload?.text ?? '')
      if (!text && !(item.payload?.media ?? []).length) continue
      await this.rawSend(
        {
          article: { platform: item.platform, a_id: item.article_key },
          rendered: { text, media: item.payload?.media ?? [] },
          route: { crawler: 'summary', formatter: null, target: this.targetId },
        },
        text,
      )
    }
    this.aggregator.close(windowId, 'sent')
  }

  /** periodic flush sweep; returns a dispose */
  startFlushLoop(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      try {
        this.pairings.sweepExpired()
      } catch (error) {
        this.ctx.root.reportTaint(this.ctx.fiber, 'apply', error)
      }
      for (const window of this.aggregator.due(this.targetId)) {
        this.flush(window.id).catch((error) => this.ctx.root.reportTaint(this.ctx.fiber, 'apply', error))
      }
    }, intervalMs)
    return () => clearInterval(timer)
  }
}
