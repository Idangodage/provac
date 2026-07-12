import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  applyPipeAxisConstraint,
  createDrawingPlane,
  createPointerRay,
  getPointerNDC,
  intersectRayWithDrawingTarget,
  intersectPointerRayWithAxis,
  planeLocalToWorld,
  projectPointerToDrawingPlane,
  resolveActiveDrawingPlane,
  resolveSnappedPipePoint,
  worldToPlaneLocal,
} from './pipePointerProjection';

function topOrtho(width = 800, height = 600): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 10000);
  camera.position.set(0, 0, 1000);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function perspective(width = 800, height = 600): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 10000);
  camera.position.set(500, 400, 900);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

describe('pointer coordinates and camera ray', () => {
  it('uses the actual canvas bounds for client -> canvas -> NDC', () => {
    const resolved = getPointerNDC(510, 320, { left: 110, top: 20, width: 800, height: 600 });
    expect(resolved.canvas.toArray()).toEqual([400, 300]);
    expect(resolved.ndc.x).toBeCloseTo(0, 12);
    expect(resolved.ndc.y).toBeCloseTo(0, 12);
  });

  it('is unaffected by DPR and changes correctly after a panel resize', () => {
    for (const dpr of [1, 1.25, 2, 3]) {
      void dpr; // Backing-buffer DPR is intentionally absent from the API.
      expect(getPointerNDC(500, 300, { left: 100, top: 0, width: 800, height: 600 }).ndc.x).toBe(0);
    }
    expect(getPointerNDC(500, 300, { left: 200, top: 0, width: 600, height: 600 }).ndc.x).toBe(0);
  });

  it('creates the expected centre ray for orthographic and perspective cameras', () => {
    const ndc = new THREE.Vector2(0, 0);
    const orthoRay = createPointerRay(ndc, topOrtho());
    expect(orthoRay.direction.x).toBeCloseTo(0, 8);
    expect(orthoRay.direction.y).toBeCloseTo(0, 8);
    expect(orthoRay.direction.z).toBeCloseTo(-1, 8);

    const camera = perspective();
    const perspectiveRay = createPointerRay(ndc, camera);
    const expected = camera.getWorldDirection(new THREE.Vector3());
    expect(perspectiveRay.direction.distanceTo(expected)).toBeLessThan(1e-8);
  });
});

describe('drawing planes and intersections', () => {
  it('round-trips transformed plane local/world coordinates', () => {
    const plane = createDrawingPlane(
      'inclined',
      'work-plane',
      new THREE.Vector3(120, -80, 350),
      new THREE.Vector3(1, 2, 3),
      new THREE.Vector3(1, 0, 0),
    );
    const local = new THREE.Vector3(45, -17, 0);
    const world = planeLocalToWorld(local, plane);
    const back = worldToPlaneLocal(world, plane);
    expect(back.distanceTo(local)).toBeLessThan(1e-9);
  });

  it('intersects horizontal and rotated planes exactly', () => {
    const horizontal = createDrawingPlane('floor', 'floor', new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    const hit = intersectRayWithDrawingTarget(
      new THREE.Ray(new THREE.Vector3(20, 30, 100), new THREE.Vector3(0, 0, -1)),
      horizontal,
    );
    expect(hit?.toArray()).toEqual([20, 30, 0]);

    const wall = createDrawingPlane('wall', 'wall', new THREE.Vector3(25, 0, 0), new THREE.Vector3(1, 0, 0));
    const wallHit = intersectRayWithDrawingTarget(
      new THREE.Ray(new THREE.Vector3(100, 12, 40), new THREE.Vector3(-1, 0, 0)),
      wall,
    );
    expect(wallHit?.toArray()).toEqual([25, 12, 40]);
  });

  it('projects the same intended world point with ortho and perspective cameras', () => {
    const plane = createDrawingPlane('floor', 'floor', new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    for (const camera of [topOrtho(), perspective()]) {
      const world = new THREE.Vector3(65, -40, 0);
      const projected = world.clone().project(camera);
      const clientX = (projected.x + 1) * rect.width / 2;
      const clientY = (1 - projected.y) * rect.height / 2;
      const result = projectPointerToDrawingPlane(clientX, clientY, rect, camera, plane);
      expect(result?.rawWorldPoint.distanceTo(world)).toBeLessThan(1e-5);
    }
  });

  it('keeps the first-click locked plane when the camera/context changes', () => {
    const locked = createDrawingPlane('wall-a', 'wall', new THREE.Vector3(10, 0, 0), new THREE.Vector3(1, 0, 0));
    const resolved = resolveActiveDrawingPlane({
      camera: perspective(),
      lockedPlane: locked,
      surfaceHit: {
        id: 'floor-b',
        kind: 'floor',
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 0, 1),
      },
    });
    expect(resolved).toBe(locked);
  });
});

describe('constraints and snap priority', () => {
  const plane = createDrawingPlane('floor', 'floor', new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  const start = new THREE.Vector3(10, 20, 30);
  const candidate = new THREE.Vector3(45, 80, 95);

  it('applies local and world axes in world space, never raw screen delta', () => {
    expect(applyPipeAxisConstraint(start, candidate, 'local-x', plane).toArray()).toEqual([45, 20, 30]);
    expect(applyPipeAxisConstraint(start, candidate, 'local-y', plane).toArray()).toEqual([10, 80, 30]);
    expect(applyPipeAxisConstraint(start, candidate, 'world-z', plane).toArray()).toEqual([10, 20, 95]);
  });

  it('solves a pointer ray against a world-Z riser axis', () => {
    const resolved = intersectPointerRayWithAxis(
      new THREE.Ray(
        new THREE.Vector3(100, 50, 300),
        new THREE.Vector3(-1, -0.5, 0.25).normalize(),
      ),
      new THREE.Vector3(10, 5, 0),
      new THREE.Vector3(0, 0, 1),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.x).toBeCloseTo(10, 10);
    expect(resolved?.y).toBeCloseTo(5, 10);
  });

  it('chooses snap category priority before distance', () => {
    const raw = new THREE.Vector3(1, 2, 3);
    const resolved = resolveSnappedPipePoint(raw, [
      { id: 'grid', kind: 'guide', point: new THREE.Vector3(10, 0, 0), screenDistancePx: 2 },
      { id: 'pipe', kind: 'pipe-endpoint', point: new THREE.Vector3(20, 0, 0), screenDistancePx: 8 },
      { id: 'port', kind: 'equipment-port', point: new THREE.Vector3(30, 0, 0), screenDistancePx: 11 },
    ], 12);
    expect(resolved.candidate?.id).toBe('port');
    expect(resolved.point.toArray()).toEqual([30, 0, 0]);
  });

  it('returns the exact raw point when every candidate is outside tolerance', () => {
    const raw = new THREE.Vector3(1, 2, 3);
    const resolved = resolveSnappedPipePoint(raw, [
      { id: 'far', kind: 'equipment-port', point: new THREE.Vector3(), screenDistancePx: 20 },
    ], 12);
    expect(resolved.candidate).toBeNull();
    expect(resolved.point).not.toBe(raw);
    expect(resolved.point.toArray()).toEqual(raw.toArray());
  });
});
