import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';
import { createPipeRenderStateCache } from '../hvac/pipeRenderStateCache';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import { buildRefrigerantPipeVisual } from '../hvac/refrigerantPipePairModel';
import type { HvacBuildSceneContext } from '../hvac/three3d';
import { disposeObject3DResources } from '../threeResourceLifecycle';

import { createHybridHvacScene } from './hybridHvacScene';
import { applyHybridPreviewMaterials, clearHybridPipePreviewScene, composeHybridPipePreviewScene,
  updateHybridPipePreviewScene } from './hybridPipePreviewScene';

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

function pipe(id: string, x = 0): HvacElement {
  return { id, type: 'refrigerant-pipe', label: id, position: { x, y: 0 }, width: 1000, depth: 50,
    height: 50, elevation: 2400, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { routePoints: [{ x, y: 0 }, { x: x + 1000, y: 0 }],
      lineKind: 'gas', pipeDiameterMm: 15.875, outerDiameterMm: 50, segmentMaterials: ['hard'] } };
}

function previewHarness(committed: HvacElement[] = [], buildRenderContext: (elements: HvacElement[]) => HvacBuildSceneContext
  = allElements => ({ allElements })) {
  const committedScene = createHybridHvacScene({ build: () => null, attach: () => {}, dispose: () => {} });
  committedScene.update(buildRenderContext(committed), 0);
  const material = new THREE.MeshStandardMaterial();
  const disposals: ReturnType<typeof vi.spyOn>[] = [];
  const build = vi.fn((element: HvacElement) => {
    const group = new THREE.Group();
    group.name = element.id;
    const geometry = new THREE.BoxGeometry();
    disposals.push(vi.spyOn(geometry, 'dispose'));
    group.add(new THREE.Mesh(geometry, material));
    return group;
  });
  const group = new THREE.Group();
  const context = vi.fn(buildRenderContext);
  const update = (drafts: HvacElement[] | null) => updateHybridPipePreviewScene(group,
    { committedScene, committed, drafts, edits: null, buildRenderContext: context }, build);
  const clear = () => { clearHybridPipePreviewScene(group); material.dispose(); };
  return { group, update, clear, build, context, disposals, committedScene };
}

