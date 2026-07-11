import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../types';

import {
  applyModelToWorldBasis,
  captureModelObjectMatrices,
  getCanonicalModelRootTransformIssue,
  getModelMatrixChanges,
  getModelToWorldBasisIssue,
  modelPoint,
  modelPointToWorld,
  resetCanonicalModelRoot,
  worldPointToModel,
} from './modelSpace';

function createFixtureModel(): THREE.Group {
  const modelRoot = new THREE.Group();
  modelRoot.name = 'ModelRoot';

  const drawingBoard = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 1200),
    new THREE.MeshBasicMaterial(),
  );
  drawingBoard.name = 'DrawingBoard';
  drawingBoard.position.set(1000, 600, -1);
  modelRoot.add(drawingBoard);

  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(1400, 140, 2600),
    new THREE.MeshBasicMaterial(),
  );
  wall.name = 'Wall';
  wall.position.set(420, -260, 1300);
  modelRoot.add(wall);

  const pipe = new THREE.Group();
  pipe.name = 'Pipe';
  pipe.position.set(-800, 320, 2400);
  pipe.rotation.z = Math.PI / 6;
  const fitting = new THREE.Mesh(
    new THREE.SphereGeometry(42),
    new THREE.MeshBasicMaterial(),
  );
  fitting.name = 'PipeFitting';
  fitting.position.set(200, 0, 0);
  pipe.add(fitting);
  modelRoot.add(pipe);

  return modelRoot;
}

describe('canonical model space', () => {
  it('maps plan x/y straight through and elevation to +Z', () => {
    expect(modelPoint({ x: 120, y: -340 }, 2600).toArray()).toEqual([
      120,
      -340,
      2600,
    ]);
  });

  it('keeps the model root as an identity parent', () => {
    const root = createFixtureModel();
    root.position.set(500, -25, 0);
    root.scale.set(-1, 1, 1);

    expect(getCanonicalModelRootTransformIssue(root)).toContain('position=');
    resetCanonicalModelRoot(root);
    expect(getCanonicalModelRootTransformIssue(root)).toBeNull();
  });

  it('detects the old bounds-derived mirror as a broken model-root transform', () => {
    const root = createFixtureModel();
    root.position.set(2000, 0, 0);
    root.scale.set(-1, 1, 1);

    const issue = getCanonicalModelRootTransformIssue(root);
    expect(issue).not.toBeNull();
    expect(issue).toMatch(/position=|scale=/);
  });

  it('allows camera-only view changes without moving model matrices', () => {
    const root = createFixtureModel();
    resetCanonicalModelRoot(root);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    const before = captureModelObjectMatrices(root);

    camera.up.set(0, 0, 1);
    camera.position.set(6000, 6000, 6000);
    camera.lookAt(new THREE.Vector3(0, 0, 0));
    camera.updateMatrixWorld(true);

    expect(getModelMatrixChanges(before, root)).toEqual([]);
  });

  it('does not accumulate drift across repeated 2D-to-3D camera cycles', () => {
    const root = createFixtureModel();
    resetCanonicalModelRoot(root);
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
    const before = captureModelObjectMatrices(root);
    const target = new THREE.Vector3(120, -80, 0);

    for (let index = 0; index < 100; index += 1) {
      camera.position.set(target.x, target.y, 100000);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      camera.position.set(5000 + index, 4200 - index, 3600);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
    }

    expect(getModelMatrixChanges(before, root)).toEqual([]);
  });
});

describe('model → world view basis', () => {
  it('round-trips model points through the mirrored world basis', () => {
    const world = modelPointToWorld({ x: 320, y: 4180 }, 2600);
    expect(world.toArray()).toEqual([320, -4180, 2600]);

    const model = worldPointToModel(world);
    expect(model.toArray()).toEqual([320, 4180, 2600]);
  });

  it('stamps a node as the permanent mirror basis and detects tampering', () => {
    const basis = new THREE.Group();
    applyModelToWorldBasis(basis);

    expect(getModelToWorldBasisIssue(basis)).toBeNull();
    // The basis is a chirality conversion: its determinant must be -1.
    expect(basis.matrixWorld.determinant()).toBeCloseTo(-1, 12);

    basis.position.x = 25;
    expect(getModelToWorldBasisIssue(basis)).toContain('position=');
    basis.position.x = 0;
    basis.scale.y = 1;
    expect(getModelToWorldBasisIssue(basis)).toContain('scale=');
  });

  it('keeps every world matrix bit-identical across 200 tilt cycles', () => {
    const basis = new THREE.Group();
    applyModelToWorldBasis(basis);
    const content = createFixtureModel();
    basis.add(content);
    basis.updateMatrixWorld(true);
    const before = captureModelObjectMatrices(basis);

    const camera = new THREE.OrthographicCamera(-640, 640, 400, -400, 1, 1e9);
    camera.up.set(0, 0, 1);
    const target = new THREE.Vector3(950, -420, 0);
    const radius = 1_000_000;
    for (let cycle = 0; cycle < 200; cycle += 1) {
      for (const polar of [1e-6, Math.PI / 4, 1e-6]) {
        camera.position.set(
          target.x,
          target.y - radius * Math.sin(polar),
          target.z + radius * Math.cos(polar),
        );
        camera.lookAt(target);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      }
    }

    expect(getModelMatrixChanges(before, basis, 0)).toEqual([]);
  });
});

