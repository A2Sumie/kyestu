import type { Context, Fiber } from './runtime'
import type { Listener } from './emitter'

export type Key = string | symbol
export type Realm = string | symbol
export type Dispose = () => void | Promise<void>
export type MaybePromise<T> = T | Promise<T>
export type EffectYield = Dispose | null | undefined | void
export type EffectIterator = Iterable<EffectYield> | AsyncIterable<EffectYield>
export type EffectResult = EffectYield | EffectIterator
export type EffectCallback = () => MaybePromise<EffectResult>

export type LifecycleState = 'INACTIVE' | 'LOADING' | 'ACTIVE' | 'UNLOADING' | 'FAILED'

export type EffectStatus = 'completed' | 'aborted' | 'error'

export interface Component<C = unknown> {
  name?: string
  inject?: Key[]
  provide?: Key[]
  /**
   * `with` keys this component actually consumes. When declared, the loader
   * warns (does not reject) on any other key at validate time — a typo'd or
   * dead key otherwise runs silently on defaults. Components that pass the
   * whole config through to a plugin layer list the plugin keys too.
   */
  knownWithKeys?: string[]
  apply: (ctx: Context, config: C) => MaybePromise<EffectResult>
}

export type TaintPhase = 'inverse' | 'guard' | 'apply' | 'listener'

export type KyestuEvent =
  | { type: 'lifecycle'; fiber: string; from: LifecycleState; to: LifecycleState }
  | { type: 'taint'; fiber: string; phase: TaintPhase; error: unknown }
  | { type: 'timeout'; fiber: string; waiting: string[] }

export interface KyestuOptions {
  name?: string
  /** max time an unloading provider waits for dependents before forcing recovery */
  unloadGuardTimeoutMs?: number
  onEvent?: Listener<KyestuEvent>
}
