import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  type BiliTitleArticle,
  MAX_BILIUP_TITLE_CHARS,
  applyGeneratedTitle,
  buildTitleGenerationInput,
  buildTitleGenerationPrompt,
  deriveDeterministicTitle,
  deriveDescription,
  loadTranslationGlossary,
  normalizeGeneratedTitle,
  parseGeneratedTitle,
  resolveBiliTitle,
  resolveTitleTask,
  truncateTitleText,
} from '../src/pipeline/bili-title'
import { uploadVideo } from '../src/pipeline/biliup'
import { createTitleGenerationLlm } from '../src/components/target-bilibili'

/**
 * B 站标题链路（译题/概括）：与 idol-bbq d56c0d2 行为对齐的钉点。
 * ①译题输入=原标题 ②模板快照 ③语义截断 ④兜底链 ⑤译名一致/日文专名合法 ⑥未译回显拒收。
 */

const TZ = 'Asia/Tokyo'
const TS = Date.parse('2026-08-16T12:00:00+09:00') / 1000

const ytArticle: BiliTitleArticle = {
  platform: 'youtube',
  a_id: 'v1',
  u_id: 'kitahara_misaki',
  username: '北原実咲',
  url: 'https://www.youtube.com/watch?v=v1',
  content: '北原実咲のうさぎの話\n\n動画の説明文です。',
  translation: '北原实咲的兔子话题\n\n这是视频说明。',
  created_at: TS,
}

const ttArticle: BiliTitleArticle = {
  platform: 'tiktok',
  a_id: '9',
  u_id: 'mochizuki_rino',
  username: '望月りの',
  url: 'https://www.tiktok.com/@mochizuki_rino/video/9',
  content: '元のキャプション',
  translation: '用粉丝送我的プリキット试着跳了舞',
  created_at: TS,
}

// ---------- ① 译题输入 = 原标题 ----------

test('译题输入：translate 任务的 original_title 就是 content 首行，且是唯一翻译素材', () => {
  const input = JSON.parse(buildTitleGenerationInput(ytArticle, 'translate_original_title', { minChars: 8, maxChars: 32 }, TZ))
  expect(input.task).toBe('translate_original_title')
  expect(input.original_title).toBe('北原実咲のうさぎの話')
  expect(input.text).toContain('動画の説明文です。')
  expect(input.title_min_chars).toBe(8)
  expect(input.title_max_chars).toBe(32)
  expect(input.source_context).toMatchObject({ platform: 'youtube', source_tag: 'YT', source_url: ytArticle.url })
})

test('概括任务（无原标题来源）不带 original_title 字段', () => {
  expect(resolveTitleTask(ttArticle)).toBe('summarize_post_title')
  expect(resolveTitleTask(ytArticle)).toBe('translate_original_title')
  const input = JSON.parse(buildTitleGenerationInput(ttArticle, 'summarize_post_title', { minChars: 4, maxChars: 32 }, TZ))
  expect(input.task).toBe('summarize_post_title')
  expect(input.original_title).toBeUndefined()
})

test('译题 prompt：few-shot + 忠实翻译约束（original_title 唯一素材）', () => {
  const prompt = buildTitleGenerationPrompt('translate_original_title', 8, 32)
  expect(prompt).toContain('忠实简体中文翻译')
  expect(prompt).toContain('original_title是唯一翻译素材')
  expect(prompt).toContain('original_title: 北原実咲のうさぎの話 → title_zh: 北原实咲的兔子话题')
  expect(prompt).toContain('glossary')
  expect(buildTitleGenerationPrompt('summarize_post_title', 4, 32)).toContain('概括标题')
  // 覆盖 prompt 后译题规则失效（文档已注明）
  expect(buildTitleGenerationPrompt('translate_original_title', 8, 32, 'custom')).toBe('custom')
})

// ---------- ② 模板快照（统一模板，无 [来源] 段） ----------

