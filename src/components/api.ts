import type { Component } from '../core/types'
import type { Root } from '../core/runtime'
import { existsSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { verifyMediaToken } from '../pipeline/onebot-media'

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
  /** QQ message recall (`delete_msg`) — explicit ops API, optional */
  onQqRecall?: (messageIds: Array<number | string>) => Promise<unknown>
  /** QQ send receipt verification (`get_msg`), optional */
  onQqReceipts?: (outboundId: number) => Promise<unknown>
  /** QQ bridge health snapshot, optional */
  onQqHealth?: () => unknown
}

export interface ApiMediaConfig {
  /** directory served at /media/<name> (usually the media store root) */
  root: string
  /** HMAC secret for signed URLs; defaults to the control-plane secret */
  secret?: string
}

export const apiComponent: Component<
  { port?: number; secret?: string; allow_insecure?: boolean; media?: ApiMediaConfig } & ApiControl
> = {
  knownWithKeys: ['port', 'secret', 'allow_insecure', 'media', 'qq_target', 'onStatus', 'onReload', 'onCookieHealth', 'onQqRecall', 'onQqReceipts', 'onQqHealth'],
  apply: (ctx, config) => {
    const port = config.port ?? 3000
    const secret = typeof config.secret === 'string' ? config.secret.trim() : ''
    // fail closed: an unauthenticated control plane is an opt-in, never a
    // default. An empty/absent secret would otherwise silently skip the only
    // route guard and expose /api/status, /api/cookie-health and the
    // state-changing POST /api/reload?force=1 to anyone who can reach the port
    // (daybreak 2026-10-08 finding 3).
    const allowInsecure = config.allow_insecure === true || process.env.KYESTU_API_INSECURE === '1'
    if (!secret && !allowInsecure) {
      throw new Error(
        'api.secret is empty: refusing to start an unauthenticated control plane. ' +
          'Set `secret` (e.g. `secret: env:KYESTU_API_SECRET`) or explicitly opt in with `allow_insecure: true` (dev only).',
      )
    }
    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url)
        // media delivery for bridge-side URL downloads: no Bearer header is
        // possible on a plain GET, so access is a signed, expiring query token
        // (HMAC over name+exp). Opt-in via `media: { root, secret }`.
        if (url.pathname.startsWith('/media/')) {
          const media = config.media
          if (!media) return Response.json({ error: 'media serving not enabled' }, { status: 404 })
          const name = decodeURIComponent(url.pathname.slice('/media/'.length))
          const exp = Number(url.searchParams.get('exp') ?? 0)
          const sig = url.searchParams.get('sig') ?? ''
          const mediaSecret = media.secret ?? secret
          if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || name.includes(sep)) {
            return Response.json({ error: 'bad name' }, { status: 400 })
          }
          if (!verifyMediaToken(name, exp, sig, mediaSecret)) {
            return Response.json({ error: 'invalid or expired media token' }, { status: 403 })
          }
          const filePath = resolve(join(media.root, name))
          if (!filePath.startsWith(resolve(media.root) + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
            return Response.json({ error: 'not found' }, { status: 404 })
          }
          return new Response(Bun.file(filePath), {
            headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
          })
        }
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
        if (url.pathname === '/api/qq/health' && req.method === 'GET') {
          return Response.json(config.onQqHealth?.() ?? { error: 'qq target not available' }, {
            status: config.onQqHealth ? 200 : 404,
          })
        }
        if (url.pathname === '/api/qq/recall' && req.method === 'POST') {
          if (!config.onQqRecall) return Response.json({ error: 'qq target not available' }, { status: 404 })
          try {
            const body = (await req.json()) as { message_ids?: unknown }
            const messageIds = Array.isArray(body?.message_ids) ? body.message_ids.map((id) => (typeof id === 'number' || typeof id === 'string' ? id : String(id))) : null
            if (!messageIds || messageIds.length === 0) return Response.json({ error: 'message_ids required' }, { status: 400 })
            return Response.json(await config.onQqRecall(messageIds))
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
          }
        }
        if (url.pathname === '/api/qq/receipts' && req.method === 'POST') {
          if (!config.onQqReceipts) return Response.json({ error: 'qq target not available' }, { status: 404 })
          try {
            const body = (await req.json()) as { outbound_id?: unknown }
            const outboundId = Number(body?.outbound_id)
            if (!Number.isInteger(outboundId)) return Response.json({ error: 'outbound_id required' }, { status: 400 })
            return Response.json(await config.onQqReceipts(outboundId))
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
