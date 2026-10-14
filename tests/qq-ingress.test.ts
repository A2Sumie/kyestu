import { test, expect } from 'bun:test'
import { request } from 'http'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, NodeHandle, nodeKey, type EntryDef } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { KyestuDb } from '../src/components/db'
import { signEventBody } from '../src/pipeline/qq-events'
import type { QqIngressApi } from '../src/components/qq-ingress'
import type { QqHistorySyncApi } from '../src/components/qq-history-sync'
import type { QqTargetApi } from '../src/types/api'

// ---------------------------------------------------------------------------
// app/qq-ingress × OneBot mock：webhook 入站（HMAC/Bearer 鉴权）→ 归一化 →
// 幂等账本 → 反应规则（reply 引用/command/forward/quick operation）→
// 自身消息防死循环 → handler 失败隔离 → bot_offline 健康联动 →
// historySync 补缺口径重放（recovered）。
// ---------------------------------------------------------------------------

const SECRET = 'test-webhook-secret'
const SELF = 234567890

interface MockOneBot {
  url: string
  seen: Array<{ action: string; payload: any }>
  respond: (action: string, payload: any) => any
  stop: () => void
}

function mockOneBot(respond: (action: string, payload: any) => any): MockOneBot {
  const seen: Array<{ action: string; payload: any }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const action = new URL(req.url).pathname.slice(1)
      const payload = await req.json()
      seen.push({ action, payload })
      const body = respond(action, payload)
      if (typeof body === 'number') return new Response('mock failure', { status: body })
      return Response.json(body)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, respond, stop: () => server.stop(true) }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  probe.stop(true)
  if (!port) throw new Error('probe server did not bind a tcp port')
  return port
}

/** one fresh connection per request (shared keep-alive pools hide who answered) */
function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            json = data
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function get(port: number, path: string, auth?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: auth ? { authorization: `Bearer ${auth}` } : {} },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            json = data
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** polling wait (no bare sleeps in assertions) */
async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('condition not met within timeout')
    await Bun.sleep(10)
  }
}

interface BootOptions {
  mockUrl: string
  ingressWith?: Record<string, unknown>
  history?: boolean
  targets?: Array<Record<string, unknown>>
}

async function boot(options: BootOptions) {
  const root = createRoot()
  const registry = defineAll(createRegistry())
  const loader = new Loader(root, registry)
  const port = freePort()
  const targets: EntryDef[] = (options.targets ?? [{ id: 'qq-a', group_id: 1001 }]).map(({ id, ...withConfig }) => ({
    id: String(id),
    use: 'target/qq',
    with: { min_interval: 0, ...withConfig },
  }))
  const entries: EntryDef[] = [
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'bus', use: 'infra/bus' },
    { id: 'onebot', use: 'infra/onebot', with: { http_url: options.mockUrl } },
    ...targets,
    ...(options.history
      ? [{ id: 'hist', use: 'app/qq-history-sync', with: { group_id: 123, interval_ms: 0, count: 5 } }]
      : []),
    {
      id: 'ingress',
      use: 'app/qq-ingress',
      with: { port, path: '/qq/events', secret: SECRET, default_target: 'qq-a', ...(options.ingressWith ?? {}) },
    },
  ]
  await loader.load(entries)
  await root.idle()
  return {
    root,
    port,
    db: root.ctx.get<KyestuDb>('db')!,
    ingress: root.ctx.get<NodeHandle>(nodeKey('ingress'))!.api<QqIngressApi>()!,
    target: (id = 'qq-a') => root.ctx.get<NodeHandle>(nodeKey(id))!.api<QqTargetApi>()!,
    history: () => root.ctx.get<NodeHandle>(nodeKey('hist'))!.api<QqHistorySyncApi>()!,
  }
}

const okSend = (action: string) => (action === 'send_group_msg' || action === 'send_private_msg' ? { status: 'ok', retcode: 0, data: { message_id: 777 } } : { status: 'ok', retcode: 0, data: {} })

