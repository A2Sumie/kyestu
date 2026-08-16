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

## Development

```bash
bun install
bun test          # 25 tests: effect engine, coeffects, lifecycle, confluence
bun run typecheck
```

Status: core runtime only. Component loader (declarative config + reconciliation) and application components land in later milestones. See `docs/` for the feasibility report and `testset/` for the behavioral test plan.
