import { test, expect } from 'bun:test'
import {
  resolveConfigValue,
  buildScheduleWebhookHeaders,
  normalizeCandidates,
  buildScheduleWebhookPayload,
  writeSchedulesFromProcessorResult,
} from '../src/pipeline/schedule-webhook'

test('resolveConfigValue resolves env: prefixes', () => {
  process.env.SW_TEST_KEY = 'secret-value'
  expect(resolveConfigValue('env:SW_TEST_KEY')).toBe('secret-value')
  expect(resolveConfigValue('plain')).toBe('plain')
  expect(resolveConfigValue('env:SW_TEST_MISSING')).toBeNull()
  expect(resolveConfigValue('')).toBeNull()
  delete process.env.SW_TEST_KEY
})

test('headers: WAF header line vs bare token, UA default', () => {
  const named = buildScheduleWebhookHeaders({ scheduleWafBypassHeader: 'x-n2nj-pass: tok123' })
  expect(named['x-n2nj-pass']).toBe('tok123')
  const bare = buildScheduleWebhookHeaders({ scheduleWafBypassHeader: 'tok123' })
  expect(bare['x-bypass-waf']).toBe('tok123')
  expect(bare['User-Agent']).toBe('N2NJ-Stream-Bot/1.0')
  const ua = buildScheduleWebhookHeaders({ scheduleUserAgent: 'custom-agent/2' })
  expect(ua['User-Agent']).toBe('custom-agent/2')
})

test('normalizeCandidates covers plans/items/tasks/array/single shapes', () => {
  expect(normalizeCandidates([{ title: 'a' }])).toHaveLength(1)
  expect(normalizeCandidates({ plans: [{ title: 'a' }] })).toHaveLength(1)
  expect(normalizeCandidates({ items: [{ title: 'a' }] })).toHaveLength(1)
  expect(normalizeCandidates({ tasks: [{ title: 'a' }] })).toHaveLength(1)
  expect(normalizeCandidates({ title: 'single' })).toHaveLength(1)
  expect(normalizeCandidates(null)).toEqual([])
  expect(normalizeCandidates({ other: 1 })).toEqual([])
})

test('payload: stable key, explicit externalKey namespaced under the source, missing title/time dropped', () => {
  const candidate = { title: 'SR 生放送', starts_at: '2026-08-20T20:00:00+09:00', confidence: 0.9, members: ['椎名桜月'] }
  const p1 = buildScheduleWebhookPayload(candidate, 'a1', 0, null)
  const p2 = buildScheduleWebhookPayload(candidate, 'a1', 0, null)
  expect(p1!.externalKey).toBe(p2!.externalKey)
  expect(p1!.externalKey).toMatch(/^a1:event:[0-9a-f]{16}$/)
  expect(p1!.scheduleType).toBe('reminder')
  expect(p1!.payload.members).toEqual(['椎名桜月'])
  // explicit keys stay stable (upsert semantics) but can never adopt a record
  // owned by another source: the downstream has a UNIQUE external_key and
  // upserts on it (daybreak finding 7)
  const explicit = buildScheduleWebhookPayload({ externalKey: 'fixed', title: 't', executionTime: '2026-08-20T20:00:00Z' }, 'a1', 0, 'k')!
  expect(explicit.externalKey).toBe('a1:ext:fixed')
  expect(explicit.externalKey).toBe(
    buildScheduleWebhookPayload({ externalKey: 'fixed', title: 't', executionTime: '2026-08-20T20:00:00Z' }, 'a1', 1, 'k')!.externalKey,
  )
  expect(
    buildScheduleWebhookPayload({ externalKey: 'fixed', title: 't', executionTime: '2026-08-20T20:00:00Z' }, 'a2', 0, 'k')!.externalKey,
  ).toBe('a2:ext:fixed')
  expect(buildScheduleWebhookPayload({ starts_at: '2026-08-20' }, 'a1', 0, null)).toBeNull()
  expect(buildScheduleWebhookPayload({ title: 't' }, 'a1', 0, null)).toBeNull()
  expect(buildScheduleWebhookPayload({ title: 't', executionTime: 'not-a-date' }, 'a1', 0, null)).toBeNull()
  expect(buildScheduleWebhookPayload(candidate, 'a1', 0, 'apikey')!.apiKey).toBe('apikey')
})

