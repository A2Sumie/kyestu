import { createHash } from 'crypto'

/**
 * Schedule webhook write-back (idol-bbq processor-schedule-webhook-service):
 * after an extract/plan processor run, normalized event candidates are POSTed
 * to the live-player schedule endpoint (production: LIVE_PLAYER_SCHEDULE_WEBHOOK_URL).
 */

export interface ScheduleWebhookOptions {
  scheduleUrl?: string | null
  scheduleApiKey?: string | null
  scheduleUserAgent?: string | null
  scheduleWafBypassHeader?: string | null
  minConfidence?: number | null
  fetchImpl?: typeof fetch
  onWarn?: (message: string) => void
}

export interface ScheduleWebhookResult {
  ok: boolean
  status: number | null
  body: unknown
  externalKey: string
  title: string
  executionTime: string
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function resolveConfigValue(value?: string | null): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (!raw.startsWith('env:')) return raw
  const envName = raw.slice('env:'.length).trim()
  return envName ? process.env[envName]?.trim() || null : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function applyHeaderLine(headers: Record<string, string>, rawHeader?: string | null): void {
  const normalized = resolveConfigValue(rawHeader) || ''
  if (!normalized) return
  const separatorIndex = normalized.indexOf(':')
  if (separatorIndex > 0) {
    const name = normalized.slice(0, separatorIndex).trim()
    const value = normalized.slice(separatorIndex + 1).trim()
    if (name && value) {
      headers[name] = value
    }
    return
  }
  headers['x-bypass-waf'] = normalized
}

export function buildScheduleWebhookHeaders(options: ScheduleWebhookOptions = {}): Record<string, string> {
  const userAgent =
    resolveConfigValue(options.scheduleUserAgent) ||
    process.env.LIVE_PLAYER_SCHEDULE_WEBHOOK_USER_AGENT?.trim() ||
    process.env.SCHEDULE_WEBHOOK_USER_AGENT?.trim() ||
    'N2NJ-Stream-Bot/1.0'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  }
  applyHeaderLine(
    headers,
    options.scheduleWafBypassHeader ||
      process.env.LIVE_PLAYER_SCHEDULE_WAF_BYPASS_HEADER ||
      process.env.SCHEDULE_WAF_BYPASS_HEADER ||
      process.env.WAF_BYPASS_HEADER,
  )
  return headers
}

export function normalizeCandidates(parsed: any): Array<any> {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return []
  if (Array.isArray(parsed.plans)) return parsed.plans
  if (Array.isArray(parsed.items)) return parsed.items
  if (Array.isArray(parsed.tasks)) return parsed.tasks
  return parsed.title ? [parsed] : []
}

function resolveExecutionTime(candidate: any): string {
  return stringValue(candidate?.executionTime) || stringValue(candidate?.starts_at)
}

function resolveScheduleType(candidate: any): string {
  const explicit = stringValue(candidate?.scheduleType)
  if (explicit) return explicit
  if (candidate?.payload?.type) return 'workflow'
  return 'reminder'
}

function stableEventKey(sourceRef: string, index: number, candidate: any): string {
  if (candidate?.externalKey) return stringValue(candidate.externalKey)
  const stableSeed = {
    index,
    title: stringValue(candidate?.title),
    executionTime: resolveExecutionTime(candidate),
    sourceUrl: stringValue(candidate?.source_url) || stringValue(candidate?.sourceUrl),
  }
  const digest = createHash('sha256').update(JSON.stringify(stableSeed)).digest('hex').slice(0, 16)
  return `${sourceRef}:event:${digest}`
}

function normalizePayload(candidate: any, sourceRef: string) {
  if (candidate?.payload && typeof candidate.payload === 'object') return candidate.payload
  const members = Array.isArray(candidate?.members)
    ? candidate.members.map((item: unknown) => stringValue(item)).filter((item: string) => item.length > 0)
    : []
  return {
    schema_version: 1,
    type: 'idol_bbq_time_event_candidate',
    sourceRef,
    eventType: stringValue(candidate?.event_type) || stringValue(candidate?.eventType) || null,
    startsAt: stringValue(candidate?.starts_at) || null,
    endsAt: stringValue(candidate?.ends_at) || null,
    timezone: stringValue(candidate?.timezone) || null,
    sourceTimeText: stringValue(candidate?.source_time_text) || stringValue(candidate?.sourceTimeText) || null,
    sourceUrl: stringValue(candidate?.source_url) || stringValue(candidate?.sourceUrl) || null,
    showroomUrl: stringValue(candidate?.showroom_url) || stringValue(candidate?.showroomUrl) || null,
    members,
    confidence: numberValue(candidate?.confidence),
    needsReview: candidate?.needs_review === true || candidate?.needsReview === true,
  }
}

export function buildScheduleWebhookPayload(candidate: any, sourceRef: string, index: number, apiKey: string | null) {
  const title = stringValue(candidate?.title)
  const executionTime = resolveExecutionTime(candidate)
  if (!title || !executionTime) return null
  const date = new Date(executionTime)
  if (Number.isNaN(date.getTime())) return null

  return {
    title,
    description:
      stringValue(candidate?.description) ||
      stringValue(candidate?.notes) ||
      stringValue(candidate?.source_time_text) ||
      null,
    externalKey: stableEventKey(sourceRef, index, candidate),
    scheduleType: resolveScheduleType(candidate),
    executionTime,
    recurrence: stringValue(candidate?.recurrence) || null,
    payload: normalizePayload(candidate, sourceRef),
    ...(apiKey ? { apiKey } : {}),
  }
}

export async function writeSchedulesFromProcessorResult(
  parsed: any,
  sourceRef: string,
  options: ScheduleWebhookOptions = {},
): Promise<ScheduleWebhookResult[]> {
  const targetUrl = resolveConfigValue(options.scheduleUrl) || process.env.SCHEDULE_WEBHOOK_URL?.trim()
  if (!targetUrl) return []

  const apiKey = resolveConfigValue(options.scheduleApiKey) || process.env.SCHEDULE_WEBHOOK_API_KEY?.trim() || null
  const minConfidence =
    typeof options.minConfidence === 'number' && Number.isFinite(options.minConfidence) ? options.minConfidence : null
  const fetcher = options.fetchImpl || fetch
  const candidates = normalizeCandidates(parsed)
  const results: ScheduleWebhookResult[] = []
  const headers = buildScheduleWebhookHeaders(options)

  for (const [index, candidate] of candidates.entries()) {
    const confidence = numberValue(candidate?.confidence)
    if (minConfidence !== null && (confidence === null || confidence < minConfidence)) continue

    const payload = buildScheduleWebhookPayload(candidate, sourceRef, index, apiKey)
    if (!payload) continue

    try {
      const response = await fetcher(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      results.push({
        ok: response.ok,
        status: response.status,
        body: tryParseJson(text) || text,
        externalKey: payload.externalKey,
        title: payload.title,
        executionTime: payload.executionTime,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.onWarn?.(`Schedule webhook failed for ${payload.externalKey}: ${message}`)
      results.push({
        ok: false,
        status: null,
        body: { error: message },
        externalKey: payload.externalKey,
        title: payload.title,
        executionTime: payload.executionTime,
      })
    }
  }

  return results
}
