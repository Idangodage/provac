import { afterEach, describe, expect, it, vi } from 'vitest';

import { drawSyntheticBuilding } from '../__fixtures__/autoRouteCorpus';
import { cancelAutoRoute, runAutoRoute } from '../autoRouteController';
import type { UnifiedAutoRouteRequest } from '../unifiedAutoRouteProtocol';

import { planAutoRouteDucts, type AutoRouteDuctResult } from './ductAutoRoute';
import { DEFAULT_DUCT_SETTINGS, resolveDuctSettings, savedDuctSettings } from './ductSettings';

/**
 * A design must not depend on how fast the computer is: on a laptop on battery
 * the search took over twice as long, reached the 20 s that used to limit it,
 * and gave another design (and other pipes and drains around it).
 */
const NOW = 1_790_000_000_000;
/** What ids made from the clock have in common while it runs on. */
const CLOCK_PREFIX = NOW.toString(36).slice(0, 4);

/** The request the app sends for what is drawn. */
function requestForTheDrawing(): UnifiedAutoRouteRequest {
  let sent: UnifiedAutoRouteRequest | null = null;
  vi.stubGlobal('Worker', class {
    onmessage = null;
    onerror = null;
    postMessage(request: UnifiedAutoRouteRequest): void { sent = request; }
    terminate(): void { /* nothing runs */ }
  });
  runAutoRoute({ services: { gas: false, liquid: false, condensate: false, supplyDuct: true, returnDuct: true }, scope: 'drawing', profile: undefined,
    duct: { shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false } });
  cancelAutoRoute();
  vi.unstubAllGlobals();
  return sent!;
}

/** The ducts Auto route designs when each reading of the clock is `stepMs` after the last (0: an endlessly fast computer). */
function designed(request: UnifiedAutoRouteRequest, stepMs: number, timeBudgetMs?: number): AutoRouteDuctResult {
  let time = NOW;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
    time += stepMs;
    return time;
  });
  try {
    const settings = resolveDuctSettings({ ...request.options.duct!.settings, ...(timeBudgetMs ? { autoTimeBudgetMs: timeBudgetMs } : {}) });
    return planAutoRouteDucts(request.scene, { supply: true, return: true }, { ...request.options.duct!, settings });
  } finally {
    clock.mockRestore();
  }
}

/** As text, with the ids made from the clock renamed by first appearance. */
function comparable(result: AutoRouteDuctResult): string {
  const names = new Map<string, string>();
  return JSON.stringify(result).replace(/[A-Za-z0-9_.:-]+/g, (token) => {
    if (!token.includes(CLOCK_PREFIX)) return token;
    if (!names.has(token)) names.set(token, `#${names.size + 1}`);
    return names.get(token)!;
  });
}

describe('the same design on any computer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a computer so slow that each reading of the clock is half a second later gets the same design', () => {
    drawSyntheticBuilding({ ducted: 1, terminals: 3, cassettes: 0 });
    const request = requestForTheDrawing();
    const fast = designed(request, 0);
    expect(fast.elementsToAdd.length).toBeGreaterThan(0);
    expect(comparable(designed(request, 500))).toBe(comparable(fast));
    // The test can tell: at the 20 s that used to be the default, that computer's search is cut short, and it says so.
    expect(designed(request, 500, 20_000).units.some((unit) => unit.exact === false)).toBe(true);
    // An endlessly fast computer never reaches a limit, and its design says it is exact.
    expect(fast.units.every((unit) => unit.exact !== false)).toBe(true);
  }, 240_000);
});

describe('the time per unit', () => {
  it('is a safety net by default, far above what a design takes', () => {
    expect(DEFAULT_DUCT_SETTINGS.autoTimeBudgetMs).toBeGreaterThanOrEqual(300_000);
    expect(resolveDuctSettings({}).autoTimeBudgetMs).toBe(DEFAULT_DUCT_SETTINGS.autoTimeBudgetMs);
  });

  it('a drawing saved with the former default takes today\'s; one that chose another keeps it', () => {
    expect(savedDuctSettings({ autoTimeBudgetMs: 20_000 }).autoTimeBudgetMs).toBe(DEFAULT_DUCT_SETTINGS.autoTimeBudgetMs);
    expect(savedDuctSettings({}).autoTimeBudgetMs).toBe(DEFAULT_DUCT_SETTINGS.autoTimeBudgetMs);
    expect(savedDuctSettings({ autoTimeBudgetMs: 45_000 }).autoTimeBudgetMs).toBe(45_000);
    expect(savedDuctSettings({ autoTimeBudgetMs: 20_000, soffitMm: 3100 }).soffitMm).toBe(3100);
  });

  it('can still be set low in the panel, even to the former default, and can go up to ten minutes', () => {
    expect(resolveDuctSettings({ autoTimeBudgetMs: 20_000 }).autoTimeBudgetMs).toBe(20_000);
    expect(resolveDuctSettings({ autoTimeBudgetMs: 5 }).autoTimeBudgetMs).toBe(1000);
    expect(resolveDuctSettings({ autoTimeBudgetMs: 9_999_999 }).autoTimeBudgetMs).toBe(600_000);
  });
});
