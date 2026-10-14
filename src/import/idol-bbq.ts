import type { KyestuConfig, RouteDef } from '../config/schema'

/**
 * Converts an idol-bbq (tweet-forwarder) AppConfig into a kyestu config.
 * Structure only — `with` payloads are carried over verbatim.
 */

/**
 * LLM processors in kyestu are named by wire protocol, not by vendor/model:
 * DeepSeek V4 (wire_api: responses) and Hy3 (chat completions) are both the
 * OpenAI protocol family. The production config is never modified; the mapping
 * happens only here.
 */
const PROVIDER_PROTOCOL: Record<string, string> = {
  DeepSeekV4Flash: 'openai',
  DeepSeekV4Pro: 'openai',
  Hy3Free: 'openai',
  OpenaiLike: 'openai',
}

const DROPPED_PROVIDERS = new Set(['Google', 'Deepseek'])

function inferWireApi(cfgProcessor: any): string {
  if (cfgProcessor?.wire_api) return cfgProcessor.wire_api
  if (String(cfgProcessor?.base_url ?? '').includes('/responses')) return 'responses'
  return 'chat_completions'
}

/**
 * idol-bbq provider 的默认端点（middleware/processor/openai.ts 的 *_DEFAULT_CONFIG）。
 * 厂商名/模型默认值只在导入器出现（D4/D5）：kyestu 侧看到的是 OpenAI 兼容端点配置。
 */
const PROVIDER_ENDPOINT_DEFAULTS: Record<string, Record<string, any>> = {
  DeepSeekV4Flash: {
    model_id: 'deepseek-v4-flash',
    base_url: 'https://opencode.ai/zen/go/v1/chat/completions',
    max_tokens: 384000,
    temperature: 1.3,
    extended_payload: { thinking: { type: 'disabled' } },
  },
  DeepSeekV4Pro: {
    model_id: 'deepseek-v4-pro',
    base_url: 'https://opencode.ai/zen/go/v1/chat/completions',
    max_tokens: 384000,
    temperature: 1.0,
    extended_payload: { thinking: { type: 'disabled' } },
  },
  Hy3Free: {
    model_id: 'hy3',
    base_url: 'https://api.lkeap.cloud.tencent.com/plan/v3/chat/completions',
    temperature: 1.0,
  },
  OpenaiLike: {},
}

/** idol-bbq 的 `{{key}}` 模板语法 → kyestu 的 `{key}` */
function templatePlaceholders(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, '{$1}') : undefined
}

/**
 * video_upload 的 idol-bbq 形态 → kyestu 形态：
 * - `metadata_templates.{title,description}` → `title_template`/`desc_template`（显式模板优先）
 * - `title_generation`（provider+cfg_processor）→ OpenAI 兼容端点块（译题语义见 docs/bili-title.md）
 * - `tag_generation` 不移植（kyestu 无 LLM 标签链路），静态 tags 保留
 */
