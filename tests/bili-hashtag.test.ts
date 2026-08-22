import { describe, expect, test } from 'bun:test'
import { convertXHashtagsToBiliFormat } from '../src/pipeline/bili-hashtag'

describe('convertXHashtagsToBiliFormat', () => {
  test('wraps a simple hashtag after a space', () => {
    expect(convertXHashtagsToBiliFormat('text #hashtag here')).toBe('text #hashtag# here')
  })

  test('does not touch a hashtag glued to a word', () => {
    expect(convertXHashtagsToBiliFormat('text#hashtag')).toBe('text#hashtag')
  })

  test('does not touch pure numeric tags', () => {
    expect(convertXHashtagsToBiliFormat('#1234')).toBe('#1234')
    expect(convertXHashtagsToBiliFormat('see #1234_567')).toBe('see #1234_567')
  })

  test('wraps tags with underscores and digits when a letter is present', () => {
    expect(convertXHashtagsToBiliFormat('a #hash_tag2 b')).toBe('a #hash_tag2# b')
  })

  test('wraps Japanese hashtags and full-width markers', () => {
    expect(convertXHashtagsToBiliFormat('これは #日本語ハッシュタグ です')).toBe('これは #日本語ハッシュタグ# です')
    expect(convertXHashtagsToBiliFormat('＃日本語 です')).toBe('#日本語# です')
  })

  test('stops at ASCII hyphen like X does', () => {
    expect(convertXHashtagsToBiliFormat('#COVID-19')).toBe('#COVID#-19')
  })

  test('keeps ー and ・ inside the tag', () => {
    expect(convertXHashtagsToBiliFormat('#COVIDー19')).toBe('#COVIDー19#')
    expect(convertXHashtagsToBiliFormat('#ナナニジ・計算中')).toBe('#ナナニジ・計算中#')
  })

  test('wraps multiple hashtags and tags at text boundaries', () => {
    expect(convertXHashtagsToBiliFormat('#start middle #end')).toBe('#start# middle #end#')
    expect(convertXHashtagsToBiliFormat('#ナナニジ の番組 #計算中 です')).toBe('#ナナニジ# の番組 #計算中# です')
  })

  test('is idempotent and leaves paired tags untouched', () => {
    const once = convertXHashtagsToBiliFormat('text #hashtag and #COVID-19')
    expect(once).toBe('text #hashtag# and #COVID#-19')
    expect(convertXHashtagsToBiliFormat(once)).toBe(once)
    expect(convertXHashtagsToBiliFormat('已经 #包好# 的话题')).toBe('已经 #包好# 的话题')
  })

  test('never lets a newline inside the emitted pair', () => {
    expect(convertXHashtagsToBiliFormat('#tag\nnext line')).toBe('#tag#\nnext line')
  })

  test('does not swallow trailing punctuation or touch entity-like sequences', () => {
    expect(convertXHashtagsToBiliFormat('看看 #ナナニジ！')).toBe('看看 #ナナニジ#！')
    expect(convertXHashtagsToBiliFormat('a &#123; b')).toBe('a &#123; b')
    expect(convertXHashtagsToBiliFormat('')).toBe('')
  })
})
