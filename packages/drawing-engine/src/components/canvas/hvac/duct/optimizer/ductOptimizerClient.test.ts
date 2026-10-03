import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateAutoDuct, type AutoDuctRequest, type AutoDuctResult } from '../ductAutoLayout';
import { DEFAULT_DUCT_SETTINGS } from '../ductSettings';

import { cancelAutoDuctWorker, runAutoDuctInWorker, type AutoDuctWorkerResponse } from './ductOptimizerClient';

vi.mock('../ductAutoLayout', () => ({ generateAutoDuct: vi.fn() }));

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: AutoDuctWorkerResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_message: unknown) => {});
  constructor() { FakeWorker.instances.push(this); }
}
const request: AutoDuctRequest = {
  unitId: 'unit', terminalIds: [], fanSpeed: 'hi', layout: 'auto',
  services: { supply: true, return: false }, rebuildExisting: false,
};
const result = { unitId: 'unit' } as AutoDuctResult;

describe('duct worker cancellation and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.mocked(generateAutoDuct).mockReturnValue(result);
  });
  afterEach(() => { cancelAutoDuctWorker(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('cancels the compatibility fallback before calculation starts', async () => {
    vi.stubGlobal('Worker', undefined);
    const work = runAutoDuctInWorker([], request, DEFAULT_DUCT_SETTINGS);
    const rejected = expect(work).rejects.toThrow('cancelled');
    cancelAutoDuctWorker();
    vi.runAllTimers();
    await rejected;
    expect(generateAutoDuct).not.toHaveBeenCalled();
  });

  it('ignores a terminated worker error instead of starting obsolete fallback work', async () => {
    const first = runAutoDuctInWorker([], request, DEFAULT_DUCT_SETTINGS);
    const rejected = expect(first).rejects.toThrow('cancelled');
    const obsolete = FakeWorker.instances[0]!;
    const oldError = obsolete.onerror!;
    const second = runAutoDuctInWorker([], request, DEFAULT_DUCT_SETTINGS);
    const current = FakeWorker.instances[1]!;
    oldError();
    vi.runAllTimers();
    expect(generateAutoDuct).not.toHaveBeenCalled();
    const sent = current.postMessage.mock.calls[0]![0] as { id: number };
    current.onmessage!({ data: { type: 'result', id: sent.id, result } });
    await rejected;
    await expect(second).resolves.toBe(result);
    expect(obsolete.terminate).toHaveBeenCalledOnce();
  });

  it('recovers from a module load failure and releases the worker', async () => {
    const work = runAutoDuctInWorker([], request, DEFAULT_DUCT_SETTINGS);
    const current = FakeWorker.instances[0]!;
    current.onerror!();
    expect(current.terminate).toHaveBeenCalledOnce();
    expect(generateAutoDuct).not.toHaveBeenCalled();
    vi.runAllTimers();
    await expect(work).resolves.toBe(result);
    expect(generateAutoDuct).toHaveBeenCalledOnce();
  });

  it('reports unreadable worker responses and releases the worker', async () => {
    const work = runAutoDuctInWorker([], request, DEFAULT_DUCT_SETTINGS);
    const rejected = expect(work).rejects.toThrow('could not be read');
    const current = FakeWorker.instances[0]!;
    current.onmessageerror!();
    await rejected;
    expect(current.terminate).toHaveBeenCalledOnce();
  });

  it('cleans up a worker when sending the scene fails', async () => {
    class UnsendableWorker extends FakeWorker {
      override postMessage = vi.fn(() => { throw new Error('DataCloneError'); });
    }
    vi.stubGlobal('Worker', UnsendableWorker);
    await expect(runAutoDuctInWorker([], request, DEFAULT_DUCT_SETTINGS)).rejects.toThrow('DataCloneError');
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
