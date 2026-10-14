/**
 * Reaction engine (mostly pure): config-driven rule matching plus pluggable
 * action executors — the "积木" of the inbound channel. One normalized event
 * (pipeline/qq-events.ts) fans out to zero or more rules; each rule carries
 * several actions of four kinds:
 *
 *  - `reply`            quote-reply into the event's scope through the existing
 *                       target/qq send chain (health gate + claim + cooldown),
 *                       with a OneBot `reply` segment anchoring the quote
 *                       (SnowLuma auto-attaches the cached original text);
 *  - `forward`          relay a formatted event summary to a group / users /
 *                       admins (again via the target send chain);
 *  - `command`          built-in commands (`status`, `recall`) with the admin
 *                       whitelist enforced inside the command itself;
 *  - `quick_operation`  answered in the webhook HTTP response body (the
 *                       OneBot http-post quick operation contract).
 *
 * Everything here is I/O-free except what the injected `QqReactionDeps`
 * resolve; the ingress component owns the transport, ledger and lifecycle.
 */
import type { QqInboundEvent, QqEventKind } from './qq-events'
import type { QqTargetApi, SendInput } from '../types/api'

// ── rule schema ────────────────────────────────────────────────────────────

export interface QqRuleMatch {
  /** event kinds to match (default: every kind) */
  kinds?: QqEventKind[]
  groups?: Array<number | string>
  users?: Array<number | string>
  self_ids?: Array<number | string>
  text_prefix?: string
  /** JavaScript regex source tested against the flattened text */
  text_regex?: string
  notice_types?: string[]
  notice_sub_types?: string[]
  /** only fire for senders in the ingress admin whitelist */
  admins_only?: boolean
}

export interface QqReplyAction {
  type: 'reply'
  /** template: {text} {user_id} {group_id} {message_id} {sender} {self_id} {kind} */
  text: string
  /** quote the triggering message (OneBot reply segment) */
  quote?: boolean
  at_sender?: boolean
  /** target/qq entry id (default: the ingress default_target) */
  target?: string
}

export interface QqForwardAction {
  type: 'forward'
  to_group?: number | string
  to_users?: Array<number | string>
  to_admins?: boolean
  prefix?: string
  /** include the event text in the relayed summary (default true) */
  include_text?: boolean
  target?: string
}

export interface QqCommandAction {
  type: 'command'
  /** built-in command name: `status` | `recall` */
  name: string
  target?: string
}

export interface QqQuickOperationAction {
  type: 'quick_operation'
  reply?: string
  at_sender?: boolean
  auto_escape?: boolean
  delete?: boolean
  ban?: boolean
  ban_duration?: number
  kick?: boolean
  reject_add_request?: boolean
  /** request events */
  approve?: boolean
  remark?: string
  reason?: string
}

export type QqAction = QqReplyAction | QqForwardAction | QqCommandAction | QqQuickOperationAction

export interface QqRule {
  id: string
  match?: QqRuleMatch
  actions: QqAction[]
  /** min interval between fires of this rule in one scope */
  cooldown_ms?: number
  /** per-(scope, rule) quota inside a sliding window */
  limit?: { window_ms: number; max: number }
  /** do not react to history-recovered events (default: react) */
  skip_recovered?: boolean
}

const ACTION_TYPES = new Set(['reply', 'forward', 'command', 'quick_operation'])
const EVENT_KINDS = new Set<QqEventKind>(['message', 'message_sent', 'notice', 'request', 'meta_event', 'notification', 'unknown'])

export interface CompiledRule extends Omit<QqRule, 'match'> {
  match: QqRuleMatch & { regex?: RegExp }
}

