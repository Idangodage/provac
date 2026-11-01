/**
 * The whole-junction contract, measured against what the walls should form: the
 * union of their square-ended rectangles. Random junctions from a fixed seed, so
 * a failure reproduces. All of these failed before the junction rules changed
 * (a six-wall junction was split apart 78% of the time).
 */
import { describe, expect, it } from 'vitest';

import { add2, dist2, dot2, perp2, scale2, sub2, type Vec2 } from './vec2';
import type { WallJustification } from './wallModel';
import { polygonArea, solveWalls, type SolverEdge, type SolverNode, type WallSolveResult } from './wallSolver';
import { subtractWallPolygons, unionWallRings, wallPolygonsArea } from './wallUnion';

interface TestWall {
  deg: number;
  thickness: number;
  length: number;
  justification?: WallJustification;
  height?: number;
  base?: number;
}

function sceneOf(walls: readonly TestWall[]): { nodes: SolverNode[]; edges: SolverEdge[] } {
  const nodes: SolverNode[] = [{ id: 'P', p: [0, 0] }];
  const edges: SolverEdge[] = [];
  walls.forEach((wall, k) => {
    const a = (wall.deg * Math.PI) / 180;
    nodes.push({ id: `n${k}`, p: [wall.length * Math.cos(a), wall.length * Math.sin(a)] });
    edges.push({
      id: `e${k}`,
      a: 'P',
      b: `n${k}`,
      thickness: wall.thickness,
      justification: wall.justification ?? 'center',
      height: wall.height ?? 2700,
      baseOffset: wall.base ?? 0,
    });
  });
  return { nodes, edges };
}

function halfWidthsOf(wall: TestWall): { hl: number; hr: number } {
  const j = wall.justification ?? 'center';
  if (j === 'center') return { hl: wall.thickness / 2, hr: wall.thickness / 2 };
  return j === 'left' ? { hl: 0, hr: wall.thickness } : { hl: wall.thickness, hr: 0 };
}

/** The wall's whole body: square at both ends, from the node to its far end. */
function bodyOf(wall: TestWall): Vec2[] {
  const a = (wall.deg * Math.PI) / 180;
  const u: Vec2 = [Math.cos(a), Math.sin(a)];
  const n = perp2(u);
  const { hl, hr } = halfWidthsOf(wall);
  const far = scale2(u, wall.length);
  return [scale2(n, hl), add2(far, scale2(n, hl)), add2(far, scale2(n, -hr)), scale2(n, -hr)];
}

function insideBody(q: Vec2, wall: TestWall, tolerance = 1): boolean {
  const a = (wall.deg * Math.PI) / 180;
  const u: Vec2 = [Math.cos(a), Math.sin(a)];
  const { hl, hr } = halfWidthsOf(wall);
  const along = dot2(q, u);
  const across = dot2(q, perp2(u));
  return along >= -tolerance && along <= wall.length + tolerance && across <= hl + tolerance && across >= -hr - tolerance;
}

function selfCrosses(ring: readonly Vec2[]): boolean {
  const side = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const n = ring.length;
  for (let k = 0; k < n; k += 1) {
    for (let l = k + 2; l < n; l += 1) {
      if (k === 0 && l === n - 1) continue;
      const [a, b, c, d] = [ring[k]!, ring[(k + 1) % n]!, ring[l]!, ring[(l + 1) % n]!];
      if (side(a, b, c) * side(a, b, d) < -1e-6 && side(c, d, a) * side(c, d, b) < -1e-6) return true;
    }
  }
  return false;
}

function piecesOf(solve: WallSolveResult): Vec2[][] {
  return [...solve.footprints.map((f) => [...f.corners]), ...solve.wedges.map((w) => w.polygon)];
}

/**
 * What may legitimately stand beyond the wall bodies: the corner each neighbouring
 * pair leaves open behind or between their square ends. Worked out here again from
 * first principles, independently of the solver: a miter where it stays within the
 * limit, otherwise a bevel.
 */
