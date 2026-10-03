import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyAutoDuctPreview, cancelAutoDuctPreview, discardAutoDuctPreview,
  generateAutoDuctPreview, resizeAutoDuctPreview,
} from '../components/canvas/hvac/duct/ductAutoController';
import type { AutoDuctRequest, AutoDuctResult } from '../components/canvas/hvac/duct/ductAutoLayout';
import { currentAutoDuctPreview, useDuctAutoPreviewStore } from '../components/canvas/hvac/duct/ductAutoPreviewStore';
import { DEFAULT_DUCT_SETTINGS } from '../components/canvas/hvac/duct/ductSettings';
import { runAutoDuctInWorker } from '../components/canvas/hvac/duct/optimizer/ductOptimizerClient';

import { useDrawingStore } from './index';

vi.mock('../components/canvas/hvac/duct/optimizer/ductOptimizerClient', () => ({
  runAutoDuctInWorker: vi.fn(), cancelAutoDuctWorker: vi.fn(),
}));

const request: AutoDuctRequest = {
  unitId: 'unit', terminalIds: [], fanSpeed: 'hi', layout: 'auto',
  services: { supply: true, return: false }, rebuildExisting: false,
};
const result: AutoDuctResult = {
  unitId: 'unit', unitLabel: 'Unit', fanSpeed: 'hi', airflowM3h: 1000, airflowSource: 'entered',
  maxEspPa: null, requiredEspPa: null, services: [], runs: [], removeIds: [], terminalUpdates: [],
  issues: [], designs: [], picks: null, selected: 0, pricePerPa: 1, currency: 'EUR', certificate: null,
  baseIssues: [], staticServices: [], sizing: null, terminalAirflowUpdates: [],
};
const drawing = () => useDrawingStore.getState();
const preview = () => useDuctAutoPreviewStore.getState();
function deferred() {
  let resolve!: (value: AutoDuctResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AutoDuctResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('duct preview lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDrawingStore.setState({ hvacElements: [], walls: [], ductSettings: { ...DEFAULT_DUCT_SETTINGS } });
    discardAutoDuctPreview();
  });
  afterEach(() => { discardAutoDuctPreview(); vi.useRealTimers(); });

  it.each(['settings', 'walls'] as const)('refuses a preview when %s change without an HVAC edit', async (change) => {
    vi.mocked(runAutoDuctInWorker).mockResolvedValue(result);
    await generateAutoDuctPreview(request);
    const originalScene = drawing().hvacElements;
    expect(currentAutoDuctPreview(originalScene, drawing().ductSettings, drawing().walls)).toBe(result);
    if (change === 'settings') drawing().setDuctSettings({ autoFrictionSupplyPaPerM: 0.4 });
    else useDrawingStore.setState({ walls: [...drawing().walls] });
    expect(drawing().hvacElements).toBe(originalScene);
    expect(currentAutoDuctPreview(originalScene, drawing().ductSettings, drawing().walls)).toBeNull();
    expect(applyAutoDuctPreview()).toContain('changed since the preview');
    expect(preview().result).toBeNull();
  });

  it('discards generation if its inputs change while it runs', async () => {
    const work = deferred();
    vi.mocked(runAutoDuctInWorker).mockReturnValue(work.promise);
    const task = generateAutoDuctPreview(request);
    drawing().setDuctSettings({ autoFrictionSupplyPaPerM: 0.4 });
    work.resolve(result);
    await task;
    expect(preview().result).toBeNull();
    expect(preview().message).toContain('changed during generation');
    expect(preview().running).toBeNull();
  });

  it('keeps a preview when only drawing annotations change', async () => {
    vi.mocked(runAutoDuctInWorker).mockResolvedValue(result);
    await generateAutoDuctPreview(request);
    drawing().setDuctSettings({ showSizeTags: !drawing().ductSettings.showSizeTags, showSupports: !drawing().ductSettings.showSupports });
    expect(currentAutoDuctPreview(drawing().hvacElements, drawing().ductSettings, drawing().walls)).toBe(result);
    expect(applyAutoDuctPreview()).toBe('The preview has no ducts to add.');
  });

  it('keeps a newer result when an older request completes late', async () => {
    const old = deferred();
    const latest = deferred();
    vi.mocked(runAutoDuctInWorker).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const oldTask = generateAutoDuctPreview(request);
    const latestTask = generateAutoDuctPreview({ ...request, fanSpeed: 'lo' });
    const latestResult = { ...result, fanSpeed: 'lo' as const };
    latest.resolve(latestResult);
    await latestTask;
    old.resolve(result);
    await oldTask;
    expect(preview().result).toBe(latestResult);
  });

  it('keeps a newer preview when an older request fails late', async () => {
    const old = deferred();
    vi.mocked(runAutoDuctInWorker).mockReturnValueOnce(old.promise).mockResolvedValueOnce(result);
    const oldTask = generateAutoDuctPreview(request);
    await generateAutoDuctPreview(request);
    old.reject(new Error('old failure'));
    await oldTask;
    expect(preview().result).toBe(result);
    expect(preview().message).toBeNull();
  });

  it.each([cancelAutoDuctPreview, discardAutoDuctPreview])('does not resurrect a cancelled preview', async (cancel) => {
    const work = deferred();
    vi.mocked(runAutoDuctInWorker).mockReturnValue(work.promise);
    const task = generateAutoDuctPreview(request);
    cancel();
    work.resolve(result);
    await task;
    expect(preview().result).toBeNull();
    expect(preview().running).toBeNull();
  });

  it('removes the previous preview while a replacement is generating', async () => {
    vi.mocked(runAutoDuctInWorker).mockResolvedValueOnce(result);
    await generateAutoDuctPreview(request);
    const work = deferred();
    vi.mocked(runAutoDuctInWorker).mockReturnValueOnce(work.promise);
    const task = generateAutoDuctPreview(request);
    expect(preview().result).toBeNull();
    expect(applyAutoDuctPreview()).toContain('finish updating');
    work.resolve(result);
    await task;
  });

  it('blocks Apply while debounced sizing is pending and clears pending work on discard', async () => {
    vi.mocked(runAutoDuctInWorker).mockResolvedValue(result);
    await generateAutoDuctPreview(request);
    vi.useFakeTimers();
    resizeAutoDuctPreview({});
    expect(preview().resizing).toBe(true);
    expect(applyAutoDuctPreview()).toContain('finish updating');
    discardAutoDuctPreview();
    vi.runAllTimers();
    expect(preview().resizing).toBe(false);
    expect(preview().result).toBeNull();
  });
});
