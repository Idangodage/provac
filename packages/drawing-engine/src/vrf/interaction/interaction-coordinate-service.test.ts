import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  beginDrag,
  calculateBranchPitchAngle,
  calculateBranchRollAngle,
  calculateCameraBasis,
  calculatePortWorldFrame,
  calculateSegmentFrame,
  closestPointBetweenRayAndAxis,
  createCoordinateFrame,
  createWorkplane,
  findNearestValidOrientation,
  intersectRayWithWorkplane,
  localDeltaToWorldFrame,
  projectPointerDeltaToAxis,
  projectPointerDeltaToPlane,
  screenPointToRay,
  updateDrag,
  worldDeltaToLocalFrame,
  type InteractionViewport,
} from './interaction-coordinate-service';

const viewport: InteractionViewport = { left: 100, top: 50, width: 800, height: 600 };

function orthoCamera(
  position = new THREE.Vector3(0, 0, 1000),
  up = new THREE.Vector3(0, 1, 0),
): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 5000);
  camera.position.copy(position);
  camera.up.copy(up);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function pointerForWorld(world: THREE.Vector3, camera: THREE.Camera) {
  const ndc = world.clone().project(camera);
  return {
    clientX: viewport.left + (ndc.x + 1) * viewport.width / 2,
    clientY: viewport.top + (1 - ndc.y) * viewport.height / 2,
  };
}

describe('camera-aware pointer projection', () => {
  it('maps a rotated plan-camera pointer back to the same level point', () => {
    const camera = orthoCamera(new THREE.Vector3(0, 0, 1000), new THREE.Vector3(1, 0, 0));
    const intended = new THREE.Vector3(120, -75, 0);
    const ray = screenPointToRay(pointerForWorld(intended, camera), camera, viewport);
    const hit = intersectRayWithWorkplane(
      ray,
      createWorkplane('level', new THREE.Vector3(), new THREE.Vector3(0, 0, 1)),
    );
    expect(hit?.distanceTo(intended)).toBeLessThan(1e-7);
  });

  it('maps an elevation-view pointer to its vertical workplane', () => {
    const camera = orthoCamera(new THREE.Vector3(0, -1000, 0), new THREE.Vector3(0, 0, 1));
    const intended = new THREE.Vector3(85, 0, 210);
    const ray = screenPointToRay(pointerForWorld(intended, camera), camera, viewport);
    const hit = intersectRayWithWorkplane(
      ray,
      createWorkplane('elevation', new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
    );
    expect(hit?.distanceTo(intended)).toBeLessThan(1e-7);
  });

  it('works with a perspective camera without applying raw screen deltas', () => {
    const camera = new THREE.PerspectiveCamera(50, viewport.width / viewport.height, 0.1, 5000);
    camera.position.set(600, -700, 900);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const intended = new THREE.Vector3(130, 95, 0);
    const ray = screenPointToRay(pointerForWorld(intended, camera), camera, viewport);
    const hit = intersectRayWithWorkplane(
      ray,
      createWorkplane('floor', new THREE.Vector3(), new THREE.Vector3(0, 0, 1)),
    );
    expect(hit?.distanceTo(intended)).toBeLessThan(1e-5);
  });

  it('uses the explicitly frozen fallback when a ray is parallel to the workplane', () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, 2, 3), new THREE.Vector3(1, 0, 0));
    const primary = createWorkplane('parallel', new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    const fallback = createWorkplane(
      'fallback',
      new THREE.Vector3(10, 0, 0),
      new THREE.Vector3(1, 0, 0),
    );
    expect(intersectRayWithWorkplane(ray, primary, fallback)?.toArray()).toEqual([10, 2, 3]);
  });
});

