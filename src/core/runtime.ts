import { Emitter } from './emitter'
import type {
  Component,
  Dispose,
  EffectCallback,
  EffectIterator,
  EffectStatus,
  Key,
  KyestuEvent,
  KyestuOptions,
  LifecycleState,
  Realm,
} from './types'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let uidCounter = 0

interface StoreEntry {
  value: unknown
  owner: Fiber | null
}

interface FoldState {
  armed: boolean
  inverses: Dispose[]
}

export interface TrackResult {
  status: EffectStatus
  error?: unknown
}

export interface EffectHandle {
  dispose: Dispose & { done: Promise<TrackResult> }
  done: Promise<TrackResult>
}

function isEffectIterator(value: unknown): value is EffectIterator {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Symbol.iterator in value || Symbol.asyncIterator in value)
  )
}

async function fold(state: FoldState, result: unknown, guard: () => boolean): Promise<TrackResult> {
  if (result == null) return { status: 'completed' }
  if (typeof result === 'function') {
    state.inverses.push(result as Dispose)
    return { status: 'completed' }
  }
  if (!isEffectIterator(result)) {
    return { status: 'error', error: new TypeError('effect callback must return a dispose function or an iterator') }
  }
  const iterator =
    Symbol.asyncIterator in result
      ? (result as AsyncIterable<Dispose | void>)[Symbol.asyncIterator]()
      : (result as Iterable<Dispose | void>)[Symbol.iterator]()
  while (guard()) {
    const step = await iterator.next()
    if (step.done) return { status: 'completed' }
    if (typeof step.value === 'function') state.inverses.push(step.value)
  }
  // guard tripped between iterations: the in-flight iteration has landed (inertia);
  // close the iterator and keep the inverses accumulated so far
  try {
    await iterator.return?.()
  } catch {
    // closing fault tolerated: nothing further to recover from this iterator
  }
  return { status: 'aborted' }
}

function trackEffect(
  accumulator: Dispose[],
  callback: EffectCallback,
  guard: (() => boolean) | undefined,
  onTaint: (error: unknown) => void,
): EffectHandle {
  const state: FoldState = { armed: true, inverses: [] }
  const effectiveGuard = guard ?? (() => state.armed)
  let resolveDone!: (result: TrackResult) => void
  const done = new Promise<TrackResult>((resolve) => (resolveDone = resolve))
  const dispose = (async () => {
    if (!state.armed) return
    state.armed = false
    await done
    for (let i = state.inverses.length - 1; i >= 0; i--) {
      const inverse = state.inverses[i]
      if (!inverse) continue
      try {
        await inverse()
      } catch (error) {
        onTaint(error)
      }
    }
    state.inverses.length = 0
  }) as Dispose & { done: Promise<TrackResult> }
  dispose.done = done
  // register before the callback runs so the accumulator order matches the
  // order in which effects were applied (LIFO recovery)
  accumulator.push(dispose)
  void (async () => {
    try {
      const result = await callback()
      resolveDone(await fold(state, result, effectiveGuard))
    } catch (error) {
      resolveDone({ status: 'error', error })
    }
  })()
  return { dispose, done }
}

export class Context {
  readonly root: Root
  readonly parent: Context | null
  fiber: Fiber | null = null
  private iso: Map<Key, Realm> | null = null
  private accumulator: Dispose[] = []
  private exposedValue: unknown

  /** expose this context's service API; consumers reach it via the node handle's api() */
  expose(value: unknown): void {
    this.exposedValue = value
  }

  get exposed(): unknown {
    return this.exposedValue
  }

  constructor(root: Root, parent: Context | null) {
    this.root = root
    this.parent = parent
  }

  ownerFiber(): Fiber | null {
    let ctx: Context | null = this
    while (ctx) {
      if (ctx.fiber) return ctx.fiber
      ctx = ctx.parent
    }
    return null
  }

  /** the context whose accumulator carries this context's effects */
  private accumulatorOwner(): Context {
    return this.ownerFiber()?.ctx ?? this.root.ctx
  }

