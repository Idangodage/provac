import fc from 'fast-check';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { modelPointToWorld } from '../modelSpace';
import { MM_TO_PX } from '../scale';

import {
  MAX_MM_PER_PX,
  MIN_MM_PER_PX,
  clampOrthoZoom,
  deriveBoardViewFromCamera,
  makeOrthoCamera,
  poseUp,
  screenToWorldOnPlaneZ,
  worldToScreen,
  type CameraPose,
} from './hybridViewportMath';
import { computePlanSheetCssMatrix, isApproximatelyIdentity } from './planSheetTransform';

const VP = { width: 1280, height: 800 };
const degToRad = (deg: number): number => (deg * Math.PI) / 180;
const POLAR = [0, 30, 55].map(degToRad);
const AZ = [0, 45].map(degToRad);

const pose = (
  polar: number,
  azimuth: number,
  target = new THREE.Vector3(0, 0, 0),
): CameraPose => ({ target, polar, azimuth, distance: 1_000_000 });

describe('screen↔world round-trip at polar {0,30,55}° × azimuth {0,45}° (reference SPEC §10)', () => {
  for (const p of POLAR) {
    for (const a of AZ) {
      it(`ortho polar=${((p * 180) / Math.PI).toFixed(0)}° az=${((a * 180) / Math.PI).toFixed(0)}°`, () => {
        const cam = makeOrthoCamera(pose(p, a), VP, 0.1);
        fc.assert(
          fc.property(
            fc.double({ min: -40_000, max: 40_000, noNaN: true }),
            fc.double({ min: -40_000, max: 40_000, noNaN: true }),
            (x, y) => {
              const world = new THREE.Vector3(x, y, 0);
              const s = worldToScreen(world, cam, VP);
              const back = screenToWorldOnPlaneZ(s.x, s.y, cam, VP, 0);
              expect(back).not.toBeNull();
              expect(back!.distanceTo(world)).toBeLessThan(0.01); // mm
            },
          ),
          { numRuns: 40 },
        );
      });
    }
  }
});