test('payload: model output is clamped to the executable shapes the downstream knows', () => {
  const base = { title: '配信', executionTime: '2026-08-20T20:00:00Z' }

  // unknown scheduleType degrades to reminder instead of being forwarded
  expect(buildScheduleWebhookPayload({ ...base, scheduleType: 'drop_tables' }, 'a1', 0, null)!.scheduleType).toBe('reminder')
  // a workflow/stream entry without an executable payload cannot run downstream
  // (it would hit "Unknown workflow type" at execution) -> reminder instead
  expect(buildScheduleWebhookPayload({ ...base, scheduleType: 'stream' }, 'a1', 0, null)!.scheduleType).toBe('reminder')
  expect(
    buildScheduleWebhookPayload(
      { ...base, scheduleType: 'stream', payload: { type: 'stop_network_stream', playerId: 1 } },
      'a1',
      0,
      null,
    )!.scheduleType,
  ).toBe('stream')

  // workflow payload passthrough only for types the downstream can execute
  const workflow = buildScheduleWebhookPayload(
    { ...base, scheduleType: 'workflow', payload: { type: 'start_network_stream', playerId: 3, source: 'rtmp://x/live' } },
    'a1',
    0,
    null,
  )!
  expect(workflow.scheduleType).toBe('workflow')
  expect(workflow.payload).toEqual({ type: 'start_network_stream', playerId: 3, source: 'rtmp://x/live' })

  // an unknown payload.type never reaches the downstream as a free-form object
  const hostile = buildScheduleWebhookPayload(
    { ...base, scheduleType: 'workflow', payload: { type: 'start_network_stream', evil: true, playerId: 1 } },
    'a1',
    0,
    null,
    { scheduleTypes: ['reminder'], workflowTypes: [] },
  )!
  expect(hostile.scheduleType).toBe('reminder')
  expect(hostile.payload.type).toBe('idol_bbq_time_event_candidate')
  expect(hostile.payload).not.toHaveProperty('evil')

  // workflow-shaped without an executable payload cannot run downstream -> reminder
  expect(
    buildScheduleWebhookPayload({ ...base, scheduleType: 'workflow', payload: { type: 'nuke' } }, 'a1', 0, null)!.scheduleType,
  ).toBe('reminder')

  // an operator can widen the lists for a downstream that grew new types
  const widened = buildScheduleWebhookPayload(
    { ...base, payload: { type: 'stop_network_stream', playerId: 1 } },
    'a1',
    0,
    null,
    { scheduleTypes: ['workflow'], workflowTypes: ['stop_network_stream'] },
  )!
  expect(widened.scheduleType).toBe('workflow')
  expect(widened.payload.type).toBe('stop_network_stream')
})

test('writeSchedules: min confidence filter, per-candidate failure captured, empty without url', async () => {
  expect(await writeSchedulesFromProcessorResult({ plans: [{ title: 'x', executionTime: '2026-08-20T20:00:00Z' }] }, 'ref', {})).toEqual([])

  const posts: any[] = []
  const results = await writeSchedulesFromProcessorResult(
    {
      plans: [
        { title: 'high', executionTime: '2026-08-20T20:00:00Z', confidence: 0.9 },
        { title: 'low', executionTime: '2026-08-21T20:00:00Z', confidence: 0.2 },
        { title: 'explodes', executionTime: '2026-08-22T20:00:00Z', confidence: 0.95 },
      ],
    },
    'ref1',
    {
      scheduleUrl: 'https://player.example.com/api/schedules',
      minConfidence: 0.5,
      fetchImpl: (async (_url: any, init: any) => {
        const body = JSON.parse(init.body)
        posts.push(body)
        if (body.title === 'explodes') throw new Error('network down')
        return new Response('{"ok":true}', { status: 200 })
      }) as any,
    },
  )
  expect(posts.map((p) => p.title)).toEqual(['high', 'explodes']) // low filtered
  expect(results.length).toBe(2)
  expect(results[0]).toMatchObject({ ok: true, status: 200, title: 'high' })
  expect(results[1]).toMatchObject({ ok: false, status: null, title: 'explodes' })
})