  resolveRealm(key: Key): Realm {
    let ctx: Context | null = this
    while (ctx) {
      const realm = ctx.iso?.get(key)
      if (realm !== undefined) return realm
      ctx = ctx.parent
    }
    return key
  }

  get<T = unknown>(key: Key): T | undefined {
    return this.root.readEntry(this, key)?.value as T | undefined
  }

  has(key: Key): boolean {
    return this.root.readEntry(this, key) !== undefined
  }

  set(key: Key, value: unknown): Dispose {
    const realm = this.resolveRealm(key)
    this.root.writeEntry(this, key, realm, value)
    this.root.notify([{ key, realm }])
    return this.effect(() => () => {
      if (this.root.removeEntryIf(realm, key, value)) this.root.notify([{ key, realm }])
    })
  }

  /** derived context: key resolves to a different realm below this context */
  isolate(key: Key, realm: Realm = Symbol(`realm:${String(key)}`)): Context {
    const ctx = new Context(this.root, this)
    ctx.iso = new Map([[key, realm]])
    return ctx
  }

  effect(callback: EffectCallback): Dispose & { done: Promise<TrackResult> } {
    const owner = this.ownerFiber()
    return trackEffect(this.accumulatorOwner().accumulator, callback, undefined, (error) =>
      this.root.reportTaint(owner, 'inverse', error),
    ).dispose
  }

  effectWithGuard(callback: EffectCallback, guard: () => boolean): EffectHandle {
    const owner = this.ownerFiber()
    return trackEffect(this.accumulatorOwner().accumulator, callback, guard, (error) =>
      this.root.reportTaint(owner, 'inverse', error),
    )
  }

  use<C>(component: Component<C>, config?: C): Fiber {
    // fiber hierarchy follows the owning fiber; the ctx chain follows the calling
    // context, so use() on an isolated context keeps the isolation
    const fiber = new Fiber(this.root, this.ownerFiber(), this, component, config as C)
    this.root.fibers.add(fiber)
    fiber.parent?.children.add(fiber)
    // registration inverse: retiring is the unload-safe form of removal (paper Def. 47)
    this.accumulatorOwner().accumulator.push(async () => {
      await fiber.dispose()
    })
    fiber.refresh()
    return fiber
  }

  async runAccumulated(): Promise<void> {
    while (this.accumulator.length > 0) {
      const dispose = this.accumulator.pop()!
      try {
        await dispose()
      } catch (error) {
        this.root.reportTaint(this.ownerFiber(), 'inverse', error)
      }
    }
  }
}

export class Root {
  readonly ctx: Context
  readonly fibers = new Set<Fiber>()
  readonly emitter = new Emitter<KyestuEvent>()
  readonly store = new Map<Realm, Map<Key, StoreEntry>>()
  readonly name: string
  readonly unloadGuardTimeoutMs: number

  constructor(options: KyestuOptions = {}) {
    this.name = options.name ?? 'kyestu'
    this.unloadGuardTimeoutMs = options.unloadGuardTimeoutMs ?? 15000
    this.ctx = new Context(this, null)
    if (options.onEvent) this.emitter.on(options.onEvent)
  }

  readEntry(ctx: Context, key: Key): StoreEntry | undefined {
    return this.store.get(ctx.resolveRealm(key))?.get(key)
  }

  writeEntry(ctx: Context, key: Key, realm: Realm, value: unknown): void {
    let table = this.store.get(realm)
    if (!table) {
      table = new Map()
      this.store.set(realm, table)
    }
    if (table.has(key)) throw new Error(`coeffect key already provided: ${String(key)}`)
    table.set(key, { value, owner: ctx.ownerFiber() })
  }

  removeEntryIf(realm: Realm, key: Key, value: unknown): boolean {
    const table = this.store.get(realm)
    const entry = table?.get(key)
    if (!entry || entry.value !== value) return false
    table!.delete(key)
    if (table!.size === 0) this.store.delete(realm)
    return true
  }

