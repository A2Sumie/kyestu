import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * B 站投稿标题链路（译题/概括）纯逻辑。
 *
 * 口径与 idol-bbq `biliup.ts` 的标题整改（commit d56c0d2）行为一致：
 * - 有创作者原标题的来源（youtube 视频/Shorts）→ `translate_original_title`：B 站主标题 =
 *   原标题的忠实中文翻译，original_title 是唯一翻译素材；
 * - 无原标题的来源（twitter/instagram/tiktok 文案）→ `summarize_post_title`：忠实概括正文开头；
 * - website 文章带作者手写标题，永远不进 LLM 标题链路。
 *
 * 确定性后处理对 LLM 输出与确定性标题同时生效：平台词清洗、emoji 收敛、空白/括号规范化、
 * ≤80 字（码点）语义安全截断。兜底链：LLM 译题 → translation 首行 → 原标题原文 →
 * `【22/7】MM.DD_YY` 日期壳 → 平台标签+时间+article_id 硬壳。
 */

// ---------- constants ----------

export const MAX_BILIUP_TITLE_CHARS = 80
const MAX_TITLE_HEADLINE_CHARS = 40
const DEFAULT_TITLE_MIN_CHARS = 4
const DEFAULT_TITLE_MAX_CHARS = 32
export const BILIUP_ORIGINAL_TITLE_LABEL = '原标题:'
/** 统一默认模板：品牌前缀 + 日期码 + 标题正文；`[来源]` 段不再进标题（简介署名） */
export const DEFAULT_TITLE_TEMPLATE = '【{account_title}】{upload_summary}'

const BILIUP_FORBIDDEN_TITLE_TERMS = [
  '震惊',
  '惊呆',
  '爆料',
  '爆炸',
  '炸裂',
  '离谱',
  '必看',
  '神回',
  '全网',
  '独家',
  '首发',
  '实锤',
  '塌房',
  '翻车',
  '泪目',
  '杀疯',
  '燃爆',
  '逆天',
  '不得不看',
]

// 平台/搬运属性词：长词随处删；缩写只在独立成词时删（"TT短视频正文" 这类正文不受影响）
const BILIUP_TITLE_SCRUB_LONG_WORDS = [
  'youtube',
  'youtubeチャンネル',
  'twitter',
  'tiktok',
  'instagram',
  'ユーチューブ',
  'ツイッター',
  'ツイート',
  'インスタ',
  'ティックタック',
  'ティックトック',
  '推特',
  '搬运',
  '转载',
  '转帖',
  '転載',
  'リポスト',
  '社媒',
  '社交媒体',
]
const BILIUP_TITLE_SCRUB_SHORT_TOKENS = ['yt', 'tt', 'ins', 'ig', 'x', 'rt']
const BILIUP_TITLE_BREAK_CHARS = new Set([
  ' ',
  '\u3000',
  '·',
  '・',
  ':',
  '：',
  '|',
  '｜',
  '、',
  '，',
  ',',
  '/',
  '／',
  '—',
  '–',
  '-',
  '~',
  '～',
])
const BILIUP_TITLE_CLOSING_BRACKETS = '】」』）)]〉》'

const SOURCE_TAGS: Record<string, string> = {
  twitter: 'X',
  tiktok: 'TT',
  instagram: 'ins',
  youtube: 'YT',
  website: 'blog',
}

// ---------- types ----------

/**
 * 标题任务模式。
 * - `translate_original_title`：来源带创作者原标题（youtube）。B 站主标题 = 该原标题的忠实
 *   简体中文翻译；original_title 是唯一翻译素材，模型不得另拟标题。
 * - `summarize_post_title`：无独立标题（twitter/instagram/tiktok 文案）。把正文开头主要信息
 *   忠实翻译并浓缩成中文标题。
 */
export type BiliTitleTask = 'translate_original_title' | 'summarize_post_title'

export interface BiliTitleArticle {
  platform?: string
  type?: string
  a_id?: string
  u_id?: string
  username?: string
  url?: string
  content?: string | null
  translation?: string | null
  created_at?: number
}