function groupMessage(overrides: Record<string, unknown> = {}) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: SELF,
    post_type: 'message',
    message_type: 'group',
    message_id: 4242,
    user_id: 10001,
    group_id: 555,
    sender: { user_id: 10001, nickname: 'alice', card: 'Alice', role: 'member' },
    message: [{ type: 'text', data: { text: '#ping' } }],
    ...overrides,
  }
}

const signed = (body: unknown) => {
  const raw = JSON.stringify(body)
  return { raw, headers: { 'x-signature': signEventBody(SECRET, raw) } }
}

const sendsTo = (mock: MockOneBot, groupId: number) => mock.seen.filter((s) => s.action === 'send_group_msg' && s.payload.group_id === groupId)

// ── 鉴权 ────────────────────────────────────────────────────────────────────

test('qq-ingress: webhook auth is fail-closed — HMAC X-Signature or Bearer, both against the shared secret', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: { rules: [{ id: 'r', actions: [{ type: 'quick_operation', reply: 'ok' }] }] },
    })
    const body = JSON.stringify(groupMessage())
    expect((await post(port, '/qq/events', body)).status).toBe(401)
    expect((await post(port, '/qq/events', body, { 'x-signature': signEventBody('wrong', body) })).status).toBe(401)
    expect((await post(port, '/qq/events', body, { authorization: 'Bearer nope' })).status).toBe(401)

    const signedOk = await post(port, '/qq/events', body, { 'x-signature': signEventBody(SECRET, body) })
    expect(signedOk.status).toBe(200)
    const bearerOk = await post(port, '/qq/events', JSON.stringify(groupMessage({ message_id: 4300 })), {
      authorization: `Bearer ${SECRET}`,
    })
    expect(bearerOk.status).toBe(200)

    // ops view: Bearer only
    expect((await get(port, '/qq/events')).status).toBe(401)
    expect((await get(port, '/qq/events', SECRET)).status).toBe(200)
    expect(ingress.stats().received).toBe(2)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

// ── reply / command（双方言） ───────────────────────────────────────────────

test('qq-ingress: SnowLuma array message → quote-reply into the event scope through the target chain', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        rules: [
          {
            id: 'ping',
            match: { kinds: ['message'], text_prefix: '#ping' },
            actions: [{ type: 'reply', text: 'pong {sender}', quote: true }],
          },
        ],
      },
    })
    const { raw, headers } = signed(groupMessage())
    const response = await post(port, '/qq/events', raw, headers)
    expect(response.status).toBe(200)
    expect(response.json).toEqual({}) // no quick operation configured

    await until(() => sendsTo(mock, 555).length === 1)
    const send = sendsTo(mock, 555)[0]!
    expect(send.payload.message[0]).toEqual({ type: 'reply', data: { message_id: 4242 } }) // 引用回复
    expect(send.payload.message[1]).toEqual({ type: 'text', data: { text: 'pong Alice' } })
    // destination override: the event's group, not the target's configured group_id
    expect(sendsTo(mock, 1001).length).toBe(0)
    await until(() => ingress.stats().ledger.ok === 1)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: NapCat CQ message → #status / #recall commands with the admin whitelist', async () => {
  const mock = mockOneBot((action) => (action === 'delete_msg' ? { status: 'ok', retcode: 0, data: null } : okSend(action)))
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        admins: [10001],
        rules: [
          {
            id: 'status',
            match: { kinds: ['message'], text_prefix: '#status', admins_only: true },
            actions: [{ type: 'command', name: 'status' }],
          },
          {
            id: 'recall',
            match: { kinds: ['message'], text_prefix: '#recall', admins_only: true },
            actions: [{ type: 'command', name: 'recall' }],
          },
        ],
      },
    })
    // NapCat string message format (CQ codes)
    const adminCq = groupMessage({ message_id: 5001, message: '#status', raw_message: '#status' })
    await post(port, '/qq/events', JSON.stringify(adminCq), { authorization: `Bearer ${SECRET}` })
    await until(() => sendsTo(mock, 555).length === 1)
    const segments = sendsTo(mock, 555)[0]!.payload.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(segments[0]).toEqual({ type: 'reply', data: { message_id: 5001 } }) // 命令回复也引用原消息
    expect(String(segments[1]!.data.text)).toContain('QQ 健康')

    const recall = groupMessage({ message_id: 5002, message: '#recall 4242', raw_message: '#recall 4242' })
    await post(port, '/qq/events', JSON.stringify(recall), { authorization: `Bearer ${SECRET}` })
    await until(() => mock.seen.some((s) => s.action === 'delete_msg' && s.payload.message_id === 4242))

    // non-admin is ignored (whitelist), including recall which is admin-only inside the command too
    const before = mock.seen.length
    const stranger = groupMessage({ message_id: 5003, user_id: 666, sender: { user_id: 666 }, message: '#recall 4242' })
    await post(port, '/qq/events', JSON.stringify(stranger), { authorization: `Bearer ${SECRET}` })
    await until(() => ingress.stats().received === 3)
    expect(mock.seen.length).toBe(before)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