describe('isolated hybrid pipe previews', () => {
  it('keeps steel and terminal previews solid without mutating shared committed materials', () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#b9c3cc' });
    const disposeShared = vi.spyOn(shared, 'dispose');
    for (const type of ['duct', 'diffuser', 'return-grille', 'refrigerant-pipe', 'refrigerant-pipe-pair',
      'condensate-pipe', 'ducted-ac', 'outdoor-unit', 'ceiling-cassette-ac', 'refrigerant-branch-kit'] as const) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
      applyHybridPreviewMaterials(mesh, { type });
      expect(mesh.material).not.toBe(shared);
      expect(mesh.material).toMatchObject({ transparent: false, opacity: 1, depthWrite: true });
      const disposePreview = vi.spyOn(mesh.material, 'dispose');
      disposeObject3DResources(mesh);
      expect(disposePreview).toHaveBeenCalledOnce();
    }
    expect(shared).toMatchObject({ transparent: false, opacity: 1, depthWrite: true });
    expect(disposeShared).not.toHaveBeenCalled();
    shared.dispose();
  });

  it('restores depth occlusion even when a source pipe material was translucent', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3, depthWrite: false, depthTest: false }));
    const shared = mesh.material;
    applyHybridPreviewMaterials(mesh, { type: 'refrigerant-pipe' });
    expect(mesh.material).toMatchObject({ transparent: false, opacity: 1, depthWrite: true, depthTest: true });
    expect(shared).toMatchObject({ transparent: true, opacity: 0.3, depthWrite: false, depthTest: false });
    disposeObject3DResources(mesh);
    shared.dispose();
  });

  it('keeps every unaffected element identical while a connected edit replaces its pipes', () => {
    const committed = Array.from({ length: 100 }, (_, index) => ({ id: `pipe-${index}`, x: index }));
    const edit = { ...committed[4]!, x: 1000 };
    const neighbor = { ...committed[5]!, x: 1100 };
    const scene = composeHybridPipePreviewScene(committed, null, [edit, neighbor]);
    expect(scene.previews).toEqual([edit, neighbor]);
    expect(scene.allElements[4]).toBe(edit);
    expect(scene.allElements[5]).toBe(neighbor);
    expect(scene.allElements.filter((element, index) => element === committed[index])).toHaveLength(98);
    expect(committed[4]!.x).toBe(4);
  });

  it('replaces extension draft IDs instead of rendering duplicate connection owners', () => {
    const host = { id: 'host', x: 10 };
    const extension = { id: 'host', x: 50 };
    const draft = { id: '__draft', x: 80 };
    const scene = composeHybridPipePreviewScene([host], [extension, draft], null);
    expect(scene.allElements).toEqual([extension, draft]);
    expect(scene.hiddenIds.has(host.id)).toBe(true);
    const cancelled = composeHybridPipePreviewScene([host], null, null);
    expect(cancelled.allElements[0]).toBe(host);
    expect(cancelled.hiddenIds.size).toBe(0);
    expect(cancelled.previews).toHaveLength(0);
  });

  it('keeps 68 preview meshes through camera updates and rebuilds only the pipe being dragged', () => {
    const harness = previewHarness();
    const drafts = [
      ...Array.from({ length: 60 }, (_, index) => pipe(`pipe-${index}`, index * 2000)),
      ...Array.from({ length: 8 }, (_, index): HvacElement => ({ ...pipe(`kit-${index}`),
        type: 'refrigerant-branch-kit', properties: { branchKitPlacementMode: 'fixed' } })),
    ];
    expect(harness.update(drafts).changed).toBe(true);
    const originalMeshes = [...harness.group.children];
    for (let frame = 0; frame < 120; frame++) expect(harness.update([...drafts]).changed).toBe(false);
    expect(harness.context).toHaveBeenCalledTimes(1);
    expect(harness.build).toHaveBeenCalledTimes(68);
    expect(harness.group.children).toEqual(originalMeshes);
    const moved = [pipe(drafts[0]!.id, 100), ...drafts.slice(1)];
    expect(harness.update(moved).changed).toBe(true);
    expect(harness.build).toHaveBeenCalledTimes(69);
    expect(harness.context).toHaveBeenCalledTimes(2);
    for (const mesh of originalMeshes.slice(1)) expect(mesh.parent).toBe(harness.group);
    expect(harness.disposals[0]).toHaveBeenCalledOnce();
    for (const dispose of harness.disposals.slice(1)) expect(dispose).not.toHaveBeenCalled();
    expect(harness.update(null).hiddenIds.size).toBe(0);
    expect(harness.group.children).toHaveLength(0);
    harness.clear();
    harness.clear();
    for (const dispose of harness.disposals) expect(dispose).toHaveBeenCalledOnce();
  });

  it('updates a committed chain head with its edited tail and releases both on cancellation', () => {
    const head = pipe('head');
    const tail = pipe('tail', 1000);
    tail.properties.startConnection = { connectionKind: 'field-pipe', sourceElementId: head.id,
      portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 },
      elevationMm: head.elevation + buildRefrigerantPipeVisual(head, [head]).localZMm };
    const harness = previewHarness([head, tail], createPipeRenderStateCache());
    const extended = { ...tail, properties: { ...tail.properties,
      routePoints: [{ x: 1000, y: 0 }, { x: 2800, y: 0 }] } };
    expect([...harness.update([extended]).hiddenIds].sort()).toEqual(['head', 'tail']);
    expect(harness.build.mock.calls.map(call => call[0].id).sort()).toEqual(['head', 'tail']);
    harness.build.mockClear();
    harness.update([{ ...extended, elevation: 2700 }]);
    expect(harness.build.mock.calls.map(call => call[0].id).sort()).toEqual(['head', 'tail']);
    harness.update(null);
    expect(harness.group.children).toHaveLength(0);
    for (const dispose of harness.disposals) expect(dispose).toHaveBeenCalledOnce();
    harness.clear();
  });

  it('keeps connected duct previews current when their terminal moves', () => {
    const terminal: HvacElement = { ...pipe('terminal'), type: 'diffuser' };
    const duct: HvacElement = { ...pipe('run'), type: 'duct',
      properties: { ductRun: { end: { kind: 'terminal', terminalId: terminal.id } } } };
    const harness = previewHarness([duct, terminal]);
    expect([...harness.update([{ ...terminal, elevation: 2600 }]).hiddenIds].sort()).toEqual(['run', 'terminal']);
    expect(harness.build.mock.calls.map(call => call[0].id)).toEqual(['terminal', 'run']);
    harness.build.mockClear();
    harness.update([{ ...terminal, elevation: 2700 }]);
    expect(harness.build.mock.calls.map(call => call[0].id)).toEqual(['terminal', 'run']);
    harness.clear();
    expect(harness.group.children).toHaveLength(0);
  });

  it('invalidates previews for changed routing settings and loaded model revisions', () => {
    const harness = previewHarness();
    const draft = pipe('draft');
    harness.update([draft]);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumPortStubMm: 350 });
    expect(harness.update([draft]).changed).toBe(true);
    expect(harness.build).toHaveBeenCalledTimes(2);
    harness.committedScene.update({ allElements: [] }, 1);
    expect(harness.update([draft]).changed).toBe(true);
    expect(harness.build).toHaveBeenCalledTimes(3);
    harness.clear();
  });
});
