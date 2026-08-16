import type { Registry } from '../loader/registry'
import { dbComponent } from './db'
import { browserPoolComponent } from './browser-pool'
import { onebotComponent } from './onebot'
import { openAiProcessorComponent } from './llm-openai'
import { busComponent } from './bus'
import { mediaStoreComponent } from './media-store'
import { makeCrawlerComponent } from './crawler'
import { makeFormatterComponent } from './formatter'
import { qqTargetComponent } from './target-qq'
import { bilibiliTargetComponent } from './target-bilibili'
import { routerComponent } from './router'
import { apiComponent } from './api'

export function defineInfra(registry: Registry): Registry {
  return registry
    .define('infra/db', dbComponent)
    .define('infra/browser-pool', browserPoolComponent)
    .define('infra/onebot', onebotComponent)
    .define('infra/bus', busComponent)
    .define('infra/media-store', mediaStoreComponent)
    .define('processor/openai', openAiProcessorComponent)
}

const CRAWLER_KINDS = ['x', 'x-list', 'instagram', 'tiktok', 'youtube', 'website-227', 'website', 'leap', 'messageboard']
const FORMATTER_RENDER_TYPES = ['text', 'text-compact', 'text-card', 'text-compact-card', 'img', 'img-tag', 'img-tag-dynamic', 'img-with-meta', 'tag', 'raw-text']

export function defineAll(registry: Registry): Registry {
  defineInfra(registry)
  for (const kind of CRAWLER_KINDS) registry.define(`crawler/${kind}`, makeCrawlerComponent(kind))
  for (const renderType of FORMATTER_RENDER_TYPES) registry.define(`formatter/${renderType}`, makeFormatterComponent(renderType))
  return registry
    .define('target/qq', qqTargetComponent)
    .define('target/bilibili', bilibiliTargetComponent)
    .define('app/router', routerComponent)
    .define('app/api', apiComponent)
}
