import { Platform, type CrawlEngine, type TaskType, type TaskTypeResult } from '../types'
import { Logger } from '@kyestu/log'
import { Page, type PageEvents } from 'puppeteer-core'
import { SimpleExpiringCache } from '../utils'
type PageEvent = 'response' | 'request' | 'domcontentloaded' | 'load'

export enum SpiderPriority {
    LOWEST = 1,
    LOW = 2,
    NORMAL = 3,
    HIGH = 4,
    HIGHEST = 5,
}

export interface SpiderPlugin {
    id: string
    platform: Platform
    priority: SpiderPriority
    urlPattern: RegExp
    create: (log?: Logger) => BaseSpider
    extractBasicInfo?: (url: string) => { u_id: string; platform: Platform } | undefined
}

class SpiderRegistry {
    private static instance: SpiderRegistry
    private plugins: Map<string, SpiderPlugin> = new Map()

    private constructor() {}

    static getInstance(): SpiderRegistry {
        if (!SpiderRegistry.instance) {
            SpiderRegistry.instance = new SpiderRegistry()
        }
        return SpiderRegistry.instance
    }

    register(plugin: SpiderPlugin): this {
        if (this.plugins.has(plugin.id)) {
            throw new Error(`Spider plugin ${plugin.id} already registered`)
        }
        this.plugins.set(plugin.id, plugin)
        return this
    }

    findByUrl(url: string): SpiderPlugin | null {
        const matches = Array.from(this.plugins.values())
            .filter((p) => p.urlPattern.test(url))
            .sort((a, b) => b.priority - a.priority)

        return matches[0] || null
    }

    findById(id: string): SpiderPlugin | null {
        return this.plugins.get(id) || null
    }

    findByPlatform(platform: Platform): SpiderPlugin[] {
        return Array.from(this.plugins.values()).filter((p) => p.platform === platform)
    }

    extractBasicInfo(url: string): { u_id: string; platform: Platform } | undefined {
        const plugin = this.findByUrl(url)
        if (!plugin) return undefined

        if (plugin.extractBasicInfo) {
            return plugin.extractBasicInfo(url)
        }

        const match = plugin.urlPattern.exec(url)
        if (match?.groups?.id) {
            return {
                u_id: match.groups.id,
                platform: plugin.platform,
            }
        }
        return undefined
    }

    getRegisteredPlugins(): SpiderPlugin[] {
        return Array.from(this.plugins.values())
    }
}

abstract class BaseSpider {
    static _VALID_URL: RegExp
    abstract BASE_URL: string
    NAME: string = 'Base Spider'
    log?: Logger

    /**
     * Per-spider-instance cache for cross-crawl request budgets (rest ids, operation
     * profiles, query ids, viewport samples). Spider instances persist across crawl
     * rounds in the spider-manager, so cache entries survive between rounds.
     */
    protected cache: SimpleExpiringCache = new SimpleExpiringCache()

