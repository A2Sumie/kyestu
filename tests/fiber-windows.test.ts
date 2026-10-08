import { test, expect } from 'bun:test'
import { createRoot, type KyestuEvent } from '../src/index'

// ---------------------------------------------------------------------------
// Fiber-level windows the effect-level suite does not pin (metric-adequacy
// evidence: every runtime.ts line is already covered, yet these transition
// paths had no test). Line coverage counts statements; these tests count
// *windows* — the intervals where a fiber is LOADING/UNLOADING and the world
// keeps moving.
// ---------------------------------------------------------------------------

test('retreat window: dispose during LOADING aborts the in-flight apply; landed iterations still recover', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ onEvent: (e) => events.push(e) })
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const fiber = root.ctx.use({
    name: 'slow',
    apply: async function* () {
      order.push('apply:a')
      yield () => void order.push('down:a')
      await gate
      order.push('apply:b')
      yield () => void order.push('down:b')
    },
  })
  // root.idle() would hang here (the parked load holds inertia); wait for the
  // apply to reach its gate instead
  while (order.length === 0) await Bun.sleep(1)
  expect(fiber.state).toBe('LOADING')

  const disposed = fiber.dispose()
  release()
  await disposed

  // the in-flight iteration landed (inertia) and was recovered LIFO; the
  // state path went through the retreat window to a pruned INACTIVE
  expect(order).toEqual(['apply:a', 'apply:b', 'down:b', 'down:a'])
  expect(fiber.state).toBe('INACTIVE')
  expect([...root.fibers].length).toBe(0)
  expect(fiber.taints).toEqual([])
  const transitions = events
    .filter((e): e is Extract<KyestuEvent, { type: 'lifecycle' }> => e.type === 'lifecycle' && e.fiber === 'slow')
    .map((e) => `${e.from}->${e.to}`)
  expect(transitions).toEqual(['INACTIVE->LOADING', 'LOADING->UNLOADING', 'UNLOADING->INACTIVE'])
  await root.dispose()
})

// The disciplined replacement path (what loader.reconcile guarantees by
// awaiting teardown before creating the replacement): the dependent's stale
// in-flight load unwinds to INACTIVE, then reloads against the new provider.
test('hot-swap window: a dependent parked in LOADING unwinds and reloads against the replacement provider', async () => {
  const root = createRoot()
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: async (ctx) => {
      const v = String(ctx.get('svc'))
      seen.push(`apply:${v}`)
      await gate // gen1 parks here; the gate stays released for gen2
      return () => void seen.push(`down:${v}`)
    },
  })
  const mkProvider = (name: string, value: string) => ({ name, apply: (ctx: any) => void ctx.set('svc', value) })

  const p1 = root.ctx.use(mkProvider('p1', 'v1'))
  while (seen.length === 0) await Bun.sleep(1)
  expect(consumer.state).toBe('LOADING')
  const uid = consumer.uid

  // p1's teardown blocks on the parked consumer (waitDependents sees its
  // committed view); opening the gate lets both unwind. The replacement is
  // created only after the old provider is fully down — the loader's order.
  const p1Disposed = p1.dispose()
  release()
  await p1Disposed
  expect(consumer.state).toBe('INACTIVE') // stale gen1 completed -> unloaded, no live target

  root.ctx.use(mkProvider('p2', 'v2'))
  const deadline = Date.now() + 3000
  while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5)

  expect(seen).toEqual(['apply:v1', 'down:v1', 'apply:v2'])
  expect(consumer.state).toBe('ACTIVE')
  expect(consumer.uid).toBe(uid) // restarted in place: same fiber, new generation
  expect(consumer.generation).toBe(2)
  await root.dispose()
})

test('hot-swap window (iterator apply): the generation guard aborts the stale load between iterations', async () => {
  const root = createRoot()
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: async function* (ctx) {
      const v = String(ctx.get('svc'))
      seen.push(`apply:${v}`)
      yield () => void seen.push(`down:${v}`)
      await gate // parked here while the provider leaves
    },
  })
  const mkProvider = (name: string, value: string) => ({ name, apply: (ctx: any) => void ctx.set('svc', value) })

  const p1 = root.ctx.use(mkProvider('p1', 'v1'))
  while (seen.length === 0) await Bun.sleep(1)
  const p1Disposed = p1.dispose()
  release()
  await p1Disposed
  root.ctx.use(mkProvider('p2', 'v2'))
  const deadline = Date.now() + 3000
  while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5)

  // same observable outcome via the aborted path: the stale generation's
  // landed inverse runs, then a fresh generation loads against p2
  expect(seen).toEqual(['apply:v1', 'down:v1', 'apply:v2'])
  expect(consumer.state).toBe('ACTIVE')
  expect(consumer.generation).toBe(2)
  await root.dispose()
})

