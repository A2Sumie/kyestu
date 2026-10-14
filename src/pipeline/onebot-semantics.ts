/**
 * OneBot response / failure semantics — pure functions, no I/O.
 *
 * Two bridge dialects must be classified correctly at the same call sites:
 *
 * - NapCat (legacy): business refusals surface as `retcode = 200` with an
 *   EventChecker `result = 120` payload (bot muted / risk-controlled). The
 *   historical kyestu/idol-bbq rule maps that shape to "non-retryable".
 * - SnowLuma: `status:"ok", retcode:0` is the only success. Everything else is
 *   `status:"failed"` with `retcode:100` (ACTION_FAILED, wording carries the
 *   reason / QQ server code), `1400` (bad request / segment validation),
 *   `1401` (unauthorized), `1404` (unknown action), `1413` (payload too
 *   large), `1200` (internal error). There is no `retcode:200` shape.
 *
 * The verdict carries two independent axes so callers do not conflate them:
 *
 * - `retryable`: may the identical payload be retried right now (chunk loop)?
 * - `redrivable`: may the article be re-driven later (router requeue)?
 *
 * Wording-derived business classes (`muted`, `risk_control`, …) decide both
 * axes and feed the cooldown table in pipeline/cooldown.ts.
 */

export type OneBotDialect = 'napcat' | 'snowluma' | 'generic'

export type OneBotFailureKind =
  | 'business' // retcode 100 (SnowLuma ACTION_FAILED) or any other non-zero business retcode
  | 'rejected' // NapCat EventChecker refusal (retcode 200 / result 120)
  | 'bad_request' // 1400
  | 'unauthorized' // 1401 / HTTP 401-403
  | 'unknown_action' // 1404
  | 'payload_too_large' // 1413 / HTTP 413
  | 'internal' // 1200 / HTTP 5xx
  | 'transport' // network error / timeout / aborted
  | 'unknown'

/** wording-derived business subclass (bilingual patterns, see classifyWording) */
export type OneBotFailureClass =
  | 'muted' // 禁言 / muted
  | 'risk_control' // 风控 / 冻结 / risk control
  | 'missing_target' // 群/好友不存在、已退群、被踢
  | 'permission' // 无权限 / forbidden
  | 'rate_limit' // 频率限制 / flood
  | 'temporary' // 稍后重试 / busy
  | 'other'

export interface OneBotFailure {
  ok: false
  kind: OneBotFailureKind
  failureClass: OneBotFailureClass
  /** identical-payload retry allowed right now */
  retryable: boolean
  /** the article may be re-driven later (bounded by the router/outbound caps) */
  redrivable: boolean
  retcode: number | null
  status: string | null
  wording: string
  /** dialect this response shape points at (retcode 200 => napcat, 100/1400/… => snowluma) */
  dialectHint: OneBotDialect | null
}

export type OneBotVerdict = { ok: true } | OneBotFailure

// ── wording classification (order matters: most specific first) ──────────────

const WORDING_PATTERNS: Array<[OneBotFailureClass, RegExp]> = [
  ['muted', /禁言|被禁|muted|bot is muted|全体禁言/i],
  ['rate_limit', /频率|限流|限速|太快|操作过于频繁|flood|rate.?limit|too many requests|slow down/i],
  ['risk_control', /风控|风险控制|安全限制|冻结|账号异常|举报|risk.?control|frozen|security.?check/i],
  ['missing_target', /不存在|已退群|被踢|被移出|已解散|no such|not found|not in (the )?group|unknown (group|user|member)|has left/i],
  ['permission', /权限|无权|不允许|仅管理员|permission|forbidden|not allowed|admin(istrator)? only/i],
  ['temporary', /稍后|重试|临时|繁忙|busy|try again|temporar|unavailable/i],
]

export function classifyWording(wording: string): OneBotFailureClass {
  for (const [klass, pattern] of WORDING_PATTERNS) {
    if (pattern.test(wording)) return klass
  }
  return 'other'
}

// ── axis tables ──────────────────────────────────────────────────────────────

/** per failure kind/class: (retryable, redrivable) */
const AXES: Record<OneBotFailureKind, { retryable: boolean; redrivable: boolean }> = {
  // business failures: wording subclass decides (see businessAxes)
  business: { retryable: true, redrivable: true },
  // NapCat EventChecker refusal: re-sending the identical payload just spams
  // the API during the outage (historical rule, kept verbatim)
  rejected: { retryable: false, redrivable: true },
  // fix-the-config classes: retrying the identical request can never succeed
  bad_request: { retryable: false, redrivable: false },
  unauthorized: { retryable: false, redrivable: false },
  unknown_action: { retryable: false, redrivable: false },
  payload_too_large: { retryable: false, redrivable: false },
  internal: { retryable: true, redrivable: true },
  transport: { retryable: true, redrivable: true },
  unknown: { retryable: true, redrivable: true },
}

const BUSINESS_AXES: Record<OneBotFailureClass, { retryable: boolean; redrivable: boolean }> = {
  // muted / risk-controlled: retrying right away spams; re-drive later only
  // (the QQ health circuit also opens — see pipeline/qq-health.ts)
  muted: { retryable: false, redrivable: true },
  risk_control: { retryable: false, redrivable: true },
  rate_limit: { retryable: false, redrivable: true },
  temporary: { retryable: true, redrivable: true },
  // the target is gone / forbidden: no amount of re-driving helps
  missing_target: { retryable: false, redrivable: false },
  permission: { retryable: false, redrivable: false },
  other: { retryable: true, redrivable: true },
}

