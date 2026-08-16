import { test, expect } from 'bun:test'
import { createRoot, type KyestuEvent } from '../src/index'

test('function inverse runs on dispose; multiple effects recover LIFO', async () => {
  const root = createRoot()
  const order: string[] = []
  root.ctx.effect(() => {
    order.push('f1')
    return () => void order.push('g1')
  })
  root.ctx.effect(() => {
    order.push('f2')
    return () => void order.push('g2')
  })
  expect(order).toEqual(['f1', 'f2'])
  await root.dispose()
  expect(order).toEqual(['f1', 'f2', 'g2', 'g1'])
})

test('sync generator: each yield registers an inverse, composed LIFO', async () => {
  const root = createRoot()
  const order: string[] = []
  const dispose = root.ctx.effect(function* () {
    order.push('a')
    yield () => void order.push('ra')
    order.push('b')
    yield () => void order.push('rb')
  })
  await dispose.done
  expect(dispose.done).resolves.toMatchObject({ status: 'completed' })
  expect(order).toEqual(['a', 'b'])
  await root.dispose()
  expect(order).toEqual(['a', 'b', 'rb', 'ra'])
})

test('dispose before first iteration boundary: nothing is applied', async () => {
  const root = createRoot()
  const order: string[] = []
  const dispose = root.ctx.effect(function* () {
    order.push('a')
    yield () => void order.push('ra')
  })
  await dispose()
  expect(order).toEqual([])
})

test('dispose during in-flight iteration: landed iteration is recovered, rest aborted', async () => {
  const root = createRoot()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const dispose = root.ctx.effect(async function* () {
    order.push('a')
    yield () => void order.push('ra')
    await gate
    order.push('b')
    yield () => void order.push('rb')
    order.push('c')
  })
  await Bun.sleep(5)
  expect(order).toEqual(['a'])
  const p = dispose()
  release()
  await p
  // the in-flight iteration lands (inertia) and its inverse runs; iteration c never happens
  expect(order).toEqual(['a', 'b', 'rb', 'ra'])
})

test('inverse throwing is tainted, not fatal: remaining inverses still run', async () => {
  const events: KyestuEvent[] = []
  const root = createRoot({ onEvent: (e) => events.push(e) })
  const order: string[] = []
  root.ctx.effect(() => {
    order.push('f1')
    return () => {
      order.push('g1')
      throw new Error('boom')
    }
  })
  root.ctx.effect(() => {
    order.push('f2')
    return () => void order.push('g2')
  })
  await root.dispose()
  expect(order).toEqual(['f1', 'f2', 'g2', 'g1'])
  const taints = events.filter((e) => e.type === 'taint')
  expect(taints.length).toBe(1)
})

test('callback throwing produces error status without unhandled rejection', async () => {
  const root = createRoot()
  const dispose = root.ctx.effect(() => {
    throw new Error('apply fail')
  })
  await expect(dispose.done).resolves.toMatchObject({ status: 'error' })
  await root.dispose()
})

test('dispose is idempotent', async () => {
  const root = createRoot()
  let count = 0
  const dispose = root.ctx.effect(() => () => void count++)
  await dispose()
  await dispose()
  expect(count).toBe(1)
  await root.dispose()
  expect(count).toBe(1)
})

test('non-function non-iterator result is an error, not a crash', async () => {
  const root = createRoot()
  const dispose = root.ctx.effect(() => 42 as any)
  await expect(dispose.done).resolves.toMatchObject({ status: 'error' })
  await root.dispose()
})
