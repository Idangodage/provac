import { defineConfig } from 'vitest/config';

/**
 * Explicit test-runner settings for the drawing engine.
 *
 * Two things were previously left to defaults and both produced misleading
 * results:
 *
 * **Timeout.** The 5 s default is shorter than several legitimate suites here.
 * `autoRouteNetwork.completeness` and `branchKitProposal` run real network
 * searches that take tens of seconds of CPU, so under parallel load they were
 * killed mid-run and reported as failures. The failing set moved between runs,
 * which is the signature of a starved worker rather than a broken assertion.
 * 30 s is chosen to be longer than the slowest honest suite measured here, not
 * long enough to hide a genuine hang.
 *
 * **Worker count.** Every worker holds its own module graph, and this package
 * pulls in three.js, fabric and a ~7k-line geometry model. With one worker per
 * core the resident set exceeded the memory actually free on a developer
 * machine and V8 aborted with `NewSpace::EnsureCurrentCapacity`. Bounding the
 * pool trades wall-clock for a result that can be trusted; it does not reduce
 * what is executed.
 *
 * Raise `maxWorkers` on a machine with more headroom — it changes scheduling
 * only, never coverage.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Vitest 4 moved the pool sizing to top-level options.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
