import type { Component } from '../core/types'

/** registry maps a `use` string (e.g. 'crawler/x') to the component definition */
export class Registry {
  private defs = new Map<string, Component<any>>()

  define(use: string, def: Component<any>): this {
    if (this.defs.has(use)) throw new Error(`component already defined: ${use}`)
    this.defs.set(use, def)
    return this
  }

  has(use: string): boolean {
    return this.defs.has(use)
  }

  get(use: string): Component<any> | undefined {
    return this.defs.get(use)
  }

  keys(): string[] {
    return [...this.defs.keys()]
  }
}

export function createRegistry(): Registry {
  return new Registry()
}
