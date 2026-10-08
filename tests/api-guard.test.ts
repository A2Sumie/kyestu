import { test, expect, afterAll } from 'bun:test'
import { request } from 'http'
import { apiComponent, type StatusView } from '../src/components/api'

/**
 * Control-plane fail-closed policy (daybreak 2026-10-08 finding 3): a missing
 * or empty secret must refuse to start rather than silently skip the only
 * route guard, and a configured secret must cover every route — including the
 * state-changing POST /api/reload?force=1.
 *
 * Requests go through node:http with a per-request connection: global fetch is
 * a keep-alive pool shared with every other test file (and is mocked by some of
 * them), which makes cross-file runs flaky and hides who answered.
 */

const status: StatusView = { entries: 0, fibers: [] }
const stopFns: Array<() => void> = []
afterAll(() => {
  while (stopFns.length) stopFns.pop()!()
})

function serve(config: Record<string, unknown>): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('ok') })
  const port = probe.port
  probe.stop(true)
  if (!port) throw new Error('probe server did not bind a tcp port')
  const stop = apiComponent.apply({} as never, { port, ...config } as never) as () => void
  stopFns.push(stop)
  return port
}

/** one fresh connection per request; resolves with the status code */
function statusOf(port: number, path: string, method = 'GET', auth?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, agent: false, headers: auth ? { authorization: `Bearer ${auth}` } : {} },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('api: refuses to start an unauthenticated control plane by default', () => {
  expect(() => apiComponent.apply({} as never, { port: 0 })).toThrow('api.secret is empty')
  expect(() => apiComponent.apply({} as never, { port: 0, secret: '   ' })).toThrow('api.secret is empty')
})

test('api: allow_insecure is an explicit opt-in that serves without a token', async () => {
  const port = serve({ allow_insecure: true, onStatus: () => status })
  expect(await statusOf(port, '/api/status')).toBe(200)
})

test('api: KYESTU_API_INSECURE=1 is the documented dev escape hatch', async () => {
  const previous = process.env.KYESTU_API_INSECURE
  process.env.KYESTU_API_INSECURE = '1'
  try {
    const port = serve({ onStatus: () => status })
    expect(await statusOf(port, '/api/status')).toBe(200)
  } finally {
    if (previous === undefined) delete process.env.KYESTU_API_INSECURE
    else process.env.KYESTU_API_INSECURE = previous
  }
})

test('api: secret enforces Bearer on every route, reload included', async () => {
  let reloads = 0
  const port = serve({
    secret: 's3cret',
    onStatus: () => status,
    onReload: async () => {
      reloads += 1
      return { ok: true }
    },
  })

  expect(await statusOf(port, '/api/status')).toBe(401)
  expect(await statusOf(port, '/api/status', 'GET', 'wrong')).toBe(401)
  expect(await statusOf(port, '/api/cookie-health')).toBe(401)
  expect(await statusOf(port, '/api/reload?force=1', 'POST')).toBe(401)
  expect(reloads).toBe(0)

  expect(await statusOf(port, '/api/status', 'GET', 's3cret')).toBe(200)
  expect(await statusOf(port, '/api/reload?force=1', 'POST', 's3cret')).toBe(200)
  expect(reloads).toBe(1)
})
