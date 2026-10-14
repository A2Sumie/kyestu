import type { Component } from '../core/types'
import type { KyestuDb } from './db'
import { statSync } from 'fs'
import { readFile } from 'fs/promises'
import { articleKey, outboundKey, OutboundStore } from '../pipeline/outbound'
import {
  OneBotClient,
  OneBotRetryLaterError,
  type OneBotMessageSegment,
} from './onebot'
import { classifyOneBotError } from '../pipeline/onebot-semantics'
import { classifyQqSendFailure, qqSendCooldownMs, qqSendRetryNow } from '../pipeline/cooldown'
import { buildSignedMediaUrl, decideMediaSource, type MediaSourceMode } from '../pipeline/onebot-media'
import { QqHealthBoard, qqHealthStore } from '../pipeline/qq-health'
import { TargetRuntime, TARGET_RUNTIME_KNOWN_WITH_KEYS } from '../pipeline/target-runtime'
import { NodeHandle, nodeKey } from '../loader/loader'
import type { QqTargetApi, SendInput, TargetApi } from '../types/api'

// canonical home of the target contract is types/api; re-exported here so
// existing import sites keep working
export type { SendInput, TargetApi, QqTargetApi } from '../types/api'

const CHUNK = 10
const SEND_ATTEMPTS_PER_CHUNK = 2

export interface QqTargetMediaConfig {
  /** media source policy (see pipeline/onebot-media.ts decision table) */
  mode?: MediaSourceMode
  /** externally reachable base URL for `cache_root`-relative media (URL source) */
  base_url?: string
  /** media root the URL maps to (defaults to the media store root) */
  root?: string
  /** HMAC secret for signed `/media/<name>?exp&sig` URLs (query-token auth) */
  secret?: string
  signed_ttl_s?: number
  inline_max_bytes?: number
  /** allow the legacy `file://` source (shared-filesystem coupling) */
  allow_file_fallback?: boolean
}