// ── 幂等 / 防自触发 / 防呆 ─────────────────────────────────────────────────

test('qq-ingress: webhook re-delivery is idempotent (ledger unique key → one reaction)', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: { rules: [{ id: 'r', match: { text_prefix: '#ping' }, actions: [{ type: 'reply', text: 'pong' }] }] },
    })
    const { raw, headers } = signed(groupMessage())
    expect((await post(port, '/qq/events', raw, headers)).status).toBe(200)
    expect((await post(port, '/qq/events', raw, headers)).status).toBe(200) // re-delivery
    await until(() => sendsTo(mock, 555).length === 1)
    await Bun.sleep(50) // give a hypothetical second reaction time to appear
    expect(sendsTo(mock, 555).length).toBe(1)
    expect(ingress.stats().duplicates).toBe(1)
    expect(ingress.stats().ledger.ok).toBe(1)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: own messages / message_sent echoes are ignored (anti-death-loop)', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        rules: [{ id: 'r', match: { kinds: ['message', 'message_sent'] }, actions: [{ type: 'reply', text: 'echo' }] }],
      },
    })
    await post(port, '/qq/events', JSON.stringify(groupMessage({ post_type: 'message_sent', message_id: 6001 })), { authorization: `Bearer ${SECRET}` })
    await post(port, '/qq/events', JSON.stringify(groupMessage({ message_id: 6002, user_id: SELF, sender: { user_id: SELF } })), {
      authorization: `Bearer ${SECRET}`,
    })
    await until(() => ingress.stats().skipped === 2)
    expect(sendsTo(mock, 555).length).toBe(0)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: non-matching rules do not fire; bad payloads are recorded and skipped', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: { rules: [{ id: 'r', match: { text_prefix: '#ping' }, actions: [{ type: 'reply', text: 'pong' }] }] },
    })
    await post(port, '/qq/events', JSON.stringify(groupMessage({ message_id: 7001, message: [{ type: 'text', data: { text: 'hello' } }] })), {
      authorization: `Bearer ${SECRET}`,
    })
    expect((await post(port, '/qq/events', 'not json', { authorization: `Bearer ${SECRET}` })).status).toBe(400)
    expect((await post(port, '/qq/events', '{"foo":1}', { authorization: `Bearer ${SECRET}` })).status).toBe(400)
    await until(() => ingress.stats().bad === 2)
    expect(ingress.stats().ledger.bad).toBe(2)
    expect(sendsTo(mock, 555).length).toBe(0)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: per-(group, rule) cooldown quota suppresses floods', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        rules: [{ id: 'r', match: { text_prefix: '#ping' }, cooldown_ms: 60_000, actions: [{ type: 'reply', text: 'pong' }] }],
      },
    })
    await post(port, '/qq/events', JSON.stringify(groupMessage({ message_id: 8001 })), { authorization: `Bearer ${SECRET}` })
    await post(port, '/qq/events', JSON.stringify(groupMessage({ message_id: 8002 })), { authorization: `Bearer ${SECRET}` })
    await until(() => sendsTo(mock, 555).length === 1)
    await Bun.sleep(50)
    expect(sendsTo(mock, 555).length).toBe(1) // second event suppressed by cooldown
    await root.dispose()
  } finally {
    mock.stop()
  }
})