describe('pose-based board derivation (regression: RMB-down board jump)', () => {
  it('derives the board view from the SCREEN CENTRE, not the camera target', () => {
    // Simulate camera-controls after setOrbitPoint: the camera keeps its
    // orientation but is laterally offset, so the "target" it orbits is the
    // point under the CURSOR — while the screen centre shows somewhere else.
    fc.assert(
      fc.property(
        fc.constantFrom(...POLAR),
        fc.constantFrom(...AZ),
        fc.double({ min: -300, max: 300, noNaN: true }),
        fc.double({ min: -200, max: 200, noNaN: true }),
        (p, a, focalOffsetPxX, focalOffsetPxY) => {
          const zoom = 0.1; // px per mm
          const cam = makeOrthoCamera(pose(p, a), VP, zoom);
          // Lateral shift in camera space == a focal offset: orientation and
          // zoom unchanged, looked-at point no longer at the screen centre.
          const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
          cam.position
            .addScaledVector(right, focalOffsetPxX / zoom)
            .addScaledVector(up, focalOffsetPxY / zoom);
          cam.updateMatrixWorld(true);

          const trueCenter = screenToWorldOnPlaneZ(VP.width / 2, VP.height / 2, cam, VP, 0);
          expect(trueCenter).not.toBeNull();
          const derived = deriveBoardViewFromCamera(cam, VP);
          // The derived flat mapping must place the true screen-centre world
          // point exactly at the screen centre: pan + zoom·model == centre px.
          const centreModel = { x: trueCenter!.x, y: -trueCenter!.y };
          const sx = derived.panPxX + derived.zoom * MM_TO_PX * centreModel.x;
          const sy = derived.panPxY + derived.zoom * MM_TO_PX * centreModel.y;
          expect(sx).toBeCloseTo(VP.width / 2, 3);
          expect(sy).toBeCloseTo(VP.height / 2, 3);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('agrees with the DOM mapping for every model point while flat', () => {
    const cam = makeOrthoCamera(pose(1e-6, 0, modelPointToWorld({ x: 4200, y: 2600 })), VP, 0.08792);
    const derived = deriveBoardViewFromCamera(cam, VP);
    fc.assert(
      fc.property(
        fc.double({ min: -30_000, max: 30_000, noNaN: true }),
        fc.double({ min: -30_000, max: 30_000, noNaN: true }),
        (mx, my) => {
          const viaCamera = worldToScreen(modelPointToWorld({ x: mx, y: my }), cam, VP);
          const viaDom = {
            x: derived.panPxX + derived.zoom * MM_TO_PX * mx,
            y: derived.panPxY + derived.zoom * MM_TO_PX * my,
          };
          expect(viaCamera.x).toBeCloseTo(viaDom.x, 2);
          expect(viaCamera.y).toBeCloseTo(viaDom.y, 2);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('azimuth flatness (regression: rotated grid under a flat plan)', () => {
  it('a flat-polar view with non-zero azimuth is NOT identity for the sheet', () => {
    const az = degToRad(30);
    const vpt = [0.35, 0, 0, 0.35, 120, -80] as const;
    const pxPerMm = vpt[0] * MM_TO_PX;
    const centerModel = {
      x: (VP.width / 2 - vpt[4]) / pxPerMm,
      y: (VP.height / 2 - vpt[5]) / pxPerMm,
    };
    const cam = makeOrthoCamera(
      pose(1e-6, az, modelPointToWorld(centerModel)),
      VP,
      pxPerMm,
    );
    const matrix = computePlanSheetCssMatrix(cam, vpt, VP.width, VP.height);
    // The sheet must keep this rotation applied — snapping to identity here
    // is exactly the "grid rotated under the plan" bug.
    expect(isApproximatelyIdentity(matrix, 1e-3)).toBe(false);
    // …and it is a pure rotation: determinant 1, orthonormal columns.
    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    expect(det).toBeCloseTo(1, 6);
    expect(Math.hypot(matrix.a, matrix.b)).toBeCloseTo(1, 6);
  });

  it('azimuth 0 at flat polar IS identity (the only state allowed to drop the matrix)', () => {
    const vpt = [0.35, 0, 0, 0.35, 120, -80] as const;
    const pxPerMm = vpt[0] * MM_TO_PX;
    const centerModel = {
      x: (VP.width / 2 - vpt[4]) / pxPerMm,
      y: (VP.height / 2 - vpt[5]) / pxPerMm,
    };
    const cam = makeOrthoCamera(
      pose(1e-6, 0, modelPointToWorld(centerModel)),
      VP,
      pxPerMm,
    );
    const matrix = computePlanSheetCssMatrix(cam, vpt, VP.width, VP.height);
    expect(isApproximatelyIdentity(matrix, 1e-3)).toBe(true);
  });
});

describe('zoom clamp (reference SPEC §10: mm-per-pixel ∈ [0.02, 20 000])', () => {
  it('clamps both ends and passes values in range', () => {
    expect(1 / clampOrthoZoom(1e9)).toBeCloseTo(MIN_MM_PER_PX, 10);
    expect(1 / clampOrthoZoom(1e-9)).toBeCloseTo(MAX_MM_PER_PX, 6);
    expect(clampOrthoZoom(0.1)).toBe(0.1);
  });
});

describe('poseUp continuity at the top-down pole', () => {
  it('matches the polar→0 limit of the generic up for every azimuth', () => {
    fc.assert(
      fc.property(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), (az) => {
        // Screen-up for a slightly tilted camera (unambiguous) …
        const tilted = makeOrthoCamera(pose(degToRad(2), az), VP, 0.1);
        const upTilted = new THREE.Vector3().setFromMatrixColumn(tilted.matrixWorld, 1);
        // …must agree with the explicit pole limit used when flat.
        const limit = poseUp(1e-6, az);
        expect(upTilted.dot(limit)).toBeGreaterThan(0.99);
      }),
      { numRuns: 60 },
    );
  });
});