export function axesFor(kind: OneBotFailureKind, failureClass: OneBotFailureClass): { retryable: boolean; redrivable: boolean } {
  return kind === 'business' ? BUSINESS_AXES[failureClass] : AXES[kind]
}

// ── response classification ─────────────────────────────────────────────────

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function wordingOf(data: any): string {
  return String(data?.wording ?? data?.message ?? data?.msg ?? data?.error ?? data?.message ?? '')
}

/**
 * Classify a parsed OneBot API response body
 * (`{status, retcode, data, wording, echo}`).
 */
export function classifyOneBotResponse(data: any): OneBotVerdict {
  const status = String(data?.status ?? '').trim().toLowerCase()
  const retcode = asNumber(data?.retcode)
  const wording = wordingOf(data)
  const success = (status === '' || status === 'ok') && (retcode === null || retcode === 0)
  if (success) return { ok: true }

  // NapCat EventChecker refusal: retcode 200, or a `result: 120` payload in
  // either the data or the body (FI-02 pins the `result=120` wording).
  const resultCode = asNumber((data?.data as any)?.result ?? (data as any)?.result)
  const napcatRejection = retcode === 200 || resultCode === 120 || /result[=:]\s*120\b/.test(wording)

  let kind: OneBotFailureKind
  if (napcatRejection) kind = 'rejected'
  else if (retcode === 100) kind = 'business'
  else if (retcode === 1200) kind = 'internal'
  else if (retcode === 1400) kind = 'bad_request'
  else if (retcode === 1401) kind = 'unauthorized'
  else if (retcode === 1404) kind = 'unknown_action'
  else if (retcode === 1413) kind = 'payload_too_large'
  else if (retcode !== null) kind = 'business' // other non-zero retcodes: business failure by wording
  else kind = 'unknown'

  const failureClass = kind === 'business' ? classifyWording(wording) : 'other'
  const axes = axesFor(kind, failureClass)
  return {
    ok: false,
    kind,
    failureClass,
    retryable: axes.retryable,
    redrivable: axes.redrivable,
    retcode,
    status: status || null,
    wording: wording || 'unknown',
    dialectHint: napcatRejection || retcode === 200 ? 'napcat' : retcode !== null ? 'snowluma' : null,
  }
}

// ── transport / HTTP error classification ───────────────────────────────────

/** classify a non-2xx HTTP status from the bridge endpoint */
export function classifyOneBotHttpStatus(httpStatus: number): OneBotFailureKind {
  if (httpStatus === 401 || httpStatus === 403) return 'unauthorized'
  if (httpStatus === 404) return 'unknown_action'
  if (httpStatus === 413) return 'payload_too_large'
  if (httpStatus === 429) return 'business'
  if (httpStatus >= 500) return 'internal'
  return 'unknown'
}

export interface TransportFailure {
  ok: false
  kind: OneBotFailureKind
  failureClass: OneBotFailureClass
  retryable: boolean
  redrivable: boolean
  retcode: number | null
  status: string | null
  wording: string
  dialectHint: OneBotDialect | null
}

/**
 * Classify a thrown error (HTTP-level failure, timeout, network error) into the
 * same verdict shape as classifyOneBotResponse. Errors already carrying a
 * verdict (OneBotError) pass through unchanged.
 */
export function classifyOneBotError(error: unknown): TransportFailure {
  const verdict = (error as any)?.verdict
  if (verdict && typeof verdict === 'object' && verdict.ok === false) return verdict as TransportFailure
  const httpStatus = asNumber((error as any)?.httpStatus)
  const message = error instanceof Error ? error.message : String(error)
  let kind: OneBotFailureKind = 'transport'
  if (httpStatus !== null && httpStatus > 0) kind = classifyOneBotHttpStatus(httpStatus)
  else if (/timeout|timed out|abort/i.test(message)) kind = 'transport'
  else if (/HTTP 5\d\d/.test(message)) kind = 'internal'
  else if (/HTTP 40[13]/.test(message)) kind = 'unauthorized'
  else if (/HTTP 404/.test(message)) kind = 'unknown_action'
  else if (/HTTP 413/.test(message)) kind = 'payload_too_large'
  const failureClass = kind === 'business' ? classifyWording(message) : 'other'
  const axes = axesFor(kind, failureClass)
  return {
    ok: false,
    kind,
    failureClass,
    retryable: axes.retryable,
    redrivable: axes.redrivable,
    retcode: null,
    status: httpStatus !== null ? String(httpStatus) : null,
    wording: message || 'unknown',
    dialectHint: null,
  }
}

// ── dialect detection ───────────────────────────────────────────────────────

/** detect the bridge dialect from a `get_version_info` payload */
export function detectDialect(versionInfo: any): OneBotDialect {
  const name = String((versionInfo as any)?.app_name ?? '').toLowerCase()
  if (name.includes('snowluma')) return 'snowluma'
  if (name.includes('napcat')) return 'napcat'
  return 'generic'
}
