import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';

import { autoRouteSourceSignature } from './autoRouteCommand';
import { applyAutoRoutePreview, discardAutoRoutePreview } from './autoRouteController';
import { condensateSourceSignature } from './condensate/condensateCommand';
import { generateCondensateNetwork } from './condensate/condensateGenerator';
import { useCondensatePreviewStore } from './condensate/condensatePreviewStore';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { buildRefrigerantHopUpdates } from './condensate/refrigerantHopProposal';
import { ductSourceSignature } from './duct/ductAutoRoute';
import { getActiveDuctSettings, setActiveDuctSettings } from './duct/ductSettings';
import { buildStraightGiDuctElement } from './giDuctModel';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

const baseline = useSmartDrawingStore.getState();
const originalDuctSettings = getActiveDuctSettings();
const settings = resolveCondensateSettings({});

function unit(id: string, ducted = false): HvacElement {
  return { id, type: ducted ? 'ducted-ac' : 'ceiling-cassette-ac', position: { x: 0, y: 0 }, rotation: 0,
    width: ducted ? 1084 : 950, depth: ducted ? 697 : 950, height: ducted ? 300 : 272,
    elevation: 2400, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5, properties: { capacityKw: 4 } };
}

function gully(): HvacElement {
  return { ...unit('gully'), type: 'condensate-gully', position: { x: 7900, y: 300 },
    width: 200, depth: 200, height: 60, elevation: 0, mountType: 'floor',
    properties: { terminationKind: 'floor-gully' } };
}

function duct(id: string, x: number, y: number, z: number, length = 2500, width = 400, height = 200): HvacElement {
  return { id, rotation: 0, supplyZoneRatio: 0,
    ...buildStraightGiDuctElement([{ x, y }, { x: x + length, y }], {
      ductKind: 'supply', outerWidthMm: width, outerHeightMm: height, elevationMm: z,
    }) } as HvacElement;
}

function initialize(scene: HvacElement[]): void {
  useSmartDrawingStore.setState({ ...baseline, hvacElements: [], walls: [], rooms: [], elevationViews: [],
    pipeRoutingSettings: { ...DEFAULT_PIPE_ROUTING_SETTINGS }, condensateSettings: settings });
  useSmartDrawingStore.getState().commitHvacElementCommand('Place equipment', { add: structuredClone(scene) });
  useSmartDrawingStore.getState().clearHistory();
}

function preview(ducts: HvacElement[], withDrains: boolean): UnifiedAutoRouteResult {
  const state = useSmartDrawingStore.getState();
  const result: UnifiedAutoRouteResult = {
    services: { gas: false, liquid: false, condensate: withDrains, supplyDuct: ducts.length > 0 },
    ducts: ducts.length ? { elementsToAdd: ducts, removeElementIds: [], terminalUpdates: [], units: [], issues: [] } : null,
    refrigerant: null,
    condensate: withDrains ? generateCondensateNetwork(state.hvacElements, { settings, routingSettings: state.pipeRoutingSettings }) : null,
    clashes: [], issues: [],
  };
  useCondensatePreviewStore.getState().setUnified(result, {
    refrigerant: null,
    ducts: ducts.length ? ductSourceSignature(state.hvacElements, state.ductSettings, state.walls) : null,
    condensate: withDrains ? condensateSourceSignature({ scene: state.hvacElements, settings,
      routingSettings: state.pipeRoutingSettings, walls: state.walls, rooms: state.rooms }) : null,
  });
  return result;
}

function hopScene(): HvacElement[] {
  const pipe: HvacElement = { ...unit('refrigerant'), type: 'refrigerant-pipe', position: { x: 4000, y: -3000 },
    width: 10, depth: 7000, height: 40, elevation: 2455,
    properties: { routePoints: [{ x: 4000, y: -3000 }, { x: 4000, y: 4000 }],
      routeNodes3d: [{ x: 4000, y: -3000, z: 2475 }, { x: 4000, y: 4000, z: 2475 }],
      pipeDiameterMm: 9.52, insulationThicknessMm: 25.4, lineKind: 'liquid', fieldBendConstruction: 'formed-tube' },
  };
  return [unit('source', true), gully(), pipe];
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  setActiveDuctSettings(baseline.ductSettings);
  discardAutoRoutePreview();
});

