import { test, expect } from 'bun:test'
import { resolveCrawlerSchedule, nextRunAt } from '../src/pipeline/schedule'

// Regression (idol-bbq a48b5c1 parity): expired slots must not be resurrected.
// The old clamp jittered = max(jittered, after+minGap) revived every stale
// same-day slot at after+minGap, so crawlers re-ran forever at ~2x minGap.
function scheduleFor(cron: string) {
  return resolveCrawlerSchedule({ cron })
}

const DAY = 86400
// 2026-08-18 14:00 JST in epoch seconds (JST = UTC+9)
const T_1400_JST = Date.UTC(2026, 7, 18, 5, 0, 0) / 1000

test('expired same-day slots are skipped, not resurrected at after+minGap', () => {
  const schedule = scheduleFor('11,26,41,56 14-16 * * *')
  expect(schedule).not.toBeNull()
  // 14:11 slot dispatched at 14:11:07; after = 14:12:07 (after + minGap at the call site)
  const after = T_1400_JST + 11 * 60 + 7 + 60
  const next = nextRunAt(schedule!, after, 'live')
  expect(next).not.toBeNull()
  // Must be the 14:26 slot, not ~14:13:07 (after+minGap)
  expect(next! - T_1400_JST).toBe(26 * 60)
})

test('when all same-day slots expired, next run is the first slot of tomorrow', () => {
  const schedule = scheduleFor('11,26,41,56 14-16 * * *')
  // 17:00 JST: every slot (last is 16:56) has expired
  const after = T_1400_JST + 17 * 3600
  const next = nextRunAt(schedule!, after, 'live')
  expect(next).not.toBeNull()
  // Tomorrow 14:11 JST
  expect(next! - T_1400_JST).toBe(DAY + 11 * 60)
})

test('future slot with negative jitter never lands below after+minGap', () => {
  const schedule = scheduleFor('11,26,41,56 14-16 * * *')
  const after = T_1400_JST + 10 * 60 // 14:10, next slot 14:11
  const next = nextRunAt(schedule!, after, 'live')
  expect(next).not.toBeNull()
  // 14:11 with jitter clamped to at least after+minGap (60s default)
  expect(next! - T_1400_JST).toBeGreaterThanOrEqual(11 * 60)
  expect(next! - T_1400_JST).toBeLessThanOrEqual(11 * 60 + 60)
})
