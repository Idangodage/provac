import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise command transitions without mounting the canvas. Refs persist for
// the returned handlers; presentation effects intentionally remain outside this test.
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: () => {},
}));

import type { HvacElement } from '../../../types';
import * as branchKit from '../hvac/branchKitProposal';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import * as pipeModel from '../hvac/refrigerantPipePairModel';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets, type RefrigerantPipeBundleConnection } from '../hvac/refrigerantPipePairModel';

import { useRefrigerantPipeTool, type UseRefrigerantPipeToolOptions } from './useRefrigerantPipeTool';

const port: RefrigerantPipeBundleConnection = {
  point: { x: 1200, y: -1000 },
  gasPoint: { x: 1200, y: -1020 }, liquidPoint: { x: 1200, y: -980 },
  gasFieldPoint: { x: 1200, y: -1020 }, liquidFieldPoint: { x: 1200, y: -980 },
  gasDirection: { x: 1, y: 0 }, liquidDirection: { x: 1, y: 0 }, direction: { x: 1, y: 0 },
  elevationMm: 2600, gasElevationMm: 2600, liquidElevationMm: 2600,
  sourceElementId: 'unit', connectionKind: 'unit-port', guideReference: 'gas',
};

function setup(scene: HvacElement[] = [], planRouting = true, overrides: Partial<UseRefrigerantPipeToolOptions> = {}) {
  const options: UseRefrigerantPipeToolOptions = {
    fabricRef: { current: null }, hvacRendererRef: { current: null }, activeTool: 'refrigerant-pipe',
    pipeMaterialMode: 'hard', pipeAngleMode: 'ortho', pipeLineMode: 'pair', planRouting,
    hvacElements: scene, zoom: 1, snapToGrid: false, gridSize: 20,
    addHvacElements: vi.fn(() => ['created']), commitHvacElementCommand: vi.fn(() => ['kit']),
    updateHvacElement: vi.fn(), saveToHistory: vi.fn(),
    setSelectedIds: vi.fn(), setProcessingStatus: vi.fn(),
    onDraftPipesChange: vi.fn(), onDraftRouteChange: vi.fn(), overlayOwnsPipePreview: true,
    onDraftAnchorChange: vi.fn(),
    ...overrides,
  };
  return { tool: useRefrigerantPipeTool(options), options };
}

function connectedMain() {
  const host = buildRefrigerantPipeElements([{ x: 0, y: 0 }, { x: 4000, y: 0 }], { bundleId: 'host' })
    .map((element, index) => ({ ...element, id: `host-${index}`, rotation: 0 } as HvacElement));
  const end = getRefrigerantPipeBundleSnapTargets(host).find((target) => target.point.x > 3999)!;
  const tail = buildRefrigerantPipeElements([end.point, { x: 8000, y: end.point.y }], {
    bundleId: 'tail', startBundleConnection: end,
  }).map((element, index) => ({ ...element, id: `tail-${index}`, rotation: 0 } as HvacElement));
  return [...host, ...tail];
}

