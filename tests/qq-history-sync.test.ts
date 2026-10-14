import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, NodeHandle, nodeKey, type EntryDef } from '../src/loader/loader'
import { defineAll } from '../src/components'
import { KyestuDb } from '../src/components/db'
import { QqMessageStore } from '../src/pipeline/qq-messages'
import { ServiceStateStore } from '../src/pipeline/service-state'
import type { QqHistorySyncApi } from '../src/components/qq-history-sync'

// ---------------------------------------------------------------------------
// historySync: message-store 镜像 + 锚点翻页补缺（断线/失败窗口后从服务端回填）
// ---------------------------------------------------------------------------

interface Stored {
  message_id: number
  time: number
  [key: string]: unknown
}

function mockHistory(pages: { all: Stored[] }, calls: Array<{ anchor: number; count: number }>) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const action = new URL(req.url).pathname.slice(1)
      const payload = await req.json()
      if (action !== 'get_group_msg_history') return Response.json({ status: 'ok', retcode: 0, data: {} })
      calls.push({ anchor: payload.message_id, count: payload.count })
      const sorted = [...pages.all].sort((a, b) => b.time - a.time)
      let slice: Stored[]
      if (!payload.message_id) slice = sorted.slice(0, payload.count)
      else {
        const index = sorted.findIndex((m) => m.message_id === payload.message_id)
        slice = index < 0 ? [] : sorted.slice(index, index + payload.count)
      }
      return Response.json({
        status: 'ok',
        retcode: 0,
        data: {
          messages: slice.map((m) => ({
            message_id: m.message_id,
            time: m.time,
            message_type: 'group',
            sender: { user_id: 42 },
            message: [{ type: 'text', data: { text: `t${m.message_id}` } }],
          })),
        },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const msg = (message_id: number, time: number): Stored => ({ message_id, time })

async function boot(url: string) {
  const root = createRoot()
  const registry = defineAll(createRegistry())
  const loader = new Loader(root, registry)
  const entries: EntryDef[] = [
    { id: 'db', use: 'infra/db', with: { path: ':memory:' } },
    { id: 'onebot', use: 'infra/onebot', with: { http_url: url } },
    { id: 'hist', use: 'app/qq-history-sync', with: { group_id: 123, count: 2, interval_ms: 0, gap_ms: 60_000, max_pages: 10 } },
  ]
  await loader.load(entries)
  await root.idle()
  await Bun.sleep(20) // let the fire-and-forget initial sync settle
  return {
    root,
    db: root.ctx.get<KyestuDb>('db')!,
    api: root.ctx.get<NodeHandle>(nodeKey('hist'))!.api<QqHistorySyncApi>()!,
  }
}

test('history-sync: mirrors the latest page and dedupes by (scope, message_id)', async () => {
  const calls: Array<{ anchor: number; count: number }> = []
  const mock = mockHistory({ all: [msg(1, 1000), msg(2, 2000)] }, calls)
  try {
    const { root, db, api } = await boot(mock.url)
    const store = new QqMessageStore(db)
    expect(store.count('group:123')).toBe(2)
    expect(store.has('group:123', 1)).toBe(true)
    expect(store.list('group:123')[0]!.text).toBe('t1')

    // re-syncing the same page inserts nothing (idempotent)
    const second = await api.sync()
    expect(second.inserted).toBe(0)
    expect(store.count('group:123')).toBe(2)
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('history-sync: a gap triggers anchor-paged backfill from the server (history 补缺)', async () => {
  const calls: Array<{ anchor: number; count: number }> = []
  const all = [msg(1, 1000), msg(2, 2000)]
  const mock = mockHistory({ all }, calls)
  try {
    const { root, db, api } = await boot(mock.url) // phase 1: messages 1-2 mirrored, cursor = 2000
    const store = new QqMessageStore(db)
    expect(store.count('group:123')).toBe(2)
    expect(api.cursor()).toBe(2000)

    // outage over messages 3-5: the next sync must page back to the cursor
    all.push(msg(3, 3000), msg(4, 4000), msg(5, 5000))
    const result = await api.sync()
    expect(result.backfilled).toBeGreaterThan(0)
    expect(store.count('group:123')).toBe(5) // 3,4,5 backfilled
    expect(api.cursor()).toBe(5000)
    // the walk used the anchor (message_id) paging contract
    expect(calls.some((c) => c.anchor === 4)).toBe(true)

    // no further gaps: a plain sync does not re-walk history
    const before = calls.length
    await api.sync()
    expect(calls.length - before).toBe(1) // only the latest-page call
    await root.dispose()
  } finally {
    mock.stop()
  }
})

test('history-sync: cursor survives a fiber rebuild via service_state (write-through)', async () => {
  const calls: Array<{ anchor: number; count: number }> = []
  const mock = mockHistory({ all: [msg(1, 1000), msg(2, 2000)] }, calls)
  try {
    const { root, db } = await boot(mock.url)
    expect(new ServiceStateStore(db).get('qq-history:hist:cursor')).toBe('2000')
    await root.dispose()
  } finally {
    mock.stop()
  }
})
