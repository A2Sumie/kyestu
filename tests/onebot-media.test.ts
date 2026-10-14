import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_INLINE_MAX_BYTES,
  buildSignedMediaUrl,
  decideMediaSource,
  signMediaToken,
  verifyMediaToken,
  MediaSourceError,
} from '../src/pipeline/onebot-media'

const dir = mkdtempSync(join(tmpdir(), 'kyestu-media-'))
const photo = join(dir, 'photo.png')
writeFileSync(photo, Buffer.alloc(1024, 1))
const video = join(dir, 'video.mp4')
writeFileSync(video, Buffer.alloc(4 * 1024 * 1024, 1))

test('auto: napcat and unknown bridges keep the legacy file:// source (compat)', () => {
  for (const dialect of ['napcat', 'generic'] as const) {
    const decision = decideMediaSource({ path: photo, size: 1024, type: 'photo', dialect })
    expect(decision).toEqual({ kind: 'file', value: `file://${photo}` })
  }
})

test('auto: snowluma prefers url > inline > stream > file', () => {
  // 1. url when base is configured
  expect(
    decideMediaSource({ path: photo, size: 1024, type: 'photo', dialect: 'snowluma', urlBase: 'http://host:3000/media', mediaRoot: dir }),
  ).toMatchObject({ kind: 'url', value: `http://host:3000/media/photo.png`, name: 'photo.png' })
  // 2. inline for small photos when no url base
  expect(decideMediaSource({ path: photo, size: 1024, type: 'photo', dialect: 'snowluma' })).toMatchObject({
    kind: 'inline',
    value: photo,
  })
  // 3. stream upload for large videos when capable
  expect(decideMediaSource({ path: video, size: 4 << 20, type: 'video', dialect: 'snowluma', streamCapable: true })).toMatchObject({
    kind: 'stream',
    value: video,
  })
  // 4. file:// as the documented last resort
  expect(decideMediaSource({ path: video, size: 4 << 20, type: 'video', dialect: 'snowluma' })).toMatchObject({
    kind: 'file',
    value: `file://${video}`,
  })
})

test('auto: inline cap is respected; video never goes inline', () => {
  expect(
    decideMediaSource({ path: video, size: DEFAULT_INLINE_MAX_BYTES + 1, type: 'photo', dialect: 'snowluma', inlineMaxBytes: 10 }),
  ).toMatchObject({ kind: 'file' })
  expect(decideMediaSource({ path: photo, size: 1024, type: 'video', dialect: 'snowluma' })).toMatchObject({ kind: 'file' })
})

test('auto: file fallback can be refused (decoupled deployments)', () => {
  expect(() =>
    decideMediaSource({ path: video, size: 4 << 20, type: 'video', dialect: 'snowluma', allowFileFallback: false }),
  ).toThrow(MediaSourceError)
})

test('forced modes pick the requested source and fail loudly', () => {
  expect(decideMediaSource({ path: photo, size: 1, type: 'photo', dialect: 'napcat', mode: 'base64' })).toMatchObject({ kind: 'inline' })
  expect(decideMediaSource({ path: photo, size: 1, type: 'photo', dialect: 'napcat', mode: 'stream' })).toMatchObject({ kind: 'stream' })
  expect(() => decideMediaSource({ path: photo, size: 1, type: 'photo', dialect: 'snowluma', mode: 'url' })).toThrow(MediaSourceError)
})

test('signed media tokens: valid within TTL, rejected when expired or tampered', () => {
  const now = 1_760_000_000_000
  const url = buildSignedMediaUrl('http://host:3000/media', 'photo.png', 'secret', 600, now)
  expect(url).toContain('/media/photo.png?exp=')
  const exp = Number(new URL(url).searchParams.get('exp'))
  const sig = new URL(url).searchParams.get('sig')!
  expect(verifyMediaToken('photo.png', exp, sig, 'secret', now)).toBe(true)
  // expiry enforced
  expect(verifyMediaToken('photo.png', exp, sig, 'secret', exp * 1000 + 1)).toBe(false)
  // name is bound into the signature
  expect(verifyMediaToken('other.png', exp, sig, 'secret', now)).toBe(false)
  expect(verifyMediaToken('photo.png', exp, signMediaToken('photo.png', exp, 'other'), 'secret', now)).toBe(false)
})
