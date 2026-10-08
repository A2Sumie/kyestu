import { lookup } from 'dns/promises'
import { isIP } from 'net'

/**
 * Outbound URL policy for content-derived destinations (daybreak 2026-10-08
 * finding 4, phase 1). Remote publishers control article text, HTML attributes
 * and media urls; those values must never turn the service into a probe for
 * loopback / private / link-local / cloud-metadata destinations, and their
 * response bytes must not ride out through forwarded media.
 *
 * Scope of this phase: the media downloader (the sink that both fetches AND
 * hands the bytes to QQ/Bilibili targets). Browser navigation and renderer
 * asset loading are phase 2 — see docs/SECURITY-REVIEW-2026-10-08.md.
 *
 * Known limit: classification happens before the request, so a DNS answer that
 * changes afterwards (rebinding) is not caught — connection-level pinning is
 * phase 2 as well.
 */

export type UrlPolicy = 'block-private' | 'allow-private'

export interface UrlGuardOptions {
  /** override the policy for one call (test seams, operator tooling) */
  policy?: UrlPolicy
  /** skip DNS resolution for hostnames (literal IPs are still classified) */
  skipDns?: boolean
}

const POLICY_ENV = 'KYESTU_URL_POLICY'

export function resolveUrlPolicy(override?: UrlPolicy): UrlPolicy {
  if (override) return override
  return process.env[POLICY_ENV]?.trim() === 'allow-private' ? 'allow-private' : 'block-private'
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

function parseIPv6(ip: string): number[] | null {
  // strip a zone id (fe80::1%eth0) and handle the v4-mapped tail
  const bare = ip.split('%')[0] ?? ''
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const expand = (part: string) => (part ? part.split(':') : [])
  let head = expand(halves[0] ?? '')
  let tail = halves.length === 2 ? expand(halves[1] ?? '') : []
  const last = [...head, ...tail].at(-1) ?? ''
  let mappedV4: number[] | null = null
  if (last.includes('.')) {
    mappedV4 = parseIPv4(last)
    if (!mappedV4) return null
    if (tail.length) tail = tail.slice(0, -1)
    else head = head.slice(0, -1)
  }
  const missing = 8 - head.length - tail.length - (mappedV4 ? 2 : 0)
  if (halves.length === 2 && missing < 0) return null
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : [...head, ...tail]
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    const value = Number.parseInt(group, 16)
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  if (mappedV4) bytes.push(...mappedV4)
  return bytes.length === 16 ? bytes : null
}

/** true when the address is loopback / private / link-local / metadata / reserved */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip)
  if (v4) return isPrivateIPv4(v4)
  const v6 = parseIPv6(ip)
  if (v6) {
    // v4-mapped / nat64 tails are judged by their embedded v4 address
    if (v6.slice(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) {
      return isPrivateIPv4(v6.slice(12))
    }
    if (v6.slice(0, 12).every((byte) => byte === 0) && v6.slice(12).some((byte) => byte !== 0) && v6[10] !== 0xff) {
      // deprecated ::a.b.c.d form
      return isPrivateIPv4(v6.slice(12))
    }
    const b0 = v6[0] ?? -1
    const b1 = v6[1] ?? -1
    if (b0 === 0 && b1 === 0 && v6.slice(2).every((byte) => byte === 0)) return true // :: unspecified
    if (b0 === 0 && b1 === 0 && v6.slice(2, 15).every((byte) => byte === 0) && v6[15] === 1) return true // ::1
    if ((b0 & 0xfe) === 0xfc) return true // fc00::/7 ULA
    if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true // fe80::/10 link-local
    if (b0 === 0xff) return true // ff00::/8 multicast
    return false
  }
  // not a parseable literal: be conservative
  return true
}

function isPrivateIPv4(bytes: number[]): boolean {
  const [a = -1, b = -1] = bytes
  if (a === 0) return true // 0.0.0.0/8 reserved ("this network")
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 192 && b === 0) return true // 192.0.0.0/24 + 192.0.2.0/24 IETF/TEST-NET
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18/15
  if (a === 198 && b === 51) return true // TEST-NET-2
  if (a === 203 && b === 0) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

/**
 * Validate a URL before it reaches a network sink. Throws on anything that is
 * not an http(s) URL pointing at a public destination (unless the policy says
 * allow-private). Returns the parsed URL so callers keep working with it.
 */
export async function assertSafeOutboundUrl(raw: string, options: UrlGuardOptions = {}): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`refusing non-http(s) media url: ${String(raw).slice(0, 160)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing non-http(s) media url: ${String(raw).slice(0, 160)}`)
  }
  if (resolveUrlPolicy(options.policy) === 'allow-private') return parsed

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host)
  const addresses = literal ? [host] : options.skipDns ? [] : (await lookup(host, { all: true })).map((entry) => entry.address)
  if (!addresses.length) throw new Error(`refusing media url with unresolvable host: ${String(raw).slice(0, 160)}`)
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`refusing media url pointing at a private address (${address}): ${String(raw).slice(0, 160)}`)
    }
  }
  return parsed
}
