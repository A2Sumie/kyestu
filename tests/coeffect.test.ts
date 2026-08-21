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

// review notes-code D3-3: an isolated context is a coeffect namespace view,
// not an effect owner — effect() on it attributes to the nearest enclosing
// fiber's accumulator. Paper-consistent (isolation scopes keys, not effect
// ownership); pinned so a future "managed realms" change can't silently
// alter teardown boundaries.
test('isolate x effect: effects on a bare isolated context belong to the enclosing fiber', async () => {
  const root = createRoot()
  const order: string[] = []
  const iso = root.ctx.isolate('cfg', 'rA')
  iso.effect(() => {
    order.push('apply')
    return () => void order.push('inverse')
  })
  expect(order).toEqual(['apply'])
  await root.dispose()
  expect(order).toEqual(['apply', 'inverse'])
})

test('isolate x effect: a fiber created under an isolated context owns its effects', async () => {
  const root = createRoot()
  const order: string[] = []
  const fiber = root.ctx.isolate('cfg', 'rB').use({
    name: 'child',
    apply: (ctx) => {
      ctx.effect(() => {
        order.push('child-apply')
        return () => void order.push('child-inverse')
      })
    },
  })
  await root.idle()
  expect(order).toEqual(['child-apply'])
  await fiber.dispose()
  expect(order).toEqual(['child-apply', 'child-inverse'])
  await root.dispose()
  expect(order).toEqual(['child-apply', 'child-inverse'])
})

// review notes-code D3-4 / decisions D18 §6: realm is a bare string and two
// entries naming the same realm share ONE key space. That is the current
// contract (prefix realm names with the entry id to opt out); pinned so the
// hazard is at least visible to refactors.
test('isolate: identical realm strings across contexts share the key space (D18 §6)', async () => {
  const root = createRoot()
  const ctxA = root.ctx.isolate('cfg', 'shared-realm')
  const ctxB = root.ctx.isolate('cfg', 'shared-realm')
  ctxA.set('cfg', 1)
  expect(ctxB.get<number>('cfg')).toBe(1) // reads cross over
  expect(() => ctxB.set('cfg', 2)).toThrow() // single-source discipline fires across entries
  await root.dispose()
})
