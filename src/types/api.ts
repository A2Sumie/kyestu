/**
 * Cross-boundary API contracts: the shape a component exposes via
 * `ctx.expose()` and consumers read back through `NodeHandle.api<T>()`.
 *
 * Type-only module (zero runtime). Both the defining component and every
 * consumer import from here, so a signature drift is a tsc error at the
 * definition site instead of a runtime surprise at the consumer (review
 * §5.2-1: previously each consumer re-declared the interface and `as T`
 * cast, with only a single-end `satisfies` as a safety net).
 */

/** a downloaded media file in a rendered payload */
export interface RenderedMedia {
  path: string
  type: 'photo' | 'video'
  content_hash?: string
}

/** formatter output: text plus downloaded media files */
export interface RenderedPayload {
  text: string
  media: RenderedMedia[]
}

/** formatter/* service contract */
export interface FormatterApi {
  renderType: string
  render: (article: any) => Promise<RenderedPayload>
}

/** router -> target dispatch input */
export interface SendInput {
  article: {
    platform: string
    a_id: string
    id?: number
    u_id?: string
    created_at?: number
    content?: string | null
    translation?: string | null
    extra?: unknown
  }
  rendered: RenderedPayload
  route: { crawler: string; formatter?: string | null; target: string }
}

/** target/* service contract */
export interface TargetApi {
  send: (input: SendInput) => Promise<void>
}

/** optional per-call context for processor/* (crawler post_processors) */
export interface ProcessContext {
  sourceRef?: string
  minConfidence?: number
}

/** processor/* service contract */
export interface ProcessorApi {
  process: (text: string, context?: ProcessContext) => Promise<string>
}
