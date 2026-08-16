/**
 * Crawler schedule math, ported from idol-bbq crawler-schedule-service.
 * Supports hot_schedule slots/windows, legacy daily crons, stable per-crawler jitter,
 * min-gap clamping, and JST/UTC timezones.
 */

const DEFAULT_TIMEZONE = 'Asia/Tokyo'
const JST_OFFSET_MINUTES = 9 * 60
const DEFAULT_TICK_SECONDS = 15
const DEFAULT_MIN_GAP_SECONDS = 60

export type ScheduleSlotInput = string | { time: string; days?: Array<number | string> }

export interface ScheduleWindowInput {
  start: string
  end: string
  every_minutes: number
  offset_minutes?: number
  days?: Array<number | string>
}

export interface HotScheduleConfig {
  enabled?: boolean
  timezone?: string
  slots?: ScheduleSlotInput[]
  windows?: ScheduleWindowInput[]
  min_gap_seconds?: number
  jitter_seconds?: number
  tick_seconds?: number
}

export interface ScheduleSlot {
  minuteOfDay: number
  days?: number[]
}

export interface ResolvedSchedule {
  timezone: string
  timezoneOffsetMinutes: number
  timezoneUnsupported?: boolean
  slots: ScheduleSlot[]
  minGapSeconds: number
  jitterSeconds: number
  tickSeconds: number
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) return fallback
  return Math.max(min, Math.min(Math.trunc(normalized), max))
}

function resolveTimezoneOffset(timezone: string | undefined): { offsetMinutes: number; valid: boolean } {
  const normalized = String(timezone || DEFAULT_TIMEZONE).trim()
  if (normalized === DEFAULT_TIMEZONE) return { offsetMinutes: JST_OFFSET_MINUTES, valid: true }
  if (normalized === 'UTC') return { offsetMinutes: 0, valid: true }
  return { offsetMinutes: JST_OFFSET_MINUTES, valid: false }
}

function parseClockToMinuteOfDay(value: string): number | null {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function normalizeDays(days?: Array<number | string>) {
  if (!Array.isArray(days) || days.length === 0) return undefined
  const normalized = [...new Set(days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  )
  return normalized.length > 0 ? normalized : undefined
}

function expandWindow(window: ScheduleWindowInput): ScheduleSlot[] {
  const start = parseClockToMinuteOfDay(window.start)
  const end = parseClockToMinuteOfDay(window.end)
  const everyMinutes = clampInteger(window.every_minutes, 0, 1, 24 * 60)
  if (start === null || end === null || everyMinutes <= 0) return []
  const days = normalizeDays(window.days)
  const offset = clampInteger(window.offset_minutes, 0, 0, everyMinutes - 1)
  const spanEnd = end < start ? end + 24 * 60 : end
  const slots: ScheduleSlot[] = []
  for (let minute = start + offset; minute <= spanEnd; minute += everyMinutes) {
    slots.push({ minuteOfDay: minute % (24 * 60), days })
  }
  return slots
}

function parseCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const token of String(field || '').split(',')) {
    const [rangePart, stepPart] = token.trim().split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step <= 0) return null
    let start = min
    let end = max
    if (rangePart && rangePart !== '*') {
      const m = rangePart.match(/^(\d+)(?:-(\d+))?$/)
      if (!m) return null
      start = Number(m[1])
      end = m[2] === undefined ? start : Number(m[2])
    }
    if (start < min || end > max || start > end) return null
    for (let v = start; v <= end; v += step) values.add(v)
  }
  return [...values].sort((a, b) => a - b)
}

function expandLegacyCron(cron: string | undefined | null): ScheduleSlot[] {
  const parts = String(cron || '').trim().split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) return []
  const cronParts = parts.length === 6 ? parts.slice(1) : parts
  const [minuteField, hourField, dom, month, dow] = cronParts
  if (dom !== '*' || month !== '*' || dow !== '*') return []
  const minutes = parseCronField(minuteField!, 0, 59)
  const hours = parseCronField(hourField!, 0, 23)
  if (!minutes || !hours) return []
  return hours.flatMap((hour) => minutes.map((minute) => ({ minuteOfDay: hour * 60 + minute })))
}

