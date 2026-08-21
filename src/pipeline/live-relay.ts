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

/**
 * Credential hygiene (sa7 §6.4): the stream url's query (`sign` is the only
 * credential; `expire`/`lsb_session_id` ride along) must not land in logs or
 * bus events. ffmpeg argv keeps the full url; everything published is stripped.
 */
export function stripStreamUrlQuery(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

interface Session {
  proc: ChildProcess
  file: string
  /** set before an intentional kill so the exit handler stays quiet */
  stopping: boolean
}

export class LiveRelay {
  private sessions = new Map<string, Session>()

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
      const session: Session = { proc, file, stopping: false }
      this.sessions.set(handle, session)
      proc.on('error', () => {
        if (this.sessions.get(handle) === session) this.sessions.delete(handle)
      })
      // stream death recovery (sa7 §6.3): pull urls die with the session
      // (offline room = 404), so ffmpeg exits on its own when the stream
      // drops. Clear the session here so the next probe round re-opens
      // recording with a fresh url; intentional kills (stop flag) stay quiet.
      proc.on('exit', () => {
        if (this.sessions.get(handle) !== session) return
        this.sessions.delete(handle)
        if (!session.stopping) {
          void Promise.resolve(this.onEvent?.({ type: 'ended', handle, file })).catch(() => null)
        }
      })
      await this.onEvent?.({ type: 'live', handle, title: status.title, file, m3u8: stripStreamUrlQuery(status.m3u8) })
    } else if (!status.live && active) {
      active.stopping = true
      active.proc.kill('SIGINT')
      this.sessions.delete(handle)
      await this.onEvent?.({ type: 'ended', handle, file: active.file })
    }
  }

  async stopAll(): Promise<void> {
    for (const [, session] of this.sessions) {
      session.stopping = true
      session.proc.kill('SIGINT')
    }
    this.sessions.clear()
  }
}
