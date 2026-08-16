import { Platform } from '../types'
import { BaseSpider, SpiderRegistry, SpiderPriority, type SpiderPlugin } from './base'
import { InstagramSpider } from './instagram'
import { XListSpider, XStatusSpider, XUserTimeLineSpider } from './x'
import { TiktokSpider } from './tiktok'
import { YoutubeSpider } from './youtube'
import { NanabunnonijyuuniWebsiteSpider } from './website'
import { LeapProjectsSpider } from './leap'
import { MessageBoardSpider } from './messageboard'

const XUserTimelinePlugin: SpiderPlugin = {
    id: 'x-timeline',
    platform: Platform.X,
    priority: SpiderPriority.NORMAL,
    urlPattern: XUserTimeLineSpider._VALID_URL,
    create: (log) => new XUserTimeLineSpider(log).init(),
}

const XListPlugin: SpiderPlugin = {
    id: 'x-list',
    platform: Platform.X,
    priority: SpiderPriority.HIGH,
    urlPattern: XListSpider._VALID_URL,
    create: (log) => new XListSpider(log).init(),
}

const XStatusPlugin: SpiderPlugin = {
    id: 'x-status',
    platform: Platform.X,
    priority: SpiderPriority.HIGH,
    urlPattern: XStatusSpider._VALID_URL,
    create: (log) => new XStatusSpider(log).init(),
    extractBasicInfo: (url) => {
        const result = XStatusSpider._VALID_URL.exec(url)?.groups
        return result?.id ? { u_id: result.id, platform: Platform.X } : undefined
    },
}

const InstagramPlugin: SpiderPlugin = {
    id: 'instagram',
    platform: Platform.Instagram,
    priority: SpiderPriority.NORMAL,
    urlPattern: InstagramSpider._VALID_URL,
    create: (log) => new InstagramSpider(log).init(),
    extractBasicInfo: (url) => InstagramSpider.extractBasicInfo(url),
}

const TiktokPlugin: SpiderPlugin = {
    id: 'tiktok',
    platform: Platform.TikTok,
    priority: SpiderPriority.NORMAL,
    urlPattern: TiktokSpider._VALID_URL,
    create: (log) => new TiktokSpider(log).init(),
}

const YoutubePlugin: SpiderPlugin = {
    id: 'youtube',
    platform: Platform.YouTube,
    priority: SpiderPriority.NORMAL,
    urlPattern: YoutubeSpider._VALID_URL,
    create: (log) => new YoutubeSpider(log).init(),
}

const WebsitePlugin: SpiderPlugin = {
    id: 'website-227',
    platform: Platform.Website,
    priority: SpiderPriority.HIGH,
    urlPattern: NanabunnonijyuuniWebsiteSpider._VALID_URL,
    create: (log) => new NanabunnonijyuuniWebsiteSpider(log).init(),
    extractBasicInfo: (url) => NanabunnonijyuuniWebsiteSpider.extractBasicInfo(url),
}

const LeapWebsitePlugin: SpiderPlugin = {
    id: 'website-leap',
    platform: Platform.Website,
    priority: SpiderPriority.HIGH,
    urlPattern: LeapProjectsSpider._VALID_URL,
    create: (log) => new LeapProjectsSpider(log).init(),
    extractBasicInfo: (url) => LeapProjectsSpider.extractBasicInfo(url),
}

const MessageBoardPlugin: SpiderPlugin = {
    id: 'messageboard-reader',
    platform: Platform.Website,
    priority: SpiderPriority.HIGH,
    urlPattern: MessageBoardSpider._VALID_URL,
    create: (log) => new MessageBoardSpider(log).init(),
    extractBasicInfo: (url) => MessageBoardSpider.extractBasicInfo(url),
}

const spiderRegistry = SpiderRegistry.getInstance()
    .register(XStatusPlugin)
    .register(XUserTimelinePlugin)
    .register(XListPlugin)
    .register(InstagramPlugin)
    .register(TiktokPlugin)
    .register(YoutubePlugin)
    .register(WebsitePlugin)
    .register(LeapWebsitePlugin)
    .register(MessageBoardPlugin)

namespace Spider {
    export interface SpiderConstructor {
        _VALID_URL: RegExp
        _PLATFORM: Platform
        new (...args: ConstructorParameters<typeof BaseSpider>): BaseSpider
    }

    const spiders: Array<SpiderConstructor> = [
        XStatusSpider,
        XUserTimeLineSpider,
        XListSpider,
        InstagramSpider,
        TiktokSpider,
        YoutubeSpider,
        NanabunnonijyuuniWebsiteSpider,
        LeapProjectsSpider,
        MessageBoardSpider,
    ]

    /** @deprecated Use spiderRegistry.findByUrl() instead */
    export function getSpider(url: string): SpiderConstructor | null {
        for (const spider of spiders) {
            if (spider._VALID_URL.test(url)) {
                return spider
            }
        }
        return null
    }

    /** @deprecated Use spiderRegistry.extractBasicInfo() instead */
    export function extractBasicInfo(url: string): { u_id: string; platform: Platform } | undefined {
        return spiderRegistry.extractBasicInfo(url)
    }
}

export { Spider, spiderRegistry }
export * from './base'
export { beginXOperationCapture, drainCapturedXOperations } from './x'
export * as X from './x'
export * as Instagram from './instagram'
export * as Tiktok from './tiktok'
export * as Youtube from './youtube'
export * as Website from './website'
export * as Leap from './leap'
export * as MessageBoard from './messageboard'
