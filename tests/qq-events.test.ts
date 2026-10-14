import { test, expect } from 'bun:test'
import {
  eventScopeKey,
  junkDedupeKey,
  normalizeQqEvent,
  parseMessageField,
  signEventBody,
  verifyEventSignature,
} from '../src/pipeline/qq-events'
import {
  compileRules,
  dispatchActions,
  formatEventSummary,
  planQuickOperation,
  QqQuotaGate,
  renderTemplate,
  ruleMatches,
  type QqRule,
} from '../src/pipeline/qq-reactions'

// ---------------------------------------------------------------------------
// 入站事件纯层：双事件方言归一化（SnowLuma 段数组 / NapCat CQ 串）、鉴权、
// 幂等键、规则匹配、配额、quick operation 规划。
// ---------------------------------------------------------------------------

const snowlumaGroupMessage = {
  time: 1760000000,
  self_id: 234567890,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 4242,
  user_id: 10001,
  group_id: 555,
  sender: { user_id: 10001, nickname: 'alice', card: 'Alice', role: 'member' },
  message: [
    { type: 'at', data: { qq: '234567890' } },
    { type: 'text', data: { text: ' #status' } },
  ],
  raw_message: '[CQ:at,qq=234567890] #status',
}

const napcatPrivateMessage = {
  time: 1760000001,
  self_id: 234567890,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 9001,
  user_id: 10002,
  sender: { user_id: 10002, nickname: 'bob' },
  message: '[CQ:at,qq=234567890] hi &#91;ok&#93;',
  raw_message: '[CQ:at,qq=234567890] hi &#91;ok&#93;',
}

test('normalize: SnowLuma group message (array segments) — scope, sender, @-mentions, dedupe key', () => {
  const event = normalizeQqEvent(snowlumaGroupMessage)!
  expect(event).not.toBeNull()
  expect(event.kind).toBe('message')
  expect(event.scope).toBe('group')
  expect(event.groupId).toBe(555)
  expect(event.userId).toBe(10001)
  expect(event.selfId).toBe(234567890)
  expect(event.senderName).toBe('Alice')
  expect(event.messageId).toBe(4242)
  expect(event.text).toContain('#status')
  expect(event.mentions).toEqual([234567890])
  expect(event.key).toBe('msg:group:555:4242')
  expect(eventScopeKey(event)).toBe('group:555')
  expect(event.recovered).toBe(false)
})

test('normalize: NapCat private message (CQ string) — decoded text + mentions', () => {
  const event = normalizeQqEvent(napcatPrivateMessage)!
  expect(event.kind).toBe('message')
  expect(event.scope).toBe('friend')
  expect(event.userId).toBe(10002)
  expect(event.key).toBe('msg:friend:10002:9001')
  expect(event.mentions).toEqual([234567890])
  expect(event.text).toBe('@234567890 hi [ok]') // CQ unescape: &#91; → [
})

test('normalize: message_sent (self echo), notices, requests, meta_event, notification', () => {
  expect(normalizeQqEvent({ ...snowlumaGroupMessage, post_type: 'message_sent' })!.kind).toBe('message_sent')

  const botOffline = normalizeQqEvent({
    time: 1,
    self_id: 234567890,
    post_type: 'notice',
    notice_type: 'bot_offline',
  })!
  expect(botOffline.kind).toBe('notice')
  expect(botOffline.noticeType).toBe('bot_offline')

  const essence = normalizeQqEvent({
    time: 1,
    self_id: 234567890,
    post_type: 'notice',
    notice_type: 'essence',
    sub_type: 'add',
    group_id: 555,
    user_id: 10001,
    message_id: 4242,
  })!
  expect(essence.noticeType).toBe('essence')
  expect(essence.noticeSubType).toBe('add')

  const request = normalizeQqEvent({
    time: 1,
    self_id: 234567890,
    post_type: 'request',
    request_type: 'group',
    group_id: 555,
    user_id: 10003,
    comment: 'let me in',
  })!
  expect(request.kind).toBe('request')
  expect(request.requestType).toBe('group')
  expect(request.text).toBe('let me in')

  const meta = normalizeQqEvent({ time: 1, self_id: 234567890, post_type: 'meta_event', meta_event_type: 'heartbeat', status: {} })!
  expect(meta.kind).toBe('meta_event')
  expect(meta.metaEventType).toBe('heartbeat')

  // SnowLuma account notifications webhook (templated body, minimal JSON shape)
  const notification = normalizeQqEvent({ uin: 234567890, event: 'offline' })!
  expect(notification.kind).toBe('notification')
  expect(notification.noticeType).toBe('account')
  expect(notification.noticeSubType).toBe('offline')
  expect(notification.selfId).toBe(234567890)
})