describe('axis and plane drag solvers', () => {
  it('falls back deterministically when the camera ray is parallel to the axis', () => {
    const ray = new THREE.Ray(new THREE.Vector3(5, 0, 10), new THREE.Vector3(0, 0, -1));
    const fallback = createWorkplane('frozen', new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    const result = closestPointBetweenRayAndAxis(
      ray,
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, 1),
      fallback,
    );
    expect(result?.usedFallback).toBe(true);
    expect(result?.point.toArray()).toEqual([0, 0, 0]);
  });

  it('projects pointer movement onto an axis and a plane', () => {
    const camera = orthoCamera();
    const start = screenPointToRay({ clientX: 500, clientY: 350 }, camera, viewport);
    const moved = screenPointToRay({ clientX: 620, clientY: 410 }, camera, viewport);
    const fallback = createWorkplane('screen', new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    const axis = projectPointerDeltaToAxis(
      start,
      moved,
      new THREE.Vector3(),
      new THREE.Vector3(1, 0, 0),
      fallback,
    );
    expect(axis?.delta.x).toBeCloseTo(120, 8);
    expect(axis?.delta.y).toBeCloseTo(0, 8);

    const plane = projectPointerDeltaToPlane(start, moved, fallback);
    expect(plane?.delta.x).toBeCloseTo(120, 8);
    expect(plane?.delta.y).toBeCloseTo(-60, 8);
    expect(plane?.delta.z).toBeCloseTo(0, 8);
  });

  it('freezes camera, viewport, frame and plane for the complete drag', () => {
    const camera = orthoCamera();
    const workplane = createWorkplane('level-02', new THREE.Vector3(0, 0, 300), new THREE.Vector3(0, 0, 1));
    const pointer = { clientX: 500, clientY: 350, pointerId: 7 };
    const drag = beginDrag(
      pointer,
      { camera, viewport, viewMode: 'plan-2d', activeWorkplane: workplane },
      { anchorWorld: new THREE.Vector3(0, 0, 300) },
    );
    expect(drag).not.toBeNull();
    camera.position.set(900, 400, 700);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    workplane.normal.set(1, 0, 0);
    const update = drag ? updateDrag(drag, pointer) : null;
    expect(update?.deltaWorld.length()).toBeLessThan(1e-9);
    expect(drag?.plane?.id).toBe('level-02');
    expect(drag?.plane?.normal.toArray()).toEqual([0, 0, 1]);
  });
});

describe('coordinate frames', () => {
  it('round-trips vector deltas through a local frame', () => {
    const frame = createCoordinateFrame(
      'rotated',
      new THREE.Vector3(50, 60, 70),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(0, 0, 1),
    );
    const world = new THREE.Vector3(12, -9, 4);
    expect(localDeltaToWorldFrame(worldDeltaToLocalFrame(world, frame), frame).distanceTo(world))
      .toBeLessThan(1e-9);
  });

  it('builds a finite short-segment frame instead of emitting NaNs', () => {
    const frame = calculateSegmentFrame(
      new THREE.Vector3(10, 20, 30),
      new THREE.Vector3(10 + 1e-10, 20, 30),
    );
    expect(frame.isDegenerate).toBe(true);
    expect(frame.length).toBe(0);
    expect(frame.xAxis.toArray().every(Number.isFinite)).toBe(true);
    expect(frame.localToWorld.determinant()).toBeGreaterThan(0);
  });

  it('resolves a nested, rotated, negatively-scaled equipment port safely', () => {
    const parent = new THREE.Group();
    parent.position.set(100, -60, 25);
    parent.rotation.set(0.2, -0.3, 0.7);
    parent.scale.set(-2, 1.5, 0.75);
    const equipment = new THREE.Group();
    equipment.position.set(30, 40, 50);
    equipment.rotation.set(-0.1, 0.4, -0.2);
    parent.add(equipment);
    parent.updateMatrixWorld(true);
    const positionLocal = new THREE.Vector3(8, -4, 12);
    const directionLocal = new THREE.Vector3(1, 0, 0);
    const frame = calculatePortWorldFrame({
      id: 'port-gas',
      positionLocal,
      directionLocal,
      upLocal: new THREE.Vector3(0, 0, 1),
      equipmentWorld: equipment,
    });
    const expectedOrigin = positionLocal.clone().applyMatrix4(equipment.matrixWorld);
    const expectedForward = positionLocal.clone().add(directionLocal)
      .applyMatrix4(equipment.matrixWorld).sub(expectedOrigin).normalize();
    expect(frame.origin.distanceTo(expectedOrigin)).toBeLessThan(1e-9);
    expect(frame.zAxis.distanceTo(expectedForward)).toBeLessThan(1e-9);
    expect(frame.localToWorld.determinant()).toBeGreaterThan(0);
  });

  it('calculates an orthonormal camera basis', () => {
    const camera = orthoCamera(new THREE.Vector3(400, -500, 700), new THREE.Vector3(0, 0, 1));
    const basis = calculateCameraBasis(camera);
    expect(Math.abs(basis.right.dot(basis.up))).toBeLessThan(1e-9);
    expect(Math.abs(basis.forward.dot(basis.up))).toBeLessThan(1e-9);
  });
});

describe('branch orientation', () => {
  it('reports pitch and gravity-relative roll', () => {
    const identity = new THREE.Quaternion();
    expect(calculateBranchPitchAngle(identity)).toBeCloseTo(0, 8);
    expect(calculateBranchRollAngle(identity)).toBeCloseTo(0, 8);

    const pitched = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(-30),
    );
    expect(calculateBranchPitchAngle(pitched)).toBeCloseTo(30, 8);

    const rolled = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      THREE.MathUtils.degToRad(90),
    );
    expect(Math.abs(calculateBranchRollAngle(rolled))).toBeCloseTo(90, 8);
  });

  it('finds the quaternion with the smallest angular correction', () => {
    const current = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(82),
    );
    const nearest = findNearestValidOrientation(current, [
      { id: 'horizontal', orientation: new THREE.Quaternion() },
      {
        id: 'vertical',
        orientation: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          THREE.MathUtils.degToRad(90),
        ),
      },
    ]);
    expect(nearest?.id).toBe('vertical');
    expect(nearest?.angularDistanceDeg).toBeCloseTo(8, 8);
  });
});

