import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { degToRad } from './angle';
import { dist2, type Vec2 } from './vec2';
import {
  halfWidths,
  polygonArea,
  solveWalls,
  type SolverEdge,
  type SolverNode,
  type WallSolveResult,
} from './wallSolver';

const N = (s: string, x: number, y: number): SolverNode => ({ id: s, p: [x, y] });
const E = (
  s: string,
  a: string,
  b: string,
  t = 200,
  just: SolverEdge['justification'] = 'center',
): SolverEdge => ({
  id: s,
  a,
  b,
  thickness: t,
  justification: just,
  height: 2700,
  baseOffset: 0,
});

/** Tolerance-aware corner comparator (reference golden-geometry testing). */
function expectCornersClose(actual: readonly Vec2[], expected: readonly Vec2[], tol = 0.01): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((c, i) => {
    const d = dist2(c, expected[i]!);
    expect(
      d,
      `corner ${i}: got [${c.join(',')}] want [${expected[i]!.join(',')}] (Δ=${d.toFixed(4)})`,
    ).toBeLessThan(tol);
  });
}

function fp(result: WallSolveResult, edgeId: string): readonly Vec2[] {
  const f = result.footprints.find((x) => x.edgeId === edgeId);
  expect(f, `footprint for ${edgeId}`).toBeDefined();
  return f!.corners;
}

