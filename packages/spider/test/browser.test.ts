import { describe, expect, test } from 'bun:test'
import { buildBrowserRequestHeaders, resolveBrowserProfile } from '../src/utils/browser'

describe('resolveBrowserProfile', () => {
    test('keeps the selected mobile device profile metadata', () => {
        const profile = resolveBrowserProfile('mobile_ios_safari_portrait')

        expect(profile.deviceProfile).toBe('mobile_ios_safari_portrait')
        expect(profile.platform).toBe('iPhone')
        expect(profile.vendor).toBe('Apple Computer, Inc.')
        expect(profile.userAgentData).toBeNull()
        expect(profile.plugins).toHaveLength(0)
    })

    test('uses chrome-like desktop defaults', () => {
        const profile = resolveBrowserProfile('desktop_chrome')

        expect(profile.deviceProfile).toBe('desktop_chrome')
        expect(profile.platform).toBe('Linux x86_64')
        expect(profile.userAgent).toContain('Chrome/142.')
        expect(profile.userAgent).toContain('X11; Linux x86_64')
        expect(profile.extraHeaders?.['sec-ch-ua-platform']).toBe('"Linux"')
        expect(profile.extraHeaders?.['sec-ch-ua-full-version-list']).toContain('142.0.7444.175')
        expect(profile.webgl?.renderer).toContain('AMD Radeon')
        expect(profile.webgl?.renderer).not.toContain('D3D11')
        expect(profile.plugins.length).toBeGreaterThan(0)
    })

    test('uses large Samsung Android Chrome mobile profile for mobile-only crawls', () => {
        const profile = resolveBrowserProfile('mobile_android_chrome_samsung_large')

        expect(profile.deviceProfile).toBe('mobile_android_chrome_samsung_large')
        expect(profile.engine).toBe('chromium')
        expect(profile.isMobile).toBe(true)
        expect(profile.hasTouch).toBe(true)
        expect(profile.chromeLike).toBe(true)
        expect(profile.viewport).toMatchObject({
            width: 412,
            height: 915,
            deviceScaleFactor: 3.5,
            hasTouch: true,
            isMobile: true,
        })
        expect(profile.userAgent).toContain('Android 14; SM-S918B')
        expect(profile.userAgent).toContain('Chrome/142.')
        expect(profile.platform).toBe('Linux armv8l')
        expect(profile.extraHeaders?.['sec-ch-ua-mobile']).toBe('?1')
        expect(profile.extraHeaders?.['sec-ch-ua-platform']).toBe('"Android"')
        expect(profile.extraHeaders?.['sec-ch-ua-full-version-list']).toContain('142.0.7444.175')
        expect(profile.webgl?.renderer).toContain('Adreno')
        expect(profile.webgl?.renderer).not.toContain('D3D11')
        expect(profile.userAgentData).toMatchObject({
            mobile: true,
            platform: 'Android',
            model: 'SM-S918B',
        })
        expect(profile.maxTouchPoints).toBeGreaterThan(0)
    })

    test('builds browser-style request headers for api-assisted crawls', () => {
        const headers = buildBrowserRequestHeaders('desktop_chrome', {
            extraHeaders: {
                'x-test-header': 'ok',
            },
        })

        expect(headers['user-agent']).toContain('Chrome/142.')
        expect(headers['accept-language']).toContain('ja-JP')
        expect(headers['sec-ch-ua-platform']).toBe('"Linux"')
        expect(headers['x-test-header']).toBe('ok')
    })
})