export interface TitleTemplateContext {
  [key: string]: string
}

/** LLM 接缝：system prompt + 输入 JSON → 模型原始输出（组件侧注入，测试可替换） */
export type BiliTitleGenerator = (prompt: string, input: string) => Promise<string>

export interface BiliTitleGenerationOptions {
  generate: BiliTitleGenerator
  minChars?: number
  maxChars?: number
  /** 整体覆盖默认 prompt（覆盖后译题/概括规则随之失效，需自带规则） */
  prompt?: string
}

export interface BiliTitleTranslationGlossaryEntry {
  source: string
  target: string
  note?: string
}

// ---------- text helpers ----------

function normalizeTextBlock(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstNonEmptyLine(value: string | null | undefined): string {
  return (
    normalizeTextBlock(value)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  )
}

function normalizeComparableText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/[【】「」『』"'“”‘’\[\]()（）]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function compactComparableText(value: string | null | undefined): string {
  return normalizeTextBlock(value)
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLocaleLowerCase()
}

function hasTitleText(value: string): boolean {
  return /[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/.test(value)
}

function normalizeMainTitleText(value: string | null | undefined, fallback: string): string {
  const normalized = normalizeTextBlock(value).replace(/\s+/g, ' ').trim()
  return normalized && hasTitleText(normalized) ? normalized : fallback
}

function countTitleScriptChars(value: string): { han: number; kana: number } {
  return {
    han: (value.match(/[\u3400-\u9fff]/g) || []).length,
    kana: (value.match(/[\u3040-\u30ff]/g) || []).length,
  }
}

/**
 * "未译"判定：完全没有汉字，或假名占绝对多数（模型回显原文）。
 * 否则带假名是合法的：译名表政策让部分歌名/节目名保留日文（如「命の続き」）。
 */
export function looksUntranslatedTitle(value: string): boolean {
  const { han, kana } = countTitleScriptChars(value)
  if (han === 0) return true
  return kana >= 4 && kana > han * 2
}

// ---------- deterministic cleanup ----------

function escapeScrubWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 确定性清洗：删平台/搬运词，emoji 连续 3+ 折 2（正常符号如 ♪、～、【】、#tag# 保留）。
 */
export function scrubTitlePayload(value: string): string {
  let payload = normalizeTextBlock(value).replace(/\s+/g, ' ').trim()
  for (const word of BILIUP_TITLE_SCRUB_LONG_WORDS) {
    payload = payload.replace(new RegExp(escapeScrubWord(word), 'giu'), ' ')
  }
  for (const token of BILIUP_TITLE_SCRUB_SHORT_TOKENS) {
    payload = payload.replace(
      new RegExp(
        `(?<![A-Za-z0-9\\u3400-\\u9fff\\u3040-\\u30ff])${escapeScrubWord(token)}(?![A-Za-z0-9\\u3400-\\u9fff\\u3040-\\u30ff])`,
        'giu',
      ),
      ' ',
    )
  }
  payload = payload.replace(
    /(?:\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}]|\u200d\p{Extended_Pictographic}(?:\ufe0f|[\u{1f3fb}-\u{1f3ff}])*)+)/gu,
    (run) => {
      const units = run.split('\u200d')
      return (run.match(/\p{Extended_Pictographic}/gu) || []).length <= 2 ? run : units.slice(0, 2).join('\u200d')
    },
  )
  return payload.replace(/\s+/g, ' ').trim()
}

/**
 * 语义安全截断：按空格/分隔符/收尾括号边界切，标单个 `…`，绝不切半个词/人名；
 * 窗口下半段无边界时才硬截。
 */
