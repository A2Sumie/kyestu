import { test, expect } from 'bun:test'
import { createRoot, type KyestuEvent } from '../src/index'

test('apply failure: partial effects recovered, fiber FAILED, no auto-retry, siblings unaffected', async () => {
  const root = createRoot()
  let attempts = 0
  const faulty = root.ctx.use({
    name: 'faulty',
    apply: (ctx) => {
      attempts++
      ctx.set('partial', 1)
      throw new Error('init fail')
    },
  })
  const sibling = root.ctx.use({ name: 'sibling', apply: () => {} })
  await root.idle()
  expect(faulty.state).toBe('FAILED')
  expect(faulty.outcome).toBeInstanceOf(Error)
  expect(root.ctx.get('partial')).toBeUndefined()
  expect(sibling.state).toBe('ACTIVE')
  await Bun.sleep(20)
  expect(attempts).toBe(1)
  await root.dispose()
})

test('reset() re-enters a FAILED fiber once the environment is fixed', async () => {
  const root = createRoot()
  let fail = true
  const fiber = root.ctx.use({
    name: 'flaky',
    apply: () => {
      if (fail) throw new Error('not yet')
    },
  })
  await root.idle()
  expect(fiber.state).toBe('FAILED')
  fail = false
  fiber.reset()
  await root.idle()
  expect(fiber.state).toBe('ACTIVE')
  await root.dispose()
})

test('duplicate provider: second provider fails, first provider and consumers unaffected', async () => {
  const root = createRoot()
  const seen: string[] = []
  root.ctx.use({ name: 'consumer', inject: ['svc'], apply: (ctx) => void seen.push(String(ctx.get('svc'))) })
  root.ctx.use({ name: 'p1', apply: (ctx) => void ctx.set('svc', 'v1') })
  const p2 = root.ctx.use({ name: 'p2', apply: (ctx) => void ctx.set('svc', 'v2') })
  await root.idle()
  expect(p2.state).toBe('FAILED')
  expect(seen).toEqual(['v1'])
  await root.dispose()
})

test('parent unload cascades to children registered in apply', async () => {
  const root = createRoot()
  const order: string[] = []
  const parent = root.ctx.use({
    name: 'parent',
    apply: (ctx) => {
      ctx.use({ name: 'child', apply: () => () => void order.push('child-down') })
      return () => void order.push('parent-down')
    },
  })
  await root.idle()
  expect([...root.fibers].length).toBe(2)
  await parent.dispose()
  expect(order).toEqual(['child-down', 'parent-down'])
  expect([...root.fibers].length).toBe(0)
  await root.dispose()
})

test('per-entry reconciliation: replacing one fiber leaves an unrelated fiber untouched', async () => {
  const root = createRoot()
  let xRuns = 0
  let yRuns = 0
  const mkX = () => ({ name: 'x', apply: () => void xRuns++ })
  let x = root.ctx.use(mkX())
  const y = root.ctx.use({ name: 'y', apply: () => void yRuns++ })
  await root.idle()
  await x.dispose()
  x = root.ctx.use(mkX())
  await root.idle()
  expect(xRuns).toBe(2)
  expect(yRuns).toBe(1)
  expect(y.state).toBe('ACTIVE')
  await root.dispose()
})

test('guard timeout: provider forces recovery past a stuck dependent, with taint recorded', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ unloadGuardTimeoutMs: 100, onEvent: (e) => events.push(e) })
  root.ctx.use({
    name: 'stuck-consumer',
    inject: ['svc'],
    apply: () => () => new Promise<void>(() => {}),
  })
  const provider = root.ctx.use({ name: 'provider', apply: (ctx) => void ctx.set('svc', 'v1') })
  await root.idle()
  await provider.dispose()
  expect(provider.state).toBe('INACTIVE')
  expect(root.ctx.get('svc')).toBeUndefined()
  expect(provider.taints.some((t) => t.phase === 'guard')).toBe(true)
  expect(events.some((e) => e.type === 'timeout' && e.fiber === 'provider')).toBe(true)
})

test('ghost write guard: late async completions of a dead generation are dropped', async () => {
  const root = createRoot()
  const log: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const fiber = root.ctx.use({
    name: 'ghosty',
    apply: (ctx) => {
      const self = ctx.fiber!
      const gen = self.generation
      gate.then(() => {
        if (self.isCurrent(gen)) log.push('unguarded')
      })
      gate.then(
        self.wrap(() => {
          log.push('wrapped')
        }),
      )
    },
  })
  await root.idle()
  expect(fiber.state).toBe('ACTIVE')
  await fiber.dispose()
  release()
  await Bun.sleep(10)
  expect(log).toEqual([])
  await root.dispose()
})

test('root dispose is idempotent and leaves no fibers', async () => {
  const root = createRoot()
  root.ctx.use({ name: 'a', apply: (ctx) => void ctx.set('a', 1) })
  root.ctx.use({ name: 'b', inject: ['a'], apply: () => {} })
  await root.idle()
  await root.dispose()
  await root.dispose()
  expect([...root.fibers].length).toBe(0)
  expect(root.ctx.get('a')).toBeUndefined()
})
