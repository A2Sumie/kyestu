declare module '@kyestu/spider' {
  export const spiderRegistry: {
    findByUrl(url: string): { create(): { init?(): unknown; crawl(url: string, page?: any, traceId?: string, config?: any): Promise<any> } } | undefined
  }
  export type BrowserMode = 'headless' | 'headed-xvfb' | 'headed'
  export type DeviceProfile = string
  export interface ProfileViewport {
    width: number
    height: number
    deviceScaleFactor?: number
    isMobile?: boolean
    hasTouch?: boolean
  }
  export interface BrowserProfileConfig {
    deviceProfile: DeviceProfile
    userAgent?: string
    viewport?: Partial<ProfileViewport>
    extraHeaders?: Record<string, string>
    locale?: string
    timezone?: string
    windowSize: { width: number; height: number }
  }
  export function resolveBrowserProfile(
    deviceProfile?: DeviceProfile,
    overrides?: {
      extraHeaders?: Record<string, string>
      locale?: string
      timezone?: string
      userAgent?: string
      viewport?: Partial<ProfileViewport>
    },
  ): BrowserProfileConfig
  export function applyBrowserProfile(
    page: any,
    deviceProfile: DeviceProfile,
    options?: {
      userAgent?: string
      viewport?: Partial<ProfileViewport>
      extraHeaders?: Record<string, string>
      locale?: string
      timezone?: string
    },
  ): Promise<void>
}