function openCorners(walls: readonly TestWall[]): Vec2[][] {
  const ordered = [...walls].sort((x, y) => ((x.deg % 360) + 360) % 360 - ((y.deg % 360) + 360) % 360);
  const rings: Vec2[][] = [];
  ordered.forEach((first, k) => {
    const second = ordered[(k + 1) % ordered.length]!;
    if (second === first) return;
    const ua: Vec2 = [Math.cos((first.deg * Math.PI) / 180), Math.sin((first.deg * Math.PI) / 180)];
    const ub: Vec2 = [Math.cos((second.deg * Math.PI) / 180), Math.sin((second.deg * Math.PI) / 180)];
    const turn = ua[0] * ub[1] - ua[1] * ub[0];
    if (Math.abs(turn) < 1e-9) return;
    // first's CCW face and second's CW face.
    const ha = first === undefined ? 0 : ccwWidthOf(first);
    const hb = cwWidthOf(second);
    const oa = scale2(perp2(ua), ha);
    const ob = scale2(perp2(ub), -hb);
    const d = sub2(ob, oa);
    const sa = (d[0] * ub[1] - d[1] * ub[0]) / turn;
    const sb = (d[0] * ua[1] - d[1] * ua[0]) / turn;
    const m = add2(oa, scale2(ua, sa));
    const limit = 2 * Math.max(first.thickness, second.thickness);
    const withinLimit = dist2(m, [0, 0]) <= limit;
    if (turn > 0) {
      const trueInnerCorner = sa >= -1e-6 && sb >= -1e-6;
      if (!trueInnerCorner && withinLimit) rings.push([oa, m, ob]);
    } else if (sa <= 1e-6 && sb <= 1e-6 && withinLimit) {
      rings.push([[0, 0], oa, m, ob]);
    } else {
      rings.push([[0, 0], oa, ob]);
    }
  });
  return rings;
}

const ccwWidthOf = (wall: TestWall): number => halfWidthsOf(wall).hl;
const cwWidthOf = (wall: TestWall): number => halfWidthsOf(wall).hr;

interface Verdict {
  holes: number;
  extra: number;
  bodies: number;
  idealBodies: number;
  twisted: number;
  spikes: number;
  exact: boolean;
}

