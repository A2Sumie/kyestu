import { existsSync, readFileSync, watch } from 'fs'
import { createRoot, Root } from './core/runtime'
import { createRegistry } from './loader/registry'
import { Loader, NodeHandle, nodeKey, type EntryDef } from './loader/loader'
import { parseConfigYaml } from './config/yaml'
import { compileConfig } from './config/schema'
import { defineAll } from './components'
import { resolveEnvStrings } from './config/env'

const configPath = process.argv[2] ?? process.env.KYESTU_CONFIG ?? 'kyestu.config.yaml'

if (!existsSync(configPath)) {
  console.error(`[kyestu] config not found: ${configPath}

快速开始：
  1. 从 idol-bbq 导入：  bun run import /path/to/idol-bbq/assets/config.yaml kyestu.config.yaml
  2. 或复制最小例子：    cp examples/config.minimal.yaml kyestu.config.yaml
  3. 启动：              bun run start kyestu.config.yaml
配置指南见 docs/config.md。`)
  process.exit(1)
}

const INFRA_DEFAULTS: EntryDef[] = [
  { id: 'db', use: 'infra/db', with: { path: process.env.DATABASE_PATH ?? './data.db' } },
  { id: 'bus', use: 'infra/bus' },
  { id: 'media-store', use: 'infra/media-store', with: { cache_root: process.env.CACHE_DIR ?? './cache' } },
  { id: 'browser-pool', use: 'infra/browser-pool', with: { cache_root: process.env.CACHE_DIR ?? './cache' } },
]

async function main() {
  const root: Root = createRoot({ name: 'kyestu' })
  const registry = defineAll(createRegistry())
  const loader = new Loader(root, registry)

  const boot = async () => {
    const config = parseConfigYaml(readFileSync(configPath, 'utf8'))
    const entries = compileConfig(config)
    const present = new Set(entries.map((e) => e.id))
    const infra = INFRA_DEFAULTS.filter((e) => !present.has(e.id))
    const resolved = entries.map((entry) => ({ ...entry, with: resolveEnvStrings(entry.with ?? {}) as Record<string, any> }))
    const userApi = entries.find((e) => e.id === 'api')
    const apiEntry: EntryDef = {
      id: 'api',
      use: 'app/api',
      with: {
        ...(userApi?.with ?? {}),
        port: userApi?.with?.port ?? Number(process.env.KYESTU_API_PORT ?? 3000),
        secret: userApi?.with?.secret ?? process.env.KYESTU_API_SECRET,
        onStatus: () => ({
          entries: loader.current().length,
          fibers: [...root.fibers].map((f) => ({ name: f.name, state: f.state, uid: f.uid })),
        }),
        // read-only cookie-health view: resolved lazily per request so the
        // api entry does not need an explicit coeffect edge on keepalive
        onCookieHealth: () => {
          const handle = root.ctx.get<NodeHandle>(nodeKey('cookie-keepalive'))
          const service = handle?.api<{ overview?: () => unknown }>()
          return service?.overview?.() ?? null
        },
        onReload: async () => {
          await boot()
          return { ok: true }
        },
      },
    }
    const routerEntry: EntryDef = { id: 'router', use: 'app/router', with: { routes: config.routes ?? [] } }
    const all = [...infra, ...resolved.filter((e) => e.id !== 'api' && e.id !== 'router'), apiEntry, routerEntry]
    const changes = await loader.reconcile(all)
    if (changes.length) console.log('[kyestu] reconciled:', changes.map((c) => `${c.kind}:${c.id}`).join(', '))
  }

  await boot()

  let debounce: ReturnType<typeof setTimeout> | null = null
  watch(configPath, () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      boot().catch((error) => console.error('[kyestu] reload failed:', error))
    }, 500)
  })

  const shutdown = async () => {
    await root.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  console.error('[kyestu] fatal startup error:', error)
  process.exit(1)
})