test('模板快照：youtube = 译文首行；X/IG/TT 无 [来源] 段；空账号退化为【22/7】日期壳', () => {
  expect(deriveDeterministicTitle(ytArticle, TZ)).toBe('【22/7 北原実咲】08.16_26 北原实咲的兔子话题')
  expect(deriveDeterministicTitle(ttArticle, TZ)).toBe('【22/7 望月りの】08.16_26 用粉丝送我的プリキット试着跳了舞')
  const noTranslation = { ...ttArticle, translation: null }
  expect(deriveDeterministicTitle(noTranslation, TZ)).toBe('【22/7 望月りの】08.16_26 元のキャプション')
  const noAccount = { platform: 'twitter', a_id: '9', u_id: '', username: '', url: 'u', content: '', created_at: TS }
  expect(deriveDeterministicTitle(noAccount, TZ)).toBe('【22/7】08.16_26')
})

test('模板快照：自定义模板仍受支持，{source_tag} 等键保留', () => {
  const title = deriveDeterministicTitle(ttArticle, TZ, '【{account_title}】[{source_tag}] {date_code} {headline}')
  expect(title).toBe('【22/7 望月りの】[TT] 08.16_26 用粉丝送我的プリキット试着跳了舞')
})

test('兜底链第2/3级：译文首行 → 原标题原文', () => {
  // 有译文：译文首行优先
  expect(deriveDeterministicTitle(ytArticle, TZ)).toContain('北原实咲的兔子话题')
  // 无译文：原标题原文照上（不翻译、不编造）
  const untranslated = { ...ytArticle, translation: null }
  expect(deriveDeterministicTitle(untranslated, TZ)).toBe('【22/7 北原実咲】08.16_26 北原実咲のうさぎの話')
})

// ---------- ③ 语义安全截断 ----------

test('截断：>80 字按语义边界截断 + 单个 …，不切半个词', () => {
  expect(truncateTitleText('河瀬詩のうたっけ！#31 2026.08.07', 16)).toBe('河瀬詩のうたっけ！#31…')
  const long = `${'北原实咲的兔子话题 '.repeat(12)}尾巴`
  const title = deriveDeterministicTitle({ ...ytArticle, translation: long }, TZ)
  expect(Array.from(title).length).toBeLessThanOrEqual(MAX_BILIUP_TITLE_CHARS)
  expect(title.endsWith('…')).toBe(true)
  expect(title).toContain('【22/7 北原実咲】08.16_26 ')
  // 截断点后不残留孤立标点
  expect(title).not.toMatch(/[·・:：|｜、，,／/—–\-~～]…$/u)
})

// ---------- ⑤ 译名一致 ----------

test('glossary 一致性：22/7 译名表随输入下发（天城サリー→天城莎莉 等）', () => {
  const glossary = loadTranslationGlossary()
  expect(glossary.length).toBe(65)
  expect(glossary).toContainEqual({ source: '天城サリー', target: '天城莎莉', note: expect.any(String) })
  expect(glossary).toContainEqual({ source: '北原実咲', target: '北原实咲', note: expect.any(String) })
  const input = JSON.parse(buildTitleGenerationInput(ytArticle, 'translate_original_title', { minChars: 8, maxChars: 32 }, TZ))
  expect(input.glossary).toEqual(glossary)
})

test('译文合格性：日文专名（歌名/节目名）合法，未译回显/无汉字/标题党拒收', () => {
  const bounds = { minChars: 4, maxChars: 32 }
  // 译名表政策保留日文专名：「命の続き」不算未译
  expect(normalizeGeneratedTitle('天城莎莉《命の続き》演唱会幕后', '【22/7】08.16_26 x', bounds, 'translate_original_title')).toBe(
    '天城莎莉《命の続き》演唱会幕后',
  )
  // 无汉字拒收
  expect(normalizeGeneratedTitle('Hello World', '【22/7】08.16_26 x', bounds, 'translate_original_title')).toBe('')
  // 假名绝对多数（模型回显原文）拒收
  expect(normalizeGeneratedTitle('北原実咲がうさぎのおはなしをした', '【22/7】08.16_26 x', bounds, 'translate_original_title')).toBe('')
  // 标题党禁词拒收
  expect(normalizeGeneratedTitle('震惊！北原实咲的兔子', '【22/7】08.16_26 x', bounds, 'translate_original_title')).toBe('')
})

