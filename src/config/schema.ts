import type { EntryDef } from '../loader/loader'

export interface RouteDef {
  from: string
  via?: string[]
  to?: string[]
}

export interface KyestuConfig {
  components: Array<{
    id: string
    use: string
    with?: Record<string, any>
    needs?: string[]
    disabled?: boolean
    isolate?: Record<string, string>
  }>
  routes?: RouteDef[]
  /** per-kind defaults, merged under each entry's `with` (kind = the part before '/') */
  defaults?: Record<string, Record<string, any>>
}

/**
 * Compiles a kyestu config into loader entries.
 * A route `from: A, via: [B, C], to: [D]` yields edges A->B, B->C, C->D;
 * every edge makes the downstream entry need the upstream entry.
 */
export function compileConfig(config: KyestuConfig): EntryDef[] {
  if (!Array.isArray(config.components)) throw new Error('config requires a components list')

  const ids = new Set<string>()
  for (const component of config.components) {
    if (!component.id) throw new Error('every component requires an id')
    if (!component.use) throw new Error(`component '${component.id}' requires a use`)
    if (ids.has(component.id)) throw new Error(`duplicate component id: ${component.id}`)
    ids.add(component.id)
  }

  const derivedNeeds = new Map<string, Set<string>>()
  const addEdge = (from: string, to: string) => {
    if (from === to) throw new Error(`route self-edge: ${from}`)
    let set = derivedNeeds.get(to)
    if (!set) derivedNeeds.set(to, (set = new Set()))
    set.add(from)
  }

  for (const [index, route] of (config.routes ?? []).entries()) {
    if (!route.from) throw new Error(`route #${index} requires 'from'`)
    const chain = [route.from, ...(route.via ?? [])]
    for (const id of [...chain, ...(route.to ?? [])]) {
      if (!ids.has(id)) throw new Error(`route #${index} references unknown component: ${id}`)
    }
    for (let i = 1; i < chain.length; i++) addEdge(chain[i - 1]!, chain[i]!)
    const last = chain[chain.length - 1]!
    for (const target of route.to ?? []) addEdge(last, target)
  }

  const entries: EntryDef[] = config.components.map((component) => {
    const kind = component.use.split('/')[0]!
    const defaults = config.defaults?.[kind] ?? {}
    const needs = new Set([...(component.needs ?? []), ...(derivedNeeds.get(component.id) ?? [])])
    for (const need of component.needs ?? []) {
      if (!ids.has(need)) throw new Error(`component '${component.id}' needs unknown component: ${need}`)
    }
    const entry: EntryDef = {
      id: component.id,
      use: component.use,
      with: { ...defaults, ...(component.with ?? {}) },
    }
    if (needs.size > 0) entry.needs = [...needs].sort()
    if (component.disabled) entry.disabled = true
    if (component.isolate) entry.isolate = component.isolate
    return entry
  })

  assertAcyclic(entries)
  return entries
}

function assertAcyclic(entries: EntryDef[]): void {
  const needs = new Map(entries.map((entry) => [entry.id, new Set(entry.needs ?? [])]))
  const permanent = new Set<string>()
  const temporary = new Set<string>()
  const stack: string[] = []

  const visit = (id: string) => {
    if (permanent.has(id)) return
    if (temporary.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(' -> ')
      throw new Error(`dependency cycle: ${cycle}`)
    }
    temporary.add(id)
    stack.push(id)
    for (const need of needs.get(id) ?? []) visit(need)
    stack.pop()
    temporary.delete(id)
    permanent.add(id)
  }

  for (const entry of entries) visit(entry.id)
}