/** validate + compile rules; a bad config must fail the component, not be silently ignored */
export function compileRules(rules: unknown): CompiledRule[] {
  if (!Array.isArray(rules)) throw new Error('qq-ingress: `rules` must be a list')
  const out: CompiledRule[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rules.entries()) {
    const rule = raw as QqRule
    if (!rule || typeof rule !== 'object') throw new Error(`qq-ingress: rule #${index} is not an object`)
    if (!rule.id || typeof rule.id !== 'string') throw new Error(`qq-ingress: rule #${index} requires an id`)
    if (seen.has(rule.id)) throw new Error(`qq-ingress: duplicate rule id '${rule.id}'`)
    seen.add(rule.id)
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) throw new Error(`qq-ingress: rule '${rule.id}' requires actions`)
    for (const action of rule.actions) {
      if (!action || !ACTION_TYPES.has(action.type)) throw new Error(`qq-ingress: rule '${rule.id}' has unknown action type '${(action as any)?.type}'`)
      if (action.type === 'command' && action.name !== 'status' && action.name !== 'recall') {
        throw new Error(`qq-ingress: rule '${rule.id}' has unknown command '${action.name}'`)
      }
      if (action.type === 'forward' && action.to_group === undefined && !(action.to_users?.length) && !action.to_admins) {
        throw new Error(`qq-ingress: rule '${rule.id}' forward action needs to_group / to_users / to_admins`)
      }
    }
    const match: CompiledRule['match'] = { ...(rule.match ?? {}) }
    for (const kind of match.kinds ?? []) {
      if (!EVENT_KINDS.has(kind)) throw new Error(`qq-ingress: rule '${rule.id}' has unknown kind '${kind}'`)
    }
    if (match.text_regex !== undefined) {
      try {
        match.regex = new RegExp(match.text_regex)
      } catch (error) {
        throw new Error(`qq-ingress: rule '${rule.id}' text_regex is invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    out.push({ id: rule.id, actions: rule.actions, cooldown_ms: rule.cooldown_ms, limit: rule.limit, skip_recovered: rule.skip_recovered, match })
  }
  return out
}

function inList(list: Array<number | string> | undefined, value: number | null): boolean {
  if (!list || list.length === 0) return true
  if (value === null) return false
  return list.some((entry) => Number(entry) === value)
}

/** every configured filter must pass (AND across fields, OR inside lists) */
export function ruleMatches(rule: CompiledRule, event: QqInboundEvent, admins: Array<number | string>): boolean {
  const match = rule.match
  if (rule.skip_recovered && event.recovered) return false
  if (match.kinds && match.kinds.length > 0 && !match.kinds.includes(event.kind)) return false
  if (!inList(match.groups, event.groupId)) return false
  if (!inList(match.users, event.userId)) return false
  if (!inList(match.self_ids, event.selfId)) return false
  if (match.text_prefix !== undefined && !event.text.startsWith(match.text_prefix)) return false
  if (match.regex && !match.regex.test(event.text)) return false
  if (match.notice_types && match.notice_types.length > 0 && !match.notice_types.includes(event.noticeType ?? '')) return false
  if (match.notice_sub_types && match.notice_sub_types.length > 0 && !match.notice_sub_types.includes(event.noticeSubType ?? '')) return false
  if (match.admins_only && (event.userId === null || !admins.some((admin) => Number(admin) === event.userId))) return false
  return true
}

// ── per-(scope, rule) quota ────────────────────────────────────────────────

/**
 * Reaction throttle (每群每 handler 配额): min-interval cooldown plus a sliding
 * window quota, keyed by (scope, rule id). Deliberately memory-only — the
 * throttle is anti-flood, not accounting, and a reload resetting it is
 * harmless (recorded as a decision in docs/decisions.md D20).
 */
export class QqQuotaGate {
  private readonly hits = new Map<string, { lastAt: number; window: number[] }>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /** consumes the quota when allowed; returns false when the rule must stay quiet */
  allow(rule: Pick<QqRule, 'id' | 'cooldown_ms' | 'limit'>, scopeKey: string): boolean {
    const key = `${scopeKey}|${rule.id}`
    const now = this.now()
    const state = this.hits.get(key) ?? { lastAt: 0, window: [] }
    if (rule.cooldown_ms && rule.cooldown_ms > 0 && now - state.lastAt < rule.cooldown_ms) return false
    if (rule.limit && rule.limit.max > 0 && rule.limit.window_ms > 0) {
      const cutoff = now - rule.limit.window_ms
      state.window = state.window.filter((at) => at > cutoff)
      if (state.window.length >= rule.limit.max) return false
    }
    state.lastAt = now
    if (rule.limit && rule.limit.max > 0 && rule.limit.window_ms > 0) state.window.push(now)
    this.hits.set(key, state)
    return true
  }
}

// ── action executors ───────────────────────────────────────────────────────

export interface QqReactionDeps {
  /** resolve a target/qq entry's API (undefined while that fiber is not ACTIVE) */
  resolveTarget: (targetId: string | undefined) => QqTargetApi | undefined
  defaultTarget?: string
  admins: Array<number | string>
}

export interface QqActionResult {
  rule: string
  action: string
  ok: boolean
  detail?: string
}

export interface QqDispatchResult {
  results: QqActionResult[]
  /** the quick operation to answer the webhook POST with (first one wins) */
  quickOperation: Record<string, unknown> | null
}

const TEMPLATE_FIELDS = ['text', 'user_id', 'group_id', 'message_id', 'sender', 'self_id', 'kind'] as const

export function renderTemplate(template: string, event: QqInboundEvent): string {
  const values: Record<string, string> = {
    text: event.text,
    user_id: event.userId === null ? '' : String(event.userId),
    group_id: event.groupId === null ? '' : String(event.groupId),
    message_id: event.messageId === null ? '' : String(event.messageId),
    sender: event.senderName ?? '',
    self_id: event.selfId === null ? '' : String(event.selfId),
    kind: event.kind,
  }
  return template.replace(/\{(text|user_id|group_id|message_id|sender|self_id|kind)\}/g, (_, field: (typeof TEMPLATE_FIELDS)[number]) => values[field] ?? '')
}

/** compact human-readable event summary used by `forward` relays */
export function formatEventSummary(event: QqInboundEvent, options: { includeText?: boolean } = {}): string {
  const where = event.scope === 'group' ? `群 ${event.groupId ?? '?'}` : event.scope === 'friend' ? `好友 ${event.userId ?? '?'}` : '系统'
  const who = event.userId !== null ? `${event.senderName ? `${event.senderName}(${event.userId})` : event.userId}` : '-'
  const head = `[QQ事件] ${event.kind}${event.noticeType ? `/${event.noticeType}${event.noticeSubType ? `/${event.noticeSubType}` : ''}` : ''} · ${where} · ${who}${event.selfId !== null ? ` · bot ${event.selfId}` : ''}`
  const text = options.includeText === false ? '' : event.text
  return text ? `${head}\n${text}` : head
}

function destOf(event: QqInboundEvent): { kind: 'group' | 'private'; id: number } | null {
  if (event.scope === 'group' && event.groupId !== null) return { kind: 'group', id: event.groupId }
  if (event.scope === 'friend' && event.userId !== null) return { kind: 'private', id: event.userId }
  return null
}

function reactionInput(event: QqInboundEvent, ruleId: string, actionKey: string, text: string, dest: { kind: 'group' | 'private'; id: number }, replyTo: { message_id: number | string } | null, targetId: string): SendInput {
  return {
    article: {
      platform: 'qq-inbound',
      a_id: `${event.key}|${ruleId}|${actionKey}|${dest.kind}:${dest.id}`,
      u_id: event.senderName ?? undefined,
      created_at: event.time || undefined,
      content: event.text,
    },
    rendered: { text, media: [] },
    route: { crawler: 'qq-ingress', formatter: null, target: targetId },
    dest,
    ...(replyTo ? { reply: replyTo } : {}),
  }
}

const COMMANDS: Record<string, (event: QqInboundEvent, action: QqCommandAction, deps: QqReactionDeps) => Promise<string>> = {
  async status(_event, action, deps) {
    const target = deps.resolveTarget(action.target ?? deps.defaultTarget)
    if (!target?.health) return 'status: 目标 target 不可用'
    const snapshot = target.health() as Record<string, unknown>
    return `QQ 健康: state=${snapshot?.state ?? '?'} openUntil=${snapshot?.openUntil ?? 0} failures=${snapshot?.consecutiveFailures ?? 0} lastError=${snapshot?.lastError ?? '-'}`
  },
  async recall(event, action, deps) {
    // recall is destructive: admin whitelist is enforced here regardless of the
    // rule's own `admins_only` flag
    if (event.userId === null || !deps.admins.some((admin) => Number(admin) === event.userId)) {
      return 'recall: 仅管理员可用'
    }
    const idMatch = /(?:^|\s)(\d{4,})\s*$/.exec(event.text)
    if (!idMatch) return 'recall: 用法 #recall <message_id>'
    const target = deps.resolveTarget(action.target ?? deps.defaultTarget)
    if (!target?.recall) return 'recall: 目标 target 不可用'
    const result = await target.recall([Number(idMatch[1])])
    return `recall: 成功 ${result.recalled.length} 条，失败 ${result.failed.length} 条`
  },
}

/**
 * Run matched rules over one event. Rule and action failures are isolated
 * (recorded in `results`) — one broken action never blocks the rest, and the
 * caller persists the outcome on the ledger row.
 */
export async function dispatchActions(
  event: QqInboundEvent,
  rules: CompiledRule[],
  deps: QqReactionDeps,
  quota: QqQuotaGate,
): Promise<QqDispatchResult> {
  const results: QqActionResult[] = []
  let quickOperation: Record<string, unknown> | null = null
  const scopeKey = event.scope && (event.groupId ?? event.userId) !== null ? `${event.scope}:${event.groupId ?? event.userId}` : `sys:${event.selfId ?? '?'}`

  for (const rule of rules) {
    if (!ruleMatches(rule, event, deps.admins)) continue
    if (!quota.allow(rule, scopeKey)) {
      results.push({ rule: rule.id, action: 'quota', ok: true, detail: 'suppressed' })
      continue
    }
    for (const [index, action] of rule.actions.entries()) {
      const actionKey = `${index}:${action.type}`
      try {
        if (action.type === 'quick_operation') {
          if (quickOperation === null) quickOperation = planQuickOperation(event, action)
          results.push({ rule: rule.id, action: actionKey, ok: true, detail: quickOperation ? 'planned' : 'not applicable' })
          continue
        }
        if (action.type === 'command') {
          const command = COMMANDS[action.name]
          if (!command) {
            results.push({ rule: rule.id, action: actionKey, ok: false, detail: `unknown command ${action.name}` })
            continue
          }
          const text = await command(event, action, deps)
          const dest = destOf(event)
          const target = deps.resolveTarget(action.target ?? deps.defaultTarget)
          if (!target || !dest) {
            results.push({ rule: rule.id, action: actionKey, ok: false, detail: dest ? 'target unavailable' : 'event has no reply scope' })
            continue
          }
          await target.send(reactionInput(event, rule.id, actionKey, text, dest, event.messageId !== null ? { message_id: event.messageId } : null, action.target ?? deps.defaultTarget ?? ''))
          results.push({ rule: rule.id, action: actionKey, ok: true, detail: action.name })
          continue
        }
        if (action.type === 'reply') {
          const dest = destOf(event)
          const target = deps.resolveTarget(action.target ?? deps.defaultTarget)
          if (!target || !dest) {
            results.push({ rule: rule.id, action: actionKey, ok: false, detail: dest ? 'target unavailable' : 'event has no reply scope' })
            continue
          }
          let text = renderTemplate(action.text, event)
          if (action.at_sender && event.userId !== null) text = `@${event.senderName ?? event.userId} ${text}`
          await target.send(reactionInput(event, rule.id, actionKey, text, dest, action.quote !== false && event.messageId !== null ? { message_id: event.messageId } : null, action.target ?? deps.defaultTarget ?? ''))
          results.push({ rule: rule.id, action: actionKey, ok: true })
          continue
        }
        // forward
        const destinations: Array<{ kind: 'group' | 'private'; id: number }> = []
        if (action.to_group !== undefined) destinations.push({ kind: 'group', id: Number(action.to_group) })
        for (const user of action.to_users ?? []) destinations.push({ kind: 'private', id: Number(user) })
        if (action.to_admins) for (const admin of deps.admins) destinations.push({ kind: 'private', id: Number(admin) })
        const summary = `${action.prefix ?? ''}${formatEventSummary(event, { includeText: action.include_text })}`
        const target = deps.resolveTarget(action.target ?? deps.defaultTarget)
        if (!target) {
          results.push({ rule: rule.id, action: actionKey, ok: false, detail: 'target unavailable' })
          continue
        }
        for (const dest of destinations) {
          await target.send(reactionInput(event, rule.id, `${actionKey}:${dest.kind}:${dest.id}`, summary, dest, null, action.target ?? deps.defaultTarget ?? ''))
        }
        results.push({ rule: rule.id, action: actionKey, ok: true, detail: `${destinations.length} destination(s)` })
      } catch (error) {
        results.push({ rule: rule.id, action: actionKey, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { results, quickOperation }
}

/** build the OneBot quick-operation response body for a matched action */
export function planQuickOperation(event: QqInboundEvent, action: QqQuickOperationAction): Record<string, unknown> | null {
  const operation: Record<string, unknown> = {}
  if (event.kind === 'message' || event.kind === 'message_sent') {
    if (action.reply) operation.reply = renderTemplate(action.reply, event)
    if (action.at_sender !== undefined) operation.at_sender = action.at_sender
    if (action.auto_escape !== undefined) operation.auto_escape = action.auto_escape
    if (action.delete) operation.delete = true
    if (action.ban) {
      operation.ban = true
      if (action.ban_duration !== undefined) operation.ban_duration = action.ban_duration
    }
    if (action.kick) {
      operation.kick = true
      if (action.reject_add_request !== undefined) operation.reject_add_request = action.reject_add_request
    }
    return Object.keys(operation).length ? operation : null
  }
  if (event.kind === 'request') {
    if (action.approve !== undefined) operation.approve = action.approve
    if (action.remark !== undefined) operation.remark = action.remark
    if (action.reason !== undefined) operation.reason = action.reason
    return Object.keys(operation).length ? operation : null
  }
  return null
}
