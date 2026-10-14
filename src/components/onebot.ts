import type { Component } from '../core/types'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import {
  classifyOneBotError,
  classifyOneBotResponse,
  detectDialect,
  type OneBotDialect,
  type OneBotVerdict,
} from '../pipeline/onebot-semantics'

/**
 * OneBot v11 HTTP client, dual-dialect: NapCat (legacy) and SnowLuma.
 * Response semantics live in pipeline/onebot-semantics.ts (pure, testable);
 * this class only transports and throws classified errors.
 */

export interface OneBotMessageSegment {
  type: string
  data: Record<string, unknown>
}

export interface OneBotCapabilities {
  dialect: OneBotDialect
  /** `get_msg` / `get_*_msg_history` message-store */
  messageStore: boolean
  /** media segments may carry http(s) URLs (bridge downloads) */
  urlMedia: boolean
  /** media segments may carry `base64://` / `data:` inline bytes */
  inlineMedia: boolean
  /** `upload_file_stream` chunked upload available */
  streamUpload: boolean
}

/**
 * A classified non-retryable-now failure. `redrivable === false` means the
 * identical request can never succeed (fix config/params); `redrivable ===
 * true` means the payload is refused *right now* (mute, risk control, NapCat
 * EventChecker) and the article may be re-driven later.
 */
export class OneBotNonRetryableError extends Error {
  readonly verdict: OneBotVerdict
  constructor(message: string, verdict?: OneBotVerdict) {
    super(message)
    this.name = 'OneBotNonRetryableError'
    this.verdict = verdict ?? { ok: false, kind: 'rejected', failureClass: 'other', retryable: false, redrivable: true, retcode: null, status: null, wording: message, dialectHint: null }
  }
  get redrivable(): boolean {
    return this.verdict.ok === false ? this.verdict.redrivable : true
  }
}

/** classified retryable failure (transport / business / internal …) */
export class OneBotError extends Error {
  readonly verdict: OneBotVerdict
  constructor(message: string, verdict: OneBotVerdict) {
    super(message)
    this.name = 'OneBotError'
    this.verdict = verdict
  }
  get redrivable(): boolean {
    return this.verdict.ok === false ? this.verdict.redrivable : true
  }
}

/**
 * The send is momentarily owned by another claim (crashed-mid-send window, or
 * an exhausted row being observed): re-drive later without consuming a retry
 * budget. Router honours `retryLater` by deferring the article.
 */
export class OneBotRetryLaterError extends Error {
  readonly retryLater = true
  readonly redrivable = true
}

export interface OneBotClientConfig {
  http_url: string
  access_token?: string
  timeout_ms?: number
  /** bridge dialect override; 'auto' probes `get_version_info` on first use */
  dialect?: 'auto' | OneBotDialect
  /** `upload_file_stream` chunk payload cap (raw bytes per request) */
  upload_chunk_bytes?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_UPLOAD_CHUNK_BYTES = 512 * 1024

export class OneBotClient {
  private readonly url: string
  private readonly token?: string
  private readonly timeoutMs: number
  private readonly uploadChunkBytes: number
  private forcedDialect: OneBotDialect | null
  private cachedCapabilities: OneBotCapabilities | null = null

  constructor(config: OneBotClientConfig) {
    this.url = config.http_url.replace(/\/+$/, '')
    this.token = config.access_token
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS
    this.uploadChunkBytes = config.upload_chunk_bytes ?? DEFAULT_UPLOAD_CHUNK_BYTES
    this.forcedDialect = config.dialect && config.dialect !== 'auto' ? config.dialect : null
    if (this.forcedDialect) {
      this.cachedCapabilities = capabilitiesFor(this.forcedDialect)
    }
  }

  async sendPrivateMsg(userId: number | string, message: OneBotMessageSegment[] | string) {
    return this.call('send_private_msg', { user_id: userId, message })
  }

  async sendGroupMsg(groupId: number | string, message: OneBotMessageSegment[] | string) {
    return this.call('send_group_msg', { group_id: groupId, message })
  }

  async sendPrivateForwardMsg(userId: number | string, nodes: OneBotMessageSegment[]) {
    return this.call('send_private_forward_msg', { user_id: userId, messages: nodes })
  }

  async sendGroupForwardMsg(groupId: number | string, nodes: OneBotMessageSegment[]) {
    return this.call('send_group_forward_msg', { group_id: groupId, messages: nodes })
  }

  async getGroupMemberList(groupId: number | string) {
    return this.call('get_group_member_list', { group_id: groupId })
  }

  // ── message-store (SnowLuma; NapCat has get_msg/delete_msg too) ───────────

  async getMsg(messageId: number | string) {
    return this.call('get_msg', { message_id: messageId })
  }

  async deleteMsg(messageId: number | string) {
    return this.call('delete_msg', { message_id: messageId })
  }

  async getGroupMsgHistory(groupId: number | string, messageId = 0, count = 20, reverseOrder = true) {
    return this.call('get_group_msg_history', { group_id: groupId, message_id: messageId, count, reverse_order: reverseOrder })
  }

  async getFriendMsgHistory(userId: number | string, messageId = 0, count = 20, reverseOrder = true) {
    return this.call('get_friend_msg_history', { user_id: userId, message_id: messageId, count, reverse_order: reverseOrder })
  }

