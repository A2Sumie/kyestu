import { test, expect } from 'bun:test'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, NodeHandle, nodeKey, type EntryDef } from '../src/loader/loader'

function setup(log: string[]) {
  const root = createRoot()
  const registry = createRegistry()
  registry
    .define('test/service', {
      apply: (ctx, config: any) => {
        log.push(`service:${config.value}:up`)
        return () => void log.push(`service:${config.value}:down`)
      },
    })
    .define('test/consumer', {
      apply: (ctx) => {
        const handle = ctx.get<NodeHandle>(nodeKey('svc'))
        log.push(`consumer:up:${handle?.uid ? 'has-handle' : 'no-handle'}`)
        return () => void log.push('consumer:down')
      },
    })
  return { root, registry }
}

const svcEntry: EntryDef = { id: 'svc', use: 'test/service', with: { value: 'v1' } }
const consumerEntry: EntryDef = { id: 'app', use: 'test/consumer', needs: ['svc'] }

test('initial load: dependency order is derived, not declared', async () => {
  const log: string[] = []
  const { root, registry } = setup(log)
  const loader = new Loader(root, registry)
  await loader.load([consumerEntry, svcEntry])
  await root.idle()
  expect(log).toEqual(['service:v1:up', 'consumer:up:has-handle'])
  await root.dispose()
})

test('reconcile removal of a provider deactivates dependents; re-adding restores them', async () => {
  const log: string[] = []
  const { root, registry } = setup(log)
  const loader = new Loader(root, registry)
  await loader.load([svcEntry, consumerEntry])
  await root.idle()
  log.length = 0

  const changes = await loader.reconcile([consumerEntry])
  expect(changes).toEqual([{ kind: 'dispose', id: 'svc' }])
  await root.idle()
  expect(log).toEqual(['consumer:down', 'service:v1:down'])
  expect(loader.fiber('app')!.state).toBe('INACTIVE')

  log.length = 0
  await loader.reconcile([svcEntry, consumerEntry])
  await root.idle()
  expect(log).toEqual(['service:v1:up', 'consumer:up:has-handle'])
  await root.dispose()
})

test('reconcile `with` change rebuilds only that fiber', async () => {
  const log: string[] = []
  const { root, registry } = setup(log)
  const loader = new Loader(root, registry)
  await loader.load([svcEntry, consumerEntry])
  await root.idle()
  const appFiber = loader.fiber('app')!
  const gen0 = appFiber.generation
  log.length = 0

  const changes = await loader.reconcile([{ id: 'svc', use: 'test/service', with: { value: 'v2' } }, consumerEntry])
  expect(changes).toEqual([{ kind: 'rebuild', id: 'svc', reason: 'with' }])
  await root.idle()
  expect(log).toEqual(['consumer:down', 'service:v1:down', 'service:v2:up', 'consumer:up:has-handle'])
  // consumer restarted in place (same fiber, new generation) when its provider was replaced
  expect(loader.fiber('app')!.uid).toBe(appFiber.uid)
  expect(loader.fiber('app')!.generation).toBeGreaterThan(gen0)
  await root.dispose()
})

test('disable keeps the entry, enable recreates it', async () => {
  const { root, registry } = setup([])
  const loader = new Loader(root, registry)
  await loader.load([svcEntry, consumerEntry])
  await root.idle()

  await loader.reconcile([{ ...svcEntry, disabled: true }, consumerEntry])
  await root.idle()
  expect(loader.fiber('svc')).toBeNull()
  expect(loader.fiber('app')!.state).toBe('INACTIVE')
  expect(loader.current().length).toBe(2)

  await loader.reconcile([svcEntry, consumerEntry])
  await root.idle()
  expect(loader.fiber('app')!.state).toBe('ACTIVE')
  await root.dispose()
})

test('validation: unknown use, duplicate id rejected before any change', async () => {
  const { root, registry } = setup([])
  const loader = new Loader(root, registry)
  await expect(loader.load([{ id: 'x', use: 'nope/nope' }])).rejects.toThrow('unknown component')
  await expect(loader.load([svcEntry, svcEntry])).rejects.toThrow('duplicate entry id')
  expect(loader.current()).toEqual([])
  await root.dispose()
})

test('no-op reconcile produces no changes and no restarts', async () => {
  const { root, registry } = setup([])
  const loader = new Loader(root, registry)
  await loader.load([svcEntry, consumerEntry])
  await root.idle()
  const fiber = loader.fiber('svc')!
  expect(await loader.reconcile([{ ...svcEntry, with: { value: 'v1' } }, consumerEntry])).toEqual([])
  expect(loader.fiber('svc')!.uid).toBe(fiber.uid)
  await root.dispose()
})
