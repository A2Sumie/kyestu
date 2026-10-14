import { spawn } from 'child_process'
import { convertXHashtagsToBiliFormat } from './bili-hashtag'
import {
  type BiliTitleGenerationOptions,
  DEFAULT_TITLE_TEMPLATE,
  deriveDescription,
  resolveBiliTitle,
} from './bili-title'
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
  /**
   * LLM 译题/概括接缝（组件侧按 video_upload.title_generation 注入）。
   * 缺省只有确定性模板（译文首行 → 原标题 → 日期壳），语义见 pipeline/bili-title.ts。
   */
  title_generation?: BiliTitleGenerationOptions
}

export interface UploadInput {
  videoPaths: string[]
  coverPath?: string
  article: {
    a_id: string
    u_id: string
    username?: string
    url: string
    content?: string | null
    translation?: string | null
    platform?: string
    type?: string
    created_at?: number
  }
}

export interface UploadResult {
  bvid?: string
  aid?: number
}

const DEFAULT_DESC_TEMPLATE = '{content}\n\n来源: {url}'

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
    // X hashtags reach Bilibili in the paired #tag# form; convert at this output
    // boundary so both templated and default metadata are covered.
    // 标题：译题/概括（可选 LLM）+ 确定性后处理 + 兜底链，见 pipeline/bili-title.ts。
    const title = convertXHashtagsToBiliFormat(
      await resolveBiliTitle({
        article: input.article,
        timeZone,
        template: config.title_template,
        generation: config.title_generation,
      }),
    )
    // 简介：youtube 原标题以 `原标题:` 行固定在首部（原文照旧，不翻译）
    const desc = convertXHashtagsToBiliFormat(
      deriveDescription(input.article, timeZone, config.desc_template ?? DEFAULT_DESC_TEMPLATE),
    )

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
