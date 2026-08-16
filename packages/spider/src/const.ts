import { Instagram, Tiktok, Website, X, Youtube } from './spiders'
import { Platform } from './types'
import { UserAgent } from './utils/http'

/**
 * 初始化顺序问题，
 * 因为在初始化时，X 会引用文件中的Platform
 * 但此处由引用了X，而此时X并没有完成初始化。
 * 所以X里不能使用这里的参数
 */
const platformArticleMapToActionText: Record<Platform, Record<string, string>> = {
    [Platform.X]: {
        [X.ArticleTypeEnum.TWEET]: '发布推文',
        [X.ArticleTypeEnum.RETWEET]: '转发推文',
        [X.ArticleTypeEnum.CONVERSATION]: '回复推文',
        [X.ArticleTypeEnum.QUOTED]: '引用推文',
    },
    [Platform.Instagram]: {
        [Instagram.ArticleTypeEnum.POST]: '发布帖子',
        [Instagram.ArticleTypeEnum.STORY]: '发布故事',
        // [Instagram.ArticleTypeEnum.HIGHLIGHTS]: '发布highlights',
        // [Instagram.ArticleTypeEnum.REEL]: '发布视频',
    },
    [Platform.TikTok]: {
        [Tiktok.ArticleTypeEnum.POST]: '发布视频',
    },
    [Platform.YouTube]: {
        [Youtube.ArticleTypeEnum.VIDEO]: '发布视频',
        [Youtube.ArticleTypeEnum.SHORTS]: '发布短视频',
    },
    [Platform.Website]: {
        [Website.ArticleTypeEnum.ARTICLE]: '发布站点更新',
    },
}

const platformNameMap: Record<Platform, string> = {
    [Platform.X]: 'X',
    [Platform.Instagram]: 'Instagram',
    [Platform.TikTok]: 'TikTok',
    [Platform.YouTube]: 'YouTube',
    [Platform.Website]: 'Website',
}

const JA_ACCEPT_LANGUAGE = 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
const CHROME_SEC_CH_UA = '"Not_A Brand";v="99", "Chromium";v="142", "Google Chrome";v="142"'

const platformPresetHeadersMap: Record<Platform, Record<string, string>> = {
    [Platform.X]: {
        'user-agent': UserAgent.LINUX_CHROME,
        'accept-language': JA_ACCEPT_LANGUAGE,
    },
    [Platform.Instagram]: {
        'user-agent': UserAgent.LINUX_CHROME,
        'accept-language': JA_ACCEPT_LANGUAGE,
    },
    [Platform.TikTok]: {
        // TikTok crawler session uses mobile_android_chrome_samsung_large; signed
        // CDN requests must present the same UA-CH family as the session that
        // obtained the cookies, not a mismatched Windows desktop UA.
        'user-agent': UserAgent.MOBILE_ANDROID_CHROME,
        'accept-language': JA_ACCEPT_LANGUAGE,
        'sec-ch-ua': CHROME_SEC_CH_UA,
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        referer: 'https://www.tiktok.com/',
    },
    [Platform.YouTube]: {
        'user-agent': UserAgent.LINUX_CHROME,
        'accept-language': JA_ACCEPT_LANGUAGE,
    },
    [Platform.Website]: {
        'user-agent': UserAgent.LINUX_CHROME,
        'accept-language': JA_ACCEPT_LANGUAGE,
    },
}

export { platformArticleMapToActionText, platformNameMap, platformPresetHeadersMap }
