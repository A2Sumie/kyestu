import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'

test('set/get roundtrip; set dispose removes the binding', async () => {
  const root = createRoot()
  expect(root.ctx.get('k')).toBeUndefined()
  const dispose = root.ctx.set('k', 42)
  expect(root.ctx.get<number>('k')).toBe(42)
  await dispose()
  expect(root.ctx.get('k')).toBeUndefined()
  await root.dispose()
})

test('double provide of one key throws (single-source discipline)', async () => {
  const root = createRoot()
  root.ctx.set('k', 1)
  expect(() => root.ctx.set('k', 2)).toThrow()
  await root.dispose()
})

test('isolate: one key, independent realms', async () => {
  const root = createRoot()
  const ctxA = root.ctx.isolate('cfg', 'rA')
  const ctxB = root.ctx.isolate('cfg', 'rB')
  ctxA.set('cfg', 1)
  ctxB.set('cfg', 2)
  expect(ctxA.get<number>('cfg')).toBe(1)
  expect(ctxB.get<number>('cfg')).toBe(2)
  expect(root.ctx.get('cfg')).toBeUndefined()
  await root.dispose()
  expect(ctxA.get('cfg')).toBeUndefined()
})

test('dependent activates only after its provider is ACTIVE', async () => {
  const root = createRoot()
  const order: string[] = []
  const consumer = root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: (ctx) => {
      order.push(`consumer:${ctx.get('svc')}`)
    },
  })
  await root.idle()
  expect(consumer.state).toBe('INACTIVE')
  expect(order).toEqual([])
  root.ctx.use({
    name: 'provider',
    provide: ['svc'],
    apply: (ctx) => {
      ctx.set('svc', 'v1')
    },
  })
  await root.idle()
  expect(consumer.state).toBe('ACTIVE')
  expect(order).toEqual(['consumer:v1'])
  await root.dispose()
})

test('provider unload: consumer teardown completes before provider inverses run', async () => {
  const root = createRoot()
  const order: string[] = []
  root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: () => () => void order.push('consumer-down'),
  })
  const provider = root.ctx.use({
    name: 'provider',
    apply: (ctx) => {
      ctx.set('svc', 'v1')
      return () => void order.push('provider-down')
    },
  })
  await root.idle()
  await provider.dispose()
  expect(order).toEqual(['consumer-down', 'provider-down'])
  expect(root.ctx.get('svc')).toBeUndefined()
  await root.dispose()
})

test('provider replacement reloads the dependent against the new provider', async () => {
  const root = createRoot()
  const seen: string[] = []
  root.ctx.use({
    name: 'consumer',
    inject: ['svc'],
    apply: (ctx) => void seen.push(String(ctx.get('svc'))),
  })
  const mkProvider = (name: string, value: string) => ({
    name,
    apply: (ctx: any) => void ctx.set('svc', value),
  })
  const p1 = root.ctx.use(mkProvider('p1', 'v1'))
  await root.idle()
  await p1.dispose()
  await root.idle()
  root.ctx.use(mkProvider('p2', 'v2'))
  await root.idle()
  expect(seen).toEqual(['v1', 'v2'])
  await root.dispose()
})

test('notify is realm-scoped: isolated and default consumers resolve independently', async () => {
  const root = createRoot()
  const activated: string[] = []
  const iso = root.ctx.isolate('svc', 'r1')
  const c1 = root.ctx.use({ name: 'c1', inject: ['svc'], apply: () => void activated.push('c1') })
  const c2 = iso.use({ name: 'c2', inject: ['svc'], apply: () => void activated.push('c2') })
  await root.idle()
  expect(activated).toEqual([])
  iso.set('svc', 'x')
  await root.idle()
  expect(activated).toEqual(['c2'])
  expect(c1.state).toBe('INACTIVE')
  expect(c2.state).toBe('ACTIVE')
  await root.dispose()
})
