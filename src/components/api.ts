import type { Component } from '../core/types'
import type { Root } from '../core/runtime'

export interface StatusFiberView {
  name: string
  state: string
  uid: string
  /** recorded recovery faults (inverse/guard/apply/listener), oldest first */
  taints: Array<{ phase: string; message: string; at: number }>
  /** apply-failure error message; present only while state === 'FAILED' */
  outcome?: string
  /** recovery escape hatch; present only while state === 'FAILED' */
  hint?: string
}

export interface StatusView {
  entries: number
  fibers: StatusFiberView[]
}

/**
 * /api/status payload. Beyond name/state/uid this surfaces each fiber's
 * taints and (for FAILED fibers) the apply-failure outcome — otherwise a
 * permanently muted fiber is invisible in production (review §2.5/§3.3).
 * The hint points at the force-reload escape hatch instead of adding a
 * dedicated reset endpoint.
 */
export function statusView(root: Root, entries: number): StatusView {
  return {
    entries,
    fibers: [...root.fibers].map((fiber) => {
      const view: StatusFiberView = {
        name: fiber.name,
        state: fiber.state,
        uid: fiber.uid,
        taints: fiber.taints.map((taint) => ({
          phase: taint.phase,
          message: taint.error instanceof Error ? taint.error.message : String(taint.error),
          at: taint.at,
        })),
      }
      if (fiber.state === 'FAILED') {
        view.outcome = fiber.outcome instanceof Error ? fiber.outcome.message : String(fiber.outcome)
        view.hint = 'recover with POST /api/reload?force=1 (resets FAILED fibers in place)'
      }
      return view
    }),
  }
}

export interface ApiControl {
  onStatus?: () => StatusView
  onReload?: (options?: { force?: boolean }) => Promise<unknown>
  /** read-only session-health view (cookie-keepalive overview), optional */
  onCookieHealth?: () => unknown
}

export const apiComponent: Component<{ port?: number; secret?: string } & ApiControl> = {
  knownWithKeys: ['port', 'secret', 'onStatus', 'onReload', 'onCookieHealth'],
  apply: (ctx, config) => {
    const port = config.port ?? 3000
    const secret = config.secret
    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url)
        if (secret) {
          const auth = req.headers.get('authorization')
          if (auth !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        if (url.pathname === '/api/status' && req.method === 'GET') {
          return Response.json(config.onStatus?.() ?? { ok: true })
        }
        if (url.pathname === '/api/cookie-health' && req.method === 'GET') {
          return Response.json(config.onCookieHealth?.() ?? { error: 'cookie-health not available' }, {
            status: config.onCookieHealth ? 200 : 404,
          })
        }
        if (url.pathname === '/api/reload' && req.method === 'POST') {
          try {
            const force = ['1', 'true'].includes(url.searchParams.get('force') ?? '')
            return Response.json((await config.onReload?.({ force })) ?? { ok: true })
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
          }
        }
        return Response.json({ error: 'not found' }, { status: 404 })
      },
    })
    return () => server.stop(true)
  },
}
