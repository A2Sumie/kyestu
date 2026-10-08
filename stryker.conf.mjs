/**
 * Stryker differential config (REDIAG 2026-09-15): one file per run via env.
 *   STRYKER_MUTATE=src/core/runtime.ts STRYKER_CMD='bun test ...' STRYKER_TAG=runtime bunx stryker run
 * Command runner = bun test on the module's direct bench (no coverage
 * analysis; every mutant re-runs the scoped bench). Score target: audit 90%.
 */
export default {
  mutate: (process.env.STRYKER_MUTATE ?? 'src/core/runtime.ts').split(','),
  testRunner: 'command',
  commandRunner: {
    command: process.env.STRYKER_CMD ?? 'bun test',
  },
  coverageAnalysis: 'off',
  timeoutMS: 120000,
  concurrency: 4,
  thresholds: { high: 90, low: 80, break: null },
  reporters: ['clear-text', 'json', 'progress'],
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
