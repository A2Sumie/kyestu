/**
 * Fiber transition census (re-runnable): `bun tests/helpers/transition-census.ts`
 *
 * Runs the full test bench under the transition tap preload, aggregates the
 * observed lifecycle (from,to) arcs, and diffs them against the legal arc set
 * of the fiber state machine (derived from src/core/runtime.ts setState call
 * sites). Prints the transition-coverage table; exits non-zero when a legal
 * arc went untriggered (the G3/G4 blind-spot class) or an illegal arc was
 * observed (a runtime bug signal). `--report-only` never fails.
 *
 * Legal arcs (runtime.ts, 2026-09-15):
 *   INACTIVE ->LOADING    kick() with a live target (initial load / reload)
 *   LOADING  ->ACTIVE     apply fold completed
 *   LOADING  ->UNLOADING  retreat during load (dispose / stale completion / apply error)
 *   ACTIVE   ->UNLOADING  L-Leave (dispose / target lost)
 *   UNLOADING->INACTIVE   teardown completed, no live target
 *   UNLOADING->FAILED     teardown completed after an apply-error outcome
 *   UNLOADING->LOADING    in-place reload (target changed mid-unload)
 *   FAILED   ->INACTIVE   manual reset() re-entry
 */
import { rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const LEGAL_ARCS: Array<[string, string]> = [
  ['INACTIVE', 'LOADING'],
  ['LOADING', 'ACTIVE'],
  ['LOADING', 'UNLOADING'],
  ['ACTIVE', 'UNLOADING'],
  ['UNLOADING', 'INACTIVE'],
  ['UNLOADING', 'FAILED'],
  ['UNLOADING', 'LOADING'],
  ['FAILED', 'INACTIVE'],
]

const root = join(import.meta.dir, '..', '..')
const trace = join(root, 'tests', '.transition-trace.jsonl')
rmSync(trace, { force: true })

const reportOnly = process.argv.includes('--report-only')

const run = Bun.spawnSync({
  cmd: ['bun', 'test', '--preload', './tests/helpers/transition-tap-preload.ts'],
  cwd: root,
  env: { ...process.env, KYESTU_TRACE: trace },
  stdout: 'inherit',
  stderr: 'inherit',
})

if (run.exitCode !== 0) {
  console.error(`\n[census] test bench exited ${run.exitCode} — census on a red bench is meaningless`)
  process.exit(run.exitCode)
}

const rows: Array<{ fiber: string; from: string; to: string }> = existsSync(trace)
  ? readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : []

const hits = new Map<string, number>()
const fibers = new Set<string>()
for (const row of rows) {
  fibers.add(row.fiber)
  const arc = `${row.from}->${row.to}`
  hits.set(arc, (hits.get(arc) ?? 0) + 1)
}

const legal = new Set(LEGAL_ARCS.map(([f, t]) => `${f}->${t}`))
const zero = LEGAL_ARCS.map(([f, t]) => `${f}->${t}`).filter((arc) => !hits.has(arc))
const illegal = [...hits.keys()].filter((arc) => !legal.has(arc))
const triggered = LEGAL_ARCS.length - zero.length

console.log('\n=== fiber transition census ===')
console.log(`events: ${rows.length}  distinct fibers: ${fibers.size}`)
for (const [from, to] of LEGAL_ARCS) {
  const arc = `${from}->${to}`
  const count = hits.get(arc) ?? 0
  console.log(`  ${arc.padEnd(24)} ${String(count).padStart(6)} ${count === 0 ? '  ZERO-TRIGGER' : ''}`)
}
if (illegal.length > 0) {
  console.log('  --- ILLEGAL arcs observed (not in the state machine):')
  for (const arc of illegal) console.log(`  ${arc.padEnd(24)} ${String(hits.get(arc)).padStart(6)}`)
}
console.log(`transition coverage: ${triggered}/${LEGAL_ARCS.length} arcs (${((triggered / LEGAL_ARCS.length) * 100).toFixed(2)}%)`)
if (zero.length > 0) console.log(`zero-trigger arcs: ${zero.join(', ')}`)

if (!reportOnly && (zero.length > 0 || illegal.length > 0)) process.exit(1)