    public crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        trace_id?: string,
        config?: {
            task_type?: T
            sub_task_type?: Array<string>
            hydrate_users?: Array<string>
            hydrate_limit?: number
            hydrate_concurrency?: number
            hydrate_interval_time?: {
                min?: number
                max?: number
            }
            crawl_engine?: CrawlEngine
            cookieString?: string
            requestHeaders?: Record<string, string>
            max_list_pages?: number
            max_detail_count?: number
            detail_interval_time?: {
                min?: number
                max?: number
            }
            block_resource_types?: Array<string>
            /**
             * Optional callback to check whether an article id is already persisted. Spiders can use
             * this to skip expensive per-item hydration for already-known content, cutting load.
             */
            isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
            articleStateLookup?: (a_id: string) => Promise<{
                known: boolean
                createdAt?: number | null
                crawledAt?: number | null
                storedPremierePending?: boolean
            }>
            articlePrefixStateLookup?: (prefix: string) => Promise<{
                known: boolean
                createdAt: number | null
                crawledAt?: number | null
            }>
            isStoredPremierePending?: (a_id: string) => Promise<boolean>
        },
    ): Promise<TaskTypeResult<T, Platform>> {
        this.log = this.log?.child({ trace_id })
        return this._crawl(url, page, {
            task_type: 'article' as T,
            crawl_engine: 'browser',
            ...config,
        })
    }

    protected abstract _crawl<T extends TaskType>(
        url: string,
        page: Page | undefined,
        config: {
            task_type: T
            crawl_engine: CrawlEngine
            sub_task_type?: Array<string>
            hydrate_users?: Array<string>
            hydrate_limit?: number
            hydrate_concurrency?: number
            hydrate_interval_time?: {
                min?: number
                max?: number
            }
            cookieString?: string
            requestHeaders?: Record<string, string>
            max_list_pages?: number
            max_detail_count?: number
            detail_interval_time?: {
                min?: number
                max?: number
            }
            block_resource_types?: Array<string>
            isArticleKnown?: (a_id: string) => Promise<boolean> | boolean
            articleStateLookup?: (a_id: string) => Promise<{
                known: boolean
                createdAt?: number | null
                crawledAt?: number | null
                storedPremierePending?: boolean
            }>
            articlePrefixStateLookup?: (prefix: string) => Promise<{
                known: boolean
                createdAt: number | null
                crawledAt?: number | null
            }>
            isStoredPremierePending?: (a_id: string) => Promise<boolean>
        },
    ): Promise<TaskTypeResult<T, Platform>>

    constructor(log?: Logger) {
        this.log = log
    }

    init() {
        this.log = this.log?.child({ subservice: 'spider', label: this.NAME })
        return this
    }

    _match_valid_url(url: string, matcher: { _VALID_URL: RegExp }): RegExpExecArray | null {
        return matcher._VALID_URL.exec(url)
    }
}

type WaitForEventResponse<T extends PageEvent> =
    | {
          success: true
          res: PageEvents[T]
          data: any | null
      }
    | {
          success: false
          res: PageEvents[T]
          data: any | null
          error: Error
      }

function waitForEvent<T extends PageEvent>(
    page: Page,
    eventName: T,
    handler?: (data: PageEvents[T], control: { done: (data?: any) => void; fail: (error?: Error) => void }) => void,
    timeout: number = 30000,
): {
    promise: Promise<WaitForEventResponse<T>>
    cleanup: () => void
} {
    let promiseResolve: (value: WaitForEventResponse<T>) => void
    let eventData: PageEvents[T]
    let settled = false
    let cleaned = false
    let cleanup: () => void

    const promise = new Promise<WaitForEventResponse<T>>((resolve) => {
        promiseResolve = resolve
    })

    const finish = (value: WaitForEventResponse<T>) => {
        if (settled) {
            return
        }
        settled = true
        cleanup()
        promiseResolve(value)
    }

    const control = {
        done: (data?: any) => {
            finish({
                success: true,
                data,
                res: eventData,
            })
        },
        fail: (e: any) => {
            finish({
                success: false,
                data: null,
                res: eventData,
                error: e,
            })
        },
    }

    const wrappedHandler = (data: PageEvents[T]) => {
        eventData = data
        try {
            if (handler) {
                handler(data, control)
            } else {
                control.done(null)
            }
        } catch (error) {
            control.fail(error instanceof Error ? error : new Error(String(error)))
        }
    }

    const timeoutId = setTimeout(() => {
        finish({
            success: false,
            data: null,
            res: eventData,
            error: new Error(`Timeout waiting for event \'${eventName.toString()}\' after ${timeout}ms`),
        })
    }, timeout)

    page.on(eventName, wrappedHandler)

    cleanup = () => {
        if (cleaned) {
            return
        }
        cleaned = true
        clearTimeout(timeoutId)
        page.off(eventName, wrappedHandler)
        if (!settled) {
            settled = true
            promiseResolve({
                success: false,
                data: null,
                res: eventData,
                error: new Error(`Wait for event \'${eventName.toString()}\' cleaned up`),
            })
        }
    }

    return {
        promise: promise.finally(cleanup),
        cleanup,
    }
}

function waitForResponse(
    page: Page,
    handler?: (
        data: PageEvents['response'],
        control: { done: (data?: any) => void; fail: (reason: any) => void },
    ) => void,
    timeout?: number,
) {
    return waitForEvent(page, 'response', handler, timeout)
}

const defaultViewport = {
    width: 1,
    height: 1,
}

export { BaseSpider, SpiderRegistry, waitForEvent, waitForResponse, defaultViewport }
