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

test('payload: stable key, explicit externalKey wins, missing title/time dropped', () => {
  const candidate = { title: 'SR 生放送', starts_at: '2026-08-20T20:00:00+09:00', confidence: 0.9, members: ['椎名桜月'] }
  const p1 = buildScheduleWebhookPayload(candidate, 'a1', 0, null)
  const p2 = buildScheduleWebhookPayload(candidate, 'a1', 0, null)
  expect(p1!.externalKey).toBe(p2!.externalKey)
  expect(p1!.externalKey).toMatch(/^a1:event:[0-9a-f]{16}$/)
  expect(p1!.scheduleType).toBe('reminder')
  expect(p1!.payload.members).toEqual(['椎名桜月'])
  expect(buildScheduleWebhookPayload({ externalKey: 'fixed', title: 't', executionTime: '2026-08-20T20:00:00Z' }, 'a1', 0, 'k')!.externalKey).toBe('fixed')
  expect(buildScheduleWebhookPayload({ starts_at: '2026-08-20' }, 'a1', 0, null)).toBeNull()
  expect(buildScheduleWebhookPayload({ title: 't' }, 'a1', 0, null)).toBeNull()
  expect(buildScheduleWebhookPayload({ title: 't', executionTime: 'not-a-date' }, 'a1', 0, null)).toBeNull()
  expect(buildScheduleWebhookPayload(candidate, 'a1', 0, 'apikey')!.apiKey).toBe('apikey')
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