function normalizeSlots(slots: ScheduleSlot[]): ScheduleSlot[] {
  const byMinute = new Map<number, Set<number> | null>()
  for (const slot of slots) {
    const minuteOfDay = ((slot.minuteOfDay % 1440) + 1440) % 1440
    const days = slot.days?.length ? slot.days : undefined
    const existing = byMinute.get(minuteOfDay)
    if (existing === null || days === undefined) {
      byMinute.set(minuteOfDay, null)
      continue
    }
    if (existing === undefined) {
      byMinute.set(minuteOfDay, new Set(days))
      continue
    }
    for (const day of days) existing.add(day)
  }
  return [...byMinute.entries()]
    .map(([minuteOfDay, daySet]) => ({ minuteOfDay, days: daySet ? [...daySet].sort((a, b) => a - b) : undefined }))
    .sort((a, b) => a.minuteOfDay - b.minuteOfDay)
}

export interface CrawlerScheduleSource {
  schedule?: HotScheduleConfig
  hot_schedule?: HotScheduleConfig
  cron?: string
  timezone?: string
}

export function resolveCrawlerSchedule(cfg: CrawlerScheduleSource): ResolvedSchedule | null {
  const schedule = cfg.schedule || cfg.hot_schedule
  let slots: ScheduleSlot[]
  if (schedule) {
    if (schedule.enabled === false) return null
    slots = [
      ...(schedule.slots ?? [])
        .map((slot) => {
          if (typeof slot === 'string') {
            const minuteOfDay = parseClockToMinuteOfDay(slot)
            return minuteOfDay === null ? null : { minuteOfDay }
          }
          const minuteOfDay = parseClockToMinuteOfDay(slot.time)
          return minuteOfDay === null ? null : { minuteOfDay, days: normalizeDays(slot.days) }
        })
        .filter((slot): slot is ScheduleSlot => Boolean(slot)),
      ...(schedule.windows ?? []).flatMap(expandWindow),
    ]
  } else {
    slots = expandLegacyCron(cfg.cron)
  }
  const normalized = normalizeSlots(slots)
  if (normalized.length === 0) return null
  const timezone = schedule?.timezone || cfg.timezone || DEFAULT_TIMEZONE
  const { offsetMinutes, valid } = resolveTimezoneOffset(timezone)
  return {
    timezone,
    timezoneOffsetMinutes: offsetMinutes,
    timezoneUnsupported: !valid,
    slots: normalized,
    minGapSeconds: clampInteger(schedule?.min_gap_seconds, DEFAULT_MIN_GAP_SECONDS, 0, 24 * 60 * 60),
    jitterSeconds: clampInteger(schedule?.jitter_seconds, 0, 0, 10 * 60),
    tickSeconds: clampInteger(schedule?.tick_seconds, DEFAULT_TICK_SECONDS, 1, 60),
  }
}

function stableJitterSeconds(key: string, jitterSeconds: number): number {
  if (jitterSeconds <= 0) return 0
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return (hash % (jitterSeconds * 2 + 1)) - jitterSeconds
}

export function nextRunAt(schedule: ResolvedSchedule, afterEpochSeconds: number, crawlerName = ''): number | null {
  const offset = schedule.timezoneOffsetMinutes
  const anchor = new Date((afterEpochSeconds + offset * 60) * 1000)
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const dayDate = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + dayOffset))
    const localDayOfWeek = dayDate.getUTCDay()
    const midnight =
      Math.floor(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate()) / 1000) - offset * 60
    for (const slot of schedule.slots) {
      if (slot.days && !slot.days.includes(localDayOfWeek)) continue
      const base = midnight + slot.minuteOfDay * 60
      let jittered = base + stableJitterSeconds(`${crawlerName}:${base}`, schedule.jitterSeconds)
      jittered = Math.max(jittered, afterEpochSeconds + schedule.minGapSeconds)
      if (jittered > afterEpochSeconds) return jittered
    }
  }
  return null
}
