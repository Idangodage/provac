import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { modelPointToWorld } from '../modelSpace';
import { MM_TO_PX } from '../scale';

import {
  SHEET_FADE_END_RAD,
  WALL_RISE_END_RAD,
  computePlanSheetCssMatrix,
  isApproximatelyIdentity,
  planSheetOpacityForPolar,
  wallRiseForPolar,
  type PlanSheetCssMatrix,
} from './planSheetTransform';

/** camera-controls pose at azimuth 0 for a z-up ortho camera (see modelSpace tests). */
function makeHybridCamera(
  polar: number,
  fabricVpt: readonly number[],
  width: number,
  height: number,
): THREE.OrthographicCamera {
  const zoom = fabricVpt[0]!;
  const pxPerMm = zoom * MM_TO_PX;
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
  const centerModel = {
    x: (width / 2 - fabricVpt[4]!) / pxPerMm,
    y: (height / 2 - fabricVpt[5]!) / pxPerMm,
  };
  const target = modelPointToWorld(centerModel);
  const radius = 1_000_000;
  camera.position.set(
    target.x,
    target.y - radius * Math.sin(polar),
    target.z + radius * Math.cos(polar),
  );
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function applyCssMatrix(
  matrix: PlanSheetCssMatrix,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

function projectModel(
  camera: THREE.Camera,
  point: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  const ndc = modelPointToWorld(point).project(camera);
  return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
}

describe('plan sheet CSS matrix', () => {
  const width = 1280;
  const height = 800;
  const viewports: ReadonlyArray<readonly number[]> = [
    [1, 0, 0, 1, 0, 0],
    [0.42, 0, 0, 0.42, 260, -140],
    [3.4, 0, 0, 3.4, -1200, 480],
  ];
  const modelPoints = [
    { x: 0, y: 0 },
    { x: 1587, y: 1122 },
    { x: -2600, y: 4200 },
    { x: 30000, y: -12000 },
  ];

  it('is the identity while the view is flat', () => {
    viewports.forEach((vpt) => {
      const camera = makeHybridCamera(1e-6, vpt, width, height);
      const matrix = computePlanSheetCssMatrix(camera, vpt, width, height);
      expect(isApproximatelyIdentity(matrix, 1e-3)).toBe(true);
    });
  });

  it('maps every flat DOM point onto the tilted camera projection exactly', () => {
    const polar = THREE.MathUtils.degToRad(30);
    viewports.forEach((vpt) => {
      const camera = makeHybridCamera(polar, vpt, width, height);
      const matrix = computePlanSheetCssMatrix(camera, vpt, width, height);
      const pxPerMm = vpt[0]! * MM_TO_PX;

      modelPoints.forEach((point) => {
        // Where the FLAT sheet draws the point today…
        const flatDom = {
          x: vpt[4]! + pxPerMm * point.x,
          y: vpt[5]! + pxPerMm * point.y,
        };
        // …CSS-transformed by the sheet matrix…
        const sheet = applyCssMatrix(matrix, flatDom);
        // …must equal the 3D scene's projection of the same model point.
        const three = projectModel(camera, point, width, height);
        expect(sheet.x).toBeCloseTo(three.x, 4);
        expect(sheet.y).toBeCloseTo(three.y, 4);
      });
    });
  });

  it('fades the sheet only inside the tuned polar band', () => {
    expect(planSheetOpacityForPolar(0)).toBe(1);
    expect(planSheetOpacityForPolar(THREE.MathUtils.degToRad(1))).toBe(1);
    const mid = planSheetOpacityForPolar(THREE.MathUtils.degToRad(6));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(planSheetOpacityForPolar(THREE.MathUtils.degToRad(12))).toBe(0);
    expect(planSheetOpacityForPolar(THREE.MathUtils.degToRad(45))).toBe(0);
  });

  it('keeps walls FLAT through the whole sheet crossfade, then rises them', () => {
    // While any part of the sheet is visible the walls must have no height —
    // a tall solid parallax-shifts its top by height·tanφ and reads as a
    // broken double wall over the plan (the reported T-junction artifact).
    expect(wallRiseForPolar(0)).toBe(0);
    expect(wallRiseForPolar(SHEET_FADE_END_RAD)).toBe(0);
    for (let f = 0; f <= 1; f += 0.1) {
      const polar = f * SHEET_FADE_END_RAD;
      expect(wallRiseForPolar(polar)).toBe(0);
    }
    // …then monotonically rises to full height once the sheet is gone.
    let prev = 0;
    for (let f = 0.05; f <= 1; f += 0.05) {
      const polar = SHEET_FADE_END_RAD + f * (WALL_RISE_END_RAD - SHEET_FADE_END_RAD);
      const rise = wallRiseForPolar(polar);
      expect(rise).toBeGreaterThanOrEqual(prev);
      prev = rise;
    }
    expect(wallRiseForPolar(WALL_RISE_END_RAD)).toBe(1);
    expect(wallRiseForPolar(THREE.MathUtils.degToRad(58))).toBe(1);
  });
});