export function truncateTitleText(value: string, maxChars: number): string {
  const chars = Array.from(value)
  if (chars.length <= maxChars) return value
  const budget = Math.max(2, maxChars - 1)
  let cut = -1
  for (let index = budget - 1; index >= Math.floor(budget * 0.5); index -= 1) {
    const char = chars[index]!
    if (BILIUP_TITLE_CLOSING_BRACKETS.includes(char)) {
      cut = index + 1
      break
    }
    if (BILIUP_TITLE_BREAK_CHARS.has(char)) {
      cut = index
      break
    }
  }
  const end = cut >= 0 ? cut : budget
  const head = chars
    .slice(0, end)
    .join('')
    .replace(/[\s·・:：|｜、，,／/—–\-~～]+$/u, '')
    .trim()
  return `${head || chars.slice(0, budget).join('')}…`
}

// ---------- task resolution ----------

/**
 * 带创作者原标题的视频来源：youtube 视频与 Shorts。这些来源的原标题是译题素材，并原样进
 * 简介 `原标题:` 行。twitter/instagram/tiktok 文案与 website 文章的首行是正文，不是标题。
 */
export function hasOriginalVideoTitle(article: Pick<BiliTitleArticle, 'platform'>): boolean {
  return article.platform === 'youtube'
}

/** 原标题 = content 首行（youtube 抓取内容的结构约定） */
export function extractOriginalTitleLine(article: Pick<BiliTitleArticle, 'content'>): string {
  return normalizeMainTitleText(firstNonEmptyLine(article?.content), '')
}

export function resolveTitleTask(article: Pick<BiliTitleArticle, 'content' | 'platform'>): BiliTitleTask {
  return hasOriginalVideoTitle(article) && extractOriginalTitleLine(article)
    ? 'translate_original_title'
    : 'summarize_post_title'
}

/** website 文章带作者手写标题；只做确定性模板，永不进 LLM 标题 */
export function allowsTitleGeneration(article: Pick<BiliTitleArticle, 'platform'>): boolean {
  return article.platform !== 'website'
}

function collectTextBlocks(article: BiliTitleArticle): string[] {
  const seen = new Set<string>()
  const blocks: string[] = []
  for (const candidate of [article.translation, article.content]) {
    const normalized = normalizeTextBlock(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    blocks.push(normalized)
  }
  return blocks
}

// ---------- date / template ----------

export interface DateTimeParts {
  date: string
  date_short: string
  /** MM.DD_YY，如 08.16_26（生产格式） */
  date_code: string
  time: string
  datetime: string
}

export function formatDateTimeParts(timestampSeconds: number | undefined, timeZone: string): DateTimeParts {
  const format = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date((timestampSeconds ?? 0) * 1000))
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value
        return acc
      }, {})
  let parts: Record<string, string>
  try {
    parts = format(timeZone)
  } catch {
    parts = format('Asia/Tokyo')
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const time = `${parts.hour}:${parts.minute}`
  return {
    date,
    date_short: `${String(parts.year || '').slice(-2)}.${parts.month}.${parts.day}`,
    date_code: timestampSeconds ? `${parts.month}.${parts.day}_${String(parts.year || '').slice(-2)}` : '',
    time,
    datetime: `${date} ${time}`,
  }
}

function resolveAccountTitle(displayName: string): string {
  // B 站频道是 22/7 fan channel：品牌前缀恒在，识别不到账号时退化为 `【22/7】`
  if (!displayName) return '22/7'
  return displayName.startsWith('22/7') ? displayName : `22/7 ${displayName}`
}

/** 标题正文候选：译文首行优先，其次原文首行（youtube 即原标题原文）；website 用作者原标题 */
function primaryTitleLine(article: BiliTitleArticle): string {
  const source = article.platform === 'website' ? article.content : (article.translation ?? article.content)
  return firstNonEmptyLine(source)
}

function resolveUploadSummary(article: BiliTitleArticle, dateTime: DateTimeParts): string {
  // headline 先清洗后语义截断到 40 字（码点），把 80 字标题预算的大头留给固定前缀之后
  const headline = truncateTitleText(scrubTitlePayload(primaryTitleLine(article)), MAX_TITLE_HEADLINE_CHARS)
  return [dateTime.date_code, headline].filter(Boolean).join(' ').trim()
}

