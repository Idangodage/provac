import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';
import { resolveUnitAirPorts } from '../hvac/duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../hvac/duct/ductDraft';
import { getDuctRunPlan } from '../hvac/duct/ductFabricationPlanner';
import { segmentEnds, segmentHotspot3D } from '../hvac/duct/ductSegments';
import { resolveDuctSettings } from '../hvac/duct/ductSettings';
import { buildHvacElementMesh } from '../hvac/three3d/buildHvacElementMesh';
import { applyModelToWorldBasis, modelPointToWorld } from '../modelSpace';

import { ductRunMeshes, ductSegmentEndRings, ductSegmentFocusAt, ductSegmentProxy, raycastDuctRun, segmentClientRect3D } from './hybridDuctSegments';

const settings = resolveDuctSettings({ showSupports: false });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const P = (along: number, across = 0): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

/** The 3D views' frame: the model root under the mirrored model→world basis, a run built into it. */
function world() {
  const run = buildDuctRunDraftElement({ port: supply, points: [P(3000), P(3000, 2500)], legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }] }, 'run');
  const scene = [unit, run];
  const three = new THREE.Scene();
  const basis = new THREE.Group();
  applyModelToWorldBasis(basis);
  three.add(basis);
  const root = new THREE.Group();
  basis.add(root);
  const group = buildHvacElementMesh(run, { allElements: scene, ductSettings: settings })!;
  root.add(group);
  three.updateMatrixWorld(true);
  return { scene, root, plan: getDuctRunPlan(run, scene, settings)! };
}

/** A ray straight down onto a model point. */
function downOnto(point: { x: number; y: number; z: number }): THREE.Raycaster {
  const above = modelPointToWorld({ x: point.x, y: point.y }, point.z + 5000);
  return new THREE.Raycaster(above, new THREE.Vector3(0, 0, -1));
}

describe('duct runs in the 3D views', () => {
  it('a ray onto a run finds it, the point on its surface in model millimetres, and the segment there', () => {
    const { scene, root, plan } = world();
    const target = segmentHotspot3D(plan, 'leg:0')!;
    const hit = raycastDuctRun(downOnto(target), root)!;
    expect(hit.runId).toBe('run');
    // On the insulation's top face, over the hotspot (the basis mirrors y; the hit comes back in the model's frame).
    expect(hit.model.x).toBeCloseTo(target.x, 3);
    expect(hit.model.y).toBeCloseTo(target.y, 3);
    const top = plan.pieces.find((piece) => piece.kind === 'straight')!;
    expect(hit.model.z).toBeCloseTo(top.centreZ + top.heightMm / 2 + 1 + plan.insulationMm, 0);
    expect(ductSegmentFocusAt(scene, settings, hit.runId, hit.model)).toMatchObject({ runId: 'run', key: 'leg:0', view: '3d' });
    // The elbow from above.
    const elbow = raycastDuctRun(downOnto(segmentHotspot3D(plan, 'node:1')!), root)!;
    expect(ductSegmentFocusAt(scene, settings, elbow.runId, elbow.model)?.key).toBe('node:1');
    // Beside the run: nothing.
    expect(raycastDuctRun(downOnto({ ...P(1500, 1500), z: target.z }), root)).toBeNull();
  });

  it('rings a segment at both of its ends, clear of its outer face', () => {
    const { scene, plan } = world();
    const ends = segmentEnds(plan, 'leg:0');
    const rings = ductSegmentEndRings(scene, settings, 'run', 'leg:0')!;
    const position = rings.geometry.getAttribute('position');
    const atEnd = [0, 0];
    for (let index = 0; index < position.count; index += 1) {
      const p = { x: position.getX(index), y: position.getY(index), z: position.getZ(index) };
      // In one end's cross-section (within the ring's tube) …
      const which = ends.findIndex((end) => Math.abs((p.x - end.point.x) * end.direction.x + (p.y - end.point.y) * end.direction.y) <= 10 + 1e-6);
      expect(which).toBeGreaterThanOrEqual(0);
      atEnd[which] = (atEnd[which] ?? 0) + 1;
      // … and round the duct, clear of its outer face.
      const end = ends[which]!;
      const across = Math.abs(-(p.x - end.point.x) * end.direction.y + (p.y - end.point.y) * end.direction.x);
      const up = Math.abs(p.z - end.z);
      expect(across > end.halfWidthMm + 10 || up > end.halfHeightMm + 10).toBe(true);
    }
    expect(atEnd[0]).toBeGreaterThan(0);
    expect(atEnd[1]).toBeGreaterThan(0);
    expect(ductSegmentEndRings(scene, settings, 'run', 'nope')).toBeNull();
  });

  it('outlines a segment with a proxy and the run with its own meshes', () => {
    const { scene, root } = world();
    const proxy = ductSegmentProxy(scene, settings, 'run', 'node:1')!;
    expect(proxy.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(ductSegmentProxy(scene, settings, 'run', 'nope')).toBeNull();
    expect(ductRunMeshes(root, 'run').length).toBeGreaterThan(0);
    expect(ductRunMeshes(root, 'other')).toEqual([]);
  });

  it("places a card by the segment's box as the camera sees it", () => {
    const { scene, plan } = world();
    const target = segmentHotspot3D(plan, 'leg:0')!;
    // Straight down onto the hotspot, a 10 m square view on a 1000 px canvas at (100, 50).
    const camera = new THREE.OrthographicCamera(-5000, 5000, 5000, -5000, 1, 100000);
    camera.up.set(0, 1, 0);
    camera.position.copy(modelPointToWorld({ x: target.x, y: target.y }, 20000));
    camera.lookAt(modelPointToWorld({ x: target.x, y: target.y }, 0));
    camera.updateProjectionMatrix();
    const host = { left: 100, top: 50, width: 1000, height: 1000 };
    const rect = segmentClientRect3D(scene, settings, { runId: 'run', key: 'leg:0', anchorMark: null }, camera, host)!;
    // The view's centre (600, 550) lies in the leg's box; its width across the duct is 600 mm + insulation at 0.1 px/mm.
    expect(rect.left).toBeLessThan(600);
    expect(rect.right).toBeGreaterThan(600);
    expect(rect.top).toBeLessThan(550);
    expect(rect.bottom).toBeGreaterThan(550);
    expect(rect.right - rect.left).toBeCloseTo(60, 0);
    // Off the drawing: no card.
    camera.position.copy(modelPointToWorld({ x: target.x + 50000, y: target.y }, 20000));
    camera.lookAt(modelPointToWorld({ x: target.x + 50000, y: target.y }, 0));
    expect(segmentClientRect3D(scene, settings, { runId: 'run', key: 'leg:0', anchorMark: null }, camera, host)).toBeNull();
  });
});
