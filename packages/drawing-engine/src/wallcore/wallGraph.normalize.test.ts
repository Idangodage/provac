import { describe, expect, it } from 'vitest';

import { legacyWallsFromGraph, wallGraphFromLegacyWalls, type LegacyWallLike, type MirrorCallbacks } from './legacyBridge';
import { COLLINEAR_EPS } from './tolerances';
import { dist2, segSegIntersect2 } from './vec2';
import { edgesAtNode, findNodeNear, mergeStraightWallsAt, nodePos, normalizeWallGraph } from './wallGraph';
import { DEFAULT_WALL_PARAMS, createEmptyWallGraph, type WallGraphDoc, type WallIdSource } from './wallModel';
import { addWallChain, moveWallEdges, moveWallEnd } from './wallOps';

function ids(prefix = 'w'): WallIdSource {
  let n = 0;
  return { newId: () => `${prefix}${(n += 1).toString().padStart(3, '0')}` };
}

const P = { ...DEFAULT_WALL_PARAMS, thickness: 200 };
const counts = (doc: WallGraphDoc) => ({ nodes: Object.keys(doc.nodes).length, edges: Object.keys(doc.edges).length });

const callbacks: MirrorCallbacks<LegacyWallLike> = {
  createWall: (edge, start, end) => ({
    id: edge.id,
    startPoint: { x: start[0], y: start[1] },
    endPoint: { x: end[0], y: end[1] },
    thickness: edge.thickness,
    material: edge.material,
  }),
  rebuildGeometry: (wall) => wall,
};

describe('normalizeWallGraph: if it looks joined, it is joined', () => {
  it('a wall ending inside another’s body joins on its centreline', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[3000, 60], [3000, 3000]], P, gen);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 2 });
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 3 });
    const tee = findNodeNear(doc, [3000, 0], 0.01)!;
    expect(tee).not.toBeNull();
    expect(edgesAtNode(doc, tee.id)).toHaveLength(3);
  });

  it('joins from the wall’s face and from either side', () => {
    for (const y of [99, -99, 100, -100]) {
      const doc = createEmptyWallGraph();
      const gen = ids();
      addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
      addWallChain(doc, [[2000, y], [2000, y * 30]], P, gen);
      normalizeWallGraph(doc, gen);
      expect(findNodeNear(doc, [2000, 0], 0.01), `y=${y}`).not.toBeNull();
    }
  });

  it('leaves a wall ending just outside the face alone', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[2000, 102], [2000, 3000]], P, gen);
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 2 });
  });

  it('near a wall’s end it welds to the corner instead of leaving a stub', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[5950, 40], [5950, 3000]], P, gen);
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 });
    expect(edgesAtNode(doc, findNodeNear(doc, [6000, 0], 0.01)!.id)).toHaveLength(2);
  });

  it('a wall moved across another makes an X', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    const [moving] = addWallChain(doc, [[3000, 1000], [3000, 3000]], P, gen);
    moveWallEdges(doc, [moving!], [0, -2000]);
    normalizeWallGraph(doc, gen, new Set([moving!]));
    expect(counts(doc)).toEqual({ nodes: 5, edges: 4 });
    expect(edgesAtNode(doc, findNodeNear(doc, [3000, 0], 0.01)!.id)).toHaveLength(4);
  });

  it('the same wall drawn twice is one wall, the one already there', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    const [first] = addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    const [second] = addWallChain(doc, [[6000, 0], [0, 0]], P, gen);
    const replaced = normalizeWallGraph(doc, gen, new Set([second!]));
    expect(counts(doc)).toEqual({ nodes: 2, edges: 1 });
    expect(doc.edges[first!]).toBeDefined();
    expect(replaced.get(second!)).toBe(first);
  });

  it('a wall drawn along part of a longer one leaves one wall on each stretch', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[2000, 0], [4000, 0]], P, gen);
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 3 });
  });

  it('two walls overlapping end to end leave one wall on each stretch', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [4000, 0]], P, gen);
    addWallChain(doc, [[2000, 0], [6000, 0]], P, gen);
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 3 });
  });

  it('walls lying side by side are not a junction', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[1000, 150], [5000, 170]], P, gen);
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 2 });
  });

  it('a short wall leaving a junction at a tight angle does not tee back into its neighbour', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[6000, 0], [5800, 60]], P, gen);
    normalizeWallGraph(doc, gen);
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 });
  });

  it('only looks at what changed, unless asked to look at everything', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [6000, 0]], P, gen);
    addWallChain(doc, [[3000, 60], [3000, 3000]], P, gen);
    normalizeWallGraph(doc, gen, new Set());
    expect(counts(doc)).toEqual({ nodes: 4, edges: 2 });
  });

  it('settles: normalizing twice changes nothing, and nothing is left crossing or lying inside', () => {
    let seed = 2024;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 60; run += 1) {
      const doc = createEmptyWallGraph();
      const gen = ids();
      for (let k = 0; k < 14; k += 1) {
        addWallChain(doc, [
          [Math.round(random() * 80) * 100, Math.round(random() * 80) * 100],
          [Math.round(random() * 80) * 100, Math.round(random() * 80) * 100],
        ], P, gen);
      }
      normalizeWallGraph(doc, gen);
      const settled = JSON.stringify([doc.nodes, doc.edges]);
      normalizeWallGraph(doc, gen);
      expect(JSON.stringify([doc.nodes, doc.edges])).toBe(settled);

      const edges = Object.values(doc.edges);
      edges.forEach((e, i) => {
        expect(dist2(nodePos(doc, e.a), nodePos(doc, e.b))).toBeGreaterThan(0);
        for (const f of edges.slice(i + 1)) {
          const shared = e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b;
          if (shared) {
            expect(new Set([e.a, e.b, f.a, f.b]).size, 'two walls between the same nodes').toBeGreaterThan(2);
            continue;
          }
          const hit = segSegIntersect2(nodePos(doc, e.a), nodePos(doc, e.b), nodePos(doc, f.a), nodePos(doc, f.b));
          const interior = (t: number) => t > 1e-3 && t < 1 - 1e-3;
          expect(Boolean(hit && interior(hit.ta) && interior(hit.tb)), 'walls crossing with no shared node').toBe(false);
        }
      });
    }
  });
});