test('normalize: junk payloads return null (recorded as bad, never crash)', () => {
  expect(normalizeQqEvent(null)).toBeNull()
  expect(normalizeQqEvent('hello')).toBeNull()
  expect(normalizeQqEvent([1, 2, 3])).toBeNull()
  expect(normalizeQqEvent({ foo: 1 })).toBeNull()
})

test('dedupe keys are stable across identical re-deliveries', () => {
  const a = normalizeQqEvent(JSON.parse(JSON.stringify(snowlumaGroupMessage)))!
  const b = normalizeQqEvent(JSON.parse(JSON.stringify(snowlumaGroupMessage)))!
  expect(a.key).toBe(b.key)
  const notice = { time: 1, self_id: 1, post_type: 'notice', notice_type: 'essence', sub_type: 'add', group_id: 9, message_id: 5 }
  expect(normalizeQqEvent(notice)!.key).toBe(normalizeQqEvent({ ...notice })!.key)
  expect(junkDedupeKey('oops')).toBe(junkDedupeKey('oops'))
  expect(junkDedupeKey('oops')).not.toBe(junkDedupeKey('oops2'))
})

test('webhook auth: HMAC-SHA1 X-Signature over the raw body (SnowLuma httpClients wire)', () => {
  const raw = JSON.stringify(snowlumaGroupMessage)
  const signature = signEventBody('shared-secret', raw)
  expect(signature.startsWith('sha1=')).toBe(true)
  expect(verifyEventSignature('shared-secret', raw, signature)).toBe(true)
  expect(verifyEventSignature('shared-secret', raw, signature.slice('sha1='.length))).toBe(true) // bare hex accepted
  expect(verifyEventSignature('wrong-secret', raw, signature)).toBe(false)
  expect(verifyEventSignature('shared-secret', `${raw} `, signature)).toBe(false) // tampered body
  expect(verifyEventSignature('shared-secret', raw, 'sha1=not-a-hex')).toBe(false)
  expect(verifyEventSignature('shared-secret', raw, null)).toBe(false)
  expect(verifyEventSignature('', raw, signature)).toBe(false) // empty secret never authenticates
})

test('parseMessageField: arrays, CQ strings, empty shapes', () => {
  expect(parseMessageField([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: { file: 'x' } }]).text).toBe('a')
  expect(parseMessageField('plain [CQ:face,id=1] tail').text).toBe('plain  tail')
  expect(parseMessageField(undefined)).toEqual({ text: '', mentions: [] })
})

// ── rule matching / quota ──────────────────────────────────────────────────

const eventFor = (overrides: Record<string, unknown> = {}) => {
  const base = normalizeQqEvent(snowlumaGroupMessage)!
  return { ...base, ...overrides }
}

const compileOne = (rule: QqRule) => compileRules([rule])[0]!

test('rule matching: filters AND across fields, OR inside lists', () => {
  const rule = compileOne({
    id: 'r',
    match: { kinds: ['message'], groups: [555, 666], users: [10001], text_prefix: '@', text_regex: '#status' },
    actions: [{ type: 'quick_operation', reply: 'ok' }],
  })
  expect(ruleMatches(rule, eventFor(), [])).toBe(true)
  expect(ruleMatches(rule, eventFor({ groupId: 777 }), [])).toBe(false)
  expect(ruleMatches(rule, eventFor({ kind: 'notice' }), [])).toBe(false)
  expect(ruleMatches(rule, eventFor({ text: 'nope' }), [])).toBe(false)
  expect(ruleMatches(compileOne({ id: 'r', match: { notice_types: ['bot_offline'] }, actions: [{ type: 'quick_operation', reply: 'x' }] }), eventFor({ kind: 'notice', noticeType: 'bot_offline', text: '' }), [])).toBe(true)
  expect(ruleMatches(compileOne({ id: 'r', match: { notice_types: ['essence'] }, actions: [{ type: 'quick_operation', reply: 'x' }] }), eventFor({ kind: 'notice', noticeType: 'bot_offline', text: '' }), [])).toBe(false)
})

test('rule matching: admins_only and skip_recovered', () => {
  const rule = compileOne({ id: 'r', match: { admins_only: true }, actions: [{ type: 'quick_operation', reply: 'ok' }] })
  expect(ruleMatches(rule, eventFor(), [10001])).toBe(true)
  expect(ruleMatches(rule, eventFor(), [999])).toBe(false)
  expect(ruleMatches(rule, eventFor({ userId: null }), [10001])).toBe(false)
  const skip = compileOne({ id: 'r', skip_recovered: true, actions: [{ type: 'quick_operation', reply: 'ok' }] })
  expect(ruleMatches(skip, eventFor({ recovered: true }), [])).toBe(false)
  expect(ruleMatches(skip, eventFor({ recovered: false }), [])).toBe(true)
})

