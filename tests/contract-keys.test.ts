import { test, expect, afterEach } from 'bun:test'
import { createRoot } from '../src/index'
import { createRegistry } from '../src/loader/registry'
import { Loader, type EntryDef } from '../src/loader/loader'
import { defineAll } from '../src/components'

/**
 * Contract: config `with` unknown-key warnings (review §5.2-2).
 * A component that declares knownWithKeys gets a console.warn for any other
 * key; the entry still loads (warn, not reject). Components without a table
 * are never warned on.
 */

const originalWarn = console.warn
let warnings: string[] = []

function captureWarnings() {
  warnings = []
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
}

afterEach(() => {
  console.warn = originalWarn
})

function setup() {
  const root = createRoot()
  const registry = createRegistry()
  registry
    .define('test/typed', {
      knownWithKeys: ['known_key', 'other_key'],
      apply: () => {},
    })
    .define('test/untyped', {
      // no knownWithKeys: legacy/open components stay warning-free
      apply: () => {},
    })
    .define('test/empty', {
      knownWithKeys: [],
      apply: () => {},
    })
  return { root, registry }
}

test('unknown key warns but the entry still loads', async () => {
  captureWarnings()
  const { root, registry } = setup()
  const loader = new Loader(root, registry)
  const entry: EntryDef = { id: 'a', use: 'test/typed', with: { known_key: 1, known_kye: 2 } }
  const changes = await loader.load([entry])
  expect(changes).toEqual([{ kind: 'create', id: 'a' }]) // warn, not reject
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("entry 'a' (test/typed)")
  expect(warnings[0]).toContain("'known_kye'")
  expect(warnings[0]).not.toContain("'known_key'")
  await root.dispose()
})

test('known keys stay silent', async () => {
  captureWarnings()
  const { root, registry } = setup()
  const loader = new Loader(root, registry)
  await loader.load([{ id: 'a', use: 'test/typed', with: { known_key: 1, other_key: 2 } }])
  expect(warnings).toHaveLength(0)
  await root.dispose()
})

test('components without a key table are never warned on', async () => {
  captureWarnings()
  const { root, registry } = setup()
  const loader = new Loader(root, registry)
  await loader.load([{ id: 'a', use: 'test/untyped', with: { anything_goes: true } }])
  expect(warnings).toHaveLength(0)
  await root.dispose()
})

test('an empty key table warns on every key', async () => {
  captureWarnings()
  const { root, registry } = setup()
  const loader = new Loader(root, registry)
  await loader.load([{ id: 'a', use: 'test/empty', with: { stray: 1 } }])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("'stray'")
  await root.dispose()
})

test('every registered component declares its key table (guard against future omissions)', () => {
  const registry = defineAll(createRegistry())
  for (const use of registry.keys()) {
    expect(registry.get(use)!.knownWithKeys, `component '${use}' is missing knownWithKeys`).toBeArray()
  }
})

test('reconcile re-checks keys on config reload', async () => {
  captureWarnings()
  const { root, registry } = setup()
  const loader = new Loader(root, registry)
  await loader.load([{ id: 'a', use: 'test/typed', with: { known_key: 1 } }])
  expect(warnings).toHaveLength(0)
  await loader.reconcile([{ id: 'a', use: 'test/typed', with: { known_key: 1, typo_key: 2 } }])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("'typo_key'")
  await root.dispose()
})
