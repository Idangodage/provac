import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSmartDrawingStore } from '../../../store';

import { cancelAutoRoute, discardAutoRoutePreview, runAutoRoute } from './autoRouteController';
import type { AutoDuctShape } from './duct/ductAutoLayout';
import type { UnifiedAutoRouteRequest } from './unifiedAutoRouteProtocol';

class RecordingWorker {
  static request: UnifiedAutoRouteRequest | null = null;
  onmessage = null;
  onerror = null;
  postMessage(request: UnifiedAutoRouteRequest) { RecordingWorker.request = request; }
  terminate() {}
}

const baseline = useSmartDrawingStore.getState();
const services = { gas: false, liquid: false, condensate: false, supplyDuct: true, returnDuct: true };

describe('Auto route duct shape defaults', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', RecordingWorker);
    RecordingWorker.request = null;
    useSmartDrawingStore.setState({ hvacElements: [], walls: [], rooms: [] });
  });

  afterEach(() => {
    cancelAutoRoute();
    discardAutoRoutePreview();
    useSmartDrawingStore.setState(baseline, true);
    vi.unstubAllGlobals();
  });

  it('sends rectangular ducts to the routing worker when no shape was selected', () => {
    runAutoRoute({ services, scope: 'drawing' });
    expect(RecordingWorker.request?.options.duct?.shape).toBe('rectangular');
  });

  it.each<AutoDuctShape>(['rectangular', 'rect', 'round', 'optimal'])('keeps an explicit %s selection', (shape) => {
    runAutoRoute({ services, scope: 'drawing', duct: { shape, fanSpeed: 'lo', rebuildExisting: true } });
    expect(RecordingWorker.request?.options.duct).toMatchObject({ shape, fanSpeed: 'lo', rebuildExisting: true });
  });
});
