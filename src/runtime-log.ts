import type { KyestuEvent } from './core/types'

// runtime event stream (D2): lifecycle transitions at info level; taints and
// unload-guard timeouts must be loud — they are the only production visibility
// into recovery faults and forced unloads (review §2.5). Extracted from
// main.ts so the rendering branches are unit-testable (observability.test.ts).
export function logRuntimeEvent(event: KyestuEvent): void {
  if (event.type === 'taint') {
    console.warn(`[kyestu] taint: ${event.fiber} (${event.phase}):`, event.error)
  } else if (event.type === 'timeout') {
    const waiting = event.waiting.length ? event.waiting.join(', ') : event.phase === 'inverses' ? '(own inverses)' : '(unknown)'
    console.error(`[kyestu] unload guard timeout: ${event.fiber} forced, waiting on ${waiting}`)
  } else {
    console.log(`[kyestu] lifecycle: ${event.fiber} ${event.from} -> ${event.to}`)
  }
}
