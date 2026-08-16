import { Context, Fiber, Root } from '../core/runtime'
import type { Component, Key } from '../core/types'
import type { Registry } from './registry'

export interface EntryDef {
  id: string
  use: string
  with?: Record<string, any>
  /** ids of other entries this entry depends on */
  needs?: string[]
  disabled?: boolean
  /** coeffect key -> realm overrides applied to this entry's context */
  isolate?: Record<string, string>
}

/** the handle every entry provides as `node:<id>` */
export class NodeHandle {
  constructor(readonly ctx: Context) {}

  get fiber(): Fiber | null {
    return this.ctx.fiber
  }

  get uid(): string | undefined {
    return this.ctx.fiber?.uid
  }

  get state() {
    return this.ctx.fiber?.state
  }

  get<T = unknown>(key: Key): T | undefined {
    return this.ctx.get<T>(key)
  }
}

export function nodeKey(id: string): string {
  return `node:${id}`
}

export interface ReconcileChange {
  kind: 'create' | 'dispose' | 'rebuild' | 'disable' | 'enable'
  id: string
  reason?: 'use' | 'with' | 'needs'
}

interface EntryState {
  def: EntryDef
  inject: Key[]
  fiber: Fiber | null
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

function sameKeys(a: Key[], b: Key[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key))
}

export class Loader {
  private entries = new Map<string, EntryState>()

  constructor(
    private root: Root,
    private registry: Registry,
  ) {}

  current(): EntryDef[] {
    return [...this.entries.values()].map((state) => state.def)
  }

  fiber(id: string): Fiber | null {
    return this.entries.get(id)?.fiber ?? null
  }

  async load(defs: EntryDef[]): Promise<ReconcileChange[]> {
    return this.reconcile(defs)
  }

  async reconcile(defs: EntryDef[]): Promise<ReconcileChange[]> {
    // validate everything before touching the running system
    const seen = new Set<string>()
    for (const def of defs) {
      if (!def.id) throw new Error('entry requires an id')
      if (seen.has(def.id)) throw new Error(`duplicate entry id: ${def.id}`)
      seen.add(def.id)
      if (!this.registry.has(def.use)) throw new Error(`unknown component '${def.use}' (entry '${def.id}')`)
    }

    const changes: ReconcileChange[] = []

    for (const [id, current] of [...this.entries]) {
      if (seen.has(id)) continue
      // await teardown so the key space is clean before any replacement is created
      await current.fiber?.dispose()
      this.entries.delete(id)
      changes.push({ kind: 'dispose', id })
    }

    for (const def of defs) {
      const inject: Key[] = (def.needs ?? []).map(nodeKey)
      const current = this.entries.get(def.id)
      if (!current) {
        const fiber = def.disabled ? null : this.createFiber(def, inject)
        this.entries.set(def.id, { def, inject, fiber })
        changes.push({ kind: def.disabled ? 'disable' : 'create', id: def.id })
        continue
      }
      const wasDisabled = Boolean(current.def.disabled)
      const nowDisabled = Boolean(def.disabled)
      if (wasDisabled !== nowDisabled) {
        if (nowDisabled) {
          await current.fiber?.dispose()
          current.fiber = null
          changes.push({ kind: 'disable', id: def.id })
        } else {
          current.fiber = this.createFiber(def, inject)
          changes.push({ kind: 'enable', id: def.id })
        }
      } else if (!nowDisabled) {
        const reason = current.def.use !== def.use ? 'use' : !sameKeys(current.inject, inject) ? 'needs' : stableStringify(current.def.with ?? {}) !== stableStringify(def.with ?? {}) ? 'with' : null
        if (reason) {
          await current.fiber?.dispose()
          current.fiber = this.createFiber(def, inject)
          changes.push({ kind: 'rebuild', id: def.id, reason })
        }
      }
      current.def = def
      current.inject = inject
    }

    return changes
  }

  async dispose(): Promise<void> {
    for (const state of this.entries.values()) await state.fiber?.dispose()
    this.entries.clear()
  }

  private createFiber(def: EntryDef, inject: Key[]): Fiber {
    const componentDef = this.registry.get(def.use)!
    let ctx: Context = this.root.ctx
    for (const [key, realm] of Object.entries(def.isolate ?? {})) ctx = ctx.isolate(key, realm)
    const wrapped: Component<any> = {
      name: def.id,
      inject: [...(componentDef.inject ?? []), ...inject],
      apply: (fiberCtx) => {
        fiberCtx.set(nodeKey(def.id), new NodeHandle(fiberCtx))
        return componentDef.apply(fiberCtx, def.with ?? {})
      },
    }
    return ctx.use(wrapped, def.with ?? {})
  }
}
