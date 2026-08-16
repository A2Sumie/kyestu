import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Live relay (beta): watch a profile's live status; while live, record the
 * m3u8 with ffmpeg and sync state to the live-player service.
 * The player API surface matches tv.n2nj.moe's relay sync; adjust syncPayload
 * if the player changes.
 */

export interface LiveRelayTarget {
  player_id?: string
  player_name?: string
  live_player_url: string
  auth_username?: string
  auth_password?: string
  waf_bypass_header?: string
  sync_interval_seconds?: number
}

export interface LiveRelayConfig {
  enabled?: boolean
  archive_root?: string
  targets?: Record<string, LiveRelayTarget>
}

export interface LiveStatus {
  live: boolean
  m3u8?: string
  title?: string
}

export class LiveRelay {
  private sessions = new Map<string, { proc: ChildProcess; file: string }>()

  constructor(
    private readonly config: LiveRelayConfig,
    private readonly spawnFfmpeg: (args: string[]) => ChildProcess = (args) => spawn('ffmpeg', args),
  ) {}

  private archiveRoot(): string {
    const root = this.config.archive_root ?? 'cache/live'
    mkdirSync(root, { recursive: true })
    return root
  }

  isRecording(handle: string): boolean {
    return this.sessions.has(handle)
  }

  async sync(handle: string, status: LiveStatus): Promise<void> {
    const target = this.config.targets?.[handle]
    if (!target) return
    const active = this.sessions.get(handle)
    if (status.live && status.m3u8 && !active) {
      const file = join(this.archiveRoot(), `${handle}-${Date.now()}.ts`)
      const proc = this.spawnFfmpeg(['-y', '-i', status.m3u8, '-c', 'copy', file])
      this.sessions.set(handle, { proc, file })
      proc.on('error', () => this.sessions.delete(handle))
      await this.post(target, { handle, status: 'live', title: status.title, file })
    } else if (!status.live && active) {
      active.proc.kill('SIGINT')
      this.sessions.delete(handle)
      await this.post(target, { handle, status: 'ended', file: active.file })
    }
  }

  private async post(target: LiveRelayTarget, payload: Record<string, unknown>): Promise<void> {
    const url = `${target.live_player_url.replace(/\/+$/, '')}/api/relay/sync`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (target.auth_username) {
      headers.Authorization = `Basic ${Buffer.from(`${target.auth_username}:${target.auth_password ?? ''}`).toString('base64')}`
    }
    if (target.waf_bypass_header) headers['x-n2nj-pass'] = target.waf_bypass_header
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ player_id: target.player_id, player_name: target.player_name, ...payload }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
  }

  async stopAll(): Promise<void> {
    for (const [, session] of this.sessions) session.proc.kill('SIGINT')
    this.sessions.clear()
  }
}
