import type { Component } from '../core/types'

/** OneBot v11 HTTP client (NapCat), ported from idol-bbq qq.ts semantics. */

export interface OneBotMessageSegment {
  type: string
  data: Record<string, unknown>
}

export class OneBotNonRetryableError extends Error {}

export interface OneBotClientConfig {
  http_url: string
  access_token?: string
  timeout_ms?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

export class OneBotClient {
  private readonly url: string
  private readonly token?: string
  private readonly timeoutMs: number

  constructor(config: OneBotClientConfig) {
    this.url = config.http_url.replace(/\/+$/, '')
    this.token = config.access_token
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS
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

  private async call(action: string, payload: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.url}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`)
    const data = (await res.json()) as any
    this.assertOk(data, action)
    return data?.data ?? data
  }

  private assertOk(data: any, context: string): void {
    const status = String(data?.status || '').trim().toLowerCase()
    const retcodeRaw = data?.retcode
    const hasRetcode = retcodeRaw !== undefined && retcodeRaw !== null && String(retcodeRaw).trim() !== ''
    const retcode = Number(retcodeRaw)
    const retcodeFailed = hasRetcode && (!Number.isFinite(retcode) || retcode !== 0)
    if ((status && status !== 'ok') || retcodeFailed) {
      const message = String(data?.message || data?.wording || data?.msg || data?.error || 'unknown')
      const detail = `OneBot ${context} failed: status=${status || 'unknown'} retcode=${hasRetcode ? retcodeRaw : 'unknown'} message=${message}`
      // retcode 200 (EventChecker rejection, e.g. bot muted): retrying the identical
      // payload just spams the API during the outage
      if (hasRetcode && retcode === 200) throw new OneBotNonRetryableError(detail)
      throw new Error(detail)
    }
  }
}

export const onebotComponent: Component<OneBotClientConfig> = {
  apply: (ctx, config) => {
    const client = new OneBotClient(config)
    ctx.expose(client)
    ctx.set('onebot', client)
  },
}
