import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  buildCylinderGeometry,
  buildSweptTubeGeometry,
  buildTubeCurve,
  CircularArcCurve3,
  simplifyTubePoints,
  unionGeometries,
} from "./pipeJointGeometry";

const vec = (x: number, y: number, z = 0): THREE.Vector3 =>
  new THREE.Vector3(x, y, z);

function crossSectionExtent(geometry: THREE.BufferGeometry): {
  axis: number;
  width: number;
  height: number;
} {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  return {
    axis: box.max.x - box.min.x,
    width: box.max.y - box.min.y,
    height: box.max.z - box.min.z,
  };
}

describe("simplifyTubePoints", () => {
  it("drops duplicate and near-collinear points", () => {
    const points = [vec(0, 0), vec(0, 0), vec(50, 0), vec(100, 0), vec(100, 80)];
    const simplified = simplifyTubePoints(points);
    // The two leading duplicates collapse and the collinear midpoint at (50,0)
    // is removed, leaving the corner and both ends.
    expect(simplified).toHaveLength(3);
    expect(simplified[0]!.x).toBe(0);
    expect(simplified[2]!.y).toBe(80);
  });
});

describe("buildTubeCurve", () => {
  it("recovers the plan's sampled circle and its tangents without applying a second fillet", () => {
    const samples = Array.from({ length: 25 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI / 48;
      return vec(400 + Math.cos(angle) * 100, 200 + Math.sin(angle) * 100);
    });
    const points = [vec(0, 100), ...samples, vec(500, 700)];
    const curve = buildTubeCurve(points, 60, true)!;
    expect(curve.curves).toHaveLength(3);
    const arc = curve.curves[1] as CircularArcCurve3;
    expect(arc).toBeInstanceOf(CircularArcCurve3);
    expect(arc.radius).toBeCloseTo(100, 7);
    expect(arc.center.distanceTo(vec(400, 200))).toBeLessThan(1e-7);
    expect(arc.getTangent(0).distanceTo(vec(1, 0))).toBeLessThan(1e-7);
    expect(arc.getTangent(1).distanceTo(vec(0, 1))).toBeLessThan(1e-7);
    expect(curve.getPoint(0).distanceTo(points[0]!)).toBeLessThan(1e-7);
    expect(curve.getPoint(1).distanceTo(points.at(-1)!)).toBeLessThan(1e-7);
    samples.forEach((sample, index) => expect(arc.getPoint(index / 24).distanceTo(sample)).toBeLessThan(1e-7));
  });

  it("recovers consecutive opposing circles with an exact shared tangent and preserves elevation", () => {
    const first = Array.from({ length: 25 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI / 48;
      return vec(200 + Math.cos(angle) * 100, 100 + Math.sin(angle) * 100, 2457);
    });
    const second = Array.from({ length: 24 }, (_, index) => {
      const angle = Math.PI - (index + 1) * Math.PI / 48;
      return vec(400 + Math.cos(angle) * 100, 100 + Math.sin(angle) * 100, 2457);
    });
    const points = [vec(0, 0, 2457), ...first, ...second, vec(700, 200, 2457)];
    const snapshot = points.map(point => point.clone());
    const curve = buildTubeCurve(points, 10, true)!;
    const arcs = curve.curves.filter((part): part is CircularArcCurve3 => part instanceof CircularArcCurve3);
    expect(arcs).toHaveLength(2);
    expect(arcs[0]!.radius).toBeCloseTo(100, 7);
    expect(arcs[1]!.radius).toBeCloseTo(100, 7);
    expect(arcs[0]!.sweepRadians).toBeCloseTo(Math.PI / 2, 7);
    expect(arcs[1]!.sweepRadians).toBeCloseTo(-Math.PI / 2, 7);
    expect(arcs[0]!.getTangent(1).distanceTo(arcs[1]!.getTangent(0))).toBeLessThan(1e-7);
    expect(arcs[0]!.getPoint(1).distanceTo(arcs[1]!.getPoint(0))).toBeLessThan(1e-7);
    for (const arc of arcs) for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(arc.getPoint(t).z).toBe(2457);
    expect(points).toEqual(snapshot);
  });

  it.each([
    [vec(0, 0), vec(400, 0), vec(400, 400), vec(900, 400)],
    [vec(0, 0), vec(400, 0), vec(425, 4), vec(447, 15), vec(466, 38), vec(900, 400)],
    // Co-circular samples must still have actual straight tangent joins.
    [vec(0, 0), ...Array.from({ length: 13 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI / 24;
      return vec(400 + Math.cos(angle) * 100, 200 + Math.sin(angle) * 100);
    }), vec(900, 700)],
  ])("preserves manual or non-tangent plan geometry without inventing smooth bends", (...points) => {
    const curve = buildTubeCurve(points, 80, true)!;
    expect(curve.curves.every(part => part instanceof THREE.LineCurve3)).toBe(true);
    expect(curve.curves).toHaveLength(points.length - 1);
    curve.curves.forEach((part, index) => {
      expect(part.getPoint(0).distanceTo(points[index]!)).toBeLessThan(1e-8);
      expect(part.getPoint(1).distanceTo(points[index + 1]!)).toBeLessThan(1e-8);
    });
  });

  it("still rounds a vertical riser when the plan already supplies its bends", () => {
    const curve = buildTubeCurve([vec(0, 0), vec(400, 0), vec(400, 0, 500)], 40, true)!;
    expect(curve.curves.some((part) => part instanceof CircularArcCurve3)).toBe(true);
  });

  it.each([80, 400])("retains both full-radius elbows on a %i mm vertical riser", riseMm => {
    const radius = 40;
    // The lane lift may insert socket and straight-span sample points. The
    // sweep's normal cleanup must remove those without shortening either bend.
    const points = simplifyTubePoints([
      vec(0, 0, 100), vec(200, 0, 100), vec(400, 0, 100),
      vec(400, 0, 100 + riseMm), vec(600, 0, 100 + riseMm), vec(1000, 0, 100 + riseMm),
    ]);
    const curve = buildTubeCurve(points, radius, true)!;
    const arcs = curve.curves.filter((part): part is CircularArcCurve3 => part instanceof CircularArcCurve3);
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) {
      expect(arc.radius).toBeCloseTo(radius, 9);
      expect(arc.sweepRadians).toBeCloseTo(Math.PI / 2, 9);
    }
    for (let index = 1; index < curve.curves.length; index += 1) {
      expect(curve.curves[index]!.getPoint(0).distanceTo(curve.curves[index - 1]!.getPoint(1))).toBeLessThan(1e-8);
    }
    for (const part of curve.curves.filter((item): item is THREE.LineCurve3 => item instanceof THREE.LineCurve3)) {
      const from = part.getPoint(0); const to = part.getPoint(1);
      expect(Math.hypot(to.x - from.x, to.y - from.y) <= 1e-8 || Math.abs(to.z - from.z) <= 1e-8).toBe(true);
    }
    expect(arcs[0]!.getPoint(1).z).toBeCloseTo(100 + radius, 9);
    expect(arcs[1]!.getPoint(0).z).toBeCloseTo(100 + riseMm - radius, 9);
    expect(curve.getPoint(0).distanceTo(points[0]!)).toBeLessThan(1e-8);
    expect(curve.getPoint(1).distanceTo(points.at(-1)!)).toBeLessThan(1e-8);
  });

  it("returns a single straight curve for two points", () => {
    const curve = buildTubeCurve([vec(0, 0), vec(100, 0)], 20);
    expect(curve).not.toBeNull();
    expect(curve!.curves).toHaveLength(1);
    expect(curve!.getLength()).toBeCloseTo(100, 3);
  });

  it("inserts a rounded fillet at an interior corner", () => {
    const curve = buildTubeCurve([vec(0, 0), vec(100, 0), vec(100, 100)], 20);
    expect(curve).not.toBeNull();
    // line -> exact circular arc -> line for a single corner.
    expect(curve!.curves).toHaveLength(3);
    expect(curve!.curves[0]).toBeInstanceOf(THREE.LineCurve3);
    expect(curve!.curves[1]).toBeInstanceOf(CircularArcCurve3);
    expect(curve!.curves[2]).toBeInstanceOf(THREE.LineCurve3);
    // A rounded corner is strictly shorter than the 200mm sharp path.
    expect(curve!.getLength()).toBeLessThan(200);
  });

  it("constructs an exact policy-radius quarter circle for a 90-degree bend", () => {
    const bendRadiusMm = 20;
    const curve = buildTubeCurve(
      [vec(0, 0), vec(100, 0), vec(100, 100)],
      bendRadiusMm,
    )!;
    const arc = curve.curves[1] as CircularArcCurve3;

    expect(arc).toBeInstanceOf(CircularArcCurve3);
    expect(arc.center.distanceTo(vec(80, 20))).toBeLessThan(1e-9);
    expect(arc.getPoint(0).distanceTo(vec(80, 0))).toBeLessThan(1e-9);
    expect(arc.getPoint(1).distanceTo(vec(100, 20))).toBeLessThan(1e-9);
    expect(arc.radius).toBeCloseTo(bendRadiusMm, 9);
    expect(arc.getLength()).toBeCloseTo((Math.PI * bendRadiusMm) / 2, 9);
    expect(arc.getPoint(0.5).distanceTo(arc.center)).toBeCloseTo(
      bendRadiusMm,
      9,
    );
    expect(arc.getTangent(0).distanceTo(vec(1, 0))).toBeLessThan(1e-9);
    expect(arc.getTangent(1).distanceTo(vec(0, 1))).toBeLessThan(1e-9);
    expect(curve.getLength()).toBeCloseTo(
      160 + (Math.PI * bendRadiusMm) / 2,
      9,
    );
  });
});

