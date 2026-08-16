import type { Component } from '../core/types'
import { DigestRules, type RulesAction, type RulesOptions } from '../pipeline/digest-rules'

/**
 * processor/rules: local, no-LLM digest processing (idol-bbq's Mechanical
 * processor, renamed). Exposes the same { process } seam as processor/openai,
 * so crawlers can bind it via post_processors without any LLM spend.
 */

export interface RulesProcessorConfig extends RulesOptions {
  action?: RulesAction
  name?: string
  extended_payload?: RulesOptions
}

export class RulesProcessorClient {
  private readonly rules: DigestRules
  private readonly action: RulesAction

  constructor(config: RulesProcessorConfig) {
    this.action = (config.action ?? 'extract').toLowerCase() as RulesAction
    this.rules = new DigestRules({ ...(config.extended_payload ?? {}), ...stripMeta(config) })
  }

  async process(text: string): Promise<string> {
    if (this.action === 'extract') return JSON.stringify(this.rules.runExtract(text), null, 2)
    if (this.action === 'merge') return JSON.stringify(this.rules.runMerge(text), null, 2)
    throw new Error(`rules processor does not support action: ${this.action}`)
  }
}

function stripMeta(config: RulesProcessorConfig): RulesOptions {
  const { action: _a, name: _n, extended_payload: _e, ...options } = config
  return options
}

export const rulesProcessorComponent: Component<RulesProcessorConfig> = {
  apply: (ctx, config) => {
    ctx.expose(new RulesProcessorClient(config))
  },
}
