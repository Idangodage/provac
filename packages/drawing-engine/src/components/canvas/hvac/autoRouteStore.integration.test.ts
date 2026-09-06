import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';

import { autoRouteSourceSignature, prepareAutoRouteCommand } from './autoRouteCommand';
import { autoRouteElementSignature, planAutoRouteNetwork } from './autoRouteNetwork';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';

const baseline = useSmartDrawingStore.getState();
const units: HvacElement[] = [
  { id: 'auto-outdoor', type: 'outdoor-unit', label: 'Outdoor', position: { x: 6900, y: 2600 }, rotation: 180,
    width: 900, depth: 450, height: 1200, elevation: 1000, mountType: 'floor', supplyZoneRatio: 0, properties: {} },
  { id: 'auto-indoor', type: 'ceiling-cassette-ac', label: 'Cassette', position: { x: 500, y: 300 }, rotation: 0,
    width: 600, depth: 600, height: 250, elevation: 2200, mountType: 'ceiling', supplyZoneRatio: 0, properties: {} },
];

describe('Auto route through the actual drawing store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    useSmartDrawingStore.setState({ ...baseline, hvacElements: [], walls: [], rooms: [], elevationViews: [],
      pipeRoutingSettings: { ...DEFAULT_PIPE_ROUTING_SETTINGS } });
    useSmartDrawingStore.getState().commitHvacElementCommand('Place equipment', { add: structuredClone(units) });
    useSmartDrawingStore.getState().clearHistory();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useSmartDrawingStore.setState(baseline, true);
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  });

  it('commits the complete pair once and restores it exactly with undo and redo', async () => {
    const current = useSmartDrawingStore.getState();
    const source = { scene: current.hvacElements, settings: current.pipeRoutingSettings, walls: current.walls };
    const original = structuredClone(source.scene);
    const result = await planAutoRouteNetwork(source.scene, { settings: source.settings, objective: 'balanced' });
    expect(result.complete, result.issues.join(' ')).toBe(true);
    const prepared = prepareAutoRouteCommand(autoRouteSourceSignature(source), source, result);
    expect(prepared.command).toBeDefined();
    current.commitHvacElementCommand('Auto route refrigerant network', prepared.command!);
    const completed = structuredClone(useSmartDrawingStore.getState().hvacElements);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(1);
    expect(completed.filter(element => element.type === 'refrigerant-pipe')).toHaveLength(2);
    useSmartDrawingStore.getState().undo();
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(original);
    useSmartDrawingStore.getState().redo();
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(completed);
  });

  it('recognizes stored ownership and retains an equal-cost layout without another undo entry', async () => {
    const current = useSmartDrawingStore.getState();
    const result = await planAutoRouteNetwork(current.hvacElements, { settings: current.pipeRoutingSettings, objective: 'balanced' });
    expect(result.complete, result.issues.join(' ')).toBe(true);
    current.commitHvacElementCommand('Auto route refrigerant network', { add: result.elementsToAdd });
    const stored = useSmartDrawingStore.getState().hvacElements;
    const generated = stored.filter(element => element.type === 'refrigerant-pipe');
    for (const pipe of generated) {
      expect((pipe.properties.autoRouteNetwork as { signature: string }).signature)
        .toBe(autoRouteElementSignature(pipe));
    }
    const repeated = await planAutoRouteNetwork(stored, { settings: current.pipeRoutingSettings, objective: 'balanced' });
    expect(repeated.complete, repeated.issues.join(' ')).toBe(true);
    expect(repeated.removeElementIds).toEqual([]);
    expect(repeated.elementsToAdd).toEqual([]);
    expect(repeated.issues.some(issue => issue.includes('existing layout retained'))).toBe(true);
    const source = { scene: stored, settings: current.pipeRoutingSettings, walls: current.walls };
    expect(prepareAutoRouteCommand(autoRouteSourceSignature(source), source, repeated).command).toBeUndefined();
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(stored);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(1);
  });
});
