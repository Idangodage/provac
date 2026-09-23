import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';
import { createPipeRenderStateCache } from '../hvac/pipeRenderStateCache';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import { buildRefrigerantPipeVisual } from '../hvac/refrigerantPipePairModel';

import { createHybridHvacScene } from './hybridHvacScene';

function pipe(id: string, x = 0): HvacElement {
  return { id, type: 'refrigerant-pipe', label: id, position: { x, y: 0 }, width: 1000, depth: 50,
    height: 50, elevation: 2400, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { routePoints: [{ x, y: 0 }, { x: x + 1000, y: 0 }],
      lineKind: 'gas', pipeDiameterMm: 15.875, outerDiameterMm: 50, segmentMaterials: ['hard'] } };
}

function harness() {
  const build = vi.fn((element: HvacElement) => ({ id: element.id }));
  const attach = vi.fn();
  const dispose = vi.fn();
  return { scene: createHybridHvacScene({ build, attach, dispose }), build, attach, dispose };
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('incremental committed HVAC scene', () => {
  it('rebuilds one edited member in a 100-pipe drawing and releases each retired mesh exactly once', () => {
    const { scene, build, dispose } = harness();
    const context = createPipeRenderStateCache();
    const original = Array.from({ length: 100 }, (_, index) => pipe(`pipe-${index}`, index * 2000));
    scene.update(context(original), 0);
    const initialMeshes = build.mock.results.map(result => result.value);
    scene.update(context([...original]), 0);
    expect(build).toHaveBeenCalledTimes(100);
    expect(dispose).not.toHaveBeenCalled();
    const edited = original.map((element, index) => index === 4 ? pipe(element.id, 8500) : element);
    scene.update(context(edited), 0);
    expect(build).toHaveBeenCalledTimes(101);
    expect(dispose.mock.calls.map(call => call[0])).toEqual([initialMeshes[4]]);
    scene.update(context([...edited.slice(1), pipe('new-pipe', 210000)]), 0);
    expect(build).toHaveBeenCalledTimes(102);
    expect(dispose.mock.calls.map(call => call[0])).toEqual([initialMeshes[4], initialMeshes[0]]);
    scene.clear();
    scene.clear();
    expect(dispose).toHaveBeenCalledTimes(102);
    expect(new Set(dispose.mock.calls.map(call => call[0])).size).toBe(102);
  });

  it('updates a retained chain head when its downstream geometry or endpoint ownership changes', () => {
    const { scene, build } = harness();
    const context = createPipeRenderStateCache();
    const head = pipe('head');
    const tail = pipe('tail', 1000);
    tail.properties.startConnection = { connectionKind: 'field-pipe', sourceElementId: head.id,
      portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 },
      elevationMm: head.elevation + buildRefrigerantPipeVisual(head, [head]).localZMm };
    const unrelated = pipe('unrelated', 5000);
    const initial = context([head, tail, unrelated]);
    expect(initial.pipeRenderChainStateMap.get(head.id)?.tailId).toBe(tail.id);
    scene.update(initial, 0);
    build.mockClear();
    const extended = { ...tail, properties: { ...tail.properties,
      routePoints: [{ x: 1000, y: 0 }, { x: 2800, y: 0 }] } };
    const preview = context([head, extended, unrelated]);
    expect(scene.changedElements(preview).map(element => element.id)).toEqual(['head', 'tail']);
    // Computing a preview does not replace meshes; cancellation needs no rebuild.
    expect(build).not.toHaveBeenCalled();
    expect(scene.changedElements(initial)).toEqual([]);
    scene.update(preview, 0);
    expect(build.mock.calls.map(call => call[0].id)).toEqual(['head', 'tail']);
    build.mockClear();
    const removed = context([head, unrelated]);
    expect(removed.pipeEndpointStateMap.get(head.id)?.openEnd).toBe(false);
    scene.update(removed, 0);
    expect(build.mock.calls.map(call => call[0].id)).toEqual(['head']);
  });

  it('invalidates live connector sources, routing settings and model loads while retaining unrelated equipment', () => {
    const { scene, build } = harness();
    const context = createPipeRenderStateCache();
    const source = { ...pipe('source'), type: 'outdoor-unit' as const };
    const target = pipe('target', 1000);
    target.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: source.id,
      portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2425 };
    const unrelated = { ...pipe('other-unit'), type: 'outdoor-unit' as const };
    scene.update(context([source, target, unrelated]), 0);
    build.mockClear();
    const moved = [{ ...source, elevation: 2700 }, target, unrelated];
    scene.update(context(moved), 0);
    expect(build.mock.calls.map(call => call[0].id)).toEqual(['source', 'target']);
    build.mockClear();
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumPortStubMm: 350 });
    scene.update(context(moved), 0);
    expect(build.mock.calls.map(call => call[0].id)).toEqual(['target']);
    build.mockClear();
    scene.update(context(moved), 1);
    expect(build).toHaveBeenCalledTimes(3);
  });
});

