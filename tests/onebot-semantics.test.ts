import { test, expect } from 'bun:test'
import {
  classifyOneBotError,
  classifyOneBotResponse,
  classifyWording,
  detectDialect,
  axesFor,
} from '../src/pipeline/onebot-semantics'
import {
  classifyQqSendFailure,
  qqSendCooldownMs,
  qqSendRedrive,
  qqSendRetryNow,
} from '../src/pipeline/cooldown'

// ── SnowLuma dialect (REPORT_snowluma_capabilities §3.3) ────────────────────

test('snowluma: status ok / retcode 0 is the only success', () => {
  expect(classifyOneBotResponse({ status: 'ok', retcode: 0, data: { message_id: 1 } })).toEqual({ ok: true })
  // absent retcode with ok status is still success
  expect(classifyOneBotResponse({ status: 'ok', data: null })).toEqual({ ok: true })
})

test('snowluma: retcode 100 is a business failure whose wording decides the axes', () => {
  const muted = classifyOneBotResponse({ status: 'failed', retcode: 100, wording: '群禁言中，无法发送' })
  expect(muted.ok).toBe(false)
  if (muted.ok) throw new Error('unreachable')
  expect(muted.kind).toBe('business')
  expect(muted.failureClass).toBe('muted')
  expect(muted.retryable).toBe(false) // do not spam the muted window
  expect(muted.redrivable).toBe(true) // but re-drive after the cooldown
  expect(muted.dialectHint).toBe('snowluma')

  const missing = classifyOneBotResponse({ status: 'failed', retcode: 100, wording: 'group not found' })
  if (missing.ok) throw new Error('unreachable')
  expect(missing.failureClass).toBe('missing_target')
  expect(missing.redrivable).toBe(false) // the target is gone

  const transient = classifyOneBotResponse({ status: 'failed', retcode: 100, wording: 'upstream timeout' })
  if (transient.ok) throw new Error('unreachable')
  expect(transient.failureClass).toBe('other')
  expect(transient.retryable).toBe(true)
})

test('snowluma: 1400/1401/1404/1413 never retry; 1200 retries', () => {
  for (const [retcode, kind] of [
    [1400, 'bad_request'],
    [1401, 'unauthorized'],
    [1404, 'unknown_action'],
    [1413, 'payload_too_large'],
  ] as const) {
    const verdict = classifyOneBotResponse({ status: 'failed', retcode, wording: 'x' })
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.kind).toBe(kind)
    expect(verdict.retryable).toBe(false)
    expect(verdict.redrivable).toBe(false) // fix config/params, do not re-drive
    expect(classifyQqSendFailure(verdict)).toBe(kind)
    expect(qqSendRedrive(classifyQqSendFailure(verdict))).toBe(false)
  }
  const internal = classifyOneBotResponse({ status: 'failed', retcode: 1200, wording: 'boom' })
  if (internal.ok) throw new Error('unreachable')
  expect(internal.kind).toBe('internal')
  expect(internal.retryable).toBe(true)
  expect(internal.redrivable).toBe(true)
})

// ── NapCat dialect (legacy semantics must not regress) ──────────────────────

test('napcat: retcode 200 / result=120 stays non-retryable-but-redrivable', () => {
  for (const body of [
    { status: 'failed', retcode: 200, message: 'EventChecker muted' },
    { status: 'failed', retcode: 0, data: { result: 120 }, wording: 'result=120' },
  ]) {
    const verdict = classifyOneBotResponse(body)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.kind).toBe('rejected')
    expect(verdict.retryable).toBe(false)
    expect(verdict.redrivable).toBe(true)
    expect(verdict.dialectHint).toBe('napcat')
    expect(classifyQqSendFailure(verdict)).toBe('rejected')
    expect(qqSendCooldownMs('rejected')).toBeGreaterThan(0)
  }
})