  notify(changes: Array<{ key: Key; realm: Realm }>): Fiber[] {
    const affected: Fiber[] = []
    for (const fiber of this.fibers) {
      if (fiber.state === 'FAILED') continue
      const inject = fiber.component.inject
      if (!inject?.length) continue
      for (const { key, realm } of changes) {
        if (!inject.includes(key)) continue
        if (fiber.ctx.resolveRealm(key) !== realm) continue
        affected.push(fiber)
        fiber.refresh()
        break
      }
    }
    return affected
  }

  notifyProvidedBy(fiber: Fiber): void {
    const changes: Array<{ key: Key; realm: Realm }> = []
    for (const [realm, table] of this.store) {
      for (const [key, entry] of table) {
        if (entry.owner === fiber) changes.push({ key, realm })
      }
    }
    if (changes.length > 0) this.notify(changes)
  }

  reportTaint(fiber: Fiber | null, phase: 'inverse' | 'guard' | 'apply' | 'listener', error: unknown): void {
    fiber?.taints.push({ phase, error, at: Date.now() })
    this.emitter.emit({ type: 'taint', fiber: fiber?.name ?? 'root', phase, error })
  }

  emitLifecycle(fiber: Fiber, from: LifecycleState, to: LifecycleState): void {
    this.emitter.emit({ type: 'lifecycle', fiber: fiber.name, from, to })
  }

  /** resolves when no fiber has a transition in flight (test/debug helper) */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.fibers].some((fiber) => fiber.inertia !== null)
      if (!busy) return
      await sleep(5)
    }
  }

  async dispose(): Promise<void> {
    await this.ctx.runAccumulated()
    for (const fiber of [...this.fibers]) await fiber.dispose()
  }
}

export class Fiber {
  readonly uid: string
  readonly name: string
  readonly root: Root
  readonly parent: Fiber | null
  readonly component: Component<any>
  readonly config: unknown
  readonly children = new Set<Fiber>()
  readonly ctx: Context
  readonly taints: Array<{ phase: string; error: unknown; at: number }> = []

  state: LifecycleState = 'INACTIVE'
  retired = false
  outcome: unknown = undefined
  generation = 0
  committed: Map<Key, string> | null = null
  inertia: Promise<void> | null = null

  private targetDigest: string | null = null
  private targetView: Map<Key, string> | null = null
  private stateWaiters = new Set<() => void>()

  constructor(root: Root, parent: Fiber | null, parentCtx: Context, component: Component<any>, config: unknown) {
    this.uid = `f${++uidCounter}`
    this.name = component.name ?? this.uid
    this.root = root
    this.parent = parent
    this.component = component
    this.config = config
    this.ctx = new Context(root, parentCtx)
    this.ctx.fiber = this
  }

  isTerminal(): boolean {
    return (this.state === 'INACTIVE' || this.state === 'FAILED') && this.inertia === null
  }

  /** ghost-write guard: true only while the generation captured at load start is live */
  isCurrent(generation: number): boolean {
    return (
      !this.retired &&
      this.generation === generation &&
      (this.state === 'LOADING' || this.state === 'ACTIVE')
    )
  }