describe("adaptive pipe sweep detail", () => {
  it("retains a small circular elbow on a 200 metre route without oversampling its straights", () => {
    const radius = 40;
    const radialSegments = 12;
    const geometry = buildSweptTubeGeometry([
      vec(0, 0), vec(100_000, 0), vec(100_000, 100_000),
    ], 5, { bendRadiusMm: radius, radialSegments, capStart: false, capEnd: false })!;
    const positions = geometry.getAttribute("position");
    const ringSize = radialSegments + 1;
    const centers: THREE.Vector3[] = [];
    for (let start = 0; start < positions.count; start += ringSize) {
      const center = vec(0, 0);
      for (let index = 0; index < radialSegments; index += 1) {
        center.add(new THREE.Vector3().fromBufferAttribute(positions, start + index));
      }
      centers.push(center.multiplyScalar(1 / radialSegments));
    }
    const elbowRings = centers.filter((point) => point.x > 99_900 && point.y < 100);
    expect(elbowRings.length).toBeGreaterThanOrEqual(24);
    for (const center of elbowRings) {
      expect(Math.abs(center.distanceTo(vec(99_960, 40)) - radius)).toBeLessThan(0.01);
    }
    expect(positions.count).toBeLessThan(500);
    expect(centers[0]!.distanceTo(vec(0, 0))).toBeLessThan(0.001);
    expect(centers[centers.length - 1]!.distanceTo(vec(100_000, 100_000))).toBeLessThan(0.001);
    geometry.dispose();
  });
});

