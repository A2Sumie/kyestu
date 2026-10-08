/**
 * Transition tap (preload): `bun test --preload ./tests/helpers/transition-tap-preload.ts`
 * Appends every fiber lifecycle transition as one JSONL row to $KYESTU_TRACE.
 * Taps the shared Emitter class once — every Root created by the bench flows
 * through it, no production-code change. No env var → no-op (zero cost when
 * the preload is loaded outside a census run).
 */
import { appendFileSync } from 'fs'
import { Emitter } from '../../src/core/emitter'

const trace = process.env.KYESTU_TRACE
if (trace) {
  const original = Emitter.prototype.emit
  Emitter.prototype.emit = function (this: Emitter<unknown>, event: unknown) {
    const e = event as { type?: string; fiber?: string; from?: string; to?: string }
    if (e?.type === 'lifecycle') {
      appendFileSync(trace, JSON.stringify({ fiber: e.fiber, from: e.from, to: e.to }) + '\n')
    }
    return original.call(this, event)
  } as typeof original
}
