import { test, expect } from 'bun:test'
import { compileConfig } from '../src/config/schema'
import { loadConfigYaml, dumpConfigYaml, parseConfigYaml } from '../src/config/yaml'

test('routes compile to needs: from->via->...->to chain', () => {
  const entries = compileConfig({
    components: [
      { id: 'a', use: 'crawler/x' },
      { id: 'b', use: 'processor/deepseek' },
      { id: 'c', use: 'formatter/img-tag' },
      { id: 'd', use: 'target/qq' },
    ],
    routes: [{ from: 'a', via: ['b', 'c'], to: ['d'] }],
  })
  const needs = Object.fromEntries(entries.map((e) => [e.id, e.needs ?? []]))
  expect(needs.a).toEqual([])
  expect(needs.b).toEqual(['a'])
  expect(needs.c).toEqual(['b'])
  expect(needs.d).toEqual(['c'])
})

test('defaults merge under entry with, entry wins', () => {
  const entries = compileConfig({
    components: [{ id: 'a', use: 'crawler/x', with: { interval: 5 } }],
    defaults: { crawler: { interval: 10, cookie: 'x.txt' } },
  })
  expect(entries[0]!.with).toEqual({ interval: 5, cookie: 'x.txt' })
})

test('explicit needs merge with route-derived needs', () => {
  const entries = compileConfig({
    components: [
      { id: 'a', use: 'x/y' },
      { id: 'b', use: 'x/y' },
      { id: 'c', use: 'x/y', needs: ['a'] },
    ],
    routes: [{ from: 'b', to: ['c'] }],
  })
  expect(entries.find((e) => e.id === 'c')!.needs).toEqual(['a', 'b'])
})

test('cycle detection reports the cycle path', () => {
  expect(() =>
    compileConfig({
      components: [
        { id: 'a', use: 'x/y', needs: ['b'] },
        { id: 'b', use: 'x/y', needs: ['a'] },
      ],
    }),
  ).toThrow(/dependency cycle/)
})

test('validation: unknown route endpoint / self-edge / unknown needs / duplicate id', () => {
  expect(() => compileConfig({ components: [{ id: 'a', use: 'x/y' }], routes: [{ from: 'a', to: ['ghost'] }] })).toThrow(/unknown component/)
  expect(() => compileConfig({ components: [{ id: 'a', use: 'x/y' }], routes: [{ from: 'a', to: ['a'] }] })).toThrow(/self-edge/)
  expect(() => compileConfig({ components: [{ id: 'a', use: 'x/y', needs: ['ghost'] }] })).toThrow(/unknown component/)
  expect(() => compileConfig({ components: [{ id: 'a', use: 'x/y' }, { id: 'a', use: 'x/y' }] })).toThrow(/duplicate/)
})

// route-derived needs feed the same cycle check as explicit needs; a loop
// closed purely by routes must be caught before anything loads
test('route-only cycles are rejected with the cycle path', () => {
  expect(() =>
    compileConfig({
      components: [
        { id: 'a', use: 'x/y' },
        { id: 'b', use: 'x/y' },
      ],
      routes: [
        { from: 'a', to: ['b'] },
        { from: 'b', to: ['a'] },
      ],
    }),
  ).toThrow(/dependency cycle: a -> b -> a/)
})

test('a cycle closed through a via chain is rejected', () => {
  // a -> b -> c plus c -> b: b needs a, c needs b, and the second route makes b need c
  expect(() =>
    compileConfig({
      components: [
        { id: 'a', use: 'x/y' },
        { id: 'b', use: 'x/y' },
        { id: 'c', use: 'x/y' },
      ],
      routes: [
        { from: 'a', via: ['b'], to: ['c'] },
        { from: 'c', to: ['b'] },
      ],
    }),
  ).toThrow(/dependency cycle/)
})

test('disabled and isolate compile through to the entry', () => {
  const entries = compileConfig({
    components: [{ id: 'a', use: 'x/y', disabled: true, isolate: { cfg: 'realm-a' } }],
  })
  expect(entries[0]).toMatchObject({ id: 'a', disabled: true, isolate: { cfg: 'realm-a' } })
})

test('structural validation: non-array components / missing use / route without from', () => {
  expect(() => compileConfig({} as any)).toThrow(/components list/)
  expect(() => compileConfig({ components: [{ id: 'a' } as any] })).toThrow(/requires a use/)
  expect(() =>
    compileConfig({ components: [{ id: 'a', use: 'x/y' }], routes: [{ to: ['a'] } as any] }),
  ).toThrow(/requires 'from'/)
})

test('via-only route: edges stop at the chain end, no phantom targets', () => {
  const entries = compileConfig({
    components: [
      { id: 'a', use: 'x/y' },
      { id: 'b', use: 'x/y' },
      { id: 'c', use: 'x/y' },
    ],
    routes: [{ from: 'a', via: ['b', 'c'] }],
  })
  const needs = Object.fromEntries(entries.map((e) => [e.id, e.needs ?? []]))
  expect(needs).toEqual({ a: [], b: ['a'], c: ['b'] })
})

test('yaml roundtrip', () => {
  const text = `
components:
  - id: x-main
    use: crawler/x
    with:
      schedule: { timezone: Asia/Tokyo }
  - id: qq-1
    use: target/qq
routes:
  - from: x-main
    to: [qq-1]
`
  const entries = loadConfigYaml(text)
  expect(entries.length).toBe(2)
  expect(entries.find((e) => e.id === 'qq-1')!.needs).toEqual(['x-main'])
  const config = parseConfigYaml(dumpConfigYaml(parseConfigYaml(text)))
  expect(config.components!.length).toBe(2)
})