function judge(walls: readonly TestWall[], solve = solveWalls(sceneOf(walls))): Verdict {
  const got = unionWallRings(piecesOf(solve));
  const ideal = unionWallRings(walls.map(bodyOf));
  const allowed = unionWallRings([...walls.map(bodyOf), ...openCorners(walls)]);
  const missing = subtractWallPolygons(ideal.polygons, got.polygons);
  const extra = subtractWallPolygons(got.polygons, allowed.polygons);
  const reach = 2 * Math.max(...walls.map((wall) => wall.thickness));
  const spikes = piecesOf(solve)
    .flat()
    .filter((q) => !walls.some((wall) => insideBody(q, wall)) && dist2(q, [0, 0]) > reach + 1).length;
  return {
    holes: wallPolygonsArea(missing.polygons),
    extra: wallPolygonsArea(extra.polygons),
    bodies: got.polygons.length,
    idealBodies: ideal.polygons.length,
    twisted: solve.footprints.filter((f) => selfCrosses(f.corners)).length + solve.wedges.filter((w) => selfCrosses(w.polygon)).length,
    spikes,
    exact: got.exact && ideal.exact && missing.exact && extra.exact,
  };
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function spacedAngles(random: () => number, count: number, minGap: number): number[] {
  for (;;) {
    const angles = Array.from({ length: count }, () => random() * 360).sort((x, y) => x - y);
    if (angles.every((angle, k) => ((angles[(k + 1) % count]! - angle + 360) % 360) >= minGap)) return angles;
  }
}

const THICKNESSES = [100, 150, 200, 230, 300];
const SIDES: WallJustification[] = ['center', 'left', 'right'];
const pick = <T,>(random: () => number, from: readonly T[]): T => from[Math.floor(random() * from.length)]!;

const FAMILIES: Array<[string, (random: () => number) => TestWall[]]> = [
  ['elbows', (r) => spacedAngles(r, 2, 10).map((deg) => ({ deg, thickness: 200, length: 4000 }))],
  ['three walls', (r) => spacedAngles(r, 3, 10).map((deg) => ({ deg, thickness: 200, length: 4000 }))],
  ['four walls', (r) => spacedAngles(r, 4, 10).map((deg) => ({ deg, thickness: 200, length: 4000 }))],
  ['five walls', (r) => spacedAngles(r, 5, 10).map((deg) => ({ deg, thickness: 200, length: 4000 }))],
  ['six walls', (r) => spacedAngles(r, 6, 10).map((deg) => ({ deg, thickness: 200, length: 4000 }))],
  ['seven walls, tight gaps', (r) => spacedAngles(r, 7, 5).map((deg) => ({ deg, thickness: 200, length: 4000 }))],
  ['mixed thickness', (r) => spacedAngles(r, 3 + Math.floor(r() * 4), 10).map((deg) => ({ deg, thickness: pick(r, THICKNESSES), length: 4000 }))],
  ['short walls', (r) => spacedAngles(r, 2 + Math.floor(r() * 4), 10).map((deg) => ({ deg, thickness: 200, length: 150 + r() * 450 }))],
  ['short walls, mixed thickness', (r) => spacedAngles(r, 2 + Math.floor(r() * 4), 10).map((deg) => ({ deg, thickness: pick(r, THICKNESSES), length: 150 + r() * 450 }))],
  ['flipped sides', (r) => spacedAngles(r, 3 + Math.floor(r() * 3), 10).map((deg) => ({ deg, thickness: 200, length: 4000, justification: pick(r, SIDES) }))],
  ['T, stem 8-30° off the through wall', (r) => {
    const off = 8 + r() * 22;
    return [
      { deg: 0, thickness: 200, length: 4000 },
      { deg: 180, thickness: 200, length: 4000 },
      { deg: 180 - off, thickness: 200, length: 4000 },
    ];
  }],
  ['straight run changing thickness', (r) => {
    const off = r() * 3;
    return [
      { deg: 0, thickness: pick(r, THICKNESSES), length: 4000 },
      { deg: 180 - off, thickness: pick(r, THICKNESSES), length: 4000 },
    ];
  }],
];

describe('the junction in the user’s picture', () => {
  const star: TestWall[] = [-90, 0, 41.4, 101.8, 151.6, 180].map((deg) => ({ deg, thickness: 200, length: 3000 }));

  it('forms one body with nothing missing', () => {
    const verdict = judge(star);
    expect(verdict.bodies).toBe(1);
    expect(verdict.holes).toBeLessThan(1);
  });

  it('has a clean six-corner core, with no corner dented in towards the node', () => {
    const { wedges } = solveWalls(sceneOf(star));
    expect(wedges).toHaveLength(1);
    const core = wedges[0]!.polygon;
    expect(core).toHaveLength(6);
    expect(selfCrosses(core)).toBe(false);
    expect(polygonArea(core)).toBeGreaterThan(0);
    // These two were the tip of the white triangle and the bottom of the sliver.
    expect(core.every((q) => dist2(q, [0, 100]) > 1)).toBe(true);
    expect(core.every((q) => dist2(q, [-48, -88]) > 1)).toBe(true);
    // Every corner is the point two neighbouring walls' faces meet, the tightest 28.4° pair included.
    expect(core.some((q) => dist2(q, [-(100 / Math.tan((28.4 * Math.PI) / 360)), 100]) < 1)).toBe(true);
  });

  it('gives each wall a quad that ends exactly on the core', () => {
    const { footprints, wedges } = solveWalls(sceneOf(star));
    const core = wedges[0]!.polygon;
    for (const footprint of footprints) {
      const [aL, , , aR] = footprint.corners;
      expect(core).toContainEqual(aL);
      expect(core).toContainEqual(aR);
    }
  });
});

describe('random junctions stay whole', () => {
  for (const [name, make] of FAMILIES) {
    it(`${name}: no holes, no extra solid, no split bodies, no twists, no spikes`, () => {
      const random = seeded(12345);
      for (let run = 0; run < 400; run += 1) {
        const walls = make(random);
        const verdict = judge(walls);
        const context = JSON.stringify(walls.map((w) => [+w.deg.toFixed(2), w.thickness, +w.length.toFixed(1), w.justification ?? 'c']));
        expect(verdict.exact, context).toBe(true);
        expect(verdict.holes, `missing area, ${context}`).toBeLessThan(1);
        expect(verdict.extra, `extra solid, ${context}`).toBeLessThan(1);
        expect(verdict.bodies, `bodies, ${context}`).toBeLessThanOrEqual(verdict.idealBodies);
        expect(verdict.twisted, `twisted, ${context}`).toBe(0);
        expect(verdict.spikes, `spikes, ${context}`).toBe(0);
      }
    });
  }

  it('walls and core do not overlap on equal, long walls (no z-fighting in 3D)', () => {
    const random = seeded(777);
    for (let run = 0; run < 300; run += 1) {
      const walls = spacedAngles(random, 2 + Math.floor(random() * 5), 10).map((deg) => ({ deg, thickness: 200, length: 4000 }));
      const pieces = piecesOf(solveWalls(sceneOf(walls)));
      // Both sides rounded to the same grid, so only real overlap can make them differ.
      const sum = pieces.reduce((total, piece) => total + wallPolygonsArea(unionWallRings([piece]).polygons), 0);
      expect(Math.abs(sum - wallPolygonsArea(unionWallRings(pieces).polygons))).toBeLessThan(1);
    }
  });

  it('the answer does not depend on the order nodes and edges arrive in', () => {
    const random = seeded(99);
    for (let run = 0; run < 100; run += 1) {
      const walls = spacedAngles(random, 3 + Math.floor(random() * 4), 10).map((deg) => ({
        deg,
        thickness: pick(random, THICKNESSES),
        length: run % 2 ? 4000 : 200 + random() * 400,
      }));
      const { nodes, edges } = sceneOf(walls);
      const reference = solveWalls({ nodes, edges });
      const shuffled = solveWalls({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
      expect(shuffled.footprints.map((f) => f.corners)).toEqual(reference.footprints.map((f) => f.corners));
      expect(shuffled.wedges.map((w) => w.polygon)).toEqual(reference.wedges.map((w) => w.polygon));
    }
  });
});

describe('junctions of unequal heights', () => {
  /** What stands at height `z`: the pieces present there against the bodies present there. */
  function section(walls: readonly TestWall[], solve: WallSolveResult, z: number) {
    const standing = (base: number, height: number) => base <= z && base + height >= z;
    const got = unionWallRings([
      ...solve.footprints.filter((f) => standing(f.baseOffset, f.height)).map((f) => [...f.corners]),
      ...solve.wedges.filter((w) => standing(w.baseOffset, w.height)).map((w) => w.polygon),
    ]);
    const ideal = unionWallRings(walls.filter((w) => standing(w.base ?? 0, w.height ?? 2700)).map(bodyOf));
    return { got, ideal };
  }

  it('a tall through wall has no slot above a shorter stem', () => {
    const walls: TestWall[] = [
      { deg: 0, thickness: 200, length: 3000, height: 3600 },
      { deg: 180, thickness: 200, length: 3000, height: 3600 },
      { deg: 90, thickness: 200, length: 3000, height: 2000 },
    ];
    const solve = solveWalls(sceneOf(walls));
    const { got, ideal } = section(walls, solve, 3000);
    expect(wallPolygonsArea(subtractWallPolygons(ideal.polygons, got.polygons).polygons)).toBeLessThan(1);
    expect(got.polygons).toHaveLength(1);
    expect(Math.max(...solve.wedges.map((w) => w.baseOffset + w.height))).toBe(3600);
  });

  it('every height of a random junction shows exactly the junction of the walls standing there', () => {
    const random = seeded(4242);
    const heights = [2000, 2400, 2700, 3000, 3600];
    for (let run = 0; run < 300; run += 1) {
      const walls = spacedAngles(random, 2 + Math.floor(random() * 4), 10).map((deg) => ({
        deg,
        thickness: pick(random, THICKNESSES),
        length: 4000,
        height: pick(random, heights),
      }));
      const solve = solveWalls(sceneOf(walls));
      for (const z of [1000, 2200, 2550, 2850, 3300]) {
        const standing = walls.filter((wall) => wall.height >= z);
        if (standing.length === 0) continue;
        const { got } = section(walls, solve, z);
        // The oracle: solve only the walls present at this height, as if the others were never drawn.
        const alone = unionWallRings(piecesOf(solveWalls(sceneOf(standing.map((wall) => ({ ...wall, height: z }))))));
        const context = JSON.stringify(walls.map((w) => [+w.deg.toFixed(2), w.thickness, w.height]));
        expect(wallPolygonsArea(subtractWallPolygons(alone.polygons, got.polygons).polygons), `missing at ${z}, ${context}`).toBeLessThan(1);
        expect(wallPolygonsArea(subtractWallPolygons(got.polygons, alone.polygons).polygons), `extra at ${z}, ${context}`).toBeLessThan(1);
      }
    }
  });

  it('a low stub on the outer side of a tall corner leaves the tall corner mitred above it', () => {
    const walls: TestWall[] = [
      { deg: 0, thickness: 200, length: 3000, height: 3000 },
      { deg: 90, thickness: 200, length: 3000, height: 3000 },
      { deg: 225, thickness: 200, length: 1000, height: 1000 },
    ];
    const solve = solveWalls(sceneOf(walls));
    const { got } = section(walls, solve, 2000);
    expect(wallPolygonsArea(subtractWallPolygons([[[[-99, -99], [-50, -99], [-50, -50], [-99, -50]]]], got.polygons).polygons)).toBeLessThan(1);
  });

  it('keeps each piece to its own wall, so materials stay right', () => {
    const walls: TestWall[] = [
      { deg: 0, thickness: 200, length: 3000, height: 3000 },
      { deg: 90, thickness: 200, length: 3000, height: 2000 },
      { deg: 180, thickness: 200, length: 3000, height: 3000 },
    ];
    const solve = solveWalls(sceneOf(walls));
    const owned = solve.wedges.filter((w) => w.edgeId);
    expect(owned.length).toBeGreaterThan(0);
    for (const piece of owned) {
      const owner = solve.footprints.find((f) => f.edgeId === piece.edgeId)!;
      expect(piece.height).toBe(owner.height);
    }
  });
});

describe('plain joints keep their exact shape', () => {
  const solve = (walls: TestWall[]) => {
    const { footprints, wedges } = solveWalls(sceneOf(walls));
    return { quads: footprints.map((f) => f.corners), wedges: wedges.map((w) => w.polygon) };
  };

  it('a T: flat underside, mitred top, triangular core', () => {
    const { quads, wedges } = solve([
      { deg: 0, thickness: 200, length: 3000 },
      { deg: 90, thickness: 200, length: 3000 },
      { deg: 180, thickness: 200, length: 3000 },
    ]);
    const close = (actual: readonly Vec2[], expected: readonly Vec2[]) =>
      actual.forEach((q, k) => expect(dist2(q, expected[k]!)).toBeLessThan(1e-9));
    close(quads[0]!, [[100, 100], [3000, 100], [3000, -100], [0, -100]]);
    close(quads[1]!, [[-100, 100], [-100, 3000], [100, 3000], [100, 100]]);
    close(quads[2]!, [[0, -100], [-3000, -100], [-3000, 100], [-100, 100]]);
    expect(wedges).toHaveLength(1);
    expect(Math.abs(polygonArea(wedges[0]!))).toBeCloseTo(20000, 6);
  });

  it('a straight wall split at a node has a flat joint and no core', () => {
    const { quads, wedges } = solve([
      { deg: 0, thickness: 200, length: 3000 },
      { deg: 180, thickness: 200, length: 2000 },
    ]);
    expect(wedges).toHaveLength(0);
    expect(dist2(quads[0]![0], [0, 100])).toBeLessThan(1e-9);
    expect(dist2(quads[1]![3], [0, 100])).toBeLessThan(1e-9);
  });
});

describe('footprint outlines (selection and hit areas)', () => {
  it('an isolated wall is just its quad', () => {
    const { footprints } = solveWalls(sceneOf([{ deg: 0, thickness: 200, length: 3000 }]));
    expect(footprints[0]!.outline).toEqual([...footprints[0]!.corners]);
  });

  it('at a junction with a core each wall reaches the node, and together they cover it', () => {
    const walls: TestWall[] = [-90, 0, 41.4, 101.8, 151.6, 180].map((deg) => ({ deg, thickness: 200, length: 3000 }));
    const { footprints, wedges } = solveWalls(sceneOf(walls));
    for (const footprint of footprints) {
      expect(footprint.outline).toContainEqual([0, 0]);
      expect(selfCrosses(footprint.outline)).toBe(false);
    }
    const outlines = unionWallRings(footprints.map((f) => f.outline));
    const pieces = unionWallRings([...footprints.map((f) => [...f.corners]), ...wedges.map((w) => w.polygon)]);
    expect(outlines.polygons).toHaveLength(1);
    expect(wallPolygonsArea(outlines.polygons)).toBeCloseTo(wallPolygonsArea(pieces.polygons), 0);
  });

  it('an L corner has no core to share', () => {
    const { footprints } = solveWalls(sceneOf([
      { deg: 0, thickness: 200, length: 3000 },
      { deg: 90, thickness: 200, length: 3000 },
    ]));
    for (const footprint of footprints) expect(footprint.outline).toEqual([...footprint.corners]);
  });

  it('a wall cut back in the exact path still owns its own whole rectangle', () => {
    // A thin wall through a thick one: the thin wall's cut-off part lies inside the thick wall.
    const walls: TestWall[] = [
      { deg: 0, thickness: 300, length: 4000 },
      { deg: 12, thickness: 100, length: 4000 },
      { deg: 180, thickness: 300, length: 4000 },
    ];
    const { footprints } = solveWalls(sceneOf(walls));
    footprints.forEach((footprint, k) => {
      expect(selfCrosses(footprint.outline)).toBe(false);
      const missing = subtractWallPolygons([[bodyOf(walls[k]!)]], unionWallRings([footprint.outline]).polygons);
      expect(wallPolygonsArea(missing.polygons)).toBeLessThan(1);
    });
  });
});

describe('degenerate input', () => {
  it('two walls on top of each other still solve to one whole body', () => {
    const walls: TestWall[] = [
      { deg: 0, thickness: 200, length: 3000 },
      { deg: 0, thickness: 200, length: 3000 },
    ];
    const verdict = judge(walls);
    expect(verdict.bodies).toBe(1);
    expect(verdict.holes).toBeLessThan(1);
    expect(verdict.twisted).toBe(0);
  });

  it('a wall shorter than its own thickness does not twist', () => {
    const walls: TestWall[] = [
      { deg: 0, thickness: 300, length: 3000 },
      { deg: 180, thickness: 300, length: 3000 },
      { deg: 80, thickness: 300, length: 120 },
    ];
    const verdict = judge(walls);
    expect(verdict.twisted).toBe(0);
    expect(verdict.holes).toBeLessThan(1);
  });

  it('a zero-length wall is ignored', () => {
    const result = solveWalls({
      nodes: [{ id: 'a', p: [0, 0] }, { id: 'b', p: [0, 0] }],
      edges: [{ id: 'e', a: 'a', b: 'b', thickness: 200, justification: 'center', height: 2700, baseOffset: 0 }],
    });
    expect(result.footprints).toHaveLength(0);
    expect(result.wedges).toHaveLength(0);
  });

  it('adding sub2 sanity: bodies start exactly at the node', () => {
    const body = bodyOf({ deg: 0, thickness: 200, length: 1000 });
    expect(dist2(sub2(body[0]!, [0, 100]), [0, 0])).toBeLessThan(1e-9);
  });
});