// Hot-swap succession: creating a replacement provider while the old one is
// STUCK in its waitDependents window used to kill the replacement on the
// single-source discipline (a FAILED that never self-healed). A retiring
// provider has semantically left (L-Leave), so writeEntry now lets the
// successor inherit the key; the old fiber's deferred inverse is
// value-guarded (removeEntryIf) and cannot remove the successor's binding.
// Genuine conflicts (active/loading/root owners) still throw — the
// 'duplicate provider' lifecycle test pins that discipline.
test('hot-swap succession: a replacement created during a stuck teardown inherits the key, transparent to consumers', async () => {
  const root = createRoot({ unloadGuardTimeoutMs: 100 })
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: async (ctx) => {
      const v = String(ctx.get('svc'))
      seen.push(`apply:${v}`)
      await gate // gen1 parks here: keeps its committed view on p1, blocking p1's teardown
      return () => void seen.push(`down:${v}`)
    },
  })
  const mkProvider = (name: string, value: string) => ({ name, apply: (ctx: any) => void ctx.set('svc', value) })

  const p1 = root.ctx.use(mkProvider('p1', 'v1'))
  while (seen.length === 0) await Bun.sleep(1)
  const p1Disposed = p1.dispose() // blocked in waitDependents; binding still in the store
  const p2 = root.ctx.use(mkProvider('p2', 'v2'))
  await Bun.sleep(20)

  // succession, not execution: p2 takes over the retiring provider's key
  expect(p2.state).toBe('ACTIVE')
  expect(p2.taints).toEqual([])

  release() // let the consumer unwind; the guard then forces p1 through
  await p1Disposed
  await root.idle()
  expect(p1.state).toBe('INACTIVE') // forced through; its inverse could not remove p2's binding
  expect(root.ctx.get<string>('svc')).toBe('v2') // the key never left the store

  // the consumer reloaded in place against the successor — no manual reset,
  // no FAILED anywhere in the swap
  const deadline = Date.now() + 3000
  while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(5)
  expect(seen).toEqual(['apply:v1', 'down:v1', 'apply:v2'])
  expect(consumer.state).toBe('ACTIVE')
  expect(consumer.generation).toBe(2)
  await root.dispose()
}, 10_000)

test('retreat reaper: a fiber whose own inverse hangs is force-completed, self-tainted, and cannot wedge root.dispose()', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ unloadGuardTimeoutMs: 100, onEvent: (e) => events.push(e) })
  const stuck = root.ctx.use({
    name: 'stuck',
    apply: () => () => new Promise<void>(() => {}),
  })
  await root.idle()

  // pre-fix this await never resolved: a hanging self-inverse wedged the
  // fiber in UNLOADING forever with zero signals of its own
  await stuck.dispose()
  expect(stuck.state).toBe('INACTIVE')
  expect(stuck.taints.some((t) => t.phase === 'guard')).toBe(true)
  // the self-taint names the abandoned inverses (mutation-hardening: pins the
  // guard message, not just its phase)
  const guardTaint = stuck.taints.find((t) => t.phase === 'guard')!
  expect(String(guardTaint.error)).toContain('own inverses')
  const timeout = events.find((e) => e.type === 'timeout' && e.fiber === 'stuck')
  expect(timeout).toMatchObject({ type: 'timeout', fiber: 'stuck', phase: 'inverses' })
  // inverses-phase events carry an EMPTY waiting list (the fiber abandoned its
  // own inverses; there are no dependent names to report)
  if (timeout?.type === 'timeout') expect(timeout.waiting).toEqual([])
  await root.dispose() // completes: no wedged fiber holds the shutdown
  expect([...root.fibers].length).toBe(0)
}, 10_000)