describe('wallSolver goldens (reference join snapshots)', () => {
  it('isolated wall: butt caps at both ends, exact rectangle', () => {
    const r = solveWalls({ nodes: [N('n1', 0, 0), N('n2', 4000, 0)], edges: [E('e1', 'n1', 'n2', 200)] });
    expectCornersClose(fp(r, 'e1'), [
      [0, 100],
      [4000, 100],
      [4000, -100],
      [0, -100],
    ]);
    expect(r.wedges).toHaveLength(0);
  });

  it('justification left/right shifts the body to one side of the centerline', () => {
    expect(halfWidths({ thickness: 200, justification: 'left' })).toEqual({ hl: 0, hr: 200 });
    expect(halfWidths({ thickness: 200, justification: 'right' })).toEqual({ hl: 200, hr: 0 });
    const r = solveWalls({
      nodes: [N('n1', 0, 0), N('n2', 1000, 0)],
      edges: [E('e1', 'n1', 'n2', 200, 'left')],
    });
    expectCornersClose(fp(r, 'e1'), [
      [0, 0],
      [1000, 0],
      [1000, -200],
      [0, -200],
    ]);
  });

  it('flip (left↔right) mirrors the body about the FIXED centerline', () => {
    const nodes = [N('n1', 0, 0), N('n2', 1000, 0)];
    const left = solveWalls({ nodes, edges: [E('e1', 'n1', 'n2', 200, 'left')] });
    const right = solveWalls({ nodes, edges: [E('e1', 'n1', 'n2', 200, 'right')] });
    // left-justified body occupies y ∈ [-200, 0]; flipped occupies y ∈ [0, 200]
    expectCornersClose(fp(right, 'e1'), [
      [0, 200],
      [1000, 200],
      [1000, 0],
      [0, 0],
    ]);
    // the centerline itself (nodes) is untouched by a flip
    expect(fp(left, 'e1')[0]![1]).toBe(0);
    expect(fp(right, 'e1')[2]![1]).toBe(0);
  });

  it('90° L-join: mitered inner and outer corners', () => {
    const r = solveWalls({
      nodes: [N('n0', 0, 0), N('nx', 3000, 0), N('ny', 0, 3000)],
      edges: [E('ex', 'n0', 'nx', 200), E('ey', 'n0', 'ny', 200)],
    });
    expectCornersClose(fp(r, 'ex'), [
      [100, 100],
      [3000, 100],
      [3000, -100],
      [-100, -100],
    ]);
    expectCornersClose(fp(r, 'ey'), [
      [-100, -100],
      [-100, 3000],
      [100, 3000],
      [100, 100],
    ]);
    expect(r.wedges).toHaveLength(0); // valence-2 miters tile completely
  });

  for (const angleDeg of [30, 45, 135, 150]) {
    it(`${angleDeg}° elbow: miter points lie on both offset lines`, () => {
      const a = degToRad(angleDeg);
      const t = 200;
      const r = solveWalls({
        nodes: [N('n0', 0, 0), N('nx', 3000, 0), N('na', 3000 * Math.cos(a), 3000 * Math.sin(a))],
        edges: [E('ex', 'n0', 'nx', t), E('ea', 'n0', 'na', t)],
      });
      const cx = fp(r, 'ex');
      // aL and aR are the two miter points; each must sit on ex's offset lines (y = ±t/2)
      expect(Math.abs(cx[0]![1] - t / 2)).toBeLessThan(1e-6);
      expect(Math.abs(cx[3]![1] + t / 2)).toBeLessThan(1e-6);
      // and on ea's offset lines: distance from the a-direction line equals t/2
      const dirA: Vec2 = [Math.cos(a), Math.sin(a)];
      for (const corner of [cx[0]!, cx[3]!]) {
        const cross = Math.abs(dirA[0] * corner[1] - dirA[1] * corner[0]);
        expect(Math.abs(cross - t / 2)).toBeLessThan(1e-6);
      }
      // footprints keep positive area after winding normalization
      expect(Math.abs(polygonArea(cx))).toBeGreaterThan(0);
    });
  }

  it('sharp 10° elbow bevels instead of spiking (miter limit 2×t)', () => {
    const a = degToRad(10);
    const t = 200;
    const r = solveWalls({
      nodes: [N('n0', 0, 0), N('nx', 3000, 0), N('na', 3000 * Math.cos(a), 3000 * Math.sin(a))],
      edges: [E('ex', 'n0', 'nx', t), E('ea', 'n0', 'na', t)],
    });
    // only the node-end corners (aL/aR — both edges start at n0) are join-controlled
    for (const f of r.footprints) {
      for (const c of [f.corners[0], f.corners[3]]) {
        expect(dist2(c, [0, 0])).toBeLessThanOrEqual(2 * t + 1e-6);
      }
    }
  });

  it('T-junction: through-wall face stays straight, wedge fills the core', () => {
    const r = solveWalls({
      nodes: [N('n0', 0, 0), N('ne', 3000, 0), N('nw', -3000, 0), N('nn', 0, 3000)],
      edges: [E('ee', 'n0', 'ne', 200), E('ew', 'n0', 'nw', 200), E('en', 'n0', 'nn', 200)],
    });
    const east = fp(r, 'ee');
    const west = fp(r, 'ew');
    // bottom face (y=-100) must be continuous: east aR and west aL meet at x=0
    expectCornersClose([east[3]!], [[0, -100]]);
    expectCornersClose([west[0]!], [[0, -100]], 0.01);
    // wedge polygon exists and covers the junction triangle
    expect(r.wedges).toHaveLength(1);
    const wedge = r.wedges[0]!;
    expect(wedge.polygon.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(polygonArea(wedge.polygon))).toBeGreaterThan(100 * 100 * 0.9);
  });

  it('X-junction (valence 4): four miter points, wedge covers the core square', () => {
    const r = solveWalls({
      nodes: [N('n0', 0, 0), N('e', 3000, 0), N('w', -3000, 0), N('n', 0, 3000), N('s', 0, -3000)],
      edges: [
        E('ee', 'n0', 'e', 200),
        E('ew', 'n0', 'w', 200),
        E('en', 'n0', 'n', 200),
        E('es', 'n0', 's', 200),
      ],
    });
    expect(r.wedges).toHaveLength(1);
    const area = Math.abs(polygonArea(r.wedges[0]!.polygon));
    expect(area).toBeGreaterThan(200 * 200 * 0.95); // ~ t² core
    expect(area).toBeLessThan(200 * 200 * 1.05);
  });

  it('collinear pass-through node: flat joint, no wedge', () => {
    const r = solveWalls({
      nodes: [N('n1', -2000, 0), N('n0', 0, 0), N('n2', 2000, 0)],
      edges: [E('e1', 'n1', 'n0', 200), E('e2', 'n0', 'n2', 200)],
    });
    expectCornersClose(fp(r, 'e1'), [
      [-2000, 100],
      [0, 100],
      [0, -100],
      [-2000, -100],
    ]);
    expect(r.wedges).toHaveLength(0);
  });

  it('fast-check: output invariant under node/edge order permutation (LAW 4)', () => {
    const base = {
      nodes: [N('n0', 0, 0), N('e', 3000, 0), N('n', 0, 3000), N('w', -2500, 500)],
      edges: [E('e1', 'n0', 'e', 200), E('e2', 'n0', 'n', 150), E('e3', 'n0', 'w', 250)],
    };
    const reference = solveWalls(base);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(base.nodes, { minLength: 4, maxLength: 4 }),
        fc.shuffledSubarray(base.edges, { minLength: 3, maxLength: 3 }),
        (nodes, edges) => {
          const shuffled = solveWalls({ nodes, edges });
          for (const f of reference.footprints) {
            const other = shuffled.footprints.find((x) => x.edgeId === f.edgeId)!;
            f.corners.forEach((c, i) => {
              expect(dist2(c, other.corners[i]!)).toBeLessThan(1e-9);
            });
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
