import { test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertSafeOutboundUrl, isPrivateAddress } from '../src/pipeline/net-guard'
import { MediaStore } from '../src/pipeline/media'

/**
 * Outbound URL policy (daybreak 2026-10-08 finding 4, phase 1): content-derived
 * media urls may not point the service at loopback / private / link-local /
 * cloud-metadata destinations. Literal addresses are classified without any
 * network access; hostnames go through resolution before the request.
 */

test('net guard: private and special addresses are classified as blocked', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ]) {
    expect(isPrivateAddress(ip)).toBeTrue()
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '2606:4700::1111']) {
    expect(isPrivateAddress(ip)).toBeFalse()
  }
})

test('net guard: content-derived urls to private destinations are refused', async () => {
  // explicit policy: these assertions must not depend on ambient env state
  const policy = { policy: 'block-private' as const }
  await expect(assertSafeOutboundUrl('http://127.0.0.1:8080/admin', policy)).rejects.toThrow('private address')
  await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data/', policy)).rejects.toThrow('private address')
  await expect(assertSafeOutboundUrl('http://[::1]/x', policy)).rejects.toThrow('private address')
  await expect(assertSafeOutboundUrl('http://192.168.0.1/cgi-bin/x', policy)).rejects.toThrow('private address')
  // hostname resolving to loopback (via /etc/hosts, no external DNS needed)
  await expect(assertSafeOutboundUrl('http://localhost:1/x', policy)).rejects.toThrow()
  // scheme policy is enforced by the same gate
  await expect(assertSafeOutboundUrl('file:///etc/passwd', policy)).rejects.toThrow('non-http(s)')
  await expect(assertSafeOutboundUrl('--url=file:///etc/passwd', policy)).rejects.toThrow('non-http(s)')
  // a public literal target is allowed (no request is made here)
  await expect(assertSafeOutboundUrl('https://93.184.216.34/a.jpg', policy)).resolves.toBeInstanceOf(URL)
})

test('net guard: allow-private is an explicit policy escape', async () => {
  await expect(assertSafeOutboundUrl('http://127.0.0.1/x', { policy: 'allow-private' })).resolves.toBeInstanceOf(URL)
  await expect(assertSafeOutboundUrl('http://169.254.169.254/x', { policy: 'allow-private' })).resolves.toBeInstanceOf(URL)
})

test('media store: refuses private destinations before any request, and never stores them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyestu-media-guard-'))
  const store = new MediaStore(dir, { maxObjectBytes: 1024, urlPolicy: 'block-private' })

  await expect(store.download('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('private address')
  await expect(store.download('http://127.0.0.1:9/x.jpg')).rejects.toThrow('private address')
  expect(readdirSync(join(dir, 'media', 'store'))).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})