// ── quick operation / 失败隔离 / 健康联动 ──────────────────────────────────

test('qq-ingress: quick_operation is answered in the webhook response body (SnowLuma http-post wire)', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        rules: [
          {
            id: 'ack',
            match: { text_prefix: '#ping' },
            actions: [{ type: 'quick_operation', reply: 'ack {user_id}', at_sender: false }],
          },
        ],
      },
    })
    const { raw, headers } = signed(groupMessage())
    const response = await post(port, '/qq/events', raw, headers)
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ reply: 'ack 10001', at_sender: false })
    expect(sendsTo(mock, 555).length).toBe(0) // quick ops let the bridge answer
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: a failing action is isolated — later actions still run, the ledger says error', async () => {
  const mock = mockOneBot((action, payload) => {
    if (action === 'send_group_msg' && payload.group_id === 555) return 500 // the reply target is broken
    return okSend(action)
  })
  try {
    const { root, port, ingress } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        rules: [
          {
            id: 'boom',
            match: { text_prefix: '#ping' },
            actions: [
              { type: 'reply', text: 'boom', target: 'qq-a' },
              { type: 'forward', to_group: 2002, target: 'qq-b', prefix: '[alert] ' },
            ],
          },
        ],
      },
      targets: [
        { id: 'qq-a', group_id: 1001 },
        { id: 'qq-b', group_id: 2002 },
      ],
    })
    const { raw, headers } = signed(groupMessage())
    await post(port, '/qq/events', raw, headers)
    await until(() => sendsTo(mock, 2002).length === 1) // the forward relay went out despite the failing reply
    await until(() => ingress.stats().ledger.error === 1)
    expect(ingress.stats().actionErrors).toBeGreaterThanOrEqual(1)
    const relay = sendsTo(mock, 2002)[0]!
    expect(relay.payload.message[0].data.text).toContain('[alert]')
    expect(relay.payload.message[0].data.text).toContain('群 555')
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: bot_offline / essence notices reach alerting and the health board', async () => {
  const mock = mockOneBot(okSend)
  try {
    // qq-a carries the health board (never sent through → stays `down` after
    // the offline notice); qq-b is the alert relay
    const { root, port, target } = await boot({
      mockUrl: mock.url,
      targets: [
        { id: 'qq-a', group_id: 1001 },
        { id: 'qq-b', group_id: 2002 },
      ],
      ingressWith: {
        health_target: 'qq-a',
        default_target: 'qq-b',
        rules: [
          { id: 'offline-alert', match: { kinds: ['notice'], notice_types: ['bot_offline'] }, actions: [{ type: 'forward', to_group: 9999, prefix: '[offline] ' }] },
          { id: 'essence-alert', match: { kinds: ['notice'], notice_types: ['essence'] }, actions: [{ type: 'forward', to_group: 9999, prefix: '[essence] ' }] },
        ],
      },
    })
    expect(target('qq-a').health()).toMatchObject({ state: 'ok' })

    const { raw, headers } = signed({ time: 1, self_id: SELF, post_type: 'notice', notice_type: 'bot_offline' })
    await post(port, '/qq/events', raw, headers)
    await until(() => sendsTo(mock, 9999).length === 1)
    await until(() => (target('qq-a').health() as { state: string }).state === 'down') // qq-health 联动

    await post(
      port,
      '/qq/events',
      JSON.stringify({ time: 2, self_id: SELF, post_type: 'notice', notice_type: 'essence', sub_type: 'add', group_id: 555, user_id: 10001, message_id: 4242 }),
      { authorization: `Bearer ${SECRET}` },
    )
    await until(() => sendsTo(mock, 9999).length === 2)
    const essenceRelay = sendsTo(mock, 9999)[1]!
    expect(essenceRelay.payload.message[0].data.text).toContain('[essence]')
    expect(essenceRelay.payload.message[0].data.text).toContain('essence/add')
    await root.dispose()
  } finally {
    mock.stop()
  }
})