/**
 * Reproduces the exact live mapping on both sides of the 2D↔3D handoff:
 *  - the DOM board draws a model point (mm) at `panPx + pxPerMm * point`
 *    (screen y grows DOWN);
 *  - the hybrid layer draws the same point through the mirrored view basis
 *    with the camera-controls pose (z-up ortho camera, azimuth 0, polar≈0,
 *    target = world board centre) that `syncBoard` produces.
 * The two must land on the same screen pixel, otherwise objects visibly jump
 * the moment the 3D scene fades in during the RMB tilt.
 */
function projectThroughHybridCamera(
  point: Point2D,
  options: {
    pxPerMm: number;
    panPxX: number;
    panPxY: number;
    width: number;
    height: number;
    mirrored: boolean;
  },
): { x: number; y: number } {
  const { pxPerMm, panPxX, panPxY, width, height, mirrored } = options;
  const scene = new THREE.Scene();
  const basis = new THREE.Group();
  if (mirrored) {
    applyModelToWorldBasis(basis);
  }
  scene.add(basis);
  const node = new THREE.Object3D();
  node.position.copy(modelPoint(point, 0));
  basis.add(node);
  scene.updateMatrixWorld(true);
  const world = node.getWorldPosition(new THREE.Vector3());

  const camera = new THREE.OrthographicCamera(
    -width / 2,
    width / 2,
    height / 2,
    -height / 2,
    1,
    1e9,
  );
  camera.up.set(0, 0, 1);
  camera.zoom = pxPerMm;
  const centerModel: Point2D = {
    x: (width / 2 - panPxX) / pxPerMm,
    y: (height / 2 - panPxY) / pxPerMm,
  };
  const target = mirrored
    ? modelPointToWorld(centerModel)
    : new THREE.Vector3(centerModel.x, centerModel.y, 0);
  // camera-controls clamps polar to >= 1e-6 (Spherical.makeSafe); use a tiny
  // tilt exactly like the live flat view rather than a degenerate 0.
  const polar = 1e-4;
  const radius = 1_000_000;
  camera.position.set(
    target.x,
    target.y - radius * Math.sin(polar),
    target.z + radius * Math.cos(polar),
  );
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const ndc = world.clone().project(camera);
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((1 - ndc.y) / 2) * height,
  };
}

describe('2D board ↔ hybrid 3D screen mapping', () => {
  const viewports = [
    { pxPerMm: 3.7795, panPxX: 0, panPxY: 0, width: 1280, height: 800 },
    { pxPerMm: 0.35, panPxX: 240, panPxY: -180, width: 1280, height: 800 },
    { pxPerMm: 12.5, panPxX: -900, panPxY: 620, width: 1920, height: 1080 },
  ];
  const points: Point2D[] = [
    { x: 0, y: 0 },
    { x: 1587, y: 1122 },
    { x: -2400, y: 3600 },
    { x: 82000, y: -45000 },
  ];

  it('lands every model point on the same screen pixel as the DOM board', () => {
    viewports.forEach((viewport) => {
      points.forEach((point) => {
        const dom = {
          x: viewport.panPxX + viewport.pxPerMm * point.x,
          y: viewport.panPxY + viewport.pxPerMm * point.y,
        };
        const three = projectThroughHybridCamera(point, {
          ...viewport,
          mirrored: true,
        });
        expect(three.x).toBeCloseTo(dom.x, 2);
        expect(three.y).toBeCloseTo(dom.y, 2);
      });
    });
  });

  it('documents the bug: without the mirror basis the plan renders vertically flipped', () => {
    const viewport = viewports[0]!;
    const point: Point2D = { x: 500, y: 1000 };
    const dom = {
      x: viewport.panPxX + viewport.pxPerMm * point.x,
      y: viewport.panPxY + viewport.pxPerMm * point.y,
    };
    const three = projectThroughHybridCamera(point, {
      ...viewport,
      mirrored: false,
    });
    // X still matches…
    expect(three.x).toBeCloseTo(dom.x, 2);
    // …but Y reflects about the viewport centre line: objects visibly jump.
    expect(Math.abs(three.y - dom.y)).toBeGreaterThan(1);
    expect(three.y).toBeCloseTo(viewport.height - dom.y, 2);
  });
});
