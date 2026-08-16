import type { Registry } from '../loader/registry'
import { dbComponent } from './db'
import { browserPoolComponent } from './browser-pool'
import { onebotComponent } from './onebot'
import { openAiProcessorComponent } from './llm-openai'

export function defineInfra(registry: Registry): Registry {
  return registry
    .define('infra/db', dbComponent)
    .define('infra/browser-pool', browserPoolComponent)
    .define('infra/onebot', onebotComponent)
    .define('processor/openai', openAiProcessorComponent)
}
