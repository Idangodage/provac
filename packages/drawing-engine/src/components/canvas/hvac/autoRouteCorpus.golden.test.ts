/**
 * The golden master of Auto route: every speed-up must give exactly the same
 * answers on the benchmark set (__fixtures__/autoRouteCorpus.ts) — every duct,
 * pipe, drain and fitting, every size, connection, cost, score, warning and
 * clash. The recorded fingerprints are in __fixtures__/auto-route-golden.json.
 *
 * The clock is frozen and Math.random fixed (see below and
 * autoRouteFingerprint.ts): the search never reads either, so a run is
 * reproducible; a frozen clock is also
 * how the duct optimiser runs on a fast enough computer (no budget reached).
 *
 * Minutes of routing, so only on request:
 *   AUTO_ROUTE_GOLDEN=verify npx vitest run src/components/canvas/hvac/autoRouteCorpus.golden.test.ts
 *   AUTO_ROUTE_GOLDEN=record … (after a deliberate change of answers; say why in the commit)
 * AUTO_ROUTE_CASES=name,name runs only those cases. The full normalised results
 * go to AUTO_ROUTE_GOLDEN_DIR (default: the temp folder), `<case>.json` when
 * recorded and `<case>.actual.json` when verified, to compare a difference.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./__fixtures__/nodeBuiltins.d.ts" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCorpusCase, selectCorpusCases, type AutoRouteCorpusCase } from './__fixtures__/autoRouteCorpus';
import { autoRouteFingerprint, fingerprintDifferences, FROZEN_NOW, type AutoRouteFingerprint } from './__fixtures__/autoRouteFingerprint';
import { inlineTaskRunner, withTaskRunner, type TaskRunner } from './parallel/taskRunner';
import { lastRoutingSessionReport } from './routingSession';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const MODE = env.AUTO_ROUTE_GOLDEN === 'record' ? 'record' : env.AUTO_ROUTE_GOLDEN === 'verify' ? 'verify' : null;
const GOLDEN_FILE = fileURLToPath(new URL('./__fixtures__/auto-route-golden.json', import.meta.url));
const OUT_DIR = env.AUTO_ROUTE_GOLDEN_DIR ?? join(tmpdir(), 'provacx-auto-route-golden');

/**
 * AUTO_ROUTE_RUNNER=pool-like: tasks are taken as for a pool of workers (with a
 * spare worker's speculative start), still run here, one by one and through the
 * worker boundary, so the answers can be compared.
 */
const POOL_LIKE: TaskRunner = {
  concurrency: 6,
  all: (tasks, onProgress) => inlineTaskRunner.all(tasks, onProgress),
  speculate: (task) => ({ want: () => inlineTaskRunner.all([task]).then(([output]) => output!), cancel: () => undefined }),
};
const RUNNER = env.AUTO_ROUTE_RUNNER === 'pool-like' ? POOL_LIKE : inlineTaskRunner;

/**
 * Math.random in these runs: fixed, except while a scene is drawn, when it is a
 * fixed sequence restarted for each case, so that the drawing's walls and rooms
 * get ids as distinct as they are in a real drawing.
 */
let drawing = false;
let drawn = 0;
const goldenRandom = () => {
  if (!drawing) return 0.5;
  // The fractions of the golden ratio: never the same twice, and far apart.
  drawn += 1;
  return (drawn * 0.6180339887498949) % 1;
};
const drawnDistinctly = (entry: AutoRouteCorpusCase): AutoRouteCorpusCase => ({
  ...entry,
  draw: () => {
    drawing = true;
    drawn = 0;
    try {
      entry.draw();
    } finally {
      drawing = false;
    }
  },
});

interface GoldenFile { note: string; cases: Record<string, AutoRouteFingerprint> }

const readGolden = (): GoldenFile => (existsSync(GOLDEN_FILE)
  ? JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenFile
  : { note: 'Fingerprints of Auto route on the benchmark set (autoRouteCorpus.golden.test.ts). Re-record only for a deliberate change of answers.', cases: {} });

describe.runIf(MODE)('Auto route golden master', () => {
  const golden = readGolden();
  beforeAll(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
    vi.spyOn(Math, 'random').mockImplementation(goldenRandom);
    mkdirSync(OUT_DIR, { recursive: true });
  });
  afterAll(() => {
    vi.restoreAllMocks();
    if (MODE === 'record') writeFileSync(GOLDEN_FILE, `${JSON.stringify(golden, null, 1)}\n`);
  });

  for (const entry of selectCorpusCases(env.AUTO_ROUTE_CASES)) {
    it(`${entry.name}: ${entry.description}`, async () => {
      const { fingerprint, canonical } = autoRouteFingerprint(await withTaskRunner(RUNNER, () => runCorpusCase(drawnDistinctly(entry))));
      // What the run's session reused (and whether every reuse was checked against a fresh value).
      writeFileSync(join(OUT_DIR, `${entry.name}.session.json`), JSON.stringify(lastRoutingSessionReport(), null, 1));
      if (MODE === 'record') {
        writeFileSync(join(OUT_DIR, `${entry.name}.json`), JSON.stringify(canonical, null, 1));
        golden.cases[entry.name] = fingerprint;
        return;
      }
      writeFileSync(join(OUT_DIR, `${entry.name}.actual.json`), JSON.stringify(canonical, null, 1));
      const expected = golden.cases[entry.name];
      expect(expected, `${entry.name} has no recorded fingerprint: run with AUTO_ROUTE_GOLDEN=record`).toBeDefined();
      expect(fingerprintDifferences(expected!, fingerprint), `${entry.name} differs from the golden master (full results in ${OUT_DIR})`).toEqual([]);
      expect(fingerprint.digest).toBe(expected!.digest);
    }, 3_600_000);
  }
});