test('compileRules: invalid config fails fast (bad action, bad regex, duplicate id)', () => {
  expect(() => compileRules([{ id: 'a', actions: [{ type: 'nope' }] }])).toThrow('unknown action type')
  expect(() => compileRules([{ id: 'a', actions: [{ type: 'reply', text: 'x' }], match: { text_regex: '(' } }])).toThrow('text_regex')
  expect(() => compileRules([{ id: 'a', actions: [{ type: 'quick_operation' }] }, { id: 'a', actions: [{ type: 'quick_operation' }] }])).toThrow('duplicate rule id')
  expect(() => compileRules([{ id: 'a', actions: [{ type: 'command', name: 'rm -rf' }] }])).toThrow('unknown command')
  expect(() => compileRules([{ id: 'a', actions: [{ type: 'forward' }] }])).toThrow('needs to_group')
  expect(() => compileRules('nope')).toThrow('must be a list')
})

test('quota gate: per-(scope, rule) cooldown + sliding window', () => {
  let now = 1000
  const gate = new QqQuotaGate({ now: () => now })
  const rule = { id: 'r', cooldown_ms: 500, limit: { window_ms: 10_000, max: 2 } }
  expect(gate.allow(rule, 'group:1')).toBe(true)
  expect(gate.allow(rule, 'group:1')).toBe(false) // cooldown
  expect(gate.allow(rule, 'group:2')).toBe(true) // scope isolation
  now += 600
  expect(gate.allow(rule, 'group:1')).toBe(true) // cooldown over
  expect(gate.allow(rule, 'group:1')).toBe(false) // window quota (2)
  now += 10_001
  expect(gate.allow(rule, 'group:1')).toBe(true) // window slid
})

test('templates, summary and quick-operation planning', () => {
  const event = eventFor()
  expect(renderTemplate('hi {sender}({user_id}) in {group_id}: {text}', event)).toBe('hi Alice(10001) in 555: @234567890 #status')
  expect(formatEventSummary(event)).toContain('群 555')
  expect(formatEventSummary(event, { includeText: false })).not.toContain('#status')

  const operation = planQuickOperation(event, { type: 'quick_operation', reply: 'got {user_id}', at_sender: false })!
  expect(operation.reply).toBe('got 10001')
  expect(operation.at_sender).toBe(false)

  const approval = planQuickOperation(normalizeQqEvent({ time: 1, post_type: 'request', request_type: 'friend', user_id: 5, flag: 'f' })!, {
    type: 'quick_operation',
    approve: true,
    remark: 'ok',
  })!
  expect(approval).toEqual({ approve: true, remark: 'ok' })

  // quick operations only apply to message / request events
  expect(planQuickOperation(eventFor({ kind: 'notice', noticeType: 'bot_offline' }), { type: 'quick_operation', reply: 'x' })).toBeNull()
})

test('dispatchActions: failing action is isolated and the rest still run', async () => {
  let sends = 0
  const rules = compileRules([
    {
      id: 'boom',
      actions: [
        { type: 'reply', text: 'first' },
        { type: 'reply', text: 'second' },
        { type: 'quick_operation', reply: 'ok' },
      ],
    },
    { id: 'cmd', actions: [{ type: 'command', name: 'status' }] },
  ])
  const result = await dispatchActions(eventFor(), rules, {
    resolveTarget: () => ({
      send: async () => {
        sends++
        if (sends === 1) throw new Error('send exploded')
      },
      recall: async () => ({ recalled: [], failed: [] }),
      verifyReceipts: async () => [],
      health: () => {
        throw new Error('board exploded')
      },
      noteBridgeEvent: () => {},
    }),
    defaultTarget: 't',
    admins: [],
  }, new QqQuotaGate())
  expect(result.results[0]).toMatchObject({ rule: 'boom', ok: false, detail: 'send exploded' })
  expect(result.results[1]).toMatchObject({ rule: 'boom', ok: true })
  expect(result.results[2]).toMatchObject({ rule: 'boom', ok: true })
  expect(result.quickOperation).toEqual({ reply: 'ok' })
  expect(sends).toBe(2) // first threw after counting, second went out
  expect(result.results[3]).toMatchObject({ rule: 'cmd', ok: false, detail: 'board exploded' })
})