function mapVideoUploadConfig(id: string, cfgPlatform: any, warnings: string[]): any {
  const videoUpload = cfgPlatform?.video_upload
  if (!videoUpload || typeof videoUpload !== 'object') return cfgPlatform
  const mapped: Record<string, any> = { ...videoUpload }

  const templates = videoUpload.metadata_templates
  if (templates && typeof templates === 'object') {
    const title = templatePlaceholders(templates.title)
    const description = templatePlaceholders(templates.description)
    if (title && mapped.title_template) {
      warnings.push(`target '${id}': video_upload.title_template overrides metadata_templates.title`)
    } else if (title) {
      mapped.title_template = title
    }
    if (description && mapped.desc_template) {
      warnings.push(`target '${id}': video_upload.desc_template overrides metadata_templates.description`)
    } else if (description) {
      mapped.desc_template = description
    }
    delete mapped.metadata_templates
  }

  const titleGeneration = videoUpload.title_generation
  if (titleGeneration && typeof titleGeneration === 'object') {
    const provider = String(titleGeneration.provider || '')
    if (provider && !(provider in PROVIDER_ENDPOINT_DEFAULTS)) {
      warnings.push(`target '${id}': title_generation provider '${provider}' unknown; cfg_processor endpoint used as-is`)
    }
    const cfgProcessor = titleGeneration.cfg_processor ?? {}
    const defaults = PROVIDER_ENDPOINT_DEFAULTS[provider] ?? {}
    const merged = {
      ...defaults,
      ...cfgProcessor,
      extended_payload: { ...(defaults.extended_payload ?? {}), ...(cfgProcessor.extended_payload ?? {}) },
    }
    const prompt = typeof merged.prompt === 'string' ? merged.prompt : ''
    const { prompt: _prompt, ...endpoint } = merged
    mapped.title_generation = {
      enabled: titleGeneration.enabled !== false,
      api_key: titleGeneration.api_key,
      ...endpoint,
      wire_api: inferWireApi(merged),
      ...(titleGeneration.target_min_chars !== undefined ? { target_min_chars: titleGeneration.target_min_chars } : {}),
      ...(titleGeneration.target_max_chars !== undefined ? { target_max_chars: titleGeneration.target_max_chars } : {}),
      ...(prompt ? { prompt } : {}),
    }
  } else if (titleGeneration === false) {
    mapped.title_generation = false
  }

  if (videoUpload.tag_generation) {
    warnings.push(`target '${id}': video_upload.tag_generation is not ported (kyestu has no LLM tag chain); static tags kept`)
    delete mapped.tag_generation
  }
  return { ...cfgPlatform, video_upload: mapped }
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
  const skippedProcessors = new Set<string>()
  const usedTargetIds = new Set<string>()
  const livePlayerTargets: Record<string, any> = {}

  const stableConfigFingerprint = (value: unknown): string => {
    const stable = (v: unknown): string => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
      if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
      return `{${Object.keys(v as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable((v as Record<string, unknown>)[key])}`)
        .join(',')}}`
    }
    let hash = 0
    const text = stable(value)
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
    return hash.toString(36).slice(0, 8)
  }

  for (const crawler of old.crawlers ?? []) {
    const id = crawler.name
    if (!id) throw new Error('crawler without a name')
    const { cfg_crawler, ...rest } = crawler
    const withConfig = { ...rest, ...(cfg_crawler ?? {}) }
    // live-player relay targets split into the standalone app/live-player plugin;
    // the crawler keeps capture-only live_relay (enabled/archive_root)
    const relayTargets = withConfig.live_relay?.targets
    if (withConfig.live_relay && relayTargets && typeof relayTargets === 'object') {
      for (const [handle, target] of Object.entries(relayTargets)) {
        if (livePlayerTargets[handle]) {
          warnings.push(`crawler '${id}': live_relay target '${handle}' already claimed by another crawler; kept first`)
          continue
        }
        livePlayerTargets[handle] = target
      }
      const { targets: _dropped, ...captureOnly } = withConfig.live_relay
      withConfig.live_relay = captureOnly
    }
    components.push({
      id,
      use: `crawler/${crawlerKind(crawler)}`,
      with: withConfig,
    })
  }

  if (Object.keys(livePlayerTargets).length > 0) {
    components.push({ id: 'live-player', use: 'app/live-player', with: { targets: livePlayerTargets } })
  }

  // in-runtime cookie keepalive replaces the external ops cron
  // (tools/youtube-cookie-keepalive.sh): one ytdlp job per distinct jar,
  // sources = crawlers that consume the jar (cookie management view)
  const keepaliveJobs: any[] = []
  const keepaliveByJar = new Map<string, { job: any; sources: string[] }>()
  for (const crawler of old.crawlers ?? []) {
    if (crawlerKind(crawler) !== 'youtube') continue
    const cookieFile: string | undefined = crawler.cfg_crawler?.cookie_file ?? crawler.cookie_file
    if (!cookieFile) continue
    const existing = keepaliveByJar.get(cookieFile)
    if (existing) {
      if (crawler.name) existing.sources.push(crawler.name)
      continue
    }
    const firstPath = Array.isArray(crawler.paths) && crawler.paths.length > 0 ? `/${String(crawler.paths[0]).replace(/^\/+/, '')}` : ''
    const job = {
      name: `yt-${keepaliveByJar.size + 1}`,
      kind: 'ytdlp',
      cookie_file: cookieFile,
      url: `${String(crawler.origin ?? 'https://www.youtube.com').replace(/\/+$/, '')}${firstPath}`,
      interval_seconds: 6 * 3600,
      sources: crawler.name ? [crawler.name] : [],
    }
    keepaliveByJar.set(cookieFile, { job, sources: job.sources })
    keepaliveJobs.push(job)
  }
  if (keepaliveJobs.length > 0) {
    components.push({ id: 'cookie-keepalive', use: 'app/cookie-keepalive', with: { jobs: keepaliveJobs } })
  }

  for (const processor of old.processors ?? []) {
    if (!processor.id) throw new Error('processor without an id')
    const { id, provider, cfg_processor, ...rest } = processor
    if (DROPPED_PROVIDERS.has(provider)) {
      warnings.push(`processor '${id}': provider '${provider}' is dropped in kyestu (unused legacy); entry skipped`)
      skippedProcessors.add(id)
      continue
    }
    if (provider === 'Mechanical') {
      components.push({ id, use: 'processor/rules', with: { ...rest, ...(cfg_processor ?? {}) } })
      continue
    }
    const protocol = PROVIDER_PROTOCOL[provider]
    if (!protocol) {
      warnings.push(`processor '${id}': unknown provider '${provider}'; entry skipped`)
      skippedProcessors.add(id)
      continue
    }
    components.push({
      id,
      use: `processor/${protocol}`,
      with: { ...rest, ...(cfg_processor ?? {}), wire_api: inferWireApi(cfg_processor) },
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
    const explicitId = typeof target.id === 'string' && target.id ? target.id : undefined
    let id = explicitId
    if (!id) {
      // no explicit id: derive a stable one from platform + config content (a
      // length-based id collides the moment two same-platform configs tie)
      id = `${target.platform}-${stableConfigFingerprint(target.cfg_platform ?? {})}`
      warnings.push(`forward_target without id: derived '${id}'`)
    }
    if (usedTargetIds.has(id)) {
      warnings.push(`duplicate forward_target id '${id}': entry skipped`)
      continue
    }
    usedTargetIds.add(id)
    components.push({
      id,
      use: `target/${target.platform}`,
      with: mapVideoUploadConfig(id, target.cfg_platform ?? {}, warnings),
    })
  }

  for (const forwarder of old.forwarders ?? []) {
    const id = forwarder.name
    if (!id) throw new Error('forwarder without a name')
    warnings.push(
      `forwarder '${id}': legacy origin auto-bind templates are not imported (media tool config moves into the crawler's own media section)`,
    )
  }

  if (old.api) components.push({ id: 'api', use: 'app/api', with: old.api })
  // live_capture (two services + plan API) is not ported to kyestu; emitting an
  // entry would fail loader validation with 'unknown component', so skip it
  if (old.live_capture) warnings.push('live_capture: app/live-capture is not ported to kyestu; entry skipped')

  // kyestu infra services the app cannot start without; safe to edit after import
  components.unshift(
    { id: 'db', use: 'infra/db', with: { path: './data.db' } },
    { id: 'bus', use: 'infra/bus' },
    { id: 'media-store', use: 'infra/media-store', with: { cache_root: './cache' } },
    { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: './cache' } },
    { id: 'onebot', use: 'infra/onebot', with: { http_url: 'env:ONEBOT_HTTP_URL' } },
  )

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
    if (skippedProcessors.has(processorId)) continue
    const owners = Object.entries(crawlerProcessor)
      .filter(([, p]) => p === processorId)
      .map(([c]) => c)
    if (owners.length === 0) {
      warnings.push(`processor-formatter: processor '${processorId}' has no owning crawler; formatter link(s) [${formatterIds.join(', ')}] skipped`)
      continue
    }
    for (const crawlerName of owners) {
      for (const formatterId of formatterIds) {
        // the processor stays OUT of the via chain: the crawler->processor
        // service edge below already wires crawl-time translation (the
        // crawler needs the processor's api), and the formatter renders the
        // translated article from the db. Putting the processor in via made
        // it need the crawler while the crawler needs it — a dependency
        // cycle that compileConfig rejects, bricking the imported config.
        pushRoute(crawlerName, [formatterId], formatterTarget[formatterId] ?? [])
      }
    }
  }
  // crawler->processor is a standalone service edge (crawl-time translation):
  // the crawler depends on the processor, so the edge points processor -> crawler
  for (const [crawlerName, processorId] of Object.entries(crawlerProcessor)) {
    if (skippedProcessors.has(processorId)) {
      warnings.push(`crawler '${crawlerName}': link to dropped processor '${processorId}' removed`)
      continue
    }
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