// ---------- ④/⑥ 兜底链与产出采用 ----------

test('LLM 译题产出逐字采用；失败/拒收时回落确定性标题（译文首行→原标题→日期壳）', async () => {
  const deterministic = deriveDeterministicTitle(ytArticle, TZ)
  // 采用
  const ok = await resolveBiliTitle({
    article: ytArticle,
    timeZone: TZ,
    generation: { generate: async () => '{"title_zh":"北原实咲聊自己养的兔子"}' },
  })
  expect(ok).toBe('【22/7 北原実咲】08.16_26 北原实咲聊自己养的兔子')
  // 模型抛错
  const down = await resolveBiliTitle({
    article: ytArticle,
    timeZone: TZ,
    generation: {
      generate: async () => {
        throw new Error('llm down')
      },
    },
  })
  expect(down).toBe(deterministic)
  // 未译回显拒收 → 兜底
  const echoed = await resolveBiliTitle({
    article: ytArticle,
    timeZone: TZ,
    generation: { generate: async () => '北原実咲がうさぎのおはなしをした' },
  })
  expect(echoed).toBe(deterministic)
  // 纯日期/纯标点不出空壳正文
  for (const bad of ['08.16_26', '。。。', '']) {
    expect(
      await resolveBiliTitle({ article: ytArticle, timeZone: TZ, generation: { generate: async () => bad } }),
    ).toBe(deterministic)
  }
})

test('译题模式忠实不剥上下文；概括模式剥掉模型回显的账号名', () => {
  const current = '【22/7 望月りの】08.16_26 用粉丝送我的プリキット试着跳了舞'
  const bounds = { minChars: 4, maxChars: 32 }
  expect(normalizeGeneratedTitle('望月りの介绍自己养的兔子', current, bounds, 'translate_original_title')).toBe(
    '望月りの介绍自己养的兔子',
  )
  expect(normalizeGeneratedTitle('望月りの介绍自己养的兔子', current, bounds, 'summarize_post_title')).toBe(
    '介绍自己养的兔子',
  )
})

test('applyGeneratedTitle 只换正文：前缀+日期码原样保留，回显日期码去重', () => {
  const options = { task: 'translate_original_title' as const, bounds: { minChars: 2, maxChars: 32 } }
  expect(applyGeneratedTitle('【22/7 北原実咲】08.16_26 北原实咲的兔子话题', '北原实咲聊自己养的兔子', options)).toBe(
    '【22/7 北原実咲】08.16_26 北原实咲聊自己养的兔子',
  )
  expect(applyGeneratedTitle('【22/7 北原実咲】08.16_26 x', '08.16_26 北原实咲聊自己养的兔子', options)).toBe(
    '【22/7 北原実咲】08.16_26 北原实咲聊自己养的兔子',
  )
  // 不合格产出不替换
  expect(applyGeneratedTitle('【22/7 北原実咲】08.16_26 x', '震惊！必看', options)).toBeNull()
})

test('parseGeneratedTitle：JSON 与纯文本译题均可采用', () => {
  expect(parseGeneratedTitle('{"title_zh":"北原实咲的兔子话题"}')).toBe('北原实咲的兔子话题')
  expect(parseGeneratedTitle('```json\n{"zh_title":"北原实咲的兔子话题"}\n```')).toBe('北原实咲的兔子话题')
  expect(parseGeneratedTitle('北原实咲的兔子话题')).toBe('北原实咲的兔子话题')
  expect(parseGeneratedTitle('多行\n输出')).toBe('')
  expect(parseGeneratedTitle('')).toBe('')
})

