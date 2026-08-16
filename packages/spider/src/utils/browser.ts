import type { Page, Viewport } from 'puppeteer-core'
import { UserAgent } from './http'

type BrowserMode = 'headless' | 'headed-xvfb'
type DeviceProfile = 'desktop_chrome' | 'mobile_ios_safari_portrait' | 'mobile_android_chrome_samsung_large'
type ScreenOrientationType = 'landscape-primary' | 'portrait-primary'

/**
 * Rendering engine behind the profile. Used to drive capability-based fingerprint shims
 * instead of brittle equality checks against individual profile names.
 */
type ProfileEngine = 'chromium' | 'webkit'

interface ProfileViewport extends Viewport {
    width: number
    height: number
}

interface ProfileWindowSize {
    width: number
    height: number
}

interface ProfileScreen {
    width: number
    height: number
    availWidth: number
    availHeight: number
    colorDepth: number
    pixelDepth: number
    orientation: ScreenOrientationType
    angle: number
}

interface ProfileConnection {
    downlink: number
    effectiveType: string
    rtt: number
    saveData: boolean
}

interface ProfileMimeType {
    type: string
    suffixes: string
    description: string
}

interface ProfilePlugin {
    name: string
    filename: string
    description: string
    mimeTypes: Array<ProfileMimeType>
}

interface ProfileUserAgentBrandVersion {
    brand: string
    version: string
}

interface ProfileUserAgentData {
    brands: Array<ProfileUserAgentBrandVersion>
    fullVersionList?: Array<ProfileUserAgentBrandVersion>
    mobile: boolean
    platform: string
    platformVersion?: string
    architecture?: string
    bitness?: string
    model?: string
    wow64?: boolean
    fullVersion?: string
}

interface BrowserProfileConfig {
    deviceProfile: DeviceProfile
    /** Underlying engine. Chromium-backed profiles keep window.chrome and UA-CH. */
    engine: ProfileEngine
    /** Whether the profile emulates a mobile device (touch UI, mobile UA-CH). */
    isMobile: boolean
    /** Whether touch input should be emulated for this profile. */
    hasTouch: boolean
    /** Whether the profile should expose a Chrome-like window.chrome object. */
    chromeLike: boolean
    userAgent: string
    viewport: ProfileViewport
    windowSize: ProfileWindowSize
    screen: ProfileScreen
    extraHeaders?: Record<string, string>
    emulateTouch?: boolean
    locale?: string
    timezone?: string
    platform: string
    vendor: string
    maxTouchPoints: number
    hardwareConcurrency: number
    deviceMemory?: number
    connection?: ProfileConnection
    plugins: Array<ProfilePlugin>
    pdfViewerEnabled?: boolean
    userAgentData?: ProfileUserAgentData | null
    webgl?: ProfileWebGL | null
}

const CHROME_MAJOR_VERSION = '142'
const CHROME_FULL_VERSION = '142.0.7444.175'
const CHROME_BRANDS: Array<ProfileUserAgentBrandVersion> = [
    {
        brand: 'Not_A Brand',
        version: '99',
    },
    {
        brand: 'Chromium',
        version: CHROME_MAJOR_VERSION,
    },
    {
        brand: 'Google Chrome',
        version: CHROME_MAJOR_VERSION,
    },
]
const CHROME_FULL_VERSION_LIST: Array<ProfileUserAgentBrandVersion> = CHROME_BRANDS.map((brand) => ({
    brand: brand.brand,
    version: brand.brand === 'Not_A Brand' ? '99.0.0.0' : CHROME_FULL_VERSION,
}))
const CHROME_FULL_VERSION_HEADER =
    '"Not_A Brand";v="99.0.0.0", ' +
    CHROME_FULL_VERSION_LIST.slice(1)
        .map((brand) => `"${brand.brand}";v="${brand.version}"`)
        .join(', ')
const PDF_MIME_TYPES: Array<ProfileMimeType> = [
    {
        type: 'application/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
    },
    {
        type: 'text/pdf',
        suffixes: 'pdf',
        description: 'Portable Document Format',
    },
]
const CHROME_PDF_PLUGINS: Array<ProfilePlugin> = [
    {
        name: 'PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: PDF_MIME_TYPES,
    },
    {
        name: 'Chrome PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: PDF_MIME_TYPES,
    },
    {
        name: 'Chromium PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        mimeTypes: PDF_MIME_TYPES,
    },
]

