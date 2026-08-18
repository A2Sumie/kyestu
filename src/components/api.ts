import type { Component } from '../core/types'

export interface ApiControl {
  onStatus?: () => unknown
  onReload?: () => Promise<unknown>
  /** read-only session-health view (cookie-keepalive overview), optional */
  onCookieHealth?: () => unknown
}

export const apiComponent: Component<{ port?: number; secret?: string } & ApiControl> = {
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
            return Response.json((await config.onReload?.()) ?? { ok: true })
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
