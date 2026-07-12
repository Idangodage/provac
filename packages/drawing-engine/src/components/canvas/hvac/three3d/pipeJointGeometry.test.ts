import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  buildCylinderGeometry,
  buildSweptTubeGeometry,
  buildTubeCurve,
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
  it("returns a single straight curve for two points", () => {
    const curve = buildTubeCurve([vec(0, 0), vec(100, 0)], 20);
    expect(curve).not.toBeNull();
    expect(curve!.curves).toHaveLength(1);
    expect(curve!.getLength()).toBeCloseTo(100, 3);
  });

  it("inserts a rounded fillet at an interior corner", () => {
    const curve = buildTubeCurve([vec(0, 0), vec(100, 0), vec(100, 100)], 20);
    expect(curve).not.toBeNull();
    // line -> bezier -> line for a single corner.
    expect(curve!.curves.length).toBeGreaterThanOrEqual(3);
    // A rounded corner is strictly shorter than the 200mm sharp path.
    expect(curve!.getLength()).toBeLessThan(200);
  });
});

describe("buildSweptTubeGeometry", () => {
  it("produces one BufferGeometry (not a group) with positions", () => {
    const geometry = buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 10);
    expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(geometry!.getAttribute("position").count).toBeGreaterThan(0);
    expect(geometry!.getAttribute("normal")).toBeTruthy();
  });

  it("keeps a constant ~2r cross-section along a straight run", () => {
    const radius = 12;
    const geometry = buildSweptTubeGeometry([vec(0, 0), vec(200, 0)], radius)!;
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
    expect(buildSweptTubeGeometry([vec(0, 0)], 10)).toBeNull();
    expect(buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 0)).toBeNull();
  });

  it("adds cap geometry when ends are closed", () => {
    const open = buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 10, {
      capStart: false,
      capEnd: false,
    })!;
    const closed = buildSweptTubeGeometry([vec(0, 0), vec(100, 0)], 10, {
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