describe('refrigerant drawing workflow', () => {
  it('adds a deliberate riser then a true horizontal length and undoes each step exactly', () => {
    const { tool, options } = setup([], false, { pipeLineMode: 'gas', pipeMaterialMode: 'hard', pipeAngleMode: 'ortho' });
    const start = { x: 100, y: 200, z: 1800 }; const corner = { x: 2100, y: 200, z: 1800 };
    tool.handleMouseDown(start); tool.handleMouseDown(corner);
    const original = [start, corner];
    expect(tool.setDrawingElevation(2600)).toBe(true);
    const riser = { x: 2100, y: 200, z: 2600 };
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith(riser);
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual([...original, riser]);
    tool.handleMouseMove({ x: 3100, y: 200, z: 2600 });
    expect(tool.appendSegmentLength(1500)).toBe(true);
    const next = { x: 3600, y: 200, z: 2600 };
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith(next);
    expect(Math.hypot(next.x - riser.x, next.y - riser.y, next.z - riser.z)).toBe(1500);
    tool.undoDrawingStep();
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual([...original, riser]);
    tool.undoDrawingStep();
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual(original);
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith(corner);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
    expect(tool.setDrawingElevation(2600)).toBe(true);
    tool.handleMouseMove(next); tool.handleDoubleClick();
    const built = vi.mocked(options.addHvacElements).mock.calls[0]![0];
    expect(built).toHaveLength(1);
    expect(built[0]!.properties!.lineKind).toBe('gas');
    expect((built[0]!.properties!.segmentMaterials as string[]).every(material => material === 'hard')).toBe(true);
    expect((built[0]!.properties!.routeNodes3d as Array<{ z: number }>).some(node => node.z === 1800)).toBe(true);
    expect((built[0]!.properties!.routeNodes3d as Array<{ z: number }>).at(-1)!.z).toBe(2600);
  });

  it('canonicalizes a legacy XY draft from its default level and restores the exact prefix on undo', () => {
    const { tool, options } = setup([], true, { pipeLineMode: 'gas', pipeMaterialMode: 'flexible', pipeAngleMode: 'free' });
    const defaultLevel = getActivePipeRoutingSettings().defaultPipeElevationMm;
    expect(tool.setDrawingElevation(4000)).toBe(true);
    expect(options.onDraftAnchorChange).not.toHaveBeenCalled();
    const first = { x: 10, y: 20 }; const second = { x: 2010, y: 20 };
    tool.handleMouseDown(first); tool.handleMouseDown(second);
    const before = structuredClone(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]);
    const count = vi.mocked(options.onDraftAnchorChange!).mock.calls.length;
    expect(tool.setDrawingElevation(defaultLevel)).toBe(true);
    expect(tool.setDrawingElevation(NaN)).toBe(false);
    expect(tool.setDrawingElevation(Infinity)).toBe(false);
    expect(vi.mocked(options.onDraftAnchorChange!).mock.calls).toHaveLength(count);
    expect(tool.setDrawingElevation(defaultLevel + 800)).toBe(true);
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual([
      { ...first, z: defaultLevel }, { ...second, z: defaultLevel }, { ...second, z: defaultLevel + 800 },
    ]);
    tool.undoDrawingStep();
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual(before);
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith(before!.at(-1));
  });

  it('keeps the selected equipment service level and its fixed port when adding a riser', () => {
    const { tool, options } = setup([], false, { pipeLineMode: 'pair' });
    const source = { ...port, elevationMm: 2550, gasElevationMm: 2600, liquidElevationMm: 2500 };
    tool.beginRouteFromBundle(source, { lineMode: 'liquid' });
    const seeded = structuredClone(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]!) as Array<{ x: number; y: number; z?: number }>;
    expect(seeded.every(point => point.z === 2500)).toBe(true);
    expect(tool.setDrawingElevation(3300)).toBe(true);
    const drafted = vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]! as Array<{ x: number; y: number; z?: number }>;
    expect(drafted.slice(0, -1)).toEqual(seeded);
    expect(drafted.at(-1)).toEqual({ ...seeded.at(-1), z: 3300 });
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith(drafted.at(-1));
    tool.undoDrawingStep();
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual(seeded);
  });

  it('reuses model snap targets during a drawing session and invalidates them when routing settings change', () => {
    const targets = vi.spyOn(pipeModel, 'getRefrigerantPipeBundleSnapTargets');
    const { tool } = setup([], true, { pipeLineMode: 'gas', pipeMaterialMode: 'flexible', pipeAngleMode: 'free' });
    tool.handleMouseDown({ x: 0, y: 0 });
    for (let index = 0; index < 12; index++) tool.handleMouseMove({ x: 1000 + index * 10, y: 500 });
    expect(targets).toHaveBeenCalledOnce();
    setActivePipeRoutingSettings({ ...getActivePipeRoutingSettings(), minimumPortStubMm: 150 });
    tool.handleMouseMove({ x: 1300, y: 500 });
    expect(targets).toHaveBeenCalledTimes(2);
  });

  it('reuses unchanged snapped preview geometry and rebuilds for rules, movement and cancellation', () => {
    const build = vi.spyOn(pipeModel, 'buildRefrigerantPipeElements');
    const { tool, options } = setup([], false, { pipeLineMode: 'gas', pipeMaterialMode: 'flexible', pipeAngleMode: 'free' });
    tool.handleMouseDown({ x: 10, y: 20, z: 1000 });
    const pointer = { x: 310, y: 420, z: 1000 };
    tool.handleMouseMove(pointer);
    expect(build).toHaveBeenCalledOnce();
    const previewCount = vi.mocked(options.onDraftPipesChange!).mock.calls.length;
    for (let index = 0; index < 20; index++) tool.handleMouseMove({ ...pointer });
    expect(build).toHaveBeenCalledOnce();
    expect(vi.mocked(options.onDraftPipesChange!).mock.calls).toHaveLength(previewCount);
    setActivePipeRoutingSettings({ ...getActivePipeRoutingSettings(), defaultPipeGapMm: 70 });
    tool.handleMouseMove(pointer);
    expect(build).toHaveBeenCalledTimes(2);
    tool.handleMouseMove({ ...pointer, x: 320 });
    expect(build).toHaveBeenCalledTimes(3);
    tool.cancelDrawing();
    tool.handleMouseDown({ x: 10, y: 20, z: 1000 });
    tool.handleMouseMove(pointer);
    expect(build).toHaveBeenCalledTimes(4);
    expect(options.addHvacElements).not.toHaveBeenCalled();
  });

  it('reports the true length and rise of a vertical drawing segment', () => {
    const { tool, options } = setup([], false, { pipeLineMode: 'gas', pipeMaterialMode: 'flexible', pipeAngleMode: 'free' });
    tool.handleMouseDown({ x: 10, y: 20, z: 1000 });
    tool.handleMouseMove({ x: 10, y: 20, z: 1700 });
    expect(options.setProcessingStatus).toHaveBeenLastCalledWith('L 700 mm · Rise 700 mm', false);
  });

  it('adds an exact 3D segment length and undoes that draft step without document history writes', () => {
    const { tool, options } = setup([], false, { pipeLineMode: 'gas', pipeMaterialMode: 'flexible', pipeAngleMode: 'free' });
    tool.handleMouseDown({ x: 10, y: 20, z: 1000 });
    tool.handleMouseMove({ x: 310, y: 420, z: 1000 });
    expect(tool.appendSegmentLength(1000)).toBe(true);
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith({ x: 610, y: 820, z: 1000 });
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual([{ x: 10, y: 20, z: 1000 }, { x: 610, y: 820, z: 1000 }]);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.saveToHistory).not.toHaveBeenCalled();
    expect(tool.handleKeyDown({ key: 'Backspace' } as KeyboardEvent)).toBe(true);
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith({ x: 10, y: 20, z: 1000 });
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]).toEqual([{ x: 10, y: 20, z: 1000 }]);
    tool.handleMouseMove({ x: 10, y: 20, z: 2000 });
    expect(tool.appendSegmentLength(700)).toBe(true);
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]?.at(-1)).toEqual({ x: 10, y: 20, z: 1700 });
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.addHvacElements).toHaveBeenCalledOnce();
  });

  it('rejects invalid length input and cancels the complete seeded equipment approach on its first undo', () => {
    const { tool, options } = setup([], false);
    expect(tool.appendSegmentLength(1000)).toBe(false);
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 3000, y: -1000, z: 2600 });
    for (const length of [0, -10, NaN, Infinity]) expect(tool.appendSegmentLength(length)).toBe(false);
    tool.undoDrawingStep();
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  });
  it('keeps Gas + liquid selected when starting from the gas side of a projected unit port', () => {
    const { tool, options } = setup([], false);
    tool.handleMouseDown({ ...port.point, z: 2600, snapTarget: port });
    tool.handleMouseMove({ x: 2200, y: -1000, z: 2600 });
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    const built = vi.mocked(options.addHvacElements).mock.calls[0]![0];
    expect(built.map((element) => element.properties!.lineKind).sort()).toEqual(['gas', 'liquid']);
  });

  it('finishes at an authoritative 3D field-pipe snap', () => {
    const { tool, options } = setup([], false);
    tool.handleMouseDown({ ...port.point, z: 2600, snapTarget: port });
    const end: RefrigerantPipeBundleConnection = {
      ...port, point: { x: 2200, y: -1000 }, gasPoint: { x: 2200, y: -1020 }, liquidPoint: { x: 2200, y: -980 },
      gasFieldPoint: { x: 2200, y: -1020 }, liquidFieldPoint: { x: 2200, y: -980 },
      sourceElementId: 'other-run', connectionKind: 'field-pipe',
    };
    tool.handleMouseDown({ ...end.point, z: 2600, snapTarget: end });
    expect(options.addHvacElements).toHaveBeenCalledOnce();
    expect(vi.mocked(options.addHvacElements).mock.calls[0]![0].every((element) => element.properties!.endConnection)).toBe(true);
  });

  it('Enter inserts a proposed pair branch atomically instead of saving a plain crossing', () => {
    const scene = buildRefrigerantPipeElements([{ x: 0, y: 0 }, { x: 4000, y: 0 }], { bundleId: 'host' })
      .map((element, index) => ({ ...element, id: `host-${index}`, rotation: 0 } as HvacElement));
    const { tool, options } = setup(scene);
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.commitHvacElementCommand).toHaveBeenCalledOnce();
    const command = vi.mocked(options.commitHvacElementCommand).mock.calls[0]![1];
    expect(command.removeIds?.sort()).toEqual(['host-0', 'host-1']);
    expect(command.add?.filter((element) => element.type === 'refrigerant-branch-kit')).toHaveLength(2);
  });

  it('previews and accepts a recovered nearby branch at the same station in one command', () => {
    const scene = connectedMain();
    const original = structuredClone(scene);
    const propose = branchKit.proposeBranchKit;
    // Search geometry is covered by the installation tests. Here the search
    // returns a real buildable layout away from the pointer, as recovery does.
    const proposalSpy = vi.spyOn(branchKit, 'proposeBranchKit').mockImplementation((elements, start, cursor, options) => {
      const recovered = propose(elements, start, { x: cursor.x + 600, y: cursor.y }, options);
      return recovered ? { ...recovered, validity: 'needs-nudge',
        violations: ['Branch position adjusted to fit the approach.', ...recovered.violations] } : null;
    });
    const insertSpy = vi.spyOn(branchKit, 'buildBranchKitInsertion');
    const { tool, options } = setup(scene);
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    const recovered = proposalSpy.mock.results.at(-1)!.value as branchKit.BranchKitProposal;
    expect(recovered.validity).toBe('needs-nudge');
    expect(recovered.teePoint.x).toBeGreaterThan(proposalSpy.mock.calls.at(-1)![2].x + 500);
    const previewRoute = vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]!;
    expect(previewRoute.at(-1)).toEqual(recovered.teePoint);
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();

    expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    expect(insertSpy).toHaveBeenCalledOnce();
    expect(insertSpy.mock.calls[0]![0]).toBe(recovered);
    expect(insertSpy.mock.calls[0]![3]?.at(-1)).toEqual(recovered.teePoint);
    expect(options.commitHvacElementCommand).toHaveBeenCalledOnce();
    const command = vi.mocked(options.commitHvacElementCommand).mock.calls[0]![1];
    expect(command.add?.filter(element => element.type === 'refrigerant-branch-kit')).toHaveLength(2);
    expect(command.removeIds?.sort()).toEqual(['host-0', 'host-1']);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.updateHvacElement).not.toHaveBeenCalled();
    expect(scene).toEqual(original);
  });

  it('previews connected run changes with real ids and applies all levels in one command', () => {
    const scene = connectedMain();
    const original = structuredClone(scene);
    const { tool, options } = setup(scene);
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    const preview = vi.mocked(options.onDraftPipesChange!).mock.calls.at(-1)?.[0] ?? [];
    expect(preview.filter((element) => element.id.startsWith('tail-'))).toHaveLength(2);
    expect(preview.filter((element) => element.id.startsWith('tail-'))
      .every((element) => Array.isArray(element.properties.routeNodes3d))).toBe(true);
    expect(scene).toEqual(original);
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.commitHvacElementCommand).toHaveBeenCalledOnce();
    const command = vi.mocked(options.commitHvacElementCommand).mock.calls[0]![1];
    expect(command.updates?.map((entry) => entry.id).sort()).toEqual(['tail-0', 'tail-1']);
    expect(command.removeIds?.sort()).toEqual(['host-0', 'host-1']);
    for (const entry of command.updates ?? []) {
      const shown = preview.find((element) => element.id === entry.id)!;
      expect(entry.updates.properties?.routeNodes3d).toEqual(shown.properties.routeNodes3d);
      expect(entry.updates.properties?.routePoints).toEqual(shown.properties.routePoints);
      expect(entry.updates.elevation).toBe(shown.elevation);
      // The committed tail binds to a newly split host; those final identifiers
      // do not exist during the level-only preview, while geometry must match.
      const sourceId = (entry.updates.properties?.startConnection as { sourceElementId: string }).sourceElementId;
      expect(command.add?.some((element) => element.id === sourceId
        && element.properties.lineKind === shown.properties.lineKind)).toBe(true);
    }
    expect(options.updateHvacElement).not.toHaveBeenCalled();
    expect(options.saveToHistory).not.toHaveBeenCalled();
  });

  it('rejects a stale level preview if a connected run changes before Enter', () => {
    const scene = connectedMain();
    const { tool, options } = setup(scene);
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    scene.find((element) => element.id === 'tail-0')!.elevation += 100;
    expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    tool.handleDoubleClick();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.onDraftPipesChange).toHaveBeenLastCalledWith(null);
    expect(options.setProcessingStatus).toHaveBeenLastCalledWith(
      'Network changed. Move the pointer to review updated levels.', false,
    );
  });

  it('requires a new preview when routing clearance changes before acceptance', () => {
    const { tool, options } = setup(connectedMain());
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    const settings = getActivePipeRoutingSettings();
    setActivePipeRoutingSettings({ ...settings, zOffsetClearanceMm: settings.zOffsetClearanceMm + 25 });
    expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.onDraftPipesChange).toHaveBeenLastCalledWith(null);
    expect(options.setProcessingStatus).toHaveBeenLastCalledWith(
      'Routing settings changed. Move the pointer to review the updated clearance and levels.', false,
    );
  });

  it.each(['Enter', 'click', 'double-click'] as const)(
    'keeps a rejected %s insertion pending review without saving a plain crossing',
    (finish) => {
      const scene = connectedMain();
      const original = structuredClone(scene);
      const { tool, options } = setup(scene);
      tool.beginRouteFromBundle(port, { lineMode: 'pair' });
      tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
      // The final collision check can reject an otherwise valid preview after
      // an unrelated scene obstacle changes. No partial mutation may escape.
      const insert = vi.spyOn(branchKit, 'buildBranchKitInsertion').mockReturnValue(null);
      if (finish === 'click') tool.handleMouseDown({ x: 1500, y: 0, z: 2600 });
      else if (finish === 'double-click') tool.handleDoubleClick();
      else expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
      expect(insert).toHaveBeenCalledOnce();
      expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
      tool.handleDoubleClick();
      expect(insert).toHaveBeenCalledOnce();
      expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
      expect(options.addHvacElements).not.toHaveBeenCalled();
      expect(options.updateHvacElement).not.toHaveBeenCalled();
      if (finish === 'click') {
        expect(vi.mocked(options.onDraftPipesChange!).mock.calls.at(-1)?.[0]?.length).toBeGreaterThan(0);
      } else {
        expect(options.onDraftPipesChange).toHaveBeenLastCalledWith(null);
      }
      expect(options.setProcessingStatus).toHaveBeenLastCalledWith(
        expect.stringContaining('Could not validate this connection. Move along the run or adjust the last waypoint, then review again.'), false,
      );
      expect(scene).toEqual(original);
    },
  );

  it('adds a draft waypoint on an invalid candidate click and guards repeated finish actions', () => {
    const scene = connectedMain();
    const propose = branchKit.proposeBranchKit;
    const proposalSpy = vi.spyOn(branchKit, 'proposeBranchKit').mockImplementation((...args) => {
      const proposal = propose(...args);
      return proposal ? { ...proposal, validity: 'invalid', violations: ['Move the branch beyond this obstruction.'] } : null;
    });
    const { tool, options } = setup(scene);
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    const authoredBefore = proposalSpy.mock.calls.at(-1)![3]!.authoredRoute!;
    const pipesShown = vi.mocked(options.onDraftPipesChange!).mock.calls.at(-1)![0]!;
    expect(pipesShown).toHaveLength(2);
    expect(pipesShown.every(pipe => !scene.some(existing => existing.id === pipe.id))).toBe(true);
    const previewCallsBefore = vi.mocked(options.onDraftRouteChange!).mock.calls.length;
    expect(tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    // Enter leaves the currently reviewed draft visible and editable.
    expect(vi.mocked(options.onDraftRouteChange!).mock.calls).toHaveLength(previewCallsBefore);
    tool.handleMouseDown({ x: 1500, y: 0, z: 2600 });
    const draft = vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]!;
    expect(draft).toHaveLength(authoredBefore.length + 1);
    expect(draft.slice(0, -1)).toEqual(authoredBefore);
    expect(draft.at(-1)).toEqual(proposalSpy.mock.calls.at(-1)![2]);
    expect(options.setProcessingStatus).toHaveBeenLastCalledWith(expect.stringContaining('Waypoint added.'), false);
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    tool.handleDoubleClick();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.setProcessingStatus).toHaveBeenLastCalledWith(expect.stringContaining('Move the branch beyond this obstruction.'), false);

    // Continuing beyond that candidate produces an ordinary, finishable draft.
    tool.handleMouseMove({ x: draft.at(-1)!.x, y: 1000, z: 2600 });
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.addHvacElements).toHaveBeenCalledOnce();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
  });

  it('keeps a dismissed suggestion hidden along its run until the pointer leaves', () => {
    const proposalSpy = vi.spyOn(branchKit, 'proposeBranchKit');
    const { tool, options } = setup(connectedMain(), true, { pipeAngleMode: 'free' });
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    expect(proposalSpy.mock.results.at(-1)!.value).not.toBeNull();
    tool.dismissBranchKitProposal();
    const callsBefore = proposalSpy.mock.calls.length;
    // Far beyond the previous 120 mm timeout, but still the same candidate.
    tool.handleMouseMove({ x: 2500, y: 0, z: 2600 });
    expect(proposalSpy).toHaveBeenCalledTimes(callsBefore);
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
    tool.handleMouseMove({ x: 2500, y: 500, z: 2600 });
    tool.handleMouseMove({ x: 2500, y: 0, z: 2600 });
    expect(proposalSpy).toHaveBeenCalledTimes(callsBefore + 2);
    expect(proposalSpy.mock.results.at(-1)!.value).not.toBeNull();
  });

  it('keeps recovered suggestions dismissed near the original cursor and the offered straight beyond a bend', () => {
    const scene = buildRefrigerantPipeElements([
      { x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 120 }, { x: 4000, y: 120 },
    ], { bundleId: 'bent-main' })
      .map((element, index) => ({ ...element, id: `bent-host-${index}`, rotation: 0 } as HvacElement));
    const proposalSpy = vi.spyOn(branchKit, 'proposeBranchKit');
    const { tool, options } = setup(scene, true, { pipeAngleMode: 'free' });
    const cursor = { x: 400, y: 0, z: 2600 };
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove(cursor);
    const recovered = proposalSpy.mock.results.at(-1)!.value as branchKit.BranchKitProposal;
    expect(recovered.validity).toBe('needs-nudge');
    expect(recovered.target.segmentStart.y).toBeGreaterThan(100);
    tool.dismissBranchKitProposal();
    const callsBefore = proposalSpy.mock.calls.length;

    // The original pointer is outside the recovered straight's snap corridor.
    // Small movement here must not reopen the dismissed suggestion.
    tool.handleMouseMove({ ...cursor, x: cursor.x + 1 });
    expect(proposalSpy).toHaveBeenCalledTimes(callsBefore);
    const target = recovered.target;
    tool.handleMouseMove({
      x: (target.segmentStart.x + target.segmentEnd.x) / 2,
      y: (target.segmentStart.y + target.segmentEnd.y) / 2,
      z: 2600,
    });
    expect(proposalSpy).toHaveBeenCalledTimes(callsBefore);
    tool.handleKeyDown({ key: 'Enter' } as KeyboardEvent);
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
    expect(options.addHvacElements).not.toHaveBeenCalled();

    // Leaving both locations restores normal proposals when the user returns.
    tool.handleMouseMove({ x: 2000, y: 1500, z: 2600 });
    tool.handleMouseMove(cursor);
    expect(proposalSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(proposalSpy.mock.results.at(-1)!.value).not.toBeNull();
  });

  it('resumes suggestions after a new waypoint changes a dismissed candidate approach', () => {
    const proposalSpy = vi.spyOn(branchKit, 'proposeBranchKit');
    const { tool, options } = setup(connectedMain(), true, { pipeAngleMode: 'free' });
    tool.beginRouteFromBundle(port, { lineMode: 'pair' });
    tool.handleMouseMove({ x: 1500, y: 0, z: 2600 });
    tool.dismissBranchKitProposal();
    const callsBefore = proposalSpy.mock.calls.length;
    tool.handleMouseDown({ x: 2000, y: 0, z: 2600 });
    expect(proposalSpy).toHaveBeenCalledTimes(callsBefore);
    const authored = vi.mocked(options.onDraftRouteChange!).mock.calls.at(-1)![0]!;
    expect(authored.at(-1)).toEqual({ x: 2000, y: 0, z: 2600 });
    tool.handleMouseMove({ x: 2200, y: 0, z: 2600 });
    expect(proposalSpy).toHaveBeenCalledTimes(callsBefore + 1);
    expect(proposalSpy.mock.calls.at(-1)![3]!.authoredRoute).toEqual(authored);
    expect(options.addHvacElements).not.toHaveBeenCalled();
    expect(options.commitHvacElementCommand).not.toHaveBeenCalled();
  });
});