afterEach(() => {
  discardAutoRoutePreview();
  vi.clearAllTimers();
  vi.useRealTimers();
  useSmartDrawingStore.setState(baseline, true);
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  setActiveDuctSettings(originalDuctSettings);
});

describe('atomic coordinated Auto route Apply', () => {
  it('does not apply valid drains while an explicitly selected terminal has no ducted unit', () => {
    initialize([unit('source'), gully()]);
    const current = preview([], true);
    const previewStore = useCondensatePreviewStore.getState();
    previewStore.setUnified({ ...current, services: { ...current.services, supplyDuct: true }, ducts: {
      elementsToAdd: [], removeElementIds: [], terminalUpdates: [], units: [], issues: [],
      unservedTerminalIds: ['orphan-terminal'],
    } }, previewStore.signatures);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    expect(applyAutoRoutePreview()).toMatch(/selected air terminal has no duct route/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('rejects an obsolete duct preview after wall geometry changes', () => {
    initialize([unit('source')]);
    preview([duct('valid-duct', 14000, 0, 2700)], false);
    useSmartDrawingStore.getState().addWall({ startPoint: { x: 15000, y: -1000 },
      endPoint: { x: 15000, y: 1000 }, thickness: 150, properties3D: { height: 3000 } });
    useSmartDrawingStore.getState().clearHistory();
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    expect(applyAutoRoutePreview()).toMatch(/changed/i);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('does not apply a valid duct while a requested new drain has failed without adding or removing anything', () => {
    initialize([unit('source'), gully()]);
    const current = preview([duct('valid-duct', 14000, 0, 2700)], true);
    const previewStore = useCondensatePreviewStore.getState();
    previewStore.setUnified({ ...current, condensate: { ...current.condensate!, elementsToAdd: [], removeElementIds: [],
      networks: [], perUnit: current.condensate!.perUnit.map(entry => ({ ...entry, status: 'infeasible' as const })),
      metrics: { ...current.condensate!.metrics, unitsConnected: 0, pipeLengthMm: 0, networks: 0 },
    } }, previewStore.signatures);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    expect(applyAutoRoutePreview()).toMatch(/no drain route/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('does not apply an additive partial refrigerant network as a complete coordinated operation', () => {
    initialize([unit('source'), unit('missing')]);
    const state = useSmartDrawingStore.getState();
    const current = preview([duct('valid-duct', 14000, 0, 2700)], false);
    const previewStore = useCondensatePreviewStore.getState();
    previewStore.setUnified({ ...current, services: { ...current.services, gas: true, liquid: true }, refrigerant: {
      elementsToAdd: [hopScene()[2]!], removeElementIds: [], updates: [], complete: false,
      connectedIndoorIds: ['source'], unconnectedIndoorIds: ['missing'], issues: [], metrics: null, evaluations: [], evaluatedCandidates: 1,
    } }, { ...previewStore.signatures!, refrigerant: autoRouteSourceSignature({ scene: state.hvacElements,
      settings: state.pipeRoutingSettings, walls: state.walls }) });
    const before = structuredClone(state.hvacElements);
    expect(applyAutoRoutePreview()).toMatch(/no refrigerant route/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('does not apply valid drains when a requested duct layout failed, even in an old preview without blockers', () => {
    initialize([unit('source'), gully()]);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    const current = preview([], true);
    expect(current.condensate!.metrics.unitsConnected).toBe(1);
    const previewStore = useCondensatePreviewStore.getState();
    previewStore.setUnified({ ...current, services: { ...current.services, supplyDuct: true }, ducts: {
      elementsToAdd: [], removeElementIds: [], terminalUpdates: [], issues: ['No buildable duct layout'],
      units: [{ unitId: 'source', unitLabel: 'FDUM22', status: 'kept', services: [], requiredEspPa: null,
        maxEspPa: null, firstCost: null, lifeCycleCost: null, currency: 'USD', runIds: [], exact: null,
        notes: ['No buildable duct layout'] }],
    } }, previewStore.signatures);
    expect(applyAutoRoutePreview()).toMatch(/No viable duct layout for 1 unit/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('applies clear ducts and drainage in one undo step and restores both together', () => {
    initialize([unit('source'), gully()]);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    const result = preview([duct('new-duct', 14000, 0, 2700)], true);
    expect(result.condensate!.metrics.unitsConnected).toBe(1);
    const message = applyAutoRoutePreview();
    expect(message).toMatch(/^Auto route applied/);
    const after = structuredClone(useSmartDrawingStore.getState().hvacElements);
    expect(after.some((element) => element.id === 'new-duct')).toBe(true);
    expect(after.filter((element) => element.type === 'condensate-pipe').length).toBeGreaterThan(0);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(1);
    useSmartDrawingStore.getState().undo();
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    useSmartDrawingStore.getState().redo();
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(after);
  });

  it('refuses a newly intersecting duct and leaves elements and undo history unchanged', () => {
    const obstacle: HvacElement = { ...unit('solid'), type: 'accessory', position: { x: 1500, y: -250 },
      width: 500, depth: 500, height: 300, elevation: 2700 };
    initialize([obstacle]);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    const history = useSmartDrawingStore.getState().historyIndex;
    preview([duct('new-duct', 0, 0, 2750)], false);
    expect(applyAutoRoutePreview()).toMatch(/Nothing was applied/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(history);
  });

  it('makes no edits until every required refrigerant hop is approved', () => {
    initialize(hopScene());
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    const result = preview([], true);
    expect(result.condensate!.hopProposals.length).toBeGreaterThan(0);
    expect(applyAutoRoutePreview()).toMatch(/approve.*hops/i);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('preserves an existing drain network when its replacement could not be connected', () => {
    const equipment = [unit('source'), gully()];
    const existing = generateCondensateNetwork(equipment, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    expect(existing.metrics.unitsConnected).toBe(1);
    initialize([...equipment, ...existing.elementsToAdd]);
    const current = preview([], true);
    const failed = {
      ...current.condensate!, elementsToAdd: [], networks: [],
      removeElementIds: existing.elementsToAdd.map((element) => element.id),
      perUnit: existing.perUnit.map((entry) => ({ ...entry, status: 'infeasible' as const, reason: 'no available fall' })),
      metrics: { ...existing.metrics, unitsConnected: 0, networks: 0, pipeLengthMm: 0 },
    };
    const previewStore = useCondensatePreviewStore.getState();
    previewStore.setUnified({ ...current, condensate: failed }, previewStore.signatures);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    const message = applyAutoRoutePreview();
    expect(message).not.toMatch(/^Auto route applied/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });

  it('applies an approved refrigerant hop together with its drains as one undoable command', () => {
    initialize(hopScene());
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    const result = preview([], true);
    expect(result.condensate!.hopProposals.length).toBeGreaterThan(0);
    for (const proposal of result.condensate!.hopProposals) useCondensatePreviewStore.getState().toggleHop(proposal.key);
    expect(applyAutoRoutePreview()).toMatch(/^Auto route applied/);
    const final = useSmartDrawingStore.getState().hvacElements;
    expect(final.find((element) => element.id === 'refrigerant')!.properties.routeNodes3d)
      .not.toEqual(before.find((element) => element.id === 'refrigerant')!.properties.routeNodes3d);
    expect(final.some((element) => element.type === 'condensate-pipe')).toBe(true);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(1);
    useSmartDrawingStore.getState().undo();
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
  });

  it('checks an approved hop against ducts added in the same Apply', () => {
    initialize(hopScene());
    const result = preview([], true);
    const proposed = result.condensate!;
    const hops = buildRefrigerantHopUpdates(useSmartDrawingStore.getState().hvacElements,
      proposed.hopProposals, settings, DEFAULT_PIPE_ROUTING_SETTINGS);
    expect(hops.rejected).toEqual([]);
    const nodes = hops.updates[0]!.updates.properties!.routeNodes3d as Array<{ x: number; y: number; z: number }>;
    const top = Math.max(...nodes.map((node) => node.z));
    const crossing = proposed.hopProposals[0]!;
    const newDuct = duct('new-duct', crossing.point.x - 1000, crossing.point.y, top - 40, 2000, 100, 80);
    const coordinated = preview([newDuct], true);
    for (const proposal of coordinated.condensate!.hopProposals) useCondensatePreviewStore.getState().toggleHop(proposal.key);
    const before = structuredClone(useSmartDrawingStore.getState().hvacElements);
    expect(applyAutoRoutePreview()).toMatch(/Nothing was applied/);
    expect(useSmartDrawingStore.getState().hvacElements).toEqual(before);
    expect(useSmartDrawingStore.getState().historyIndex).toBe(0);
  });
});
