import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type { KyestuDb } from '../components/db'
import { ArticleStore } from './articles'
import { OutboundStore, outboundKey, articleKey } from './outbound'

/**
 * Bilibili recovery reconciliation (idol-bbq bilibili-recovery-reconciliation-service):
 * after the DB is restored from a backup (outbound state lost), a recovery
 * marker file triggers a one-shot reconcile — fetch each upload-enabled
 * bilibili target's archive list, match archives to stored articles by the
 * biliup `source` url, and seed outbound sent state so restored articles are
 * not re-uploaded as duplicates.
 */

const DEFAULT_PAGE_SIZE = 50
const DEFAULT_MAX_PAGES = 50
const DEFAULT_ARCHIVES_URL = 'https://member.bilibili.com/x/web/archives'
export const DEFAULT_RECOVERY_MARKER = '/tmp/kyestu/db-recovered.json'

export interface BilibiliReconcileTarget {
  id: string
  cookie_file?: string
  sessdata?: string
  bili_jct?: string
}

export interface BilibiliArchive {
  aid?: string | number
  bvid?: string
  title?: string
  source?: string
  ptime?: number
  state?: number
  state_desc?: string
}

export interface ReconcileResult {
  markerPath: string
  archives: number
  matched: number
  seeded: number
  skippedNoSource: number
  skippedNoArticle: number
  targets: number
}

