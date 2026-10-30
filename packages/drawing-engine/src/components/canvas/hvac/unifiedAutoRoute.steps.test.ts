import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { drawSyntheticBuilding } from './__fixtures__/autoRouteCorpus';
import { cancelAutoRoute, runAutoRoute } from './autoRouteController';
import { inlineTaskRunner, withTaskRunner, type TaskRunner } from './parallel/taskRunner';
import { planUnifiedAutoRoute, type AutoRouteStepMemo, type UnifiedAutoRouteResult } from './unifiedAutoRoute';
import type { UnifiedAutoRouteRequest } from './unifiedAutoRouteProtocol';

/** The request the app sends its worker for what is drawn. */
function requestForTheDrawing(): UnifiedAutoRouteRequest {
  let sent: UnifiedAutoRouteRequest | null = null;
  vi.stubGlobal('Worker', class {
    onmessage = null;
    onerror = null;
    postMessage(request: UnifiedAutoRouteRequest): void { sent = request; }
    terminate(): void { /* nothing runs */ }
  });
  runAutoRoute({ services: { gas: true, liquid: true, condensate: true, supplyDuct: true, returnDuct: true }, scope: 'drawing', profile: undefined,
    duct: { shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false } });
  cancelAutoRoute();
  vi.unstubAllGlobals();
  return sent!;
}

/** Counts the searches handed to it, and runs them here. */
function countingRunner() {
  const kinds: string[] = [];
  const runner: TaskRunner = {
    concurrency: 1,
    all: (tasks, onProgress) => {
      kinds.push(...tasks.map((task) => task.kind));
      return inlineTaskRunner.all(tasks, onProgress);
    },
  };
  return { runner, kinds };
}

const withoutTimings = ({ timings: _timings, ...result }: UnifiedAutoRouteResult) => result;

describe('Auto route steps', () => {
  let request: UnifiedAutoRouteRequest;
  let first: UnifiedAutoRouteResult;
  let memo: AutoRouteStepMemo | undefined;
  const partials: UnifiedAutoRouteResult[] = [];

  beforeAll(async () => {
    drawSyntheticBuilding({ ducted: 1, terminals: 2, cassettes: 1 });
    request = requestForTheDrawing();
    first = await planUnifiedAutoRoute(request.scene, { ...request.options, onPartial: (partial) => partials.push(partial), onMemo: (steps) => { memo = steps; } });
  }, 180_000);
  afterEach(() => vi.unstubAllGlobals());

  it('shows each service as it finishes: what is shown is what the answer holds', () => {
    expect(first.ducts?.elementsToAdd.length).toBeGreaterThan(0);
    expect(first.refrigerant?.elementsToAdd.length).toBeGreaterThan(0);
    expect(first.condensate?.elementsToAdd.length).toBeGreaterThan(0);
    const [afterDucts, afterRefrigerant] = partials;
    expect(afterDucts!.ducts).toEqual(first.ducts);
    expect(afterDucts!.refrigerant).toBeNull();
    expect(afterDucts!.condensate).toBeNull();
    expect(afterRefrigerant!.ducts).toEqual(first.ducts);
    expect(afterRefrigerant!.refrigerant).not.toBeNull();
    expect(afterRefrigerant!.condensate).toBeNull();
  });

  it('with nothing changed, gives the same answer without searching again', async () => {
    const { runner, kinds } = countingRunner();
    const again = await withTaskRunner(runner, () => planUnifiedAutoRoute(request.scene, { ...request.options, previous: memo, onMemo: () => undefined }));
    expect(kinds).toEqual([]);
    expect(withoutTimings(again)).toEqual(withoutTimings(first));
  }, 60_000);

  it('works out again only what a change reaches', async () => {
    const settings = request.options.condensate.settings;
    const options = { ...request.options, condensate: { ...request.options.condensate, settings: { ...settings, insulationThicknessMm: settings.insulationThicknessMm + 3 } } };
    const { runner, kinds } = countingRunner();
    let steps: AutoRouteStepMemo | undefined;
    const again = await withTaskRunner(runner, () => planUnifiedAutoRoute(request.scene, { ...options, previous: memo, onMemo: (remembered) => { steps = remembered; } }));
    // The ducts and pipes are as they were: no search ran for them; the drains are worked out with the new setting.
    expect(kinds).toEqual([]);
    expect(again.ducts).toEqual(first.ducts);
    expect(again.refrigerant).toEqual(first.refrigerant);
    expect(steps!.ducts!.key).toBe(memo!.ducts!.key);
    expect(steps!.refrigerant!.key).toBe(memo!.refrigerant!.key);
    expect(steps!.condensate!.key).not.toBe(memo!.condensate!.key);
  }, 60_000);

  it('a moved unit is a new drawing: everything is worked out again', async () => {
    const scene = request.scene.map((element) => (element.type === 'ceiling-cassette-ac' ? { ...element, position: { x: element.position.x + 200, y: element.position.y } } : element));
    const { runner, kinds } = countingRunner();
    let steps: AutoRouteStepMemo | undefined;
    await withTaskRunner(runner, () => planUnifiedAutoRoute(scene, { ...request.options, previous: memo, onMemo: (remembered) => { steps = remembered; } }));
    expect(kinds).toContain('grow-network');
    expect(steps!.refrigerant!.key).not.toBe(memo!.refrigerant!.key);
    expect(steps!.condensate!.key).not.toBe(memo!.condensate!.key);
  }, 120_000);

  it('without anyone listening it remembers nothing', async () => {
    const onMemo = vi.fn();
    const { runner, kinds } = countingRunner();
    const plain = await withTaskRunner(runner, () => planUnifiedAutoRoute(request.scene, { ...request.options, previous: memo }));
    expect(onMemo).not.toHaveBeenCalled();
    // (No listener: \`previous\` is not read, the searches run as ever.)
    expect(kinds.length).toBeGreaterThan(0);
    expect(plain.refrigerant?.connectedIndoorIds).toEqual(first.refrigerant?.connectedIndoorIds);
  }, 120_000);
});