// ── historySync 补缺联动 ───────────────────────────────────────────────────

test('qq-ingress: historySync backfill recovers missed messages as `recovered` events (补缺)', async () => {
  const now = Math.floor(Date.now() / 1000)
  const history: Array<{ message_id: number; time: number; sender: number }> = [
    { message_id: 1, time: now - 200, sender: 10001 },
    { message_id: 2, time: now - 190, sender: 10001 },
  ]
  const mock = mockOneBot((action, payload) => {
    if (action === 'get_group_msg_history') {
      const sorted = [...history].sort((a, b) => b.time - a.time)
      const slice = payload.message_id ? sorted.slice(sorted.findIndex((m) => m.message_id === payload.message_id)) : sorted.slice(0, payload.count)
      return {
        status: 'ok',
        retcode: 0,
        data: {
          messages: slice.map((m) => ({
            message_id: m.message_id,
            time: m.time,
            message_type: 'group',
            sender: { user_id: m.sender },
            message: [{ type: 'text', data: { text: `hist ${m.message_id}` } }],
          })),
        },
      }
    }
    return okSend(action)
  })
  try {
    const { root, port, ingress, db } = await boot({
      mockUrl: mock.url,
      history: true,
      ingressWith: {
        rules: [{ id: 'relay', match: { kinds: ['message'] }, actions: [{ type: 'forward', to_group: 9999 }] }],
        recover: { enabled: true, history_sync: 'hist', interval_ms: 0, max_age_ms: 3_600_000 },
      },
    })
    // wait for the history mirror to hold the seeded messages, then run a pass
    await until(() => ((db.db.query('SELECT COUNT(*) AS n FROM qq_messages').get() as { n: number }).n ?? 0) >= 2)
    await ingress.recover()
    await until(() => sendsTo(mock, 9999).length === 2) // both history rows replayed as recovered
    await until(() => ingress.stats().recovered === 2)

    // a live event lands normally (and mirrors into the message store)
    await post(port, '/qq/events', JSON.stringify(groupMessage({ message_id: 3, user_id: 10001 })), { authorization: `Bearer ${SECRET}` })
    await until(() => sendsTo(mock, 9999).length === 3)

    // disconnect window: messages 4-5 exist only in the bridge history
    history.push({ message_id: 4, time: now - 10, sender: 10001 }, { message_id: 5, time: now - 5, sender: 10002 })
    await ingress.recover()
    await until(() => sendsTo(mock, 9999).length === 5) // 4 and 5 recovered …
    await until(() => ingress.stats().recovered === 4)
    await Bun.sleep(50)
    expect(sendsTo(mock, 9999).length).toBe(5) // …and nothing replayed twice (1,2,3 deduped by ledger)
    expect(ingress.stats().duplicates).toBe(0)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('qq-ingress: crash-mid-dispatch rows are re-dispatched, already-sent actions dedupe on the outbound claim', async () => {
  const mock = mockOneBot(okSend)
  try {
    const { root, port, ingress, db } = await boot({
      mockUrl: mock.url,
      ingressWith: {
        rules: [{ id: 'r', match: { text_prefix: '#ping' }, actions: [{ type: 'reply', text: 'pong' }] }],
        recover: { enabled: true, history_sync: 'hist', interval_ms: 0 },
      },
    })
    const { raw, headers } = signed(groupMessage())
    await post(port, '/qq/events', raw, headers)
    await until(() => sendsTo(mock, 555).length === 1)

    // simulate a crash before the ledger verdict: row back to `received`
    db.db.query("UPDATE qq_inbound_events SET status = 'received' WHERE message_id = 4242").run()
    await ingress.recover()
    await until(() => ingress.stats().ledger.ok === 1)
    await Bun.sleep(50)
    expect(sendsTo(mock, 555).length).toBe(1) // claim dedupe: no double reply
    await root.dispose()
  } finally {
    mock.stop()
  }
})
