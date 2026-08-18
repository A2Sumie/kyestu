import { describe, expect, test } from 'bun:test'
import {
    domainBreakerSnapshot,
    isDomainBlocked,
    recordDomainFailure,
    recordDomainSuccess,
    resetDomainBreakers,
} from '../src/utils/domain-breaker'

describe('in-page fetch domain circuit breaker', () => {
    test('opens after the configured threshold of consecutive failures', () => {
        resetDomainBreakers()
        const domain = 'www.instagram.com'

        expect(isDomainBlocked(domain)).toBe(false)
        recordDomainFailure(domain, { threshold: 3, blockMs: 60_000 })
        recordDomainFailure(domain, { threshold: 3, blockMs: 60_000 })
        expect(isDomainBlocked(domain)).toBe(false)

        recordDomainFailure(domain, { threshold: 3, blockMs: 60_000 })
        expect(isDomainBlocked(domain)).toBe(true)
        expect(domainBreakerSnapshot(domain)).toEqual({ failCount: 3, blocked: true })
    })

    test('a single success resets the failure count', () => {
        resetDomainBreakers()
        const domain = 'www.instagram.com'

        recordDomainFailure(domain, { threshold: 3, blockMs: 60_000 })
        recordDomainFailure(domain, { threshold: 3, blockMs: 60_000 })
        recordDomainSuccess(domain)
        recordDomainFailure(domain, { threshold: 3, blockMs: 60_000 })
        // Counter restarted at 0 after the success: 1 failure ≠ open.
        expect(isDomainBlocked(domain)).toBe(false)
    })

    test('auto-recovers once the block window elapses', async () => {
        resetDomainBreakers()
        const domain = 'www.instagram.com'

        recordDomainFailure(domain, { threshold: 1, blockMs: 50 })
        expect(isDomainBlocked(domain)).toBe(true)

        await new Promise((resolve) => setTimeout(resolve, 80))
        expect(isDomainBlocked(domain)).toBe(false)
        expect(domainBreakerSnapshot(domain).failCount).toBe(0)
    })

    test('ignores empty domains', () => {
        resetDomainBreakers()
        expect(isDomainBlocked('')).toBe(false)
        recordDomainFailure('')
        recordDomainSuccess('')
    })
})