describe("buildSweptTubeGeometry", () => {
  it("produces one BufferGeometry (not a group) with positions", () => {
    const geometry = buildSweptTubeGeometry(
      [vec(0, 0), vec(100, 0)],
      10,
      { bendRadiusMm: 20 },
    );
    expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(geometry!.getAttribute("position").count).toBeGreaterThan(0);
    expect(geometry!.getAttribute("normal")).toBeTruthy();
  });

  it("keeps a constant ~2r cross-section along a straight run", () => {
    const radius = 12;
    const geometry = buildSweptTubeGeometry(
      [vec(0, 0), vec(200, 0)],
      radius,
      { bendRadiusMm: 24 },
    )!;
    const { axis, width, height } = crossSectionExtent(geometry);
    expect(axis).toBeCloseTo(200, 0);
    // 24-facet tube: cross dimension is between the inscribed and circumscribed
    // diameter, i.e. close to 2r with no ball-joint bulge.
    expect(width).toBeGreaterThan(radius * 1.9);
    expect(width).toBeLessThan(radius * 2.1);
    expect(height).toBeGreaterThan(radius * 1.9);
    expect(height).toBeLessThan(radius * 2.1);
  });

  it("returns null for degenerate input", () => {
    expect(
      buildSweptTubeGeometry([vec(0, 0)], 10, { bendRadiusMm: 20 }),
    ).toBeNull();
    expect(
      buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 0, {
        bendRadiusMm: 20,
      }),
    ).toBeNull();
  });

  it("adds cap geometry when ends are closed", () => {
    const open = buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 10, {
      bendRadiusMm: 20,
      capStart: false,
      capEnd: false,
    })!;
    const closed = buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 10, {
      bendRadiusMm: 20,
      capStart: true,
      capEnd: true,
    })!;
    expect(closed.getAttribute("position").count).toBeGreaterThan(
      open.getAttribute("position").count,
    );
  });
});

describe("buildCylinderGeometry", () => {
  it("spans the two endpoints at the given radius", () => {
    const radius = 8;
    const geometry = buildCylinderGeometry(vec(0, 0), vec(0, 0, 50), radius)!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.z - box.min.z).toBeCloseTo(50, 0);
    expect(box.max.x - box.min.x).toBeGreaterThan(radius * 1.9);
    expect(box.max.x - box.min.x).toBeLessThan(radius * 2.1);
  });
});

describe("unionGeometries", () => {
  it("returns the single input unchanged", () => {
    const geometry = buildCylinderGeometry(vec(0, 0), vec(50, 0), 10)!;
    expect(unionGeometries([geometry])).toBe(geometry);
    expect(unionGeometries([null, undefined])).toBeNull();
  });

  it("boolean-unions overlapping solids headlessly into one watertight mesh", () => {
    // A run cylinder and a perpendicular branch that intersects it — the tee
    // case that used to interpenetrate.
    const run = buildCylinderGeometry(vec(-100, 0), vec(100, 0), 15)!;
    const branch = buildCylinderGeometry(vec(0, 0), vec(0, 120), 8)!;
    const union = unionGeometries([run, branch]);
    // Duck-typed (not `instanceof`): under Node the CSG library loads its own
    // three build, so the result's class identity differs from this file's
    // ESM three even though it is structurally a BufferGeometry.
    expect(union).not.toBeNull();
    expect((union as THREE.BufferGeometry).isBufferGeometry).toBe(true);
    expect(union!.getAttribute("position").count).toBeGreaterThan(0);
    // The union must span both inputs' extents.
    union!.computeBoundingBox();
    const box = union!.boundingBox!;
    expect(box.min.x).toBeLessThanOrEqual(-99);
    expect(box.max.x).toBeGreaterThanOrEqual(99);
    expect(box.max.y).toBeGreaterThanOrEqual(119);
  });
});