describe('merging straight walls back into one', () => {
  const straight = (order: 'same' | 'against') => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    const [first] = addWallChain(doc, [[0, 0], [4000, 0]], P, gen);
    const [second] = order === 'same'
      ? addWallChain(doc, [[4000, 0], [6000, 0]], P, gen)
      : addWallChain(doc, [[6000, 0], [4000, 0]], P, gen);
    return { doc, gen, first: first!, second: second!, node: findNodeNear(doc, [4000, 0], 0.01)!.id };
  };

  it('keeps the longer wall', () => {
    const { doc, first, second, node } = straight('same');
    expect(mergeStraightWallsAt(doc, node, COLLINEAR_EPS)).toEqual({ stays: first, goes: second });
    expect(counts(doc)).toEqual({ nodes: 2, edges: 1 });
    expect(nodePos(doc, doc.edges[first]!.b)).toEqual([6000, 0]);
  });

  it('refuses walls that differ, or that turn', () => {
    const { doc, second, node } = straight('same');
    doc.edges[second]!.thickness = 150;
    expect(mergeStraightWallsAt(doc, node, COLLINEAR_EPS)).toBeNull();
    const corner = createEmptyWallGraph();
    const gen = ids();
    addWallChain(corner, [[0, 0], [4000, 0], [4000, 3000]], P, gen);
    expect(mergeStraightWallsAt(corner, findNodeNear(corner, [4000, 0], 0.01)!.id, COLLINEAR_EPS)).toBeNull();
  });

  it('a one-sided wall only merges with one on the same side', () => {
    const { doc, first, second, node } = straight('against');
    doc.edges[first]!.justification = 'left';
    doc.edges[second]!.justification = 'left'; // running the other way, so its body is on the other side
    expect(mergeStraightWallsAt(doc, node, COLLINEAR_EPS)).toBeNull();
    doc.edges[second]!.justification = 'right';
    expect(mergeStraightWallsAt(doc, node, COLLINEAR_EPS)).not.toBeNull();
  });

  for (const order of ['same', 'against'] as const) {
    it(`doors keep their place on the merged wall (second wall running ${order === 'same' ? 'the same way' : 'against it'})`, () => {
      const { doc, first, second, node } = straight(order);
      const walls = legacyWallsFromGraph(doc, [], callbacks).map((w) => ({
        ...w,
        openings: w.id === first
          ? [{ id: 'on-first', position: 1000, width: 600 }]
          : [{ id: 'on-second', position: 500, width: 600 }],
      }));
      const graph = wallGraphFromLegacyWalls(walls, ids('x'));
      mergeStraightWallsAt(graph, node, COLLINEAR_EPS);
      const merged = legacyWallsFromGraph(graph, walls, callbacks);
      expect(merged).toHaveLength(1);
      const positions = Object.fromEntries(merged[0]!.openings!.map((o) => [o.id, o.position]));
      expect(positions['on-first']).toBe(1000);
      // 500 from the second wall's own start, which is at x = 4000 or x = 6000.
      expect(positions['on-second']).toBe(order === 'same' ? 4500 : 5500);
      expect(second).toBeDefined();
    });
  }
});

describe('moveWallEnd', () => {
  it('moves only this wall: a neighbour sharing the node stays where it is', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    const [first, second] = addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], P, gen);
    moveWallEnd(doc, first!, 'b', [3000, 0], gen);
    expect(nodePos(doc, doc.edges[first!]!.b)).toEqual([3000, 0]);
    expect(nodePos(doc, doc.edges[second!]!.a)).toEqual([4000, 0]);
    expect(counts(doc)).toEqual({ nodes: 4, edges: 2 });
  });

  it('a free end just moves, with no node left behind', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    const [only] = addWallChain(doc, [[0, 0], [4000, 0]], P, gen);
    moveWallEnd(doc, only!, 'b', [5000, 0], gen);
    expect(counts(doc)).toEqual({ nodes: 2, edges: 1 });
  });
});
