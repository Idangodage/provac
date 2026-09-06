import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  buildPipeCenterline,
  centerlineLength,
} from './pipeCenterline';
import {
  toCurvePath3D,
  toOffsetCurvePath3D,
} from './pipeCenterline3d';
import { CircularArcCurve3 } from './three3d/pipeJointGeometry';

describe('toCurvePath3D', () => {
  it('preserves the canonical 90-degree circular arc exactly', () => {
    const centerline = buildPipeCenterline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      20,
    );
    const path = toCurvePath3D(centerline, 45)!;

    expect(path.curves).toHaveLength(3);
    expect(path.curves[0]).toBeInstanceOf(THREE.LineCurve3);
    expect(path.curves[1]).toBeInstanceOf(CircularArcCurve3);
    expect(path.curves[2]).toBeInstanceOf(THREE.LineCurve3);
    expect(
      path.curves.some((curve) => curve instanceof THREE.QuadraticBezierCurve3),
    ).toBe(false);

    const arc = path.curves[1] as CircularArcCurve3;
    expect(arc.center.distanceTo(new THREE.Vector3(80, 20, 45))).toBeLessThan(
      1e-9,
    );
    expect(arc.getPoint(0).distanceTo(new THREE.Vector3(80, 0, 45))).toBeLessThan(
      1e-9,
    );
    expect(
      arc.getPoint(1).distanceTo(new THREE.Vector3(100, 20, 45)),
    ).toBeLessThan(1e-9);
    expect(arc.radius).toBeCloseTo(20, 9);
    expect(path.getLength()).toBeCloseTo(centerlineLength(centerline), 9);
  });
});

describe('toOffsetCurvePath3D', () => {
  it('keeps a pipe pair at exact centre spacing through lines and a bend', () => {
    const centerline = buildPipeCenterline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      30,
    );
    const centerSpacingMm = 20;
    const left = toOffsetCurvePath3D(
      centerline,
      12,
      centerSpacingMm / 2,
    )!;
    const right = toOffsetCurvePath3D(
      centerline,
      12,
      -centerSpacingMm / 2,
    )!;

    expect(left.curves).toHaveLength(3);
    expect(right.curves).toHaveLength(3);
    for (let curveIndex = 0; curveIndex < left.curves.length; curveIndex += 1) {
      const leftCurve = left.curves[curveIndex]!;
      const rightCurve = right.curves[curveIndex]!;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        expect(leftCurve.getPoint(t).distanceTo(rightCurve.getPoint(t))).toBeCloseTo(
          centerSpacingMm,
          9,
        );
      }
    }

    const leftArc = left.curves[1] as CircularArcCurve3;
    const rightArc = right.curves[1] as CircularArcCurve3;
    expect(leftArc).toBeInstanceOf(CircularArcCurve3);
    expect(rightArc).toBeInstanceOf(CircularArcCurve3);
    expect(rightArc.radius - leftArc.radius).toBeCloseTo(centerSpacingMm, 9);
    expect(leftArc.center.distanceTo(rightArc.center)).toBeLessThan(1e-9);
  });
});
