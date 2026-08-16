import type { KyestuConfig, RouteDef } from '../config/schema'

/**
 * Converts an idol-bbq (tweet-forwarder) AppConfig into a kyestu config.
 * Structure only — `with` payloads are carried over verbatim.
 */

const KNOWN_PROVIDERS: Record<string, string> = {
  DeepSeekV4Flash: 'deepseek-v4-flash',
  DeepSeekV4Pro: 'deepseek-v4-pro',
  Hy3Free: 'hy3-free',
  Google: 'google',
  OpenaiLike: 'openai-like',
  Mechanical: 'mechanical',
}

function kebab(value: string): string {
  if (KNOWN_PROVIDERS[value]) return KNOWN_PROVIDERS[value]
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase()
}

function crawlerKind(crawler: any): string {
  const origin: string = crawler.origin ?? ''
  const website: string = crawler.websites?.[0] ?? ''
  const probe = `${origin} ${website}`
  if (probe.includes('x.com/i/lists')) return 'x-list'
  if (probe.includes('x.com') || probe.includes('twitter.com')) return 'x'
  if (probe.includes('instagram.com')) return 'instagram'
  if (probe.includes('tiktok.com')) return 'tiktok'
  if (probe.includes('youtube.com') || probe.includes('youtu.be')) return 'youtube'
  if (probe.includes('nanabunnonijyuuni')) return 'website-227'
  if (probe.includes('leap-projects.jp')) return 'leap'
  return 'website'
}

export function convertIdolBbqConfig(old: any): KyestuConfig {
  if (!old || typeof old !== 'object') throw new Error('invalid idol-bbq config')
  const components: KyestuConfig['components'] = []
  const warnings: string[] = []

  for (const crawler of old.crawlers ?? []) {
    const id = crawler.name
    if (!id) throw new Error('crawler without a name')
    const { cfg_crawler, ...rest } = crawler
    components.push({
      id,
      use: `crawler/${crawlerKind(crawler)}`,
      with: { ...rest, ...(cfg_crawler ?? {}) },
    })
  }

  for (const processor of old.processors ?? []) {
    if (!processor.id) throw new Error('processor without an id')
    const { id, provider, cfg_processor, ...rest } = processor
    components.push({
      id,
      use: `processor/${kebab(provider ?? 'unknown')}`,
      with: { ...rest, ...(cfg_processor ?? {}) },
    })
  }

  for (const formatter of old.formatters ?? []) {
    if (!formatter.id) throw new Error('formatter without an id')
    const { id, render_type, ...rest } = formatter
    components.push({
      id,
      use: `formatter/${render_type ?? 'text'}`,
      with: rest,
    })
  }

  for (const target of old.forward_targets ?? []) {
    const id = target.id ?? `${target.platform}-${JSON.stringify(target.cfg_platform ?? {}).length}`
    components.push({
      id,
      use: `target/${target.platform}`,
      with: target.cfg_platform ?? {},
    })
  }

  for (const forwarder of old.forwarders ?? []) {
    const id = forwarder.name
    if (!id) throw new Error('forwarder without a name')
    const { cfg_forwarder, ...rest } = forwarder
    components.push({
      id,
      use: `forwarder/${crawlerKind(forwarder)}`,
      with: { ...rest, ...(cfg_forwarder ?? {}) },
    })
    warnings.push(`forwarder '${id}': legacy origin auto-bind is not imported; add explicit routes if needed`)
  }

  if (old.api) components.push({ id: 'api', use: 'app/api', with: old.api })
  if (old.live_capture) components.push({ id: 'live-capture', use: 'app/live-capture', with: old.live_capture })

  // connections -> routes
  const connections = old.connections ?? {}
  const crawlerProcessor: Record<string, string> = connections['crawler-processor'] ?? {}
  const processorFormatter: Record<string, string[]> = connections['processor-formatter'] ?? {}
  const crawlerFormatter: Record<string, string[]> = connections['crawler-formatter'] ?? {}
  const formatterTarget: Record<string, string[]> = connections['formatter-target'] ?? {}
  const forwarderTarget: Record<string, string[]> = connections['forwarder-target'] ?? {}

  const crawlerIds = new Set((old.crawlers ?? []).map((c: any) => c.name))
  const merged = new Map<string, RouteDef>()
  const pushRoute = (from: string, via: string[], to: string[]) => {
    const key = JSON.stringify([from, via])
    const existing = merged.get(key)
    if (existing) existing.to = [...new Set([...(existing.to ?? []), ...to])]
    else merged.set(key, { from, ...(via.length ? { via } : {}), to: [...new Set(to)] })
  }

  for (const [crawlerName, formatterIds] of Object.entries(crawlerFormatter)) {
    if (!crawlerIds.has(crawlerName)) warnings.push(`connections reference unknown crawler '${crawlerName}'`)
    for (const formatterId of formatterIds) {
      pushRoute(crawlerName, [formatterId], formatterTarget[formatterId] ?? [])
    }
  }
  for (const [processorId, formatterIds] of Object.entries(processorFormatter)) {
    const owners = Object.entries(crawlerProcessor)
      .filter(([, p]) => p === processorId)
      .map(([c]) => c)
    for (const crawlerName of owners) {
      for (const formatterId of formatterIds) {
        pushRoute(crawlerName, [processorId, formatterId], formatterTarget[formatterId] ?? [])
      }
    }
  }
  // crawler->processor is a standalone service edge (crawl-time translation):
  // the crawler depends on the processor, so the edge points processor -> crawler
  for (const [crawlerName, processorId] of Object.entries(crawlerProcessor)) {
    pushRoute(processorId, [], [crawlerName])
  }
  for (const [forwarderName, targetIds] of Object.entries(forwarderTarget)) {
    pushRoute(forwarderName, [], targetIds)
  }

  const defaults: Record<string, Record<string, any>> = {}
  if (old.cfg_crawler) defaults.crawler = old.cfg_crawler
  if (old.cfg_forwarder) defaults.forwarder = old.cfg_forwarder
  if (old.cfg_forward_target) defaults.target = old.cfg_forward_target

  const config: KyestuConfig = {
    components,
    routes: [...merged.values()],
    ...(Object.keys(defaults).length ? { defaults } : {}),
  }
  if (warnings.length) (config as any).warnings = warnings
  return config
}