  /** wrap an async continuation so it runs only while its generation is live */
  wrap<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
    const generation = this.generation
    return (...args: A) => (this.isCurrent(generation) ? fn(...args) : undefined)
  }

  refresh(): void {
    if (this.state === 'FAILED') return
    const target = this.retired ? null : this.computeTarget()
    const digest = target?.digest ?? null
    if (digest === this.targetDigest) return
    this.targetDigest = digest
    this.targetView = target?.view ?? null
    if (this.inertia) return
    this.kick()
  }

  /** manual re-entry from FAILED (the calculus never re-enters automatically) */
  reset(): void {
    if (this.state !== 'FAILED') return
    this.outcome = undefined
    this.targetDigest = null
    this.targetView = null
    this.setState('INACTIVE')
    this.refresh()
  }

  /** O-Retire: marks the fiber retired and lets the lifecycle carry it out */
  async dispose(): Promise<void> {
    if (!this.retired) {
      this.retired = true
      this.targetDigest = null
      this.targetView = null
      if (!this.inertia) this.kick()
    }
    await this.waitTerminal()
    this.pruneIfDead()
  }

  async waitTerminal(): Promise<void> {
    while (!this.isTerminal()) await this.nextStateChange()
  }

  nextStateChange(): Promise<void> {
    return new Promise((resolve) => {
      const waiter = () => {
        this.stateWaiters.delete(waiter)
        resolve()
      }
      this.stateWaiters.add(waiter)
    })
  }

  private setState(to: LifecycleState): void {
    if (this.state === to) return
    const from = this.state
    this.state = to
    this.root.emitLifecycle(this, from, to)
    for (const waiter of [...this.stateWaiters]) waiter()
  }

  private computeTarget(): { digest: string; view: Map<Key, string> } | null {
    const view = new Map<Key, string>()
    for (const key of this.component.inject ?? []) {
      const entry = this.root.readEntry(this.ctx, key)
      if (!entry) return null
      if (entry.owner && entry.owner.state !== 'ACTIVE') return null
      view.set(key, entry.owner ? entry.owner.uid : 'root')
    }
    const digest = JSON.stringify([...view].map(([key, uid]) => [String(key), uid]).sort())
    return { digest, view }
  }

  private kick(): void {
    if (this.inertia) return
    if (this.state === 'LOADING' || this.state === 'UNLOADING' || this.state === 'FAILED') return
    if (this.targetDigest !== null) this.startLoad()
    else if (this.state === 'ACTIVE') this.startUnload()
  }

  private startLoad(): void {
    this.setState('LOADING')
    const generation = ++this.generation
    this.committed = this.targetView ? new Map(this.targetView) : new Map()
    const digestAtStart = this.targetDigest!
    const handle = this.ctx.effectWithGuard(
      () => this.component.apply(this.ctx, this.config),
      () => !this.retired && this.generation === generation && this.targetDigest === digestAtStart,
    )
    this.inertia = (async () => {
      const result = await handle.done
      this.inertia = null
      if (result.status === 'error') {
        this.startUnload({ error: result.error })
        return
      }
      if (result.status === 'aborted' || this.retired || this.targetDigest !== digestAtStart) {
        this.startUnload()
        return
      }
      this.setState('ACTIVE')
      this.root.notifyProvidedBy(this)
    })()
  }

  private startUnload(outcome?: { error: unknown }): void {
    if (this.inertia) return
    if (this.state !== 'UNLOADING') this.setState('UNLOADING')
    // L-Leave: stop providing before any inverse is scheduled, so dependents leave first
    this.root.notifyProvidedBy(this)
    this.inertia = (async () => {
      await this.waitDependents()
      await this.ctx.runAccumulated()
      this.committed = null
      this.inertia = null
      if (outcome) {
        this.outcome = outcome.error
        this.setState('FAILED')
      } else if (this.retired || this.targetDigest === null) {
        this.setState('INACTIVE')
        this.pruneIfDead()
      } else {
        this.startLoad()
      }
    })()
  }

  private async waitDependents(): Promise<void> {
    const deadline = Date.now() + this.root.unloadGuardTimeoutMs
    for (;;) {
      const blocking = [...this.root.fibers].filter(
        (fiber) =>
          fiber !== this &&
          !fiber.isTerminal() &&
          fiber.committed !== null &&
          [...fiber.committed.values()].includes(this.uid),
      )
      if (blocking.length === 0) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const waiting = blocking.map((fiber) => fiber.name)
        this.root.emitter.emit({ type: 'timeout', fiber: this.name, waiting })
        this.taints.push({ phase: 'guard', error: new Error(`unload guard timeout, forced; dependents: ${waiting.join(', ')}`), at: Date.now() })
        return
      }
      await Promise.race([...blocking.map((fiber) => fiber.nextStateChange()), sleep(Math.min(25, remaining))])
    }
  }

  private pruneIfDead(): void {
    if (!this.retired || !this.isTerminal() || this.children.size > 0) return
    this.root.fibers.delete(this)
    this.parent?.children.delete(this)
    this.parent?.pruneIfDead()
  }
}

export function createRoot(options: KyestuOptions = {}): Root {
  return new Root(options)
}