// ---------- 简介：原标题行 ----------

test('简介：youtube 原标题以 `原标题:` 行固定首部且不重复；社媒无此行', () => {
  const desc = deriveDescription(ytArticle, TZ, '{content}\n\n来源: {url}')
  expect(desc.startsWith('原标题: 北原実咲のうさぎの話')).toBe(true)
  expect(desc).toContain('動画の説明文です。')
  expect(desc).toContain('来源: https://www.youtube.com/watch?v=v1')
  // 正文首行的原文标题去重（原文只出现一次）
  expect(desc.split('北原実咲のうさぎの話').length - 1).toBe(1)
  expect(deriveDescription(ttArticle, TZ, '{content}\n\n来源: {url}')).not.toContain('原标题:')
})

// ---------- LLM 接缝 × mock LLM（Bun.serve） ----------

test('title_generation 接缝：mock LLM 收到译题输入，产出进 --title；坏产出回落确定性标题', async () => {
  const calls: Array<{ system: string; user: string }> = []
  let mode: 'ok' | 'echo' = 'ok'
  const llm = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as any
      calls.push({ system: body.messages[0].content, user: body.messages[1].content })
      const content = mode === 'ok' ? '{"title_zh":"北原实咲聊自己养的兔子"}' : '北原実咲がうさぎのおはなしをした'
      return Response.json({ choices: [{ message: { content } }] })
    },
  })
  try {
    const generate = createTitleGenerationLlm({
      api_key: 'k',
      base_url: `http://127.0.0.1:${llm.port}/v1/chat/completions`,
      wire_api: 'chat_completions',
    })
    const dir = mkdtempSync(join(tmpdir(), 'kyestu-bili-title-'))
    const helper = join(dir, 'helper.py')
    writeFileSync(
      helper,
      'import os, sys\nopen(os.environ["ARGV_OUT"], "w").write("\\n".join(sys.argv[1:]))\nprint("done bvid=BV1xx411c7mD aid=1")\n',
    )
    chmodSync(helper, 0o755)
    const cookie = join(dir, 'cookies.json')
    writeFileSync(cookie, JSON.stringify({ cookie_info: { cookies: [{ name: 'SESSDATA', value: 'x' }, { name: 'bili_jct', value: 'y' }] } }))
    const video = join(dir, 'v.mp4')
    writeFileSync(video, 'fake')
    const argvOut = join(dir, 'argv.txt')
    process.env.ARGV_OUT = argvOut
    try {
      await uploadVideo(
        { cookie_file: cookie, helper_path: helper, title_generation: { generate } },
        { videoPaths: [video], article: ytArticle as any },
      )
      let argv = readFileSync(argvOut, 'utf8').split('\n')
      expect(argv[argv.indexOf('--title') + 1]).toBe('【22/7 北原実咲】08.16_26 北原实咲聊自己养的兔子')
      expect(argv[argv.indexOf('--desc') + 1]!.startsWith('原标题: 北原実咲のうさぎの話')).toBe(true)
      expect(calls.length).toBe(1)
      expect(calls[0]!.system).toContain('忠实简体中文翻译')
      expect(JSON.parse(calls[0]!.user).original_title).toBe('北原実咲のうさぎの話')

      mode = 'echo'
      await uploadVideo(
        { cookie_file: cookie, helper_path: helper, title_generation: { generate } },
        { videoPaths: [video], article: ytArticle as any },
      )
      argv = readFileSync(argvOut, 'utf8').split('\n')
      expect(argv[argv.indexOf('--title') + 1]).toBe('【22/7 北原実咲】08.16_26 北原实咲的兔子话题')
    } finally {
      delete process.env.ARGV_OUT
    }
  } finally {
    llm.stop(true)
  }
})
