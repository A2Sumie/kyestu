import { test, expect, afterEach } from 'bun:test'
import { OneBotClient, OneBotNonRetryableError } from '../src/components/onebot'
import { isPossiblyDeliveredTransportError } from '../src/pipeline/onebot-semantics'

/**
 * 2026-10-15 duplicate-send incident pins for the kyestu mirror of the guard:
 * an ambiguously failed send (the bridge may already have delivered it) is
 * reconciled against `get_*_msg_history` before any redrive — never a blind
 * re-send of a possibly delivered payload.
 */

type FetchStub = (url: string, init: any) => Promise<any>

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch as any
})

function stubFetch(handler: FetchStub) {
  globalThis.fetch = (async (url: any, init: any) => await handler(String(url), init)) as any
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any
}

function timeoutError() {
  return Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
}

function refusedError() {
  return Object.assign(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3200'), { code: 'ECONNREFUSED' })
}

function makeClient() {
  return new OneBotClient({ http_url: 'http://127.0.0.1:3200', reconcile_delays_ms: [1] })
}

const deliveredText = '🎉 Ratatan（ラタタン）本日正式リリース！'

test('incident pin: ambiguous timeout + delivered bridge copy sends exactly one message', async () => {
  let sendCalls = 0
  stubFetch(async (url) => {
    if (url.endsWith('/send_group_msg')) {
      sendCalls += 1
      throw timeoutError()
    }
    if (url.endsWith('/get_group_msg_history')) {
      return jsonRes({
        status: 'ok',
        retcode: 0,
        data: {
          messages: [
            {
              message_id: -1106780317,
              time: Math.floor(Date.now() / 1000),
              sender: { user_id: 3219117363 },
              message: [
                { type: 'text', data: { text: deliveredText } },
                { type: 'image', data: { url: 'https://multimedia/x' } },
              ],
            },
          ],
        },
      })
    }
    throw new Error(`unexpected url ${url}`)
  })

  const result = await makeClient().sendGroupMsg(742435777, [{ type: 'text', data: { text: deliveredText } }])
  expect(sendCalls).toBe(1)
  expect(result.message_id).toBe('-1106780317')
})

test('ambiguous timeout with proven-absent bridge copy rethrows for bounded redrive', async () => {
  let sendCalls = 0
  stubFetch(async (url) => {
    if (url.endsWith('/send_group_msg')) {
      sendCalls += 1
      throw timeoutError()
    }
    if (url.endsWith('/get_group_msg_history')) {
      return jsonRes({ status: 'ok', retcode: 0, data: { messages: [] } })
    }
    throw new Error(`unexpected url ${url}`)
  })

  await expect(makeClient().sendGroupMsg(742435777, [{ type: 'text', data: { text: 'never landed' } }])).rejects.toThrow(
    'timed out',
  )
  expect(sendCalls).toBe(1)
})

test('ambiguous timeout with unreachable history is terminal: no blind resend', async () => {
  let sendCalls = 0
  stubFetch(async (url) => {
    if (url.endsWith('/send_group_msg')) {
      sendCalls += 1
      throw timeoutError()
    }
    if (url.endsWith('/get_group_msg_history')) {
      throw refusedError()
    }
    throw new Error(`unexpected url ${url}`)
  })

  let caught: unknown
  try {
    await makeClient().sendGroupMsg(742435777, [{ type: 'text', data: { text: 'do not duplicate me' } }])
  } catch (error) {
    caught = error
  }
  expect(caught instanceof OneBotNonRetryableError).toBe(true)
  expect((caught as OneBotNonRetryableError).redrivable).toBe(false)
  expect(sendCalls).toBe(1)
})

test('never-delivered connection failures rethrow without a history reconcile', async () => {
  let sendCalls = 0
  stubFetch(async (url) => {
    if (url.endsWith('/send_group_msg')) {
      sendCalls += 1
      throw refusedError()
    }
    throw new Error(`unexpected url ${url}`)
  })

  await expect(makeClient().sendGroupMsg(742435777, [{ type: 'text', data: { text: 'retry me safely' } }])).rejects.toThrow(
    'ECONNREFUSED',
  )
  expect(sendCalls).toBe(1)
})

test('text-less payloads cannot be reconciled: ambiguous failures are terminal', async () => {
  let sendCalls = 0
  stubFetch(async (url) => {
    if (url.endsWith('/send_group_msg')) {
      sendCalls += 1
      throw timeoutError()
    }
    throw new Error(`unexpected url ${url}`)
  })

  let caught: unknown
  try {
    await makeClient().sendGroupMsg(742435777, [{ type: 'image', data: { file: 'http://x/y.png' } }])
  } catch (error) {
    caught = error
  }
  expect(caught instanceof OneBotNonRetryableError).toBe(true)
  expect(sendCalls).toBe(1)
})

test('isPossiblyDeliveredTransportError separates ambiguous from never-delivered failures', () => {
  expect(isPossiblyDeliveredTransportError(timeoutError())).toBe(true)
  expect(isPossiblyDeliveredTransportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
  // The bridge answered (any HTTP status) -> explicit verdict, not ambiguous.
  expect(isPossiblyDeliveredTransportError(Object.assign(new Error('HTTP 502'), { httpStatus: 502 }))).toBe(false)
  expect(isPossiblyDeliveredTransportError(refusedError())).toBe(false)
  expect(isPossiblyDeliveredTransportError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe(
    false,
  )
  expect(isPossiblyDeliveredTransportError(Object.assign(new Error('HTTP 429'), { httpStatus: 429 }))).toBe(false)
})