export function buildTitleContext(article: BiliTitleArticle, timeZone: string): TitleTemplateContext {
  const dateTime = formatDateTimeParts(article.created_at, timeZone)
  const displayName = String(article.username ?? article.u_id ?? '').trim()
  return {
    account_title: resolveAccountTitle(displayName),
    a_id: String(article.a_id ?? ''),
    content: normalizeTextBlock(article.content),
    date: dateTime.date,
    date_code: dateTime.date_code,
    date_short: dateTime.date_short,
    datetime: dateTime.datetime,
    headline: truncateTitleText(scrubTitlePayload(primaryTitleLine(article)), MAX_TITLE_HEADLINE_CHARS),
    platform: String(article.platform ?? ''),
    source_tag: SOURCE_TAGS[article.platform ?? ''] ?? '社媒',
    time: dateTime.time,
    u_id: String(article.u_id ?? ''),
    upload_summary: resolveUploadSummary(article, dateTime),
    url: String(article.url ?? ''),
    username: displayName,
  }
}

function stripEmptyRenderedBrackets(value: string): string {
  return value
    .replace(/【\s*】/g, '')
    .replace(/「\s*」/g, '')
    .replace(/『\s*』/g, '')
    .replace(/（\s*）/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    // 只折横向空白：简介模板带换行结构（`原标题:` 行、正文分段）不能被压成一行
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function renderTitleTemplate(template: string, context: TitleTemplateContext): string {
  return stripEmptyRenderedBrackets(
    template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => context[key] || ''),
  )
}

/** 渲染结果剥到只剩壳（模板没有正文占位/上下文为空）时不产空壳正文，走硬兜底 */
function hasRenderedTitlePayload(value: string, context: TitleTemplateContext): boolean {
  const ignoredTokens = new Set(
    [context.source_tag, context.platform, 'TT', 'YT', 'X', 'ins', 'blog', '社媒']
      .map((token) => String(token || '').trim().toLocaleLowerCase())
      .filter(Boolean),
  )
  const payload = normalizeTextBlock(value)
    .replace(/[【】\[\]()（）{}<>《》「」『』]/g, ' ')
    .replace(/[|｜:：,，.。/_-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !ignoredTokens.has(token.toLocaleLowerCase()))
    .join(' ')
  return hasTitleText(payload)
}

const PLATFORM_NAMES: Record<string, string> = {
  twitter: 'Twitter',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  website: 'Website',
}

/** 硬壳：平台标签 + 时间 + article_id（连日期壳都渲染不出正文时的最后兜底） */
function hardTitleFallback(context: TitleTemplateContext): string {
  const platformName = PLATFORM_NAMES[context.platform ?? ''] || 'Unknown'
  const platformTag = context.username && context.username !== platformName ? `${platformName} ${context.username}` : platformName
  return normalizeMainTitleText(
    [platformTag, context.datetime, context.a_id].filter(Boolean).join(' ') || 'Bilibili upload',
    'Bilibili upload',
  )
}

export function buildTitleFallback(context: TitleTemplateContext): string {
  const shell = stripEmptyRenderedBrackets(`【${context.account_title}】${context.upload_summary}`)
  return normalizeMainTitleText(shell, hardTitleFallback(context))
}

/**
 * 确定性标题（兜底链 2-4 级）：译文首行 → 原标题原文 → 日期壳。
 * LLM 不可用/译文不合格时它就是最终标题。
 */
export function deriveDeterministicTitle(article: BiliTitleArticle, timeZone: string, template?: string): string {
  const context = buildTitleContext(article, timeZone)
  const rendered = renderTitleTemplate(template || DEFAULT_TITLE_TEMPLATE, context).replace(/\s{2,}/g, ' ').trim()
  const fallback = buildTitleFallback(context)
  const title = hasRenderedTitlePayload(rendered, context) ? rendered : fallback
  return truncateTitleText(normalizeMainTitleText(title, fallback), MAX_BILIUP_TITLE_CHARS)
}

// ---------- description ----------

/** 简介首部固定 `原标题: <原文>`（youtube）；已有该行或首行重复原文时去重后前置 */
export function prependOriginalTitle(description: string, originalTitle: string): string {
  const originalNormalized = normalizeMainTitleText(originalTitle, '')
  if (!originalNormalized) return description.trim()

  const compactOriginal = compactComparableText(originalNormalized)
  const lines = description
    .trim()
    .split('\n')
    .filter((line) => !line.trim().startsWith(BILIUP_ORIGINAL_TITLE_LABEL))
  while (lines[0] !== undefined && !lines[0]!.trim()) lines.shift()
  if (compactOriginal && compactComparableText(lines[0] || '') === compactOriginal) {
    lines.shift()
    while (lines[0] !== undefined && !lines[0]!.trim()) lines.shift()
  }
  const body = lines.join('\n').trim()
  return [`${BILIUP_ORIGINAL_TITLE_LABEL} ${originalNormalized}`, body].filter(Boolean).join('\n\n')
}

/** 简介：模板渲染 + youtube 原标题行（`原标题:` 恒在首部） */
export function deriveDescription(article: BiliTitleArticle, timeZone: string, template: string): string {
  const context = buildTitleContext(article, timeZone)
  const rendered = renderTitleTemplate(template, context)
  const originalTitle = hasOriginalVideoTitle(article) ? extractOriginalTitleLine(article) : ''
  return prependOriginalTitle(rendered, originalTitle)
}

// ---------- glossary ----------

/**
 * 22/7 日→中译名表（assets/knowledge/22_7/translation_terms_22_7_ja_zh.json）。
 * 随译题 prompt 下发，成员/角色/作品名与全链路译文写法一致。
 */
export function loadTranslationGlossary(): BiliTitleTranslationGlossaryEntry[] {
  const candidates = [
    fileURLToPath(new URL('../../assets/knowledge/22_7/translation_terms_22_7_ja_zh.json', import.meta.url)),
    `${process.cwd()}/assets/knowledge/22_7/translation_terms_22_7_ja_zh.json`,
  ]
  const sourcePath = candidates.find((candidate) => existsSync(candidate))
  if (!sourcePath) return []
  try {
    const payload = JSON.parse(readFileSync(sourcePath, 'utf8')) as Array<Record<string, unknown>>
    return (Array.isArray(payload) ? payload : [])
      .map((entry) => ({
        source: String(entry?.source || '').trim(),
        target: String(entry?.target || '').trim(),
        note: String(entry?.note || '').trim() || undefined,
      }))
      .filter((entry) => entry.source && entry.target)
  } catch {
    return []
  }
}

// ---------- LLM generation ----------

/** 输入 JSON：task / original_title / text / glossary / title_min_chars / title_max_chars / source_context */
export function buildTitleGenerationInput(
  article: BiliTitleArticle,
  task: BiliTitleTask,
  bounds: { minChars: number; maxChars: number },
  timeZone: string,
): string {
  const dateTime = formatDateTimeParts(article.created_at, timeZone)
  const context: Record<string, unknown> = {
    task,
    text: collectTextBlocks(article).join('\n\n'),
    glossary: loadTranslationGlossary(),
    title_min_chars: bounds.minChars,
    title_max_chars: bounds.maxChars,
    source_context: {
      platform: article.platform || '',
      source_tag: SOURCE_TAGS[article.platform ?? ''] ?? '社媒',
      type: article.type || '',
      username: article.username || '',
      user_id: article.u_id || '',
      article_id: article.a_id || '',
      source_url: article.url || '',
      date: dateTime.date,
      time: dateTime.time,
    },
  }
  if (task === 'translate_original_title') {
    // 唯一翻译素材：模型只翻译这个标题，别的都不看
    context.original_title = extractOriginalTitleLine(article)
  }
  return JSON.stringify(context, null, 2)
}

const BILIUP_TITLE_TRANSLATION_RULES = (titleMinChars: number, titleMaxChars: number) => [
  '你是B站投稿标题助手。只输出一个JSON对象：{"title_zh":"中文标题"}。',
  'title_zh规则（本次任务：翻译原标题）：',
  '- title_zh必须是输入original_title的忠实简体中文翻译：original_title是唯一翻译素材，不得改写、扩写、概括或另拟标题，不得补写原文没有的时间、地点、人物、评价。',
  '- 保留成员名、角色名、作品名、曲名、节目名、数字、日期、期数、序号、记号与原文结构；不截断、不漏译关键名词。',
  '- 专有名词按输入glossary的target写法翻译并保持一致（含note里的“avoid”警告）；glossary未收录的专有名词保守处理，可保留原文。',
  '- 用自然简体中文，不逐词硬译、不带翻译腔；不使用“震惊、必看、神回”等标题党词；不加解释、译注、引号装饰或表情符号堆砌。',
  `- 长度目标${titleMinChars}到${titleMaxChars}字：宁可完整传达原标题信息，超长时省略次要修饰语，绝不截断半个词。`,
  '示例：',
  'original_title: 【ナナコミ】第12回 配信開始 → title_zh: 《NANA-COMI》第12回 开始直播',
  'original_title: 天城サリー『推しカメラ』#3 を公開 → title_zh: 天城莎莉《推し相机》#3 公开',
  'original_title: 北原実咲のうさぎの話 → title_zh: 北原实咲的兔子话题',
]

const BILIUP_TITLE_SUMMARIZE_RULES = (titleMinChars: number, titleMaxChars: number) => [
  '你是B站投稿标题助手。只输出一个JSON对象：{"title_zh":"中文标题"}。',
  'title_zh规则（本次任务：概括标题，来源没有独立标题）：',
  '- 把输入text开头的主要信息忠实翻译并浓缩成简体中文标题：先逐句翻译正文开头的事实，只在原文过长时压缩次要修饰；不得脑补原文没有的信息。',
  `title_zh应为${titleMinChars}到${titleMaxChars}个中文字符，具体描述视频内容或事件本身（例如“北原実咲介绍自己养的兔子”“推し相机：强肩偶像把签名球送到2层观众席”），不夸张、不偏颇、不脑补。`,
  '禁止把成员名、日期、时间、账号名或平台名作为标题主体（例如“北原実咲 26.08.06”这类仅成员名加日期的标题）；只要输入包含可描述的事实就必须给出能反映内容的标题，不得用空字符串或缩略概括替代。',
  '- 保留成员名、作品名、数字、日期；专有名词按输入glossary的target写法；不使用标题党词，不加解释或译注。',
  '- title_zh会放在固定账号/日期前缀之后作为主标题；不要重复账号名、平台名、日期、原标题或搬运属性词。',
]

export function buildTitleGenerationPrompt(
  task: BiliTitleTask,
  titleMinChars: number,
  titleMaxChars: number,
  overridePrompt?: string,
): string {
  return (
    overridePrompt ||
    (task === 'translate_original_title'
      ? BILIUP_TITLE_TRANSLATION_RULES(titleMinChars, titleMaxChars)
      : BILIUP_TITLE_SUMMARIZE_RULES(titleMinChars, titleMaxChars)
    ).join('\n')
  )
}

/** 模型输出 → 标题：JSON（title_zh/zh_title/chinese_title/title）或纯文本单行译题 */
export function parseGeneratedTitle(value: string): string {
  const trimmed = String(value || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed)
    const titleZh =
      typeof parsed?.title_zh === 'string'
        ? parsed.title_zh
        : typeof parsed?.zh_title === 'string'
          ? parsed.zh_title
          : typeof parsed?.chinese_title === 'string'
            ? parsed.chinese_title
            : typeof parsed?.title === 'string' && typeof parsed?.tags !== 'object'
              ? parsed.title
              : undefined
    if (titleZh !== undefined) return titleZh
  } catch {
    // 非 JSON 输出：纯文本译题也可直接采用
  }
  if (!/[\n,，、]/.test(trimmed) && Array.from(trimmed).length <= MAX_BILIUP_TITLE_CHARS) return trimmed
  return ''
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function looseLiteralPattern(value: string): string {
  return Array.from(value)
    .map((char) => escapeRegExpLiteral(char))
    .join('\\s*')
}

/** 概括模式下模型回显的上下文词（账号名/日期）——译题模式不剥，译文保持忠实 */
function collectGeneratedTitleContextTerms(currentTitle: string): string[] {
  const terms: string[] = []
  const structuredMatch = currentTitle.match(/^【([^】]+)】(?:\[[^\]]+\])?\s*(.*)$/)
  const accountTitle = normalizeTextBlock(structuredMatch?.[1] || '')
  const payload = normalizeTextBlock(structuredMatch?.[2] || currentTitle)

  if (accountTitle) {
    terms.push(accountTitle)
    terms.push(accountTitle.replace(/^22\/7\s+/i, ''))
    terms.push(...accountTitle.split(/\s+/))
  }
  const forcedNameMatch = payload.match(/^(.+?)\s+\d{2}[./-]\d{2}[./-]\d{2}\b/)
  if (forcedNameMatch?.[1]) {
    terms.push(forcedNameMatch[1])
    terms.push(...forcedNameMatch[1].split(/\s+/))
  }
  return Array.from(
    new Set(terms.map((term) => normalizeTextBlock(term)).filter((term) => Array.from(term).length >= 2)),
  ).sort((a, b) => Array.from(b).length - Array.from(a).length)
}

function stripLeadingGeneratedTitleContext(value: string, currentTitle: string): string {
  let title = value.trim()
  const terms = collectGeneratedTitleContextTerms(currentTitle)
  for (let index = 0; index < 8; index += 1) {
    const before = title
    title = title
      .replace(/^\s*(?:\d{2}[./-]\d{2}[./-]\d{2}|20\d{2}[./-]\d{1,2}[./-]\d{1,2})\s*(?:[:：,，、\-ー－—–|｜/／・])?\s*/u, '')
      .trim()
    for (const term of terms) {
      const pattern = new RegExp(
        `^\\s*${looseLiteralPattern(term)}\\s*(?:さん|ちゃん|様|氏)?\\s*(?:[:：,，、\\-ー－—–|｜/／・の])?\\s*`,
        'u',
      )
      const next = title.replace(pattern, '').trim()
      if (next !== title) {
        title = next
        break
      }
    }
    if (title === before) break
  }
  return title
}

/**
 * 合格性校验 + 清洗：无汉字拒收、假名绝对多数（未译回显）拒收、标题党禁词拒收。
 * 超长不再整体拒收，由安全截断处理。
 */
export function normalizeGeneratedTitle(
  value: string | null | undefined,
  currentTitle: string,
  bounds: { minChars?: number; maxChars?: number },
  task: BiliTitleTask,
): string {
  // 忠实翻译可以很短（短而忠实好过长而编造），译题模式只留最低合理性下限；
  // 概括模式保留目标下限，逼出有信息量的标题。
  const minChars =
    task === 'translate_original_title' ? 2 : Math.max(1, Math.floor(bounds?.minChars ?? DEFAULT_TITLE_MIN_CHARS))
  const title = scrubTitlePayload(
    normalizeTextBlock(value)
      .replace(/[|｜\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[「『【《\[\]()（）\s]+|[」』】》\[\]()（）\s]+$/g, '')
      .trim(),
  )
  const strippedTitle = task === 'translate_original_title' ? title : stripLeadingGeneratedTitleContext(title, currentTitle)
  if (!strippedTitle || Array.from(strippedTitle).length < minChars) return ''
  if (looksUntranslatedTitle(strippedTitle)) return ''
  const lowercaseTitle = strippedTitle.toLocaleLowerCase()
  if (BILIUP_FORBIDDEN_TITLE_TERMS.some((term) => lowercaseTitle.includes(term.toLocaleLowerCase()))) return ''
  if (!compactComparableText(strippedTitle)) return ''
  return strippedTitle
}

export function splitTitleStructure(title: string): { head: string; dateCode: string; payload: string } {
  const normalized = normalizeMainTitleText(title, title)
  // 固定段保持渲染原样：`【account】` + 可选 `[source]`（自定义旧模板）+ 可选 `MM.DD_YY`。
  // 只有尾部正文可被替换。
  const match = normalized.match(/^(\s*【[^】]+】(?:\s*\[[^\]]+\])?\s*(?:\d{2}\.\d{2}_\d{2})?\s*)(.*)$/)
  return {
    head: match?.[1] || '',
    dateCode: match?.[1]?.match(/(\d{2}\.\d{2}_\d{2})/)?.[1] || '',
    payload: (match?.[2] || normalized).trim(),
  }
}

/** 只换正文：前缀+日期码原样保留；模型回显的日期码不重复；空壳返回 null（保持确定性标题） */
export function applyGeneratedTitle(
  currentTitle: string,
  titleZh: string | undefined,
  options: { task: BiliTitleTask; bounds?: { minChars?: number; maxChars?: number } },
): string | null {
  const normalizedTitle = normalizeMainTitleText(currentTitle, currentTitle)
  const generatedTitle = normalizeGeneratedTitle(titleZh, normalizedTitle, options.bounds || {}, options.task)
  if (!generatedTitle) return null

  const { head, dateCode, payload: _oldPayload } = splitTitleStructure(normalizedTitle)
  let payload = generatedTitle
  const echoedDate = dateCode ? payload.match(/^\d{2}\.\d{2}_\d{2}[\s:：,，、\-ー－—–|｜/／・]+/)?.[0] : undefined
  if (echoedDate && echoedDate.includes(dateCode)) payload = payload.slice(echoedDate.length).trim()
  if (!head) {
    // 无结构自定义模板：整体替换，日期码保活
    const looseDateCode = normalizedTitle.match(/(\d{2}\.\d{2}_\d{2})/)?.[1] || ''
    if (looseDateCode && !payload.includes(looseDateCode)) payload = `${looseDateCode} ${payload}`.trim()
    return truncateTitleText(payload, MAX_BILIUP_TITLE_CHARS)
  }

  const availableTitleLength = MAX_BILIUP_TITLE_CHARS - Array.from(head).length
  if (availableTitleLength < 4 || !payload) return null
  return `${head}${truncateTitleText(payload, availableTitleLength)}`
}

// ---------- orchestration ----------

export interface ResolveBiliTitleOptions {
  article: BiliTitleArticle
  timeZone: string
  template?: string
  generation?: BiliTitleGenerationOptions
}

/**
 * 标题主链路：确定性标题打底 →（可选）LLM 译题/概括替换正文。
 * 兜底链：LLM 译题 → translation 首行 → 原标题原文 → 日期壳 → 硬壳——LLM 不可用、
 * 译文不合格或解析失败时，确定性标题原样交付，绝不产空壳。
 */
export async function resolveBiliTitle(options: ResolveBiliTitleOptions): Promise<string> {
  const { article, timeZone, template, generation } = options
  const deterministic = deriveDeterministicTitle(article, timeZone, template)
  if (!generation || !allowsTitleGeneration(article)) return deterministic
  const blocks = collectTextBlocks(article)
  if (!blocks.length) return deterministic

  const bounds = {
    minChars: generation.minChars ?? DEFAULT_TITLE_MIN_CHARS,
    maxChars: generation.maxChars ?? DEFAULT_TITLE_MAX_CHARS,
  }
  const task = resolveTitleTask(article)
  try {
    const prompt = buildTitleGenerationPrompt(task, bounds.minChars, bounds.maxChars, generation.prompt)
    const input = buildTitleGenerationInput(article, task, bounds, timeZone)
    const raw = await generation.generate(prompt, input)
    return applyGeneratedTitle(deterministic, parseGeneratedTitle(raw), { task, bounds }) ?? deterministic
  } catch {
    return deterministic
  }
}
