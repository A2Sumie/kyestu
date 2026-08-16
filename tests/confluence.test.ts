import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'

const P = { name: 'P', apply: (ctx: any) => void ctx.set('a', 'A') }
const Q = { name: 'Q', inject: ['a'], apply: (ctx: any) => void ctx.set('b', `B(${ctx.get('a')})`) }
const R = { name: 'R', inject: ['b'], apply: (ctx: any) => void ctx.set('c', `C(${ctx.get('b')})`) }

function snapshot(root: any) {
  return {
    a: root.ctx.get('a'),
    b: root.ctx.get('b'),
    c: root.ctx.get('c'),
    active: [...root.fibers].filter((f: any) => f.state === 'ACTIVE').map((f: any) => f.name).sort(),
    terminal: [...root.fibers].every((f: any) => f.isTerminal()),
  }
}

test('dynamic history leaves no trace: churned system quiesces at the statically assembled state', async () => {
  const churn = createRoot()
  let p = churn.ctx.use(P)
  let q = churn.ctx.use(Q)
  churn.ctx.use(R)
  await churn.idle()
  await p.dispose()
  await churn.idle()
  await q.dispose()
  await churn.idle()
  p = churn.ctx.use(P)
  await churn.idle()
  q = churn.ctx.use(Q)
  await churn.idle()

  const fresh = createRoot()
  fresh.ctx.use(P)
  fresh.ctx.use(Q)
  fresh.ctx.use(R)
  await fresh.idle()

  expect(snapshot(churn)).toEqual(snapshot(fresh))
  expect(churn.ctx.get<string>('c')).toBe('C(B(A))')
  await churn.dispose()
  await fresh.dispose()
})

test('permutation of insertion order converges to the same quiescent state', async () => {
  const orders = [
    [P, Q, R],
    [R, Q, P],
    [Q, R, P],
  ]
  const snapshots = []
  for (const order of orders) {
    const root = createRoot()
    for (const component of order) root.ctx.use(component as any)
    await root.idle()
    snapshots.push(snapshot(root))
    await root.dispose()
  }
  expect(snapshots[0]).toEqual(snapshots[1])
  expect(snapshots[1]).toEqual(snapshots[2])
  expect(snapshots[0]!.c).toBe('C(B(A))')
})