function branchKit(id: string, mode: 'fixed' | 'inline-pipe-run'): HvacElement {
  return { id, type: 'refrigerant-branch-kit', label: id, position: { x: 5000, y: 0 },
    width: 300, depth: 200, height: 120, elevation: 2500, rotation: 0, mountType: 'ceiling',
    supplyZoneRatio: 0, properties: { branchKitLineKind: 'both', branchKitPlacementMode: mode } };
}

describe('branch-kit scene dependency', () => {
  it('keeps a fixed kit while an unrelated pipe changes', () => {
    // A fixed kit is positioned entirely by its own record, so an edit elsewhere
    // must not invalidate it. One kit rebuild is a three-bvh-csg union measured
    // at 70.8 ms, so depending on the whole scene froze the main thread for
    // roughly half a second per commit on a drawing with several kits.
    const { scene, build, dispose } = harness();
    const context = createPipeRenderStateCache();
    const kit = branchKit('kit-1', 'fixed');
    const original = [pipe('pipe-0'), pipe('pipe-1', 4000), kit];
    scene.update(context(original), 0);
    expect(build).toHaveBeenCalledTimes(3);

    // Only pipe-1 is replaced; every other member keeps its identity.
    const edited = original.map(element => element.id === 'pipe-1' ? pipe('pipe-1', 9000) : element);
    scene.update(context(edited), 0);
    expect(build).toHaveBeenCalledTimes(4);
    expect(build.mock.calls.at(-1)![0].id).toBe('pipe-1');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rebuilds an inline kit when the scene changes, because it resolves against a run', () => {
    const { scene, build } = harness();
    const context = createPipeRenderStateCache();
    const kit = branchKit('kit-1', 'inline-pipe-run');
    const original = [pipe('pipe-0'), pipe('pipe-1', 4000), kit];
    scene.update(context(original), 0);
    expect(build).toHaveBeenCalledTimes(3);

    const edited = original.map(element => element.id === 'pipe-1' ? pipe('pipe-1', 9000) : element);
    scene.update(context(edited), 0);
    // The moved pipe AND the inline kit, whose render centre tracks the run.
    expect(build).toHaveBeenCalledTimes(5);
    expect(build.mock.calls.slice(-2).map(call => call[0].id).sort()).toEqual(['kit-1', 'pipe-1']);
  });

  it('rebuilds a fixed kit when its own record changes', () => {
    const { scene, build } = harness();
    const context = createPipeRenderStateCache();
    const original = [pipe('pipe-0'), branchKit('kit-1', 'fixed')];
    scene.update(context(original), 0);
    expect(build).toHaveBeenCalledTimes(2);

    const moved = { ...original[1]!, position: { x: 7000, y: 0 } };
    scene.update(context([original[0]!, moved]), 0);
    expect(build).toHaveBeenCalledTimes(3);
    expect(build.mock.calls.at(-1)![0].id).toBe('kit-1');
  });
});