const DEVICE_PROFILE_PRESETS: Record<DeviceProfile, BrowserProfileConfig> = {
    // Honest Linux desktop matching the actual host (3020e): real Chrome on X11, ja-JP locale,
    // kernel-versioned UA-CH, host CPU count. Consistency beats blending in with a fake Windows set.
    desktop_chrome: {
        deviceProfile: 'desktop_chrome',
        engine: 'chromium',
        isMobile: false,
        hasTouch: false,
        chromeLike: true,
        userAgent: UserAgent.LINUX_CHROME,
        viewport: {
            width: 1600,
            height: 1200,
            deviceScaleFactor: 1,
            hasTouch: false,
            isLandscape: true,
            isMobile: false,
        },
        windowSize: {
            width: 1600,
            height: 1200,
        },
        screen: {
            width: 1600,
            height: 1200,
            availWidth: 1600,
            availHeight: 1160,
            colorDepth: 24,
            pixelDepth: 24,
            orientation: 'landscape-primary',
            angle: 0,
        },
        extraHeaders: {
            'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
            'sec-ch-ua': `"Not_A Brand";v="99", "Chromium";v="${CHROME_MAJOR_VERSION}", "Google Chrome";v="${CHROME_MAJOR_VERSION}"`,
            'sec-ch-ua-full-version-list': CHROME_FULL_VERSION_HEADER,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Linux"',
        },
        locale: 'ja-JP',
        timezone: 'Asia/Tokyo',
        platform: 'Linux x86_64',
        vendor: 'Google Inc.',
        maxTouchPoints: 0,
        hardwareConcurrency: 2,
        deviceMemory: 8,
        connection: {
            downlink: 10,
            effectiveType: '4g',
            rtt: 100,
            saveData: false,
        },
        plugins: CHROME_PDF_PLUGINS,
        pdfViewerEnabled: true,
        userAgentData: {
            brands: CHROME_BRANDS,
            fullVersionList: CHROME_FULL_VERSION_LIST,
            mobile: false,
            platform: 'Linux',
            platformVersion: '7.0.12',
            architecture: 'x86',
            bitness: '64',
            model: '',
            wow64: false,
            fullVersion: CHROME_FULL_VERSION,
        },
    },
    mobile_ios_safari_portrait: {
        deviceProfile: 'mobile_ios_safari_portrait',
        engine: 'webkit',
        isMobile: true,
        hasTouch: true,
        chromeLike: false,
        userAgent: UserAgent.MOBILE_IOS_SAFARI,
        viewport: {
            width: 430,
            height: 932,
            deviceScaleFactor: 3,
            hasTouch: true,
            isLandscape: false,
            isMobile: true,
        },
        windowSize: {
            width: 430,
            height: 932,
        },
        screen: {
            width: 430,
            height: 932,
            availWidth: 430,
            availHeight: 932,
            colorDepth: 32,
            pixelDepth: 32,
            orientation: 'portrait-primary',
            angle: 0,
        },
        extraHeaders: {
            'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        emulateTouch: true,
        locale: 'ja-JP',
        timezone: 'Asia/Tokyo',
        platform: 'iPhone',
        vendor: 'Apple Computer, Inc.',
        maxTouchPoints: 5,
        hardwareConcurrency: 6,
        plugins: [],
        userAgentData: null,
    },
    mobile_android_chrome_samsung_large: {
        deviceProfile: 'mobile_android_chrome_samsung_large',
        engine: 'chromium',
        isMobile: true,
        hasTouch: true,
        chromeLike: true,
        userAgent: UserAgent.MOBILE_ANDROID_CHROME,
        // Samsung Galaxy S23 Ultra-like large Android phone, matching a manual Chrome DevTools
        // device emulation of a big Samsung screen.
        viewport: {
            width: 412,
            height: 915,
            deviceScaleFactor: 3.5,
            hasTouch: true,
            isLandscape: false,
            isMobile: true,
        },
        windowSize: {
            width: 412,
            height: 915,
        },
        screen: {
            width: 412,
            height: 915,
            availWidth: 412,
            availHeight: 915,
            colorDepth: 24,
            pixelDepth: 24,
            orientation: 'portrait-primary',
            angle: 0,
        },
        extraHeaders: {
            'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
            'sec-ch-ua': `"Not_A Brand";v="99", "Chromium";v="${CHROME_MAJOR_VERSION}", "Google Chrome";v="${CHROME_MAJOR_VERSION}"`,
            'sec-ch-ua-full-version-list': CHROME_FULL_VERSION_HEADER,
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"',
        },
        emulateTouch: true,
        locale: 'ja-JP',
        timezone: 'Asia/Tokyo',
        platform: 'Linux armv8l',
        vendor: 'Google Inc.',
        maxTouchPoints: 5,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        connection: {
            downlink: 10,
            effectiveType: '4g',
            rtt: 100,
            saveData: false,
        },
        plugins: [],
        pdfViewerEnabled: true,
        userAgentData: {
            brands: CHROME_BRANDS,
            fullVersionList: CHROME_FULL_VERSION_LIST,
            mobile: true,
            platform: 'Android',
            platformVersion: '14.0.0',
            architecture: '',
            bitness: '',
            model: 'SM-S918B',
            wow64: false,
            fullVersion: CHROME_FULL_VERSION,
        },
    },
}

interface BrowserProfileOverrides {
    userAgent?: string
    viewport?: Partial<ProfileViewport>
    extraHeaders?: Record<string, string>
    locale?: string
    timezone?: string
    webgl?: ProfileWebGL | null
}

interface ProfileWebGL {
    vendor: string
    renderer: string
}

const DEFAULT_DESKTOP_WEBGL: ProfileWebGL = {
    vendor: process.env.BROWSER_WEBGL_VENDOR || 'Google Inc. (AMD)',
    renderer:
        process.env.BROWSER_WEBGL_RENDERER ||
        'ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics (0x15D8) OpenGL 4.6 (ANGLE 2.1.0), OpenGL ES 2.0)',
}

const DEFAULT_MOBILE_WEBGL: ProfileWebGL = {
    vendor: process.env.BROWSER_WEBGL_VENDOR || 'Google Inc. (Qualcomm)',
    renderer:
        process.env.BROWSER_WEBGL_RENDERER ||
        'ANGLE (Qualcomm, Adreno (TM) 730 (0x06050300) OpenGL ES 3.2 V@0481.0 (GIT@K20MA, K20WVE))',
}

function resolveBrowserProfile(
    deviceProfile: DeviceProfile = 'desktop_chrome',
    overrides: BrowserProfileOverrides = {},
): BrowserProfileConfig {
    const preset = DEVICE_PROFILE_PRESETS[deviceProfile]
    return {
        ...preset,
        ...overrides,
        viewport: {
            ...preset.viewport,
            ...(overrides.viewport || {}),
        },
        extraHeaders: {
            ...(preset.extraHeaders || {}),
            ...(overrides.extraHeaders || {}),
        },
        userAgent: overrides.userAgent || preset.userAgent,
        webgl:
            overrides.webgl === undefined
                ? preset.isMobile
                    ? DEFAULT_MOBILE_WEBGL
                    : DEFAULT_DESKTOP_WEBGL
                : overrides.webgl,
    }
}

async function applyBrowserProfile(
    page: Page,
    deviceProfile: DeviceProfile = 'desktop_chrome',
    overrides: BrowserProfileOverrides = {},
) {
    const profile = resolveBrowserProfile(deviceProfile, overrides)

    await page.setUserAgent(profile.userAgent)
    await page.setViewport(profile.viewport)
    if (profile.extraHeaders && Object.keys(profile.extraHeaders).length > 0) {
        await page.setExtraHTTPHeaders(profile.extraHeaders)
    }
    if (profile.timezone) {
        await page.emulateTimezone(profile.timezone).catch(() => null)
    }
    await page.setBypassCSP(true).catch(() => null)

    await page.evaluateOnNewDocument(
        (fingerprint: any) => {
            try {
                const isMobile = fingerprint.isMobile
                // Anti-leak: shimmed getters must toString like native accessors. Patch
                // Function.prototype.toString (itself native-looking) to serve canned native
                // sources for every shim function we install.
                const nativeToString = Function.prototype.toString
                const patchedSources = new Map<object, string>()
                const patchNativeSource = <T extends object>(fn: T, source: string): T => {
                    patchedSources.set(fn, source)
                    return fn
                }
                Object.defineProperty(Function.prototype, 'toString', {
                    configurable: true,
                    writable: true,
                    value: patchNativeSource(function toString(this: unknown, ...args: Array<unknown>) {
                        const patched = patchedSources.get(this as object)
                        if (patched) {
                            return patched
                        }
                        return nativeToString.apply(this, args as [])
                    }, 'function toString() { [native code] }'),
                })
                const defineGetter = (target: object, property: string, value: unknown) => {
                    const getter = patchNativeSource(() => value, `function get ${property}() { [native code] }`)
                    Object.defineProperty(target, property, {
                        configurable: true,
                        get: getter,
                    })
                }
                if (fingerprint.webgl) {
                    const maskedWebglVendor = fingerprint.webgl.vendor
                    const maskedWebglRenderer = fingerprint.webgl.renderer
                    try {
                        const webglProtos = [WebGLRenderingContext.prototype]
                        if (typeof WebGL2RenderingContext !== 'undefined') {
                            webglProtos.push(WebGL2RenderingContext.prototype)
                        }
                        for (const glProto of webglProtos) {
                            const originalGetParameter = glProto.getParameter
                            glProto.getParameter = patchNativeSource(function (
                                this: WebGLRenderingContext,
                                pname: number,
                            ) {
                                if (pname === 0x9245) {
                                    return maskedWebglVendor
                                }
                                if (pname === 0x9246) {
                                    return maskedWebglRenderer
                                }
                                return originalGetParameter.call(this, pname)
                            }, 'function getParameter() { [native code] }')
                        }
                    } catch {
                        // Ignore WebGL masking failures.
                    }
                }
                const createNamedArray = (items: Array<Record<string, unknown>>, proto: object, namedKey: string) => {
                    const nativeFind = Array.prototype.find
                    const arrayLike = [] as Array<Record<string, unknown>>
                    Object.setPrototypeOf(arrayLike, proto)
                    Object.defineProperty(arrayLike, 'item', {
                        configurable: true,
                        value: patchNativeSource(
                            (index: number) => arrayLike[index] || null,
                            'function item() { [native code] }',
                        ),
                    })
                    Object.defineProperty(arrayLike, 'namedItem', {
                        configurable: true,
                        value: patchNativeSource(
                            (name: string) =>
                                nativeFind.call(
                                    arrayLike,
                                    (item: Record<string, unknown>) => item[namedKey] === name,
                                ) || null,
                            'function namedItem() { [native code] }',
                        ),
                    })
                    for (const [index, item] of items.entries()) {
                        arrayLike[index] = item
                        const key = item[namedKey]
                        if (typeof key === 'string' && !(key in arrayLike)) {
                            Object.defineProperty(arrayLike, key, {
                                configurable: true,
                                enumerable: false,
                                value: item,
                            })
                        }
                    }
                    return arrayLike
                }
                const mimeTypeProto = typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype
                const mimeTypeArrayProto =
                    typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : Array.prototype
                const pluginProto = typeof Plugin !== 'undefined' ? Plugin.prototype : Object.prototype
                const pluginArrayProto = typeof PluginArray !== 'undefined' ? PluginArray.prototype : Array.prototype
                const mimeTypeIndex = new Map<string, Record<string, unknown>>()
                for (const plugin of fingerprint.plugins as Array<Record<string, unknown>>) {
                    for (const mimeType of (plugin.mimeTypes as Array<Record<string, unknown>> | undefined) || []) {
                        const key = `${String(mimeType.type)}:${String(mimeType.suffixes)}`
                        if (!mimeTypeIndex.has(key)) {
                            const mimeTypeObject = {
                                type: mimeType.type,
                                suffixes: mimeType.suffixes,
                                description: mimeType.description,
                                enabledPlugin: null as Record<string, unknown> | null,
                            }
                            Object.setPrototypeOf(mimeTypeObject, mimeTypeProto)
                            mimeTypeIndex.set(key, mimeTypeObject)
                        }
                    }
                }
                const mimeTypes = Array.from(mimeTypeIndex.values())
                const mimeTypeArray = createNamedArray(mimeTypes, mimeTypeArrayProto, 'type')
                const plugins = fingerprint.plugins.map((plugin: Record<string, unknown>) => {
                    const pluginMimeTypes = (
                        (plugin.mimeTypes as Array<Record<string, unknown>> | undefined) || []
                    ).map(
                        (mimeType) =>
                            mimeTypeIndex.get(`${String(mimeType.type)}:${String(mimeType.suffixes)}`) || null,
                    )
                    const pluginObject: Record<string, unknown> = {
                        name: plugin.name,
                        filename: plugin.filename,
                        description: plugin.description,
                        length: pluginMimeTypes.length,
                        item: (mimeTypeIndex: number) => pluginMimeTypes[mimeTypeIndex] || null,
                        namedItem: (name: string) =>
                            pluginMimeTypes.find((mimeType) => mimeType?.type === name) || null,
                    }
                    for (const [mimeTypeIndex, mimeType] of pluginMimeTypes.entries()) {
                        if (!mimeType) {
                            continue
                        }
                        pluginObject[mimeTypeIndex] = mimeType
                        if (typeof mimeType.type === 'string' && !(mimeType.type in pluginObject)) {
                            pluginObject[mimeType.type] = mimeType
                        }
                        mimeType.enabledPlugin = pluginObject
                    }
                    Object.setPrototypeOf(pluginObject, pluginProto)
                    return pluginObject
                })
                const pluginArray = createNamedArray(plugins, pluginArrayProto, 'name')

                defineGetter(navigator, 'language', fingerprint.locale)
                defineGetter(navigator, 'languages', [fingerprint.locale, 'ja', 'en-US'])
                defineGetter(navigator, 'maxTouchPoints', fingerprint.maxTouchPoints)
                defineGetter(navigator, 'webdriver', false)
                defineGetter(navigator, 'platform', fingerprint.platform)
                defineGetter(navigator, 'vendor', fingerprint.vendor)
                defineGetter(navigator, 'hardwareConcurrency', fingerprint.hardwareConcurrency)
                defineGetter(navigator, 'plugins', pluginArray)
                defineGetter(navigator, 'mimeTypes', mimeTypeArray)
                if (typeof fingerprint.pdfViewerEnabled === 'boolean') {
                    defineGetter(navigator, 'pdfViewerEnabled', fingerprint.pdfViewerEnabled)
                }
                if (typeof fingerprint.deviceMemory === 'number') {
                    defineGetter(navigator, 'deviceMemory', fingerprint.deviceMemory)
                }
                if (fingerprint.connection) {
                    const connection = {
                        downlink: fingerprint.connection.downlink,
                        effectiveType: fingerprint.connection.effectiveType,
                        onchange: null,
                        rtt: fingerprint.connection.rtt,
                        saveData: fingerprint.connection.saveData,
                        addEventListener: () => undefined,
                        removeEventListener: () => undefined,
                        dispatchEvent: () => false,
                    }
                    defineGetter(navigator, 'connection', connection)
                }
                if (fingerprint.userAgentData) {
                    const uaData = {
                        ...fingerprint.userAgentData,
                        getHighEntropyValues: async (hints: Array<string>) => {
                            const values: Record<string, unknown> = {
                                architecture: fingerprint.userAgentData?.architecture,
                                bitness: fingerprint.userAgentData?.bitness,
                                brands: fingerprint.userAgentData?.brands,
                                fullVersionList: fingerprint.userAgentData?.fullVersionList,
                                mobile: fingerprint.userAgentData?.mobile,
                                model: fingerprint.userAgentData?.model,
                                platform: fingerprint.userAgentData?.platform,
                                platformVersion: fingerprint.userAgentData?.platformVersion,
                                wow64: fingerprint.userAgentData?.wow64,
                            }
                            return hints.reduce(
                                (acc, hint) => {
                                    if (hint in values) {
                                        acc[hint] = values[hint]
                                    }
                                    return acc
                                },
                                {} as Record<string, unknown>,
                            )
                        },
                        toJSON: () => ({
                            brands: fingerprint.userAgentData?.brands || [],
                            mobile: fingerprint.userAgentData?.mobile || false,
                            platform: fingerprint.userAgentData?.platform || '',
                        }),
                    }
                    defineGetter(navigator, 'userAgentData', uaData)
                } else {
                    defineGetter(navigator, 'userAgentData', undefined)
                }
                if (fingerprint.screen) {
                    defineGetter(screen, 'width', fingerprint.screen.width)
                    defineGetter(screen, 'height', fingerprint.screen.height)
                    defineGetter(screen, 'availWidth', fingerprint.screen.availWidth)
                    defineGetter(screen, 'availHeight', fingerprint.screen.availHeight)
                    defineGetter(screen, 'colorDepth', fingerprint.screen.colorDepth)
                    defineGetter(screen, 'pixelDepth', fingerprint.screen.pixelDepth)
                    defineGetter(screen, 'orientation', {
                        type: fingerprint.screen.orientation,
                        angle: fingerprint.screen.angle,
                        onchange: null,
                        addEventListener: () => undefined,
                        removeEventListener: () => undefined,
                        dispatchEvent: () => false,
                    })
                }
                if (fingerprint.windowSize) {
                    defineGetter(window, 'outerWidth', fingerprint.windowSize.width)
                    defineGetter(window, 'outerHeight', fingerprint.windowSize.height)
                }
                const originalQuery = navigator.permissions?.query?.bind(navigator.permissions)
                if (originalQuery) {
                    Object.defineProperty(navigator.permissions, 'query', {
                        configurable: true,
                        value: patchNativeSource((parameters: { name?: string }) => {
                            if (parameters?.name === 'notifications') {
                                return Promise.resolve({
                                    state: Notification.permission,
                                    onchange: null,
                                    addEventListener: () => undefined,
                                    removeEventListener: () => undefined,
                                    dispatchEvent: () => false,
                                })
                            }
                            return originalQuery(parameters as PermissionDescriptor)
                        }, 'function query() { [native code] }'),
                    })
                }
                if (fingerprint.chromeLike) {
                    const chromeObject = {
                        app: {
                            InstallState: {
                                DISABLED: 'disabled',
                                INSTALLED: 'installed',
                                NOT_INSTALLED: 'not_installed',
                            },
                            RunningState: {
                                CANNOT_RUN: 'cannot_run',
                                READY_TO_RUN: 'ready_to_run',
                                RUNNING: 'running',
                            },
                            isInstalled: false,
                        },
                        runtime: {},
                    }
                    defineGetter(window, 'chrome', chromeObject)
                } else {
                    try {
                        delete (window as Window & { chrome?: unknown }).chrome
                    } catch {
                        // Ignore delete failures.
                    }
                    defineGetter(window, 'chrome', undefined)
                }
                // Puppeteer injects a window.cdc_* marker for DevTools protocol; detection scripts
                // probe for it as a hard automation signal. Delete it before anything can read it.
                try {
                    for (const key of Object.getOwnPropertyNames(window)) {
                        if (key.startsWith('cdc_')) {
                            delete (window as unknown as Record<string, unknown>)[key]
                        }
                    }
                } catch {
                    // Ignore cleanup failures.
                }
                if (isMobile) {
                    defineGetter(navigator, 'standalone', false)
                    defineGetter(window, 'orientation', 0)
                    if (!('ontouchstart' in window)) {
                        defineGetter(window, 'ontouchstart', null)
                    }
                }
            } catch {
                // Ignore profile shim failures.
            }
        },
        {
            deviceProfile: profile.deviceProfile,
            engine: profile.engine,
            isMobile: profile.isMobile,
            hasTouch: profile.hasTouch,
            chromeLike: profile.chromeLike,
            platform: profile.platform,
            vendor: profile.vendor,
            maxTouchPoints: profile.maxTouchPoints,
            hardwareConcurrency: profile.hardwareConcurrency,
            deviceMemory: profile.deviceMemory,
            screen: profile.screen,
            windowSize: profile.windowSize,
            connection: profile.connection,
            plugins: profile.plugins,
            pdfViewerEnabled: profile.pdfViewerEnabled,
            userAgentData: profile.userAgentData,
            locale: profile.locale || 'ja-JP',
            webgl: profile.webgl || null,
        },
    )
}

function buildBrowserRequestHeaders(
    deviceProfile: DeviceProfile = 'desktop_chrome',
    overrides: BrowserProfileOverrides = {},
): Record<string, string> {
    const profile = resolveBrowserProfile(deviceProfile, overrides)
    return {
        'user-agent': profile.userAgent,
        ...(profile.extraHeaders || {}),
    }
}

export { DEVICE_PROFILE_PRESETS, applyBrowserProfile, buildBrowserRequestHeaders, resolveBrowserProfile }
export type { BrowserMode, BrowserProfileConfig, BrowserProfileOverrides, DeviceProfile, ProfileViewport }
