import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** biliup video upload runner: stages parts, writes the cookie doc, runs the helper. */

export interface BiliupUploadConfig {
  cookie_file?: string
  sessdata?: string
  bili_jct?: string
  helper_path?: string
  python_path?: string
  tid?: number
  tags?: string[]
  copyright?: number
  submit_api?: string
  line?: string
  threads?: number
  title_template?: string
  desc_template?: string
  timezone?: string
}

export interface UploadInput {
  videoPaths: string[]
  coverPath?: string
  article: { a_id: string; u_id: string; username?: string; url: string; content?: string | null; translation?: string | null; platform?: string; created_at?: number }
}

export interface UploadResult {
  bvid?: string
  aid?: number
}

const SOURCE_TAGS: Record<string, string> = {
  twitter: 'X',
  tiktok: 'TT',
  instagram: 'ins',
  youtube: 'YT',
  website: 'blog',
}

/** MM.DD_YY, e.g. 08.16_26 (production format) */
function dateCode(timestampSeconds: number | undefined, timeZone: string): string {
  if (!timestampSeconds) return ''
  let parts: Record<string, string>
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestampSeconds * 1000))
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value
        return acc
      }, {})
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(timestampSeconds * 1000))
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value
        return acc
      }, {})
  }
  return `${parts.month}.${parts.day}_${String(parts.year ?? '').slice(-2)}`
}

function truncateCodePoints(value: string, maxChars: number): string {
  const chars = Array.from(value)
  if (chars.length <= maxChars) return value
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join('')}...`
}

function renderTemplate(template: string, article: UploadInput['article'], timeZone: string): string {
  const displayName = article.username ?? article.u_id
  const accountTitle = displayName ? (displayName.startsWith('22/7') ? displayName : `22/7 ${displayName}`) : ''
  // translated text first: production titles use the translated caption
  const caption = (article.translation ?? article.content ?? '').split('\n')[0] ?? ''
  const headline = truncateCodePoints(caption.replace(/\s+/g, ' ').trim(), 40)
  // upload_summary drops the display name on purpose: account_title already
  // carries it, repeating it after [TT]/[X] reads as a stutter
  const uploadSummary = [dateCode(article.created_at, timeZone), headline].filter(Boolean).join(' ')
  return template
    .replaceAll('{account_title}', accountTitle)
    .replaceAll('{source_tag}', SOURCE_TAGS[article.platform ?? ''] ?? '社媒')
    .replaceAll('{date_code}', dateCode(article.created_at, timeZone))
    .replaceAll('{upload_summary}', uploadSummary)
    .replaceAll('{u_id}', article.u_id)
    .replaceAll('{username}', displayName)
    .replaceAll('{platform}', article.platform ?? '')
    .replaceAll('{headline}', headline)
    .replaceAll('{a_id}', article.a_id)
    .replaceAll('{content}', article.content ?? '')
    .replaceAll('{url}', article.url)
    .replace(/【】/g, '')
    .replace(/\[\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export async function uploadVideo(config: BiliupUploadConfig, input: UploadInput): Promise<UploadResult> {
  const helperPath =
    config.helper_path ?? new URL('../../scripts/biliup-upload.py', import.meta.url).pathname
  const pythonPath = config.python_path ?? 'python3'
  const cookieFile = config.cookie_file
  if (!cookieFile && !(config.sessdata && config.bili_jct)) {
    throw new Error('biliup upload requires cookie_file or both sessdata and bili_jct')
  }

  const uploadDir = mkdtempSync(join(tmpdir(), 'kyestu-biliup-'))
  try {
    let cookieDoc: unknown
    if (cookieFile && existsSync(cookieFile)) {
      cookieDoc = JSON.parse(await Bun.file(cookieFile).text())
    } else {
      cookieDoc = {
        cookie_info: {
          cookies: [
            { name: 'SESSDATA', value: config.sessdata },
            { name: 'bili_jct', value: config.bili_jct },
          ],
        },
      }
    }
    const cookiePath = join(uploadDir, 'cookies.json')
    writeFileSync(cookiePath, JSON.stringify(cookieDoc, null, 2))

    const timeZone = config.timezone ?? 'Asia/Tokyo'
    const title = truncateCodePoints(renderTemplate(config.title_template ?? '【{account_title}】[{source_tag}] {upload_summary}', input.article, timeZone), 80)
    const desc = renderTemplate(config.desc_template ?? '{content}\n\n来源: {url}', input.article, timeZone)

    const args = [
      helperPath,
      '--cookie-file', cookiePath,
      '--title', title,
      '--desc', desc,
      '--source-url', input.article.url,
      '--tid', String(config.tid ?? 138),
      '--threads', String(config.threads ?? 3),
      '--submit-api', config.submit_api ?? 'web',
      '--line', config.line ?? 'auto',
      '--copyright', String(config.copyright ?? 2),
    ]
    for (const tag of config.tags ?? []) args.push('--tag', tag)
    if (input.coverPath) args.push('--cover', input.coverPath)
    args.push('--', ...input.videoPaths)

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(pythonPath, args, { cwd: uploadDir, env: { ...process.env, PYTHONUNBUFFERED: '1' } })
      const out: string[] = []
      const err: string[] = []
      child.stdout?.on('data', (chunk) => out.push(String(chunk)))
      child.stderr?.on('data', (chunk) => err.push(String(chunk)))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(out.join(''))
        else reject(new Error(`biliup exited ${code}: ${err.join('').slice(-500)}`))
      })
    })
    const bvid = stdout.match(/BV[0-9A-Za-z]{10}/)?.[0]
    const aid = stdout.match(/aid[=:\s]+(\d+)/i)?.[1]
    return { bvid, aid: aid ? Number(aid) : undefined }
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
}