test('legacy: unknown non-zero retcodes without a dialect marker stay retryable', () => {
  const verdict = classifyOneBotResponse({ status: 'failed', retcode: 1, message: '???' })
  if (verdict.ok) throw new Error('unreachable')
  expect(verdict.retryable).toBe(true)
  expect(verdict.redrivable).toBe(true)
})

// ── wording classification ──────────────────────────────────────────────────

test('wording classes are bilingual (rate_limit wins over the generic temporary match)', () => {
  expect(classifyWording('你已被禁言')).toBe('muted')
  expect(classifyWording('bot is muted')).toBe('muted')
  expect(classifyWording('操作过于频繁，请稍后再试')).toBe('rate_limit')
  expect(classifyWording('账号存在风控风险')).toBe('risk_control')
  expect(classifyWording('该群不存在或已解散')).toBe('missing_target')
  expect(classifyWording('no permission to send')).toBe('permission')
  expect(classifyWording('nothing special here')).toBe('other')
})

test('axis table: fix-config classes never redrive, operational classes do', () => {
  expect(axesFor('bad_request', 'other')).toEqual({ retryable: false, redrivable: false })
  expect(axesFor('business', 'muted')).toEqual({ retryable: false, redrivable: true })
  expect(axesFor('business', 'rate_limit')).toEqual({ retryable: false, redrivable: true })
  expect(axesFor('transport', 'other')).toEqual({ retryable: true, redrivable: true })
})

// ── transport / HTTP ────────────────────────────────────────────────────────

test('transport errors classify: 5xx retryable, 4xx fix-config, network retryable', () => {
  const http502 = classifyOneBotError(Object.assign(new Error('OneBot send_group_msg HTTP 502'), { httpStatus: 502 }))
  expect(http502.kind).toBe('internal')
  expect(http502.retryable).toBe(true)
  const http401 = classifyOneBotError(Object.assign(new Error('OneBot send_group_msg HTTP 401'), { httpStatus: 401 }))
  expect(http401.kind).toBe('unauthorized')
  expect(http401.redrivable).toBe(false)
  const timeout = classifyOneBotError(new Error('fetch timed out'))
  expect(timeout.kind).toBe('transport')
  expect(timeout.retryable).toBe(true)
})

test('classifyOneBotError passes an embedded verdict through unchanged', () => {
  const error = Object.assign(new Error('wrapped'), {
    verdict: { ok: false, kind: 'rejected', failureClass: 'other', retryable: false, redrivable: true, retcode: 200, status: 'failed', wording: 'x', dialectHint: 'napcat' },
  })
  expect(classifyOneBotError(error).kind).toBe('rejected')
})

// ── cooldown policy table ───────────────────────────────────────────────────

test('qq send policy: retry-now vs redrive vs cooldown per class', () => {
  expect(qqSendRetryNow('transient')).toBe(true)
  expect(qqSendRetryNow('timeout')).toBe(true)
  expect(qqSendRetryNow('muted')).toBe(false)
  expect(qqSendRetryNow('rejected')).toBe(false)
  expect(qqSendRedrive('muted')).toBe(true)
  expect(qqSendRedrive('rejected')).toBe(true)
  expect(qqSendRedrive('bad_request')).toBe(false)
  expect(qqSendRedrive('missing_target')).toBe(false)
  expect(qqSendCooldownMs('muted')).toBe(10 * 60 * 1000)
  expect(qqSendCooldownMs('risk_control')).toBe(30 * 60 * 1000)
  expect(qqSendCooldownMs('missing_target')).toBe(24 * 60 * 60 * 1000)
  expect(qqSendCooldownMs('bad_request')).toBe(0)
})

// ── dialect detection ───────────────────────────────────────────────────────

test('detectDialect discriminates bridges by get_version_info app_name', () => {
  expect(detectDialect({ app_name: 'SnowLuma', app_version: '1.14.22-node', protocol_version: 'v11' })).toBe('snowluma')
  expect(detectDialect({ app_name: 'NapCat.OneBot' })).toBe('napcat')
  expect(detectDialect({ app_name: 'go-cqhttp' })).toBe('generic')
})
