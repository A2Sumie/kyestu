import type { Component } from '../core/types'

/**
 * OpenAI-protocol LLM processor (`processor/openai`).
 * One component covers both wire APIs: `responses` (DeepSeek V4 style) and
 * `chat_completions` (Hy3 style), with an optional one-level fallback endpoint.
 */

export interface PromptAsset {
  path: string
  label?: string
  format?: string
  max_chars?: number
}

export interface CircuitConfig {
  failure_threshold?: number
  cooldown_seconds?: number
}

export interface OpenAiProcessorConfig {
  api_key?: string
  base_url?: string
  model_id?: string
  wire_api?: 'responses' | 'chat_completions'
  name?: string
  prompt?: string
  prompt_assets?: PromptAsset[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  response_format?: unknown
  extended_payload?: Record<string, unknown>
  reasoning_effort?: string
  request_timeout_ms?: number
  circuit?: CircuitConfig
  fallback?: {
    api_key?: string
    base_url?: string
    model_id?: string
    wire_api?: 'responses' | 'chat_completions'
    extended_payload?: Record<string, unknown>
    circuit?: CircuitConfig
  }
}

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** provider circuit is open; skip attempts until cooldown elapses (idol-bbq hy3-circuit-breaker, generalized) */
export class CircuitOpenError extends Error {}

export interface ProviderStatus {
  state: 'closed' | 'open'
  consecutive_failures: number
  open_until: number | null
  last_error: string | null
  last_probe: { ok: boolean; latency_ms: number; error: string | null; at: number } | null
}

export interface ProcessorApi {
  process: (text: string) => Promise<string>
}

function resolveApiKey(raw: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (!raw) return ''
  if (raw.startsWith('env:')) {
    const name = raw.slice(4)
    const value = env[name]
    if (!value) throw new Error(`env var not set for api_key: ${name}`)
    return value
  }
  return raw
}

async function readAssetText(asset: PromptAsset): Promise<string> {
  const { readFileSync } = await import('fs')
  const text = readFileSync(asset.path, 'utf8')
  return asset.max_chars && text.length > asset.max_chars ? text.slice(0, asset.max_chars) : text
}

export class OpenAiProcessorClient implements ProcessorApi {
  private readonly config: OpenAiProcessorConfig
  private readonly apiKey: string
  private readonly fallbackClient: OpenAiProcessorClient | null = null
  private promptCache: string | null = null
  private consecutiveFailures = 0
  private circuitOpenUntil = 0
  private lastError: string | null = null
  private lastProbe: ProviderStatus['last_probe'] = null

  constructor(config: OpenAiProcessorConfig) {
    this.config = config
    this.apiKey = resolveApiKey(config.api_key)
    if (config.fallback) {
      const { extended_payload: _primaryPayload, ...shared } = config
      this.fallbackClient = new OpenAiProcessorClient({
        ...shared,
        ...config.fallback,
        api_key: config.fallback.api_key ?? config.api_key,
        fallback: undefined,
      })
    }
  }

  status(): ProviderStatus {
    const open = Date.now() < this.circuitOpenUntil
    return {
      state: open ? 'open' : 'closed',
      consecutive_failures: this.consecutiveFailures,
      open_until: open ? this.circuitOpenUntil : null,
      last_error: this.lastError,
      last_probe: this.lastProbe,
    }
  }

  unfreeze(): void {
    this.consecutiveFailures = 0
    this.circuitOpenUntil = 0
    this.lastError = null
  }

