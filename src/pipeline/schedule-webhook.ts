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
  /** allowlisted scheduleType values (default: the downstream's reminder|workflow|stream) */
  scheduleTypes?: string[]
  /** allowlisted workflow payload.type values (default: the downstream's three stream actions) */
  workflowTypes?: string[]
}

/**
 * Model-output policy (daybreak 2026-10-08 finding 7). The downstream
 * live-player scheduler executes scheduleType ∈ {reminder, workflow, stream}
 * and, for workflow/stream, payload.type ∈ {start,stop,update_network_stream} —
 * those three start and stop real network streams. Article text is
 * publisher-controlled and reaches the model, so the write-back clamps the
 * privileged shape to what the downstream can actually execute instead of
 * forwarding whatever the model emitted. Extending the downstream means
 * extending these lists (env: KYESTU_SCHEDULE_TYPES /
 * KYESTU_SCHEDULE_WORKFLOW_TYPES); nothing outside them is dropped silently —
 * it degrades to a reminder candidate, which still gets created.
 */
export interface SchedulePolicy {
  scheduleTypes: string[]
  workflowTypes: string[]
}

const DEFAULT_SCHEDULE_TYPES = ['reminder', 'workflow', 'stream']
const DEFAULT_WORKFLOW_TYPES = ['start_network_stream', 'stop_network_stream', 'update_network_stream']

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return values.length ? values : fallback
}

export function resolveSchedulePolicy(options: ScheduleWebhookOptions = {}): SchedulePolicy {
  return {
    scheduleTypes: options.scheduleTypes?.length
      ? options.scheduleTypes
      : envList('KYESTU_SCHEDULE_TYPES', DEFAULT_SCHEDULE_TYPES),
    workflowTypes: options.workflowTypes?.length
      ? options.workflowTypes
      : envList('KYESTU_SCHEDULE_WORKFLOW_TYPES', DEFAULT_WORKFLOW_TYPES),
  }
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

function resolveScheduleType(candidate: any, explicitWorkflowShaped: boolean, policy: SchedulePolicy): string {
  const explicit = stringValue(candidate?.scheduleType)
  let type = explicit || (explicitWorkflowShaped ? 'workflow' : 'reminder')
  // unknown types are not forwarded (the downstream throws on them anyway) and
  // a workflow/stream without an executable payload shape cannot run there
  if (!policy.scheduleTypes.includes(type)) type = 'reminder'
  if ((type === 'workflow' || type === 'stream') && !explicitWorkflowShaped) type = 'reminder'
  return type
}

function stableEventKey(sourceRef: string, index: number, candidate: any): string {
  const stableSeed = {
    index,
    title: stringValue(candidate?.title),
    executionTime: resolveExecutionTime(candidate),
    sourceUrl: stringValue(candidate?.source_url) || stringValue(candidate?.sourceUrl),
  }
  const digest = createHash('sha256').update(JSON.stringify(stableSeed)).digest('hex').slice(0, 16)
  const derived = `${sourceRef}:event:${digest}`
  const explicit = stringValue(candidate?.externalKey)
  if (!explicit) return derived
  // model-supplied keys stay supported (they keep upserts stable across
  // re-parses) but are namespaced under the source: externalKey is UNIQUE in
  // the downstream and it upserts on it, so a bare model key could adopt — and
  // overwrite — a schedule owned by another source or system (daybreak finding 7)
  return `${sourceRef}:ext:${explicit.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 64)}`
}

function normalizePayload(candidate: any, sourceRef: string) {
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

export function buildScheduleWebhookPayload(
  candidate: any,
  sourceRef: string,
  index: number,
  apiKey: string | null,
  policy: SchedulePolicy = resolveSchedulePolicy(),
) {
  const title = stringValue(candidate?.title)
  const executionTime = resolveExecutionTime(candidate)
  if (!title || !executionTime) return null
  const date = new Date(executionTime)
  if (Number.isNaN(date.getTime())) return null

  // a model payload is forwarded only when its type is a workflow the
  // downstream can execute; anything else becomes the locally constructed
  // candidate schema (no free-form object reaches the schedule service)
  const rawPayload = candidate?.payload && typeof candidate.payload === 'object' ? candidate.payload : null
  const workflowShaped = Boolean(rawPayload && policy.workflowTypes.includes(stringValue(rawPayload.type)))

  return {
    title,
    description:
      stringValue(candidate?.description) ||
      stringValue(candidate?.notes) ||
      stringValue(candidate?.source_time_text) ||
      null,
    externalKey: stableEventKey(sourceRef, index, candidate),
    scheduleType: resolveScheduleType(candidate, workflowShaped, policy),
    executionTime,
    recurrence: stringValue(candidate?.recurrence) || null,
    payload: workflowShaped ? rawPayload : normalizePayload(candidate, sourceRef),
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

    const payload = buildScheduleWebhookPayload(candidate, sourceRef, index, apiKey, resolveSchedulePolicy(options))
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