test('retreat reaper: a stuck dependent is reaped after the provider forced through — both sides get their own signal', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ unloadGuardTimeoutMs: 100, onEvent: (e) => events.push(e) })
  root.ctx.use({
    name: 'stuck-consumer',
    inject: ['svc'],
    apply: () => () => new Promise<void>(() => {}),
  })
  const provider = root.ctx.use({ name: 'provider', apply: (ctx) => void ctx.set('svc', 'v1') })
  await root.idle()
  const stuck = [...root.fibers].find((f) => f.name === 'stuck-consumer')!

  await provider.dispose() // unwedges one way or the other (see below)

  // whichever guard fires first, the stuck fiber's own reaper also runs:
  // guard taint + inverses-phase timeout event on ITSELF, and a terminal
  // state. (The provider's dependents-guard and the dependent's inverse-guard
  // share the budget here and race; the provider-side timeout event is
  // therefore NOT asserted — the dedicated guard-timeout test pins it with a
  // split budget.)
  const deadline = Date.now() + 3000
  while (stuck.state !== 'INACTIVE' && Date.now() < deadline) await Bun.sleep(10)
  expect(stuck.state).toBe('INACTIVE')
  expect(stuck.taints.some((t) => t.phase === 'guard')).toBe(true)
  expect(events.some((e) => e.type === 'timeout' && e.fiber === 'stuck-consumer' && e.phase === 'inverses')).toBe(true)
  expect(provider.state).toBe('INACTIVE')
  await root.dispose()
}, 10_000)

test('retreat reaper: an abandoned zombie drain cannot eat the next generation\'s inverses', async () => {
  const root = createRoot({ unloadGuardTimeoutMs: 100 })
  const order: string[] = []
  let applyCount = 0
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['trigger'],
    apply: () => {
      const gen = ++applyCount
      return () => {
        order.push(`inverse:gen${gen}`)
        if (gen === 1) return new Promise<void>(() => {}) // gen1's inverse hangs forever
      }
    },
  })
  const t1 = root.ctx.use({ name: 't1', apply: (ctx) => void ctx.set('trigger', 1) })
  await root.idle()

  // provider swap sends the consumer into an in-place reload whose gen1
  // inverse hangs; the reaper must abandon it and let gen2 load
  const t1Disposed = t1.dispose()
  root.ctx.use({ name: 't2', apply: (ctx) => void ctx.set('trigger', 2) })
  const deadline = Date.now() + 5000
  while (consumer.state !== 'ACTIVE' && Date.now() < deadline) await Bun.sleep(10)
  expect(consumer.state).toBe('ACTIVE')
  expect(consumer.generation).toBe(2)

  await root.dispose() // gen2's inverses must run exactly once, in order
  expect(order).toEqual(['inverse:gen1', 'inverse:gen2'])
  await t1Disposed
}, 10_000)

test('retreat reaper: a zombie drain resuming LATE cannot steal the successor generation\'s inverses', async () => {
  // mutation-hardening for detachAccumulator: the forever-hanging zombie above
  // cannot observe the detach (it never wakes). This one wakes up AFTER the
  // reaper fired and a successor generation registered its own inverses —
  // the detached array must be exhausted, so the zombie exits without ever
  // popping the successor's inverse, and the successor's own drain must find
  // its array pristine (no foreign entries, no error taint).
  const root = createRoot({ unloadGuardTimeoutMs: 100 })
  const order: string[] = []
  let applyCount = 0
  let releaseGen1!: () => void
  const gen1Gate = new Promise<void>((r) => (releaseGen1 = r))
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['trigger'],
    apply: () => {
      const gen = ++applyCount
      return () => {
        order.push(`inverse:gen${gen}:start`)
        if (gen === 1) return gen1Gate.then(() => void order.push('inverse:gen1:end'))
        order.push(`inverse:gen${gen}:end`)
      }
    },
  })
  const t1 = root.ctx.use({ name: 't1', apply: (ctx) => void ctx.set('trigger', 1) })
  await root.idle()

  const t1Disposed = t1.dispose()
  root.ctx.use({ name: 't2', apply: (ctx) => void ctx.set('trigger', 2) })
  const deadline = Date.now() + 5000
  while (consumer.state !== 'ACTIVE' && Date.now() < deadline) await Bun.sleep(10)
  expect(consumer.generation).toBe(2)

  // the reaper already fired (guard taint + detach); NOW the hanging inverse
  // resolves. The zombie drain wakes, finds its captured array empty, exits —
  // gen2's inverse must NOT have run (a shared array would let the zombie
  // pop and execute it right here)
  releaseGen1()
  await Bun.sleep(100)
  expect(order).not.toContain('inverse:gen2:start')

  await root.dispose() // gen2's inverse runs exactly once, in its own drain
  expect(order).toEqual(['inverse:gen1:start', 'inverse:gen1:end', 'inverse:gen2:start', 'inverse:gen2:end'])
  // a polluted detached array (foreign entries) would surface as inverse-phase
  // error taints on the consumer fiber when gen2 drains
  expect(consumer.taints.filter((t) => t.phase === 'inverse')).toEqual([])
  await t1Disposed
}, 10_000)