/** cookie header from a biliup-style JSON cookie file, or sessdata/bili_jct fallback */
export function bilibiliCookieHeader(target: BilibiliReconcileTarget): string {
  if (target.cookie_file && existsSync(target.cookie_file)) {
    let doc: any
    try {
      doc = JSON.parse(readFileSync(target.cookie_file, 'utf8'))
    } catch (error) {
      throw new Error(
        `bilibili cookie file parse failed: ${target.cookie_file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const cookies = doc?.cookie_info?.cookies
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('bilibili cookie file must contain cookie_info.cookies')
    }
    const header = cookies
      .map((c: any) => {
        const name = typeof c?.name === 'string' ? c.name.trim() : ''
        const value = typeof c?.value === 'string' ? c.value : ''
        return name && value ? `${name}=${value}` : ''
      })
      .filter(Boolean)
      .join('; ')
    if (!header) throw new Error('bilibili cookie document does not contain usable cookies')
    return header
  }
  if (!target.sessdata || !target.bili_jct) {
    throw new Error(`bilibili target ${target.id} has no cookie_file or sessdata/bili_jct`)
  }
  return `SESSDATA=${target.sessdata}; bili_jct=${target.bili_jct}`
}

export interface FetchArchivesOptions {
  pageSize?: number
  maxPages?: number
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export async function fetchBilibiliArchives(cookieHeader: string, options: FetchArchivesOptions = {}): Promise<BilibiliArchive[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, 100))
  const maxPages = Math.max(1, Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, 200))
  const baseUrl = options.baseUrl ?? DEFAULT_ARCHIVES_URL
  const fetcher = options.fetchImpl ?? fetch
  const archives: BilibiliArchive[] = []

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(baseUrl)
    url.searchParams.set('status', 'is_pubing,pubed,not_pubed')
    url.searchParams.set('pn', String(page))
    url.searchParams.set('ps', String(pageSize))
    const response = await fetcher(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        referer: 'https://member.bilibili.com/platform/upload-manager/article',
        cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`bilibili archives API returned HTTP ${response.status}`)
    const payload = (await response.json()) as any
    if (payload?.code !== 0) {
      throw new Error(`bilibili archives API returned code ${payload?.code}: ${payload?.message || payload?.msg || ''}`)
    }
    const data = payload?.data ?? {}
    const items = (data.arc_audits || data.arcs || []) as Array<any>
    for (const item of items) {
      const archive = item?.Archive || item?.archive || item
      if (archive && typeof archive === 'object') archives.push(archive as BilibiliArchive)
    }
    const total = Number(data.page?.count || 0)
    if (items.length < pageSize || (total > 0 && archives.length >= total)) break
  }

  return archives
}

function seedSentState(store: KyestuDb, targetId: string, article: { id: number; platform: any; a_id: string }, archive: BilibiliArchive): boolean {
  const outbound = new OutboundStore(store)
  const key = articleKey(article.platform, article.a_id)
  const outboundId = outboundKey({ crawler: 'system:bilibili-recovery', target: targetId, article: key })
  const claim = outbound.claim(
    outboundId,
    { routeKey: `system:bilibili-recovery:${targetId}`, targetId, taskKind: 'article', articleKeys: [key] },
    { route_key: `system:bilibili-recovery:${targetId}`, target_id: targetId, task_kind: 'article', article_key: key },
  )
  if (claim.duplicate === 'sent') return false
  outbound.mark(claim.id, 'sent')
  outbound.markForwarded(article.platform, article.a_id, targetId, 'article')
  return true
}

export interface ReconcileOptions extends FetchArchivesOptions {
  markerPath?: string
}

/**
 * One-shot reconcile: runs only when the recovery marker exists, then consumes
 * it (result written to <marker>.bilibili-reconciled). Returns null when there
 * is nothing to do.
 */
export async function reconcileBilibiliSubmissions(
  store: KyestuDb,
  targets: BilibiliReconcileTarget[],
  options: ReconcileOptions = {},
): Promise<ReconcileResult | null> {
  const markerPath = options.markerPath ?? process.env.KYESTU_DB_RECOVERY_MARKER ?? DEFAULT_RECOVERY_MARKER
  if (!existsSync(markerPath)) return null

  const articles = new ArticleStore(store)
  const result: ReconcileResult = {
    markerPath,
    archives: 0,
    matched: 0,
    seeded: 0,
    skippedNoSource: 0,
    skippedNoArticle: 0,
    targets: targets.length,
  }
  if (targets.length === 0) return result // leave the marker for the next boot with targets configured

  // archives are fetched per target account and seeded only for the account
  // that actually hosts them; cross-seeding would suppress legitimate future
  // sends on the other accounts
  for (const target of targets) {
    const archives = await fetchBilibiliArchives(bilibiliCookieHeader(target), options)
    result.archives += archives.length
    const seenSources = new Set<string>()
    for (const archive of archives) {
      const source = String(archive.source || '').trim()
      if (!source) {
        result.skippedNoSource += 1
        continue
      }
      if (seenSources.has(source)) continue
      seenSources.add(source)
      const article = articles.findByUrl(source)
      if (!article) {
        result.skippedNoArticle += 1
        continue
      }
      result.matched += 1
      if (seedSentState(store, target.id, article, archive)) result.seeded += 1
    }
  }

  writeFileSync(
    `${markerPath}.bilibili-reconciled`,
    JSON.stringify({ ...result, completed_at: new Date().toISOString() }, null, 2) + '\n',
  )
  rmSync(markerPath, { force: true })
  return result
}

// ---- process-wide one-shot wiring: target components register themselves,
// the reconcile runs once per marker after all components have applied ----

const pending = new Map<string, { store: KyestuDb; options: ReconcileOptions; targets: BilibiliReconcileTarget[]; scheduled: boolean }>()

export function registerBilibiliRecoveryTarget(store: KyestuDb, target: BilibiliReconcileTarget, options: ReconcileOptions = {}): void {
  const markerPath = options.markerPath ?? process.env.KYESTU_DB_RECOVERY_MARKER ?? DEFAULT_RECOVERY_MARKER
  let entry = pending.get(markerPath)
  if (!entry) {
    entry = { store, options, targets: [], scheduled: false }
    pending.set(markerPath, entry)
  }
  if (!entry.targets.some((t) => t.id === target.id)) entry.targets.push(target)
  if (entry.scheduled) return
  entry.scheduled = true
  // defer so every bilibili target component registers before the run
  setTimeout(() => {
    const current = pending.get(markerPath)
    pending.delete(markerPath)
    if (!current) return
    void reconcileBilibiliSubmissions(current.store, current.targets, { ...current.options, markerPath }).catch(() => null)
  }, 0)
}
