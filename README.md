# kyestu

Spatiotemporal composability runtime for long-lived, dynamically reconfigurable systems.

Every mutation of the shared environment is an **effect** paired with its inverse, tracked by the runtime and recovered automatically on unload (temporal composability). Every dependency between components is a declared **coeffect**, resolved reactively as providers come and go (spatial composability). Components are instantiated as **fibers** with a full lifecycle state machine: `INACTIVE → LOADING → ACTIVE → UNLOADING`, with failure routed to `FAILED` after automatic partial recovery.

The model follows the Cordis paper (cordiverse/paper, *A Programming Paradigm for Spatiotemporal Composability*); the implementation is purpose-built for Bun with an explicit stability focus.

## Core API

```typescript
import { createRoot } from 'kyestu'

const root = createRoot()

// a component: inject declares coeffects, apply performs effects
const provider = {
  name: 'db',
  provide: ['db'],
  apply: (ctx) => {
    const db = connect()
    ctx.set('db', db)              // coeffect provision; tracked, auto-removed on unload
    return () => db.close()        // inverse: composed into the fiber's accumulator
  },
}

const consumer = {
  name: 'server',
  inject: ['db'],                  // stays INACTIVE until 'db' is provided
  apply: (ctx) => {
    const db = ctx.get('db')
    const server = serve(db)
    return () => server.close()
  },
}

root.ctx.use(provider)
root.ctx.use(consumer)             // activates once provider is ACTIVE
await root.dispose()               // recovers everything, dependents first
```

## Semantics

- **Effects** (`ctx.effect`): accept a dispose function, a sync generator, or an async generator yielding inverses. Inverses accumulate and run LIFO on dispose. An inverse that throws is recorded as a taint and skipped — remaining inverses still run.
- **Coeffects** (`ctx.set` / `ctx.get` / `ctx.isolate`): `set` is itself an effect, so provisions are withdrawn automatically on unload. Isolation realms let the same key resolve to independent bindings per subtree.
- **Lifecycle**: a fiber activates only when every injected key resolves to an ACTIVE provider (or a root-provided value). A provider entering UNLOADING stops providing immediately; dependents deactivate first, and the provider's own recovery waits for them — bounded by `unloadGuardTimeoutMs`, after which recovery is forced and a taint is recorded.
- **Inertia**: an in-flight effect iteration always lands before a divert; interruption happens only at iteration boundaries.
- **Failure**: an `apply` that throws recovers its partial effects and lands the fiber in FAILED with the error as `outcome`. No automatic retry; call `fiber.reset()` to re-enter.
- **Ghost-write guard**: `fiber.wrap(fn)` / `fiber.isCurrent(gen)` drop async continuations of dead generations.

## Config & loader

Declarative entries + routes compile into coeffect wiring; reconciliation applies the least-disruptive change per entry. See [docs/config.md](docs/config.md).

```yaml
components:
  - id: x-main
    use: crawler/x
    with: { cookie_file: cookies/x.txt }
  - id: group-1
    use: target/qq
    with: { group_id: 123456 }
routes:
  - from: x-main
    to: [group-1]
```

```typescript
import { createRoot, createRegistry, Loader, loadConfigYaml } from 'kyestu'

const root = createRoot()
const registry = createRegistry().define('crawler/x', XCrawler).define('target/qq', QQTarget)
const loader = new Loader(root, registry)
await loader.load(loadConfigYaml(configText))
// later: await loader.reconcile(newEntries) — per-entry minimal-disruption diff
```

Import an idol-bbq config: `bun scripts/import-idol-bbq.ts <config.yaml> [out.yaml]`.

## Quick start

```bash
git clone <kyestu-repo> && cd kyestu
bun install

# from an idol-bbq deployment:
bun scripts/import-idol-bbq.ts /path/to/idol-bbq/assets/config.yaml kyestu.config.yaml
# edit kyestu.config.yaml: cookie paths, onebot http_url, api secret…

export DEEPSEEK_API_KEY=... ONEBOT_HTTP_URL=http://127.0.0.1:3001
bun src/main.ts kyestu.config.yaml
```

That's it: infra entries (db/bus/media-store/browser-pool) are auto-provided with local defaults,
fibers come up in dependency order, the config file is watched and reconciled on change,
and `/api/status` + `/api/reload` (POST) are on port 3000 (Bearer `KYESTU_API_SECRET` if set).

## Current scope

**v1 (works today)**: crawler spine (x / x-list / instagram / tiktok / youtube / website-227 / leap /
messageboard) with schedule windows + cooldowns + retry classification; OpenAI-protocol processors
(responses & chat_completions with fallback); all formatter render types incl. card rendering;
QQ target (full segment send, rate limit, dedup); Bilibili target (text + photo dynamics);
declarative config with hot reconcile; fiber lifecycle (partial-failure recovery, unload guard
timeouts, ghost-write protection).

**v1.1 (explicitly deferred)**: digest/summary-card aggregation, video pairing, media-visibility
dedup windows, Bilibili video upload (biliup), live capture, cookie keepalive cron. Configs using
aggregation fields load fine but those behaviors are inert; Bilibili video articles are skipped
with a taint recorded.

## Development

```bash
bun install
bun test          # 230 tests: core, loader, config, importer, components, e2e pipeline
bun run typecheck
```

Status: runnable end-to-end (crawl → translate → render → send). See `docs/` for the feasibility
report, decisions log and config guide; `testset/` holds the parity/conformance test plan.
