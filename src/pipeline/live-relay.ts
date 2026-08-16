import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Live relay capture: watch a profile's live status; while live, record the
 * m3u8 with ffmpeg. Pure capture/session lifecycle — syncing state to a
 * live-player service (e.g. tv.n2nj.moe) is the `app/live-player` plugin's
 * job, driven by the events emitted here.
 */

export interface LiveRelayConfig {
  enabled?: boolean
  archive_root?: string
}

export interface LiveRelayEvent {
  type: 'live' | 'ended'
  handle: string
  title?: string
  file: string
  m3u8?: string
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
    private readonly onEvent?: (event: LiveRelayEvent) => void | Promise<void>,
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
    const active = this.sessions.get(handle)
    if (status.live && status.m3u8 && !active) {
      const file = join(this.archiveRoot(), `${handle}-${Date.now()}.ts`)
      const proc = this.spawnFfmpeg(['-y', '-i', status.m3u8, '-c', 'copy', file])
      this.sessions.set(handle, { proc, file })
      proc.on('error', () => this.sessions.delete(handle))
      await this.onEvent?.({ type: 'live', handle, title: status.title, file, m3u8: status.m3u8 })
    } else if (!status.live && active) {
      active.proc.kill('SIGINT')
      this.sessions.delete(handle)
      await this.onEvent?.({ type: 'ended', handle, file: active.file })
    }
  }

  async stopAll(): Promise<void> {
    for (const [, session] of this.sessions) session.proc.kill('SIGINT')
    this.sessions.clear()
  }
}
