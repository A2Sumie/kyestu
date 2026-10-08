import { test, expect } from 'bun:test'
import * as fc from 'fast-check'
import { createRoot } from '../src/index'
import {
  SessionHealthBoard,
  type SessionHealthSnapshot,
  type SessionHealthState,
} from '../src/pipeline/session-health'
import { compileConfig, type KyestuConfig } from '../src/config/schema'

// ---------------------------------------------------------------------------
// fast-check PBT for the runtime invariants the 2026-09-15 fix waves rest on
// (stratum P1-P4 pattern: fixed seeds for determinism; every property pairs
// with a negative control that plants the violation and demands a shrink —
// a property that cannot fail is not a proof).
//
//   PBT-1 generation guard seam: fiber.wrap fires ⟺ its generation is live
//        (the primitive G1/G7-style post-unload-write rejection rests on)
//   PBT-2 hot-swap succession: overlapping replacements never FAILED, the
//        final value is visible, consumers converge (G3 class)
//   PBT-3 session-health board: model-based state machine + write-through
//        store hydration equivalence (board.record discipline)
//   PBT-4 config acyclicity: compileConfig accepts ⟺ the needs graph is
//        acyclic (oracle = an independent Kahn checker)
// ---------------------------------------------------------------------------

type Root = ReturnType<typeof createRoot>
type Fiber = ReturnType<Root['ctx']['use']>

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met before deadline: ${what}`)
    await Bun.sleep(2)
  }
}

// ---------------------------------------------------------------------------
// PBT-1 — generation guard seam
// ---------------------------------------------------------------------------

type GuardOp = 'capture' | 'swap' | 'fire' | 'retire'
const guardOpsArb = fc.array(fc.constantFrom<GuardOp>('capture', 'swap', 'fire', 'retire'), {
  minLength: 1,
  maxLength: 14,
})

/**
 * Drives random capture/swap/fire/retire sequences. `wrapBroken` is the
 * planted violation for the negative control: a wrap that checks liveness but
 * forgets the generation — the pre-guard class of bug.
 */
async function runGuardScenario(ops: GuardOp[], wrapBroken: boolean): Promise<void> {
  const root = createRoot()
  const fired: number[] = []
  const wraps: Array<{ gen: number; call: () => void }> = []
  let triggerValue = 0
  let provider = root.ctx.use({ name: 'trigger-0', apply: (ctx) => void ctx.set('trigger', triggerValue) })
  const fiber = root.ctx.use({ name: 'consumer', inject: ['trigger'], apply: () => () => {} })
  await until(() => fiber.state === 'ACTIVE', 2000, 'consumer active')
  let retired = false

  for (const op of ops) {
    if (op === 'capture') {
      const gen = fiber.generation
      const call = wrapBroken
        ? () => {
            if (fiber.state === 'ACTIVE' || fiber.state === 'LOADING') fired.push(gen)
          }
        : fiber.wrap(() => void fired.push(gen))
      wraps.push({ gen, call })
    } else if (op === 'swap') {
      triggerValue++
      const prev = provider
      await prev.dispose() // disciplined order; the consumer reloads against the successor
      provider = root.ctx.use({ name: `trigger-${triggerValue}`, apply: (ctx) => void ctx.set('trigger', triggerValue) })
      if (!retired) await until(() => fiber.state === 'ACTIVE', 2000, 'consumer reloaded')
    } else if (op === 'retire') {
      if (!retired) {
        retired = true
        await fiber.dispose()
      }
    } else {
      fired.length = 0
      for (const w of wraps) w.call()
      // oracle: a wrap fires ⟺ its captured generation is the live one
      const live = !retired && (fiber.state === 'ACTIVE' || fiber.state === 'LOADING')
      const expected = new Set(wraps.filter((w) => live && w.gen === fiber.generation).map((w) => w.gen))
      expect(new Set(fired)).toEqual(expected)
    }
  }
  await root.dispose()
}

test('PBT-1 generation guard: fiber.wrap fires ⟺ its captured generation is live', async () => {
  await fc.assert(
    fc.asyncProperty(guardOpsArb, async (ops) => {
      await runGuardScenario(ops, false)
    }),
    { seed: 20260915, numRuns: 30 },
  )
}, 60_000)

test('NC-1 negative control: a generation-blind wrap is caught and shrunk', async () => {
  const result = await fc.check(
    fc.asyncProperty(guardOpsArb, async (ops) => {
      await runGuardScenario(ops, true)
    }),
    { seed: 7, numRuns: 30 },
  )
  expect(result.failed).toBe(true)
  // the shrink produced a counterexample (stale generation fired after a swap)
  expect(result.counterexample).not.toBeNull()
  const ops = (result.counterexample as [GuardOp[]])[0]
  expect(ops).toContain('swap')
}, 60_000)

// ---------------------------------------------------------------------------
// PBT-2 — hot-swap succession (G3 class)
// ---------------------------------------------------------------------------

interface SwapScenario {
  parked: boolean
  chainLength: number
}
const swapScenarioArb = fc.record<SwapScenario>({
  parked: fc.boolean(),
  chainLength: fc.integer({ min: 1, max: 4 }),
})

/**
 * A consumer (optionally parked in LOADING) watches key `svc` through a chain
 * of overlapping provider replacements: each successor is created while its
 * predecessor is still retiring. Invariants: no fiber ever FAILED, the key
 * never holds a stale value at rest, and the consumer converges to the final
 * provider without manual intervention.
 */
async function runSwapScenario({ parked, chainLength }: SwapScenario): Promise<void> {
  const root = createRoot({ unloadGuardTimeoutMs: 60 })
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  if (!parked) release()
  const values = Array.from({ length: chainLength }, (_, i) => `v${i}`)
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: async (ctx) => {
      const v = String(ctx.get('svc'))
      seen.push(`apply:${v}`)
      await gate
      return () => void seen.push(`down:${v}`)
    },
  })
  const mk = (name: string, value: string) => ({ name, apply: (ctx: any) => void ctx.set('svc', value) })

  const providers: Fiber[] = [root.ctx.use(mk('p0', values[0]!))]
  await until(() => seen.length === 1, 2000, 'consumer first apply')

  const disposes: Promise<void>[] = []
  for (let i = 1; i < chainLength; i++) {
    disposes.push(providers[i - 1]!.dispose()) // predecessor stuck/retiring…
    providers.push(root.ctx.use(mk(`p${i}`, values[i]!))) // …while the successor activates
  }
  release()
  await Promise.all(disposes)
  await until(() => providers[chainLength - 1]!.state === 'ACTIVE', 3000, 'last provider active')
  if (parked) await until(() => consumer.state === 'ACTIVE', 3000, 'consumer converged')

  const last = values[chainLength - 1]!
  expect([...root.fibers].every((f) => f.state !== 'FAILED')).toBe(true)
  expect(root.ctx.get<string>('svc')).toBe(last)
  for (const p of providers.slice(0, -1)) expect(p.state).toBe('INACTIVE')
  if (parked) {
    if (chainLength >= 2) {
      expect(seen).toEqual([`apply:${values[0]}`, `down:${values[0]}`, `apply:${last}`])
      expect(consumer.generation).toBe(2)
    } else {
      // no successor: the gate release completes gen1 in place, no reload
      expect(seen).toEqual([`apply:${values[0]}`])
      expect(consumer.state).toBe('ACTIVE')
    }
  } else {
    expect(seen[0]).toBe(`apply:${values[0]}`)
    expect(seen[seen.length - 1]).toBe(`apply:${last}`)
    expect(consumer.state).toBe('ACTIVE')
  }
  await root.dispose()
}

test('PBT-2 hot-swap succession: overlapping replacements are transparent and never FAILED', async () => {
  await fc.assert(
    fc.asyncProperty(swapScenarioArb, async (scenario) => {
      await runSwapScenario(scenario)
    }),
    { seed: 20260915, numRuns: 25 },
  )
}, 120_000)

test('NC-2 negative control: the pre-fix single-source discipline fails the property', async () => {
  // plant the pre-fix writeEntry (unconditional double-provide throw) on the
  // shared Root prototype, restored in finally — proves PBT-2 is non-vacuous
  // w.r.t. the G3 class
  const probe = createRoot()
  const proto = Object.getPrototypeOf(probe) as any
  const original = proto.writeEntry
  proto.writeEntry = function (ctx: any, key: any, realm: any, value: unknown): void {
    let table = this.store.get(realm)
    if (!table) {
      table = new Map()
      this.store.set(realm, table)
    }
    if (table.has(key)) throw new Error(`coeffect key already provided: ${String(key)}`)
    table.set(key, { value, owner: ctx.ownerFiber() })
  }
  try {
    const result = await fc.check(
      fc.asyncProperty(swapScenarioArb, async (scenario) => {
        await runSwapScenario(scenario)
      }),
      { seed: 11, numRuns: 10 },
    )
    expect(result.failed).toBe(true)
    expect(result.counterexample).not.toBeNull()
  } finally {
    proto.writeEntry = original
    await probe.dispose()
  }
}, 120_000)

// ---------------------------------------------------------------------------
// PBT-3 — session-health board: model-based transitions + hydration (write-through)
// ---------------------------------------------------------------------------

interface BoardOp {
  key: number
  kind: 'ok' | 'fail' | 'resume' | 'guard' | 'tick'
  advance: number
}
const boardOpArb: fc.Arbitrary<BoardOp> = fc.record({
  key: fc.integer({ min: 0, max: 2 }),
  kind: fc.constantFrom('ok', 'fail', 'fail', 'resume', 'guard', 'tick'),
  advance: fc.integer({ min: 0, max: 4000 }),
})

interface ModelSlot {
  state: SessionHealthState
  cf: number
  autoResumeAt: number | null
}

function memStore() {
  const rows = new Map<string, SessionHealthSnapshot>()
  return {
    load: () => [...rows.values()].map((r) => ({ ...r })),
    save: (s: SessionHealthSnapshot) => void rows.set(s.key, { ...s }),
  }
}

function runBoardScenario(
  ops: BoardOp[],
  threshold: number,
  resumeAfterMs: number,
  Ctor: typeof SessionHealthBoard = SessionHealthBoard,
): void {
  let now = 1_000
  const store = memStore()
  const board = new Ctor({ brokenThreshold: threshold, resumeAfterMs, now: () => now, store })

  const model = new Map<string, ModelSlot>()
  const mslot = (k: string): ModelSlot => {
    let s = model.get(k)
    if (!s) {
      s = { state: 'fresh', cf: 0, autoResumeAt: null }
      model.set(k, s)
    }
    return s
  }
  const mAutoResume = (s: ModelSlot) => {
    if (s.state === 'quarantined' && s.autoResumeAt !== null && now >= s.autoResumeAt) {
      s.state = 'fresh'
      s.cf = 0
      s.autoResumeAt = null
    }
  }

  for (const op of ops) {
    now += op.advance
    const key = `k${op.key}`
    if (op.kind === 'ok') {
      board.record(key, true)
      const s = mslot(key)
      s.cf = 0
      s.state = 'fresh'
    } else if (op.kind === 'fail') {
      board.record(key, false, new Error('boom'))
      const s = mslot(key)
      s.cf += 1
      if (s.state !== 'quarantined') {
        if (s.cf >= threshold) {
          s.state = 'quarantined'
          s.autoResumeAt = resumeAfterMs > 0 ? now + resumeAfterMs : null
        } else if (s.state === 'fresh') {
          s.state = 'suspect'
        }
      }
    } else if (op.kind === 'resume') {
      board.resume(key)
      const s = mslot(key)
      if (s.state === 'quarantined') {
        s.state = 'fresh'
        s.autoResumeAt = null
      }
      s.cf = 0
    } else if (op.kind === 'guard') {
      board.guard(key) // creates the slot and applies lazy auto-resume
      mAutoResume(mslot(key))
    }
    // 'tick': time only; auto-resume is lazy in both worlds (snapshot below)

    const snap = board.snapshot() // snapshot applies lazy auto-resume per slot
    for (const s of model.values()) mAutoResume(s)
    const byKey = new Map(snap.map((r) => [r.key, r]))
    expect([...byKey.keys()].sort()).toEqual([...model.keys()].sort())
    for (const [k, s] of model) {
      const row = byKey.get(k)!
      expect({ state: row.state, cf: row.consecutiveFailures }).toEqual({ state: s.state, cf: s.cf })
    }
  }

  // write-through: a fresh board hydrating from the same store must hold the
  // same INFORMATION as the live board (the G7 ghost-write invariant). Slots
  // that carry no information (all defaults — e.g. created lazily by guard()
  // and never persisted) are indistinguishable from absence, so both sides
  // are compared modulo default-valued rows.
  const rehydrated = new Ctor({ brokenThreshold: threshold, resumeAfterMs, now: () => now, store })
  const isDefault = (r: SessionHealthSnapshot) =>
    r.state === 'fresh' && r.consecutiveFailures === 0 && r.lastOkAt === null && r.lastFailureAt === null &&
    r.lastError === null && r.quarantinedAt === null && r.autoResumeAt === null && r.reason === null
  const canon = (rows: SessionHealthSnapshot[]) =>
    JSON.stringify(rows.filter((r) => !isDefault(r)).sort((a, b) => a.key.localeCompare(b.key)))
  expect(canon(rehydrated.snapshot())).toBe(canon(board.snapshot()))
}

const boardScenarioArb = fc.record({
  ops: fc.array(boardOpArb, { minLength: 1, maxLength: 30 }),
  threshold: fc.integer({ min: 1, max: 3 }),
  resumeAfterMs: fc.constantFrom(0, 1500, 5000),
})

test('PBT-3 board discipline: record/resume/guard match the model and hydrate losslessly', () => {
  fc.assert(
    fc.property(boardScenarioArb, ({ ops, threshold, resumeAfterMs }) => {
      runBoardScenario(ops, threshold, resumeAfterMs)
    }),
    { seed: 20260915, numRuns: 100 },
  )
})

test('NC-3 negative control: an escalation-swallowing board is caught and shrunk', () => {
  class BuggyBoard extends SessionHealthBoard {
    override record(key: string, ok: boolean): void {
      super.record(key, true) // planted: failures never escalate
    }
  }
  const result = fc.check(
    fc.property(boardScenarioArb, ({ ops, threshold, resumeAfterMs }) => {
      runBoardScenario(ops, threshold, resumeAfterMs, BuggyBoard)
    }),
    { seed: 13, numRuns: 50 },
  )
  expect(result.failed).toBe(true)
  const counter = JSON.stringify(result.counterexample)
  expect(counter).toContain('fail')
})

// ---------------------------------------------------------------------------
// PBT-4 — config acyclicity (compileConfig accepts ⟺ needs graph is acyclic)
// ---------------------------------------------------------------------------

/** independent oracle: Kahn's algorithm over route+needs edge semantics */
function hasCycleKahn(ids: string[], edges: Array<[string, string]>): boolean {
  const needs = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]))
  for (const [from, to] of edges) needs.get(to)!.add(from)
  const indeg = new Map<string, number>()
  for (const [id, set] of needs) indeg.set(id, set.size)
  const dependents = new Map<string, string[]>()
  for (const [id, set] of needs) for (const need of set) dependents.set(need, [...(dependents.get(need) ?? []), id])
  const queue = ids.filter((id) => indeg.get(id) === 0)
  let seen = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    seen++
    for (const dep of dependents.get(id) ?? []) {
      indeg.set(dep, indeg.get(dep)! - 1)
      if (indeg.get(dep) === 0) queue.push(dep)
    }
  }
  return seen < ids.length
}

interface ConfigCase {
  config: KyestuConfig
  cyclic: boolean
}
const configCaseArb: fc.Arbitrary<ConfigCase> = fc
  .record({
    n: fc.integer({ min: 1, max: 6 }),
    routes: fc.array(
      fc.record({
        from: fc.integer({ min: 0, max: 5 }),
        via: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 3 }),
        to: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 2 }),
      }),
      { maxLength: 4 },
    ),
    needs: fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 })), { maxLength: 4 }),
  })
  .map(({ n, routes, needs }) => {
    const ids = Array.from({ length: n }, (_, i) => `c${i}`)
    const valid = (i: number) => i < n
    const edges: Array<[string, string]> = []
    const cleanRoutes: NonNullable<KyestuConfig['routes']> = []
    for (const r of routes) {
      if (![r.from, ...r.via, ...r.to].every(valid)) continue
      const chain = [r.from, ...r.via]
      // keep the generator inside the 'dependency cycle' domain: immediate
      // self-edges are rejected earlier with a different error
      if (chain.some((v, i) => i > 0 && chain[i - 1] === v)) continue
      if (r.to.some((t) => t === chain[chain.length - 1])) continue
      for (let i = 1; i < chain.length; i++) edges.push([`c${chain[i - 1]!}`, `c${chain[i]!}`])
      for (const t of r.to) edges.push([`c${chain[chain.length - 1]!}`, `c${t}`])
      cleanRoutes.push({ from: `c${r.from}`, via: r.via.map((i) => `c${i}`), to: r.to.map((i) => `c${i}`) })
    }
    const needsByComponent = new Map<string, string[]>()
    for (const [who, need] of needs) {
      if (!valid(who) || !valid(need)) continue
      edges.push([`c${need}`, `c${who}`])
      needsByComponent.set(`c${who}`, [...(needsByComponent.get(`c${who}`) ?? []), `c${need}`])
    }
    const config: KyestuConfig = {
      components: ids.map((id) => ({ id, use: 'test/component', needs: needsByComponent.get(id) })),
      routes: cleanRoutes,
    }
    return { config, cyclic: hasCycleKahn(ids, edges) }
  })

function entriesHaveCycle(entries: ReturnType<typeof compileConfig>): boolean {
  return hasCycleKahn(
    entries.map((e) => e.id),
    entries.flatMap((e) => (e.needs ?? []).map((need): [string, string] => [need, e.id])),
  )
}

test('PBT-4 acyclicity: compileConfig accepts ⟺ the needs graph is acyclic (independent oracle)', () => {
  fc.assert(
    fc.property(configCaseArb, ({ config, cyclic }) => {
      let entries: ReturnType<typeof compileConfig> | null = null
      let message: string | null = null
      try {
        entries = compileConfig(config)
      } catch (error) {
        message = String((error as Error)?.message ?? error)
      }
      if (cyclic) {
        expect(message).toContain('dependency cycle')
        return
      }
      expect(message).toBeNull()
      expect(entriesHaveCycle(entries!)).toBe(false)
    }),
    { seed: 20260915, numRuns: 200 },
  )
})

test('NC-4 negative control: an output checker that misses back-edges is caught', () => {
  const result = fc.check(
    fc.property(configCaseArb, ({ config, cyclic }) => {
      if (cyclic || config.components.length < 2) return
      const entries = compileConfig(config)
      // planted: a regression that lets a back-edge pair through the checker
      const [a, b] = [entries[0]!, entries[1]!]
      a.needs = [...(a.needs ?? []), b.id]
      b.needs = [...(b.needs ?? []), a.id]
      expect(entriesHaveCycle(entries)).toBe(false)
    }),
    { seed: 17, numRuns: 60 },
  )
  expect(result.failed).toBe(true)
  expect(result.counterexample).not.toBeNull()
})
