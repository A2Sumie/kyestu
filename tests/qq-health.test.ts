import { test, expect } from 'bun:test'
import { QqHealthBoard, type QqHealthStore, type QqHealthSnapshot } from '../src/pipeline/qq-health'

function memoryStore(): QqHealthStore & { saved: QqHealthSnapshot[] } {
  let value: QqHealthSnapshot | null = null
  const saved: QqHealthSnapshot[] = []
  return {
    saved,
    load: () => value,
    save: (snapshot) => {
      value = snapshot
      saved.push(snapshot)
    },
  }
}

test('qq-health: transient failures open the circuit with escalation; success closes it', () => {
  let now = 1_000_000
  const board = new QqHealthBoard({ now: () => now, baseCooldownMs: 1000 })
  expect(board.gate().allowed).toBe(true)

  const first = board.recordFailure('transport', 'other', 'HTTP 502')
  expect(first.opened).toBe(true)
  expect(board.gate().allowed).toBe(false)
  expect(first.until).toBe(now + 1000)

  // escalation: second failure doubles the cooldown
  now += 2000
  const second = board.recordFailure('transport', 'other', 'HTTP 502')
  expect(second.until).toBe(now + 2000)

  // cooldown expiry re-opens the gate (passive recovery, FI-01)
  now += 3000
  expect(board.gate().allowed).toBe(true)

  // a success resets the escalation ladder
  board.recordSuccess()
  expect(board.snapshotOf().state).toBe('ok')
  expect(board.snapshotOf().consecutiveFailures).toBe(0)
})

test('qq-health: muted / risk-control open long cooldowns; config errors do not', () => {
  let now = 2_000_000
  const board = new QqHealthBoard({ now: () => now, baseCooldownMs: 1000 })
  const muted = board.recordFailure('business', 'muted', '群禁言中', { cooldownMs: 10 * 60 * 1000 })
  expect(muted.opened).toBe(true)
  expect(muted.until).toBe(now + 10 * 60 * 1000)

  const ok = new QqHealthBoard({ now: () => now })
  const badRequest = ok.recordFailure('bad_request', 'other', 'retcode 1400')
  expect(badRequest.opened).toBe(false)
  expect(ok.gate().allowed).toBe(true) // a bad payload must not stop the whole target
})

test('qq-health: active probe closes the circuit early and extends it when still down', async () => {
  let now = 3_000_000
  const board = new QqHealthBoard({ now: () => now, baseCooldownMs: 60_000 })
  board.recordFailure('transport', 'other', 'HTTP 502')
  expect(board.gate().allowed).toBe(false)
  expect(board.probeDue()).toBe(true)

  // bridge is back: probe closes the circuit before the cooldown expires
  await board.runProbe(async () => ({ online: true, good: true }))
  expect(board.gate().allowed).toBe(true)

  // still down: the probe failure extends the circuit instead of healing it
  board.recordFailure('transport', 'other', 'HTTP 502')
  await board.runProbe(async () => ({ online: false, good: false }))
  expect(board.gate().allowed).toBe(false)
  expect(board.probeDue()).toBe(false) // just probed
})

test('qq-health: probe failures are health signals, never thrown', async () => {
  const board = new QqHealthBoard({ baseCooldownMs: 1000 })
  await board.runProbe(async () => {
    throw new Error('connection refused')
  })
  expect(board.gate().allowed).toBe(false)
  expect(board.snapshotOf().lastError).toContain('connection refused')
})

test('qq-health: state survives rehydration via the store', () => {
  const store = memoryStore()
  let now = 4_000_000
  const board = new QqHealthBoard({ now: () => now, store, baseCooldownMs: 5000 })
  board.recordFailure('transport', 'other', 'HTTP 503')
  expect(store.saved.length).toBeGreaterThan(0)

  const restored = new QqHealthBoard({ now: () => now, store })
  expect(restored.gate().allowed).toBe(false) // the cooldown resumes across a rebuild
  now += 10 * 60 * 1000
  expect(new QqHealthBoard({ now: () => now, store }).gate().allowed).toBe(true) // …but never revives past expiry
})
