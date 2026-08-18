/**
 * Module-level global circuit breaker for in-page fetch probes against the
 * same origin (IG web_profile_info avatar backfill, live web_info XHR).
 *
 * Rationale (8-16 postmortem): after a session dies, these probes keep firing
 * per handle per round and pile risk score onto an already-burning session.
 * A breaker trips after N consecutive non-2xx/network failures for a domain,
 * blocks all probes for that domain for BLOCK_MS, then auto-recovers. A single
 * success resets the failure counter.
 *
 * Deliberately process-global: separate spider instances / relay services in
 * the same runtime share one breaker per domain.
 */

export interface DomainCircuitBreakerOptions {
    /** Consecutive failures before the breaker opens. */
    threshold?: number
    /** How long the breaker stays open (ms). */
    blockMs?: number
    /** Log a one-line warn when the breaker opens or skips (pass a logger fn). */
    warn?: (message: string) => void
}

interface BreakerState {
    failCount: number
    blockedUntil: number
}

const DEFAULT_BREAKER_THRESHOLD = 3
const DEFAULT_BREAKER_BLOCK_MS = 24 * 60 * 60 * 1000

// Keyed by origin domain (e.g. "www.instagram.com").
const BREAKER_STATES = new Map<string, BreakerState>()

function stateFor(domain: string): BreakerState {
    let state = BREAKER_STATES.get(domain)
    if (!state) {
        state = { failCount: 0, blockedUntil: 0 }
        BREAKER_STATES.set(domain, state)
    }
    return state
}

/**
 * Returns true when the domain is currently blocked (breaker open). Warns once
 * per check while blocked so the log shows the skip without spamming.
 */
export function isDomainBlocked(
    domain: string,
    options: DomainCircuitBreakerOptions = {},
): boolean {
    if (!domain) {
        return false
    }
    const state = stateFor(domain)
    if (state.blockedUntil <= Date.now()) {
        if (state.blockedUntil > 0) {
            // Block window elapsed — auto-recover.
            state.blockedUntil = 0
            state.failCount = 0
        }
        return false
    }
    return true
}

/** Record a successful probe: resets the failure count. */
export function recordDomainSuccess(domain: string): void {
    if (!domain) {
        return
    }
    const state = stateFor(domain)
    state.failCount = 0
    state.blockedUntil = 0
}

/**
 * Record a failed probe (non-2xx or network failure). Opens the breaker when
 * the consecutive-failure threshold is reached.
 */
export function recordDomainFailure(
    domain: string,
    options: DomainCircuitBreakerOptions = {},
): void {
    if (!domain) {
        return
    }
    const threshold = options.threshold ?? DEFAULT_BREAKER_THRESHOLD
    const blockMs = options.blockMs ?? DEFAULT_BREAKER_BLOCK_MS
    const state = stateFor(domain)
    state.failCount += 1
    if (state.failCount >= threshold && state.blockedUntil <= Date.now()) {
        state.blockedUntil = Date.now() + blockMs
        options.warn?.(
            `in-page fetch circuit breaker OPEN for ${domain} after ${state.failCount} consecutive failures; blocking probes for ${Math.round(blockMs / 3600000)}h`,
        )
    }
}

/** Test hook: clear all breaker state. */
export function resetDomainBreakers(): void {
    BREAKER_STATES.clear()
}

/** Test helper: current snapshot of a domain's breaker state. */
export function domainBreakerSnapshot(domain: string): { failCount: number; blocked: boolean } {
    const state = BREAKER_STATES.get(domain)
    return {
        failCount: state?.failCount ?? 0,
        blocked: Boolean(state && state.blockedUntil > Date.now()),
    }
}