  // ── health / identity ────────────────────────────────────────────────────

  async getStatus() {
    return this.call('get_status', {})
  }

  async getVersionInfo() {
    return this.call('get_version_info', {})
  }

  async getLoginInfo() {
    return this.call('get_login_info', {})
  }

  // ── stream upload (NapCat Stream API wire, SnowLuma compatible) ──────────

  /**
   * Chunked upload to the bot's local disk (`upload_file_stream`), returning
   * the bot-local path to feed a media segment. Removes the shared-filesystem
   * assumption of `file://` sends for arbitrarily large files.
   */
  async uploadFileStream(
    filePath: string,
    opts: { filename?: string; fileRetentionMs?: number } = {},
  ): Promise<{ file_path: string; file_name: string; file_size: number; sha256: string }> {
    const bytes = await readFile(filePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const streamId = `kyestu_${createHash('sha256').update(`${filePath}:${bytes.length}:${sha256}`).digest('hex').slice(0, 24)}`
    const filename = opts.filename ?? filePath.split('/').pop() ?? 'file.bin'
    const chunkSize = this.uploadChunkBytes
    const totalChunks = Math.max(1, Math.ceil(bytes.length / chunkSize))
    let result: any = null
    for (let index = 0; index < totalChunks; index++) {
      const chunk = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize))
      result = await this.call('upload_file_stream', {
        stream_id: streamId,
        chunk_data: chunk.toString('base64'),
        chunk_index: index,
        total_chunks: index === 0 ? totalChunks : undefined,
        file_size: bytes.length,
        expected_sha256: index === 0 ? sha256 : undefined,
        is_complete: index === totalChunks - 1,
        filename,
        file_retention: opts.fileRetentionMs ?? 600_000,
      })
    }
    const filePathOut = result?.file_path
    if (!filePathOut) {
      throw new OneBotError(`OneBot upload_file_stream completed without file_path: ${JSON.stringify(result)}`, {
        ok: false,
        kind: 'unknown',
        failureClass: 'other',
        retryable: true,
        redrivable: true,
        retcode: null,
        status: null,
        wording: 'upload_file_stream: no file_path in completion frame',
        dialectHint: null,
      })
    }
    return {
      file_path: String(filePathOut),
      file_name: String(result?.file_name ?? filename),
      file_size: Number(result?.file_size ?? bytes.length),
      sha256: String(result?.sha256 ?? sha256),
    }
  }

  // ── capability probe ─────────────────────────────────────────────────────

  /**
   * Cached capability snapshot. `get_version_info`'s `app_name` discriminates
   * the dialect (SnowLuma vs NapCat); per-capability flags follow the dialect
   * table in docs/snowluma.md. Probing never throws.
   */
  async capabilities(): Promise<OneBotCapabilities> {
    if (this.cachedCapabilities) return this.cachedCapabilities
    let dialect: OneBotDialect = 'generic'
    try {
      dialect = detectDialect(await this.getVersionInfo())
    } catch {
      // unknown bridge: conservative defaults (capabilitiesFor('generic'))
    }
    this.cachedCapabilities = capabilitiesFor(dialect)
    return this.cachedCapabilities
  }

  private async call(action: string, payload: Record<string, unknown>): Promise<any> {
    let res: Response
    try {
      res = await fetch(`${this.url}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      // transport failure (timeout / network / abort)
      throw new OneBotError(`OneBot ${action} transport failure: ${error instanceof Error ? error.message : String(error)}`, classifyOneBotError(error))
    }
    if (!res.ok) {
      const transport = classifyOneBotError(Object.assign(new Error(`OneBot ${action} HTTP ${res.status}`), { httpStatus: res.status }))
      throw new OneBotError(`OneBot ${action} HTTP ${res.status}`, transport)
    }
    const data = (await res.json()) as any
    this.assertOk(data, action)
    return data?.data ?? data
  }

  private assertOk(data: any, context: string): void {
    const verdict = classifyOneBotResponse(data)
    if (verdict.ok) return
    const detail = `OneBot ${context} failed: status=${verdict.status ?? 'unknown'} retcode=${verdict.retcode ?? 'unknown'} message=${verdict.wording}`
    if (!verdict.retryable) throw new OneBotNonRetryableError(detail, verdict)
    throw new OneBotError(detail, verdict)
  }
}

function capabilitiesFor(dialect: OneBotDialect): OneBotCapabilities {
  return {
    dialect,
    messageStore: dialect !== 'generic',
    urlMedia: dialect === 'snowluma',
    inlineMedia: dialect === 'snowluma',
    streamUpload: dialect !== 'generic',
  }
}

export const onebotComponent: Component<OneBotClientConfig> = {
  knownWithKeys: ['http_url', 'access_token', 'timeout_ms', 'dialect', 'upload_chunk_bytes'],
  apply: (ctx, config) => {
    const client = new OneBotClient(config)
    ctx.expose(client)
    // multi-UIN: several infra/onebot entries may coexist (one per bridge
    // endpoint); only the first takes the shared `onebot` coeffect key, the
    // rest are addressed via their node handles (`onebot: <entry id>` on
    // target/qq). A second ctx.set on the same key would kill that fiber.
    if (ctx.get('onebot') === undefined) ctx.set('onebot', client)
  },
}
