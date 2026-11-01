import { describe, expect, it } from 'vitest';

import type { Vec2 } from './vec2';
import { subtractWallPolygons, unionWallRings, wallPolygonsArea } from './wallUnion';

const box = (x: number, y: number, w: number, h: number): Vec2[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const ringArea = (ring: readonly Vec2[]): number => {
  let doubled = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    doubled += a[0] * b[1] - b[0] * a[1];
  });
  return doubled / 2;
};

describe('unionWallRings', () => {
  it('merges overlapping rings into one polygon with the true area', () => {
    const { polygons, exact } = unionWallRings([box(0, 0, 100, 100), box(50, 50, 100, 100)]);
    expect(exact).toBe(true);
    expect(polygons).toHaveLength(1);
    expect(wallPolygonsArea(polygons)).toBeCloseTo(17500, 6);
  });

  it('merges rings that only share an edge, leaving no seam vertex behind', () => {
    const { polygons } = unionWallRings([box(0, 0, 100, 50), box(100, 0, 100, 50)]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(1);
    expect(polygons[0]![0]).toHaveLength(4);
  });

  it('does not cancel overlapping rings wound in opposite directions', () => {
    const { polygons } = unionWallRings([box(0, 0, 100, 100), [...box(50, 0, 100, 100)].reverse()]);
    expect(wallPolygonsArea(polygons)).toBeCloseTo(15000, 6);
  });

  it('keeps an enclosed space as a hole wound against its outer ring', () => {
    const { polygons } = unionWallRings([
      box(0, 0, 1000, 100),
      box(0, 900, 1000, 100),
      box(0, 0, 100, 1000),
      box(900, 0, 100, 1000),
    ]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
    expect(ringArea(polygons[0]![0]!)).toBeGreaterThan(0);
    expect(ringArea(polygons[0]![1]!)).toBeLessThan(0);
    expect(wallPolygonsArea(polygons)).toBeCloseTo(1000 * 1000 - 800 * 800, 6);
  });

  it('keeps truly separate bodies separate', () => {
    expect(unionWallRings([box(0, 0, 10, 10), box(100, 0, 10, 10)]).polygons).toHaveLength(2);
  });

  it('closes a hairline gap narrower than the grid', () => {
    const { polygons } = unionWallRings([box(0, 0, 100, 50), box(100.001, 0, 100, 50)]);
    expect(polygons).toHaveLength(1);
  });

  it('drops slit-shaped debris instead of reporting a hole', () => {
    // Two walls almost meeting along their whole length, 0.02 mm apart inside a frame.
    const { polygons } = unionWallRings([
      box(0, 0, 4000, 100),
      box(0, 100.02, 4000, 100),
      box(0, 0, 50, 200.02),
      box(3950, 0, 50, 200.02),
    ]);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(1);
  });

  it('ignores rings that collapse on the grid', () => {
    const collapsed: Vec2[] = [[0, 0], [0.001, 0], [0.001, 0.001]];
    const line: Vec2[] = [[0, 0], [100, 0], [200, 0]];
    expect(unionWallRings([collapsed, line]).polygons).toEqual([]);
    expect(unionWallRings([]).exact).toBe(true);
    expect(unionWallRings([box(0, 0, 10, 10), collapsed]).polygons).toHaveLength(1);
  });

  it('accepts rings given closed', () => {
    const closed = [...box(0, 0, 10, 10), [0, 0] as Vec2];
    expect(wallPolygonsArea(unionWallRings([closed]).polygons)).toBeCloseTo(100, 6);
  });

  it('answers on the nearly-collinear shapes that make the float clipper throw', () => {
    // A straight run changing thickness, slightly off straight: turf failed on this family.
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 400; run += 1) {
      const angle = (random() * Math.PI) / 90;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const h = 50 + random() * 100;
      const tilted = box(-4000, -h, 4000, 2 * h).map(([x, y]): Vec2 => [x * c - y * s, x * s + y * c]);
      const { exact, polygons } = unionWallRings([box(0, -100, 4000, 200), tilted]);
      expect(exact).toBe(true);
      expect(polygons.length).toBeGreaterThan(0);
    }
  });
});

describe('subtractWallPolygons', () => {
  it('leaves the room inside a frame of walls as its own polygon', () => {
    const walls = unionWallRings([
      box(0, 0, 1000, 100),
      box(0, 900, 1000, 100),
      box(0, 0, 100, 1000),
      box(900, 0, 100, 1000),
    ]).polygons;
    const { polygons, exact } = subtractWallPolygons([[box(-500, -500, 2000, 2000)]], walls);
    expect(exact).toBe(true);
    const areas = polygons.map((polygon) => wallPolygonsArea([polygon])).sort((a, b) => a - b);
    expect(areas).toHaveLength(2);
    expect(areas[0]).toBeCloseTo(800 * 800, 6); // the room
    expect(areas[1]).toBeCloseTo(2000 * 2000 - 1000 * 1000, 6); // outside, with the building as a hole
  });
});