export const qqTargetComponent: Component<Record<string, any>> = {
  inject: ['onebot', 'db'],
  knownWithKeys: ['group_id', 'min_interval', 'onebot', 'media', 'health', ...TARGET_RUNTIME_KNOWN_WITH_KEYS],
  apply: (ctx, config) => {
    const db = ctx.get<KyestuDb>('db')!
    // multi-UIN: `onebot: <entry id>` addresses a secondary infra/onebot entry
    // via its node handle; the shared `onebot` coeffect key is the default
    const client =
      (typeof config.onebot === 'string'
        ? ctx.get<NodeHandle>(nodeKey(config.onebot))?.api<OneBotClient>()
        : undefined) ?? ctx.get<OneBotClient>('onebot')!
    const outbound = new OutboundStore(db)
    const groupId = config.group_id
    const minInterval = Number(config.min_interval ?? 1000)
    const mediaCfg: QqTargetMediaConfig = (config.media ?? {}) as QqTargetMediaConfig
    const healthCfg = (config.health ?? {}) as { probe_interval_ms?: number; base_cooldown_ms?: number; max_cooldown_ms?: number }
    const health = new QqHealthBoard({
      store: qqHealthStore(db, String(config.__id)),
      probeIntervalMs: Number(healthCfg.probe_interval_ms ?? 30_000),
      baseCooldownMs: Number(healthCfg.base_cooldown_ms ?? 30_000),
      maxCooldownMs: Number(healthCfg.max_cooldown_ms ?? 10 * 60 * 1000),
    })
    let lastSentAt = 0

    /** gate → claim → build → send; message_ids land on the outbound row */
    const rawSend = async (input: SendInput, text: string): Promise<void> => {
      // health gate BEFORE the claim: while the bridge/bot is down or muted,
      // sends are suppressed instead of piling up `failed` outbound rows
      // (FI-01/FI-02). Active recovery probe closes the circuit early.
      let gate = health.gate()
      if (!gate.allowed && gate.probeDue) {
        await health.runProbe(async () => {
          const status: any = await client.getStatus()
          return { online: status?.online !== false, good: status?.good !== false }
        })
        gate = health.gate()
      }
      if (!gate.allowed) throw new OneBotRetryLaterError(gate.reason)

      const aKey = articleKey(input.article.platform as any, input.article.a_id)
      const key = outboundKey({
        crawler: input.route.crawler,
        formatter: input.route.formatter,
        target: String(input.route.target),
        article: aKey,
      })
      const { id, duplicate } = outbound.claim(
        key,
        { text, media: input.rendered.media.map((m) => m.path) },
        { route_key: key, target_id: String(input.route.target), task_kind: 'article', article_key: aKey },
      )
      if (duplicate === 'sent' || duplicate === 'exhausted') return
      // another claim owns this row (crashed-mid-send window): re-drive later
      if (duplicate === 'in_progress') throw new OneBotRetryLaterError(`outbound claim in progress for ${key}`)

      const messageIds: Array<number | string> = []
      try {
        const segments = await buildSegments(client, input, mediaCfg, text)
        if (segments.length === 0) {
          outbound.mark(id, 'skipped', 'empty payload')
          return
        }

        for (let i = 0; i < segments.length; i += CHUNK) {
          const chunk = segments.slice(i, i + CHUNK)
          const wait = minInterval - (Date.now() - lastSentAt)
          if (wait > 0) await Bun.sleep(wait)
          let lastError: unknown
          for (let attempt = 0; attempt < SEND_ATTEMPTS_PER_CHUNK; attempt++) {
            try {
              // destination override (inbound reactions reply into the event's
              // scope); default stays the configured group_id
              const dest = input.dest ?? { kind: 'group' as const, id: groupId }
              const res: any = await (dest.kind === 'private'
                ? client.sendPrivateMsg(dest.id, chunk)
                : client.sendGroupMsg(dest.id, chunk))
              const messageId = res?.message_id ?? (Array.isArray(res) ? res[0]?.message_id : undefined)
              if (messageId !== undefined && messageId !== null) messageIds.push(messageId)
              lastError = null
              break
            } catch (error) {
              lastError = error
              // retry only classes where the identical payload may succeed now;
              // everything else goes through the classified failure path
              const failure = classifyOneBotError(error)
              if (!qqSendRetryNow(classifyQqSendFailure(failure))) break
            }
          }
          if (lastError) throw lastError
          lastSentAt = Date.now()
        }
        outbound.mark(id, 'sent', undefined, messageIds.length ? { messageIds } : undefined)
        health.recordSuccess()
      } catch (error) {
        const failure = classifyOneBotError(error)
        const klass = classifyQqSendFailure(failure)
        const message = error instanceof Error ? error.message : String(error)
        health.recordFailure(failure.kind, failure.failureClass, message, { cooldownMs: qqSendCooldownMs(klass) })
        // some chunks already went out: 'partial' is terminal for re-driving
        // (re-sending would duplicate visible content)
        outbound.mark(id, messageIds.length ? 'partial' : 'failed', message, messageIds.length ? { messageIds } : undefined)
        throw error
      }
    }

    const runtime = new TargetRuntime(ctx, db, String(config.__id), config, rawSend)
    ctx.effect(() => runtime.startFlushLoop())
    ctx.expose({
      send: async (input: SendInput) => {
        await runtime.send(input)
        outbound.markForwarded(input.article.platform as any, input.article.a_id, String(input.route.target))
      },
      recall: async (messageIds: Array<number | string>) => {
        const recalled: Array<number | string> = []
        const failed: Array<{ message_id: number | string; error: string }> = []
        for (const messageId of messageIds) {
          try {
            await client.deleteMsg(messageId)
            recalled.push(messageId)
          } catch (error) {
            failed.push({ message_id: messageId, error: error instanceof Error ? error.message : String(error) })
          }
        }
        return { recalled, failed }
      },
      verifyReceipts: async (outboundId: number) => {
        const row = outbound.get(outboundId)
        const results: Array<{ message_id: number | string; found: boolean; error?: string }> = []
        for (const messageId of row?.messageIds ?? []) {
          try {
            await client.getMsg(messageId)
            results.push({ message_id: messageId, found: true })
          } catch (error) {
            results.push({ message_id: messageId, found: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (row) outbound.mark(row.id, row.status, row.lastError ?? undefined, { messageIds: row.messageIds, segmentResults: { receipts: results } })
        return results
      },
      health: () => health.snapshotOf(),
      noteBridgeEvent: (kind: 'offline' | 'online', detail?: string) => {
        // inbound signal (SnowLuma bot_offline notice / account notifications):
        // an offline bot means "defer sends", the same verdict the health board
        // derives from a failing bridge; `online` closes the circuit early
        if (kind === 'offline') {
          health.recordFailure('internal', 'temporary', detail ?? 'bot offline (inbound event)')
        } else {
          health.recordSuccess()
        }
      },
    } satisfies QqTargetApi)
  },
}

/** build one outbound chunk's segments; media sources are capability-adaptive */
async function buildSegments(
  client: OneBotClient,
  input: SendInput,
  mediaCfg: QqTargetMediaConfig,
  text: string,
): Promise<OneBotMessageSegment[]> {
  const segments: OneBotMessageSegment[] = []
  // quote-reply anchor first: SnowLuma attaches the cached original text as a
  // QQ quote preview; NapCat renders the bare quote
  if (input.reply !== undefined) segments.push({ type: 'reply', data: { message_id: input.reply.message_id } })
  if (text) segments.push({ type: 'text', data: { text } })
  const capabilities = await client.capabilities()
  for (const media of input.rendered.media) {
    const size = (() => {
      try {
        return statSync(media.path).size
      } catch {
        return 0
      }
    })()
    const decision = decideMediaSource({
      path: media.path,
      size,
      type: media.type === 'video' ? 'video' : 'photo',
      dialect: capabilities.dialect,
      mode: mediaCfg.mode,
      urlBase: mediaCfg.base_url,
      mediaRoot: mediaCfg.root,
      inlineMaxBytes: mediaCfg.inline_max_bytes ? Number(mediaCfg.inline_max_bytes) : undefined,
      allowFileFallback: mediaCfg.allow_file_fallback,
      streamCapable: capabilities.streamUpload,
    })
    let fileValue = decision.value
    if (decision.kind === 'inline') {
      fileValue = `base64://${(await readFile(media.path)).toString('base64')}`
    } else if (decision.kind === 'stream') {
      const uploaded = await client.uploadFileStream(media.path, {
        filename: media.path.split('/').pop() ?? 'file.bin',
      })
      fileValue = uploaded.file_path
    } else if (decision.kind === 'url' && mediaCfg.secret && decision.name) {
      fileValue = buildSignedMediaUrl(mediaCfg.base_url!, decision.name, mediaCfg.secret, Number(mediaCfg.signed_ttl_s ?? 600))
    }
    segments.push({ type: media.type === 'video' ? 'video' : 'image', data: { file: fileValue } })
  }
  return segments
}
