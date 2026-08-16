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
}

export interface UploadInput {
  videoPaths: string[]
  coverPath?: string
  article: { a_id: string; u_id: string; username?: string; url: string; content?: string | null; platform?: string }
}

export interface UploadResult {
  bvid?: string
  aid?: number
}

function renderTemplate(template: string, article: UploadInput['article']): string {
  const headline = (article.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return template
    .replaceAll('{u_id}', article.u_id)
    .replaceAll('{username}', article.username ?? article.u_id)
    .replaceAll('{platform}', article.platform ?? '')
    .replaceAll('{headline}', headline)
    .replaceAll('{a_id}', article.a_id)
    .replaceAll('{content}', article.content ?? '')
    .replaceAll('{url}', article.url)
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

    const title = renderTemplate(config.title_template ?? '【{username}】{headline}', input.article).slice(0, 80)
    const desc = renderTemplate(config.desc_template ?? '{content}\n\n来源: {url}', input.article)

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
