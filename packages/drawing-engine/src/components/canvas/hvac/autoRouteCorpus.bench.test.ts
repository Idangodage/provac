/**
 * Times Auto route on the benchmark set (__fixtures__/autoRouteCorpus.ts),
 * with the real clock, and holds each case to its time budget so the speed
 * cannot slowly get worse again. Writes one JSON line per case (total and each
 * step) to AUTO_ROUTE_BENCH_OUT (default: auto-route-bench.jsonl in the temp
 * folder).
 *
 *   AUTO_ROUTE_BENCH=1 npx vitest run src/components/canvas/hvac/autoRouteCorpus.bench.test.ts
 *
 * The first case of a run starts cold (as each Auto route does: a fresh
 * worker); later cases run on a warmed-up engine. For before/after numbers run
 * one case per process (AUTO_ROUTE_CASES=name) and take the median of three.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./__fixtures__/nodeBuiltins.d.ts" />
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCorpusCase, selectCorpusCases } from './__fixtures__/autoRouteCorpus';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const OUT = env.AUTO_ROUTE_BENCH_OUT ?? join(tmpdir(), 'auto-route-bench.jsonl');

describe.runIf(env.AUTO_ROUTE_BENCH)('Auto route speed on the benchmark set', () => {
  for (const entry of selectCorpusCases(env.AUTO_ROUTE_CASES)) {
    it(`${entry.name}: ${entry.description}`, async () => {
      const started = performance.now();
      const result = await runCorpusCase(entry);
      const totalMs = Math.round(performance.now() - started);
      const steps = Object.fromEntries((result.timings?.steps ?? []).map((step) => [step.step, Math.round(step.ms)]));
      appendFileSync(OUT, `${JSON.stringify({ case: entry.name, at: new Date().toISOString(), totalMs, steps })}\n`);
      if (entry.budgetMs !== undefined) expect(totalMs, `${entry.name} took ${totalMs} ms (budget ${entry.budgetMs} ms)`).toBeLessThanOrEqual(entry.budgetMs);
    }, 3_600_000);
  }
});