  /** reachability/auth probe: tiny request, bypasses the circuit */
  async probe(): Promise<NonNullable<ProviderStatus['last_probe']>> {
    const started = Date.now()
    try {
      const isResponses = this.config.wire_api === 'responses'
      const body: Record<string, unknown> = isResponses
        ? { model: this.config.model_id || 'openai', input: [{ role: 'user', content: 'ping' }], max_output_tokens: 16 }
        : {
            model: this.config.model_id || 'openai',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }
      const res = await fetch(this.config.base_url || 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.request_timeout_ms ?? 30_000),
      })
      if (!res.ok) throw new LlmHttpError(res.status, `probe failed: HTTP ${res.status}`)
      this.lastProbe = { ok: true, latency_ms: Date.now() - started, error: null, at: started }
    } catch (error) {
      this.lastProbe = {
        ok: false,
        latency_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        at: started,
      }
    }
    return this.lastProbe
  }

  async process(text: string): Promise<string> {
    try {
      return await this.processWithRetry(text)
    } catch (error) {
      if (!this.fallbackClient) throw error
      return await this.fallbackClient.processWithRetry(text)
    }
  }

  private async processWithRetry(text: string, retries = 2): Promise<string> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new CircuitOpenError(
        `provider circuit open until ${new Date(this.circuitOpenUntil).toISOString()}: ${this.lastError ?? 'repeated failures'}`,
      )
    }
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.processOnce(text)
        this.consecutiveFailures = 0
        this.lastError = null
        return result
      } catch (error) {
        lastError = error
        // 4xx is a caller/auth problem; retrying the identical payload is noise
        // and it must not trip the circuit (the provider itself is healthy)
        if (error instanceof LlmHttpError && error.status >= 400 && error.status < 500) throw error
      }
    }
    this.recordFailure(lastError)
    throw lastError
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1
    this.lastError = error instanceof Error ? error.message : String(error)
    const threshold = this.config.circuit?.failure_threshold ?? 3
    if (this.consecutiveFailures >= threshold) {
      const cooldownMs = (this.config.circuit?.cooldown_seconds ?? 300) * 1000
      this.circuitOpenUntil = Date.now() + cooldownMs
    }
  }

  private async processOnce(text: string): Promise<string> {
    const input = [
      { role: 'system', content: await this.getPrompt() },
      { role: 'user', content: text },
    ]
    const compatible: Record<string, unknown> = {}
    if (typeof this.config.temperature === 'number') compatible.temperature = this.config.temperature
    if (typeof this.config.top_p === 'number') compatible.top_p = this.config.top_p
    const isResponses = this.config.wire_api === 'responses'
    let body: Record<string, unknown>
    if (isResponses) {
      const { max_tokens: _omit, ...shared } = compatible
      body = {
        ...shared,
        ...this.config.extended_payload,
        model: this.config.model_id || 'openai',
        input,
        ...(typeof this.config.max_tokens === 'number' ? { max_output_tokens: this.config.max_tokens } : {}),
        ...(this.config.response_format ? { text: { format: this.config.response_format } } : {}),
        ...(this.config.reasoning_effort ? { reasoning: { effort: this.config.reasoning_effort } } : {}),
      }
    } else {
      body = {
        ...compatible,
        ...(typeof this.config.max_tokens === 'number' ? { max_tokens: this.config.max_tokens } : {}),
        ...(this.config.response_format ? { response_format: this.config.response_format } : {}),
        ...this.config.extended_payload,
        model: this.config.model_id || 'openai',
        messages: input,
      }
    }
    const res = await fetch(this.config.base_url || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.request_timeout_ms ?? 30_000),
    })
    if (!res.ok) throw new LlmHttpError(res.status, `LLM request failed: HTTP ${res.status}`)
    const data = (await res.json()) as any
    if (isResponses) return readResponsesText(data)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('chat_completions returned no message content')
    return content
  }

  private async getPrompt(): Promise<string> {
    if (this.promptCache !== null) return this.promptCache
    let prompt = this.config.prompt ?? ''
    for (const asset of this.config.prompt_assets ?? []) {
      if (asset.format && asset.format !== 'text') continue
      const text = await readAssetText(asset)
      prompt += `${prompt ? '\n\n' : ''}${asset.label ? `# ${asset.label}\n` : ''}${text}`
    }
    this.promptCache = prompt
    return prompt
  }
}

function readResponsesText(data: any): string {
  const text = (Array.isArray(data?.output) ? data.output : [])
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
    .filter((item: any) => item?.type === 'output_text' && typeof item?.text === 'string')
    .map((item: any) => item.text)
    .join('')
  if (!text) {
    const status = data?.status ? ` status=${data.status}` : ''
    const reason = data?.incomplete_details?.reason ? ` reason=${data.incomplete_details.reason}` : ''
    const outputTypes = Array.isArray(data?.output) ? ` output=[${data.output.map((item: any) => item?.type).join(',')}]` : ''
    throw new Error(`responses API returned no output_text${status}${reason}${outputTypes}`)
  }
  return text
}

export const openAiProcessorComponent: Component<OpenAiProcessorConfig> = {
  apply: (ctx, config) => {
    ctx.expose(new OpenAiProcessorClient(config) satisfies ProcessorApi)
  },
}
