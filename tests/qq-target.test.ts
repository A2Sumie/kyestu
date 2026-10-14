import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, NodeHandle, nodeKey, type EntryDef } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { KyestuDb } from '../src/components/db'
import { OneBotNonRetryableError } from '../src/components/onebot'
import { OutboundStore } from '../src/pipeline/outbound'
import type { QqTargetApi, SendInput } from '../src/types/api'

// ---------------------------------------------------------------------------
// target/qq × OneBot mock: message_id 落库、双 retcode 语义、媒体来源、
// FI-01 健康熔断（down 时不攒 failed 行，恢复后自动继续）、撤回/回执核对。
// ---------------------------------------------------------------------------

interface MockOneBot {
  url: string
  seen: Array<{ action: string; payload: any }>
  /** mutable response program: return a body object, or a number for an HTTP status */
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

const DB: EntryDef = { id: 'db', use: 'infra/db', with: { path: ':memory:' } }

async function boot(mock: MockOneBot, targetWith: Record<string, unknown> = {}, onebotWith: Record<string, unknown> = {}) {
  const root = createRoot()
  const registry = defineAll(createRegistry())
  const loader = new Loader(root, registry)
  await loader.load([
    DB,
    { id: 'onebot', use: 'infra/onebot', with: { http_url: mock.url, ...onebotWith } },
    { id: 'qq-1', use: 'target/qq', with: { group_id: 1001, min_interval: 0, ...targetWith } },
  ])
  await root.idle()
  return {
    root,
    db: root.ctx.get<KyestuDb>('db')!,
    target: root.ctx.get<NodeHandle>(nodeKey('qq-1'))!.api<QqTargetApi>()!,
  }
}

const dir = mkdtempSync(join(tmpdir(), 'kyestu-qq-target-'))
const photo = join(dir, 'photo.png')
writeFileSync(photo, Buffer.alloc(2048, 7))

function sendInput(media: Array<{ path: string; type: 'photo' | 'video' }> = []): SendInput {
  return {
    article: { platform: 'twitter', a_id: 'a1', id: 1, content: 'hello' },
    rendered: { text: 'hello', media: media.map((m) => ({ path: m.path, type: m.type })) },
    route: { crawler: 'c1', formatter: null, target: 'qq-1' },
  }
}

test('target/qq: message_id receipts land on the outbound row; segments stay file:// on legacy bridges', async () => {
  const mock = mockOneBot((action) =>
    action === 'send_group_msg' ? { status: 'ok', retcode: 0, data: { message_id: 4242 } } : { status: 'ok', retcode: 0, data: {} },
  )
  try {
    const { root, db, target } = await boot(mock, {})
    await target.send(sendInput([{ path: photo, type: 'photo' }]))
    const rows = new OutboundStore(db).sentWithReceipts('qq-1')
    expect(rows.length).toBe(1)
    expect(rows[0]!.messageIds).toEqual([4242])

    const send = mock.seen.find((s) => s.action === 'send_group_msg')!
    expect(send.payload.group_id).toBe(1001)
    const image = send.payload.message.find((s: any) => s.type === 'image')
    expect(image.data.file).toBe(`file://${photo}`) // legacy compat (NapCat / unknown bridges)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('target/qq: snowluma dialect decouples media — small photos go base64 inline', async () => {
  const mock = mockOneBot((action) => {
    if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'SnowLuma', app_version: '1.14.22-node', protocol_version: 'v11' } }
    return { status: 'ok', retcode: 0, data: { message_id: 1 } }
  })
  try {
    const { root, target } = await boot(mock)
    await target.send(sendInput([{ path: photo, type: 'photo' }]))
    const send = mock.seen.find((s) => s.action === 'send_group_msg')!
    const image = send.payload.message.find((s: any) => s.type === 'image')
    expect(image.data.file.startsWith('base64://')).toBe(true)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('target/qq: napcat retcode 200 (EventChecker refusal) is non-retryable and redrivable (legacy pin)', async () => {
  let sends = 0
  const mock = mockOneBot((action) => {
    if (action === 'send_group_msg') {
      sends++
      return { status: 'failed', retcode: 200, message: 'EventChecker result=120' }
    }
    return { status: 'ok', retcode: 0, data: {} }
  })
  try {
    const { root, db, target } = await boot(mock, {})
    const error = await target.send(sendInput()).catch((e) => e)
    expect(error).toBeInstanceOf(OneBotNonRetryableError)
    expect((error as any).redrivable).toBe(true) // re-drive after the cooldown
    expect(sends).toBe(1) // no identical-payload retry
    const row = new OutboundStore(db).sentWithReceipts('qq-1')
    expect(row.length).toBe(0) // nothing was sent
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('target/qq: snowluma retcode 1400 (bad request) never redrives', async () => {
  const mock = mockOneBot((action) =>
    action === 'send_group_msg'
      ? { status: 'failed', retcode: 1400, wording: 'MessageElementValidationError' }
      : { status: 'ok', retcode: 0, data: {} },
  )
  try {
    const { root, target } = await boot(mock, {})
    const error = await target.send(sendInput()).catch((e) => e)
    expect(error).toBeInstanceOf(OneBotNonRetryableError)
    expect((error as any).redrivable).toBe(false) // fix the payload; the router drops instead of re-driving
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('FI-01: bridge outage suppresses sends without piling failed rows; recovery resumes automatically', async () => {
  let healthy = false
  const mock = mockOneBot((action) => {
    if (!healthy) return 502
    if (action === 'send_group_msg') return { status: 'ok', retcode: 0, data: { message_id: 7 } }
    return { status: 'ok', retcode: 0, data: { online: true, good: true, time: 1 } }
  })
  try {
    const { root, db, target } = await boot(mock, { health: { probe_interval_ms: 1, base_cooldown_ms: 20 } })
    const outbound = new OutboundStore(db)

    // outage: the send fails (one row, marked failed) …
    await expect(target.send(sendInput())).rejects.toThrow()
    // … the circuit is open: the next send defers BEFORE claiming (no new row) …
    const error = await target.send(sendInput()).catch((e) => e)
    expect((error as any).retryLater).toBe(true)
    expect(outbound.sentWithReceipts('qq-1').length).toBe(0)
    const allRows = (db.db.query('SELECT COUNT(*) AS n FROM outbound_messages').get() as { n: number }).n
    expect(allRows).toBe(1)

    // recovery: the probe sees the bridge healthy again and the send resumes
    healthy = true
    await Bun.sleep(30) // let the small cooldown lapse + probe run
    await target.send(sendInput())
    expect(outbound.sentWithReceipts('qq-1').length).toBe(1)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('target/qq: recall (delete_msg) and receipt verification (get_msg) ops', async () => {
  const mock = mockOneBot((action) => {
    if (action === 'send_group_msg') return { status: 'ok', retcode: 0, data: { message_id: 99 } }
    if (action === 'get_msg') return { status: 'ok', retcode: 0, data: { message_id: 99, real_id: 99, time: 1, message: [] } }
    if (action === 'delete_msg') return { status: 'ok', retcode: 0, data: null }
    return { status: 'ok', retcode: 0, data: {} }
  })
  try {
    const { root, db, target } = await boot(mock, {})
    await target.send(sendInput())
    const row = new OutboundStore(db).sentWithReceipts('qq-1')[0]!

    const receipts = await target.verifyReceipts(row.id)
    expect(receipts).toEqual([{ message_id: 99, found: true }])

    const recall = await target.recall([99])
    expect(recall.recalled).toEqual([99])
    expect(recall.failed).toEqual([])
    expect(mock.seen.some((s) => s.action === 'delete_msg' && s.payload.message_id === 99)).toBe(true)
    await root.dispose()
  } finally {
    mock.stop()
  }
})
