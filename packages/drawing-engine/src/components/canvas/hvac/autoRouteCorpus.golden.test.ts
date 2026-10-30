/**
 * The golden master of Auto route: every speed-up must give exactly the same
 * answers on the benchmark set (__fixtures__/autoRouteCorpus.ts) — every duct,
 * pipe, drain and fitting, every size, connection, cost, score, warning and
 * clash. The recorded fingerprints are in __fixtures__/auto-route-golden.json.
 *
 * The clock is frozen and Math.random fixed (see autoRouteFingerprint.ts): the
 * search never reads either, so a run is reproducible; a frozen clock is also
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

import { runCorpusCase, selectCorpusCases } from './__fixtures__/autoRouteCorpus';
import { autoRouteFingerprint, fingerprintDifferences, FROZEN_NOW, type AutoRouteFingerprint } from './__fixtures__/autoRouteFingerprint';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const MODE = env.AUTO_ROUTE_GOLDEN === 'record' ? 'record' : env.AUTO_ROUTE_GOLDEN === 'verify' ? 'verify' : null;
const GOLDEN_FILE = fileURLToPath(new URL('./__fixtures__/auto-route-golden.json', import.meta.url));
const OUT_DIR = env.AUTO_ROUTE_GOLDEN_DIR ?? join(tmpdir(), 'provacx-auto-route-golden');

interface GoldenFile { note: string; cases: Record<string, AutoRouteFingerprint> }

const readGolden = (): GoldenFile => (existsSync(GOLDEN_FILE)
  ? JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenFile
  : { note: 'Fingerprints of Auto route on the benchmark set (autoRouteCorpus.golden.test.ts). Re-record only for a deliberate change of answers.', cases: {} });

describe.runIf(MODE)('Auto route golden master', () => {
  const golden = readGolden();
  beforeAll(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    mkdirSync(OUT_DIR, { recursive: true });
  });
  afterAll(() => {
    vi.restoreAllMocks();
    if (MODE === 'record') writeFileSync(GOLDEN_FILE, `${JSON.stringify(golden, null, 1)}\n`);
  });

  for (const entry of selectCorpusCases(env.AUTO_ROUTE_CASES)) {
    it(`${entry.name}: ${entry.description}`, async () => {
      const { fingerprint, canonical } = autoRouteFingerprint(await runCorpusCase(entry));
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
