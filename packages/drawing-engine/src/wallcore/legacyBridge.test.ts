import { describe, expect, it } from 'vitest';

import {
  legacyWallsFromGraph,
  wallGraphFromLegacyWalls,
  type LegacyWallLike,
  type MirrorCallbacks,
} from './legacyBridge';
import { edgesAtNode, findNodeNear } from './wallGraph';
import { DEFAULT_WALL_PARAMS, createEmptyWallGraph, type WallIdSource } from './wallModel';
import { addWallChain, moveWallNode } from './wallOps';

function ids(prefix = 'n'): WallIdSource {
  let n = 0;
  return { newId: () => `${prefix}${++n}` };
}

const callbacks: MirrorCallbacks<LegacyWallLike & { connectedWalls?: string[] }> = {
  createWall: (edge, start, end) => ({
    id: edge.id,
    startPoint: { x: start[0], y: start[1] },
    endPoint: { x: end[0], y: end[1] },
    thickness: edge.thickness,
    material: edge.material,
    properties3D: {
      height: edge.height,
      baseElevation: edge.baseOffset,
      materialId: edge.materialId,
    },
  }),
  rebuildGeometry: (wall) => wall,
};

describe('graph → legacy mirror', () => {
  it('mirrors edges with graph metadata and true shared-node connections', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], DEFAULT_WALL_PARAMS, ids('g'));
    const walls = legacyWallsFromGraph(doc, [], callbacks);
    expect(walls).toHaveLength(2);
    for (const wall of walls) {
      expect(wall.graph).toBeDefined();
      expect((wall as { connectedWalls?: string[] }).connectedWalls).toHaveLength(1);
    }
  });

  it('preserves the surviving wall object (openings etc.) across a graph edit', () => {
    const doc = createEmptyWallGraph();
    const gen = ids('g');
    addWallChain(doc, [[0, 0], [4000, 0]], DEFAULT_WALL_PARAMS, gen);
    const mirrored = legacyWallsFromGraph(doc, [], callbacks);
    const decorated = mirrored.map((w) => ({ ...w, openings: ['door-1'] }));

    const corner = findNodeNear(doc, [4000, 0], 1)!;
    moveWallNode(doc, corner.id, [4200, 500]);
    const next = legacyWallsFromGraph(doc, decorated, callbacks);
    expect(next[0]!.endPoint).toEqual({ x: 4200, y: 500 });
    expect((next[0] as { openings?: string[] }).openings).toEqual(['door-1']); // survived
  });
});

describe('legacy → graph reconstruction / migration', () => {
  it('round-trips exactly through the mirror metadata', () => {
    const doc = createEmptyWallGraph();
    addWallChain(
      doc,
      [[0, 0], [5000, 0], [5000, 3000], [0, 3000], [0, 0]],
      DEFAULT_WALL_PARAMS,
      ids('g'),
    );
    const walls = legacyWallsFromGraph(doc, [], callbacks);
    const rebuilt = wallGraphFromLegacyWalls(walls, ids('x'));
    expect(Object.keys(rebuilt.nodes).sort()).toEqual(Object.keys(doc.nodes).sort());
    expect(Object.keys(rebuilt.edges).sort()).toEqual(Object.keys(doc.edges).sort());
    for (const [id, node] of Object.entries(doc.nodes)) {
      expect(rebuilt.nodes[id]!.p).toEqual(node.p);
    }
  });

  it('migrates bare legacy walls by welding endpoints into shared nodes', () => {
    const legacy: LegacyWallLike[] = [
      { id: 'w1', startPoint: { x: 0, y: 0 }, endPoint: { x: 4000, y: 0 }, thickness: 150, material: 'brick' },
      // endpoint within WELD_EPS of w1's end → must share the corner node
      { id: 'w2', startPoint: { x: 4000.2, y: 0.2 }, endPoint: { x: 4000, y: 3000 }, thickness: 150, material: 'brick' },
    ];
    const doc = wallGraphFromLegacyWalls(legacy, ids('m'));
    expect(Object.keys(doc.edges)).toHaveLength(2);
    expect(Object.keys(doc.nodes)).toHaveLength(3); // welded corner shared
    const corner = findNodeNear(doc, [4000, 0], 1)!;
    expect(edgesAtNode(doc, corner.id)).toHaveLength(2);
    // migration preserves wall ids so openings/selection keep working
    expect(doc.edges.w1).toBeDefined();
    expect(doc.edges.w2).toBeDefined();
  });

  it('round-trips wall base elevation into the 3D graph offset', () => {
    const legacy: LegacyWallLike[] = [{
      id: 'raised-wall',
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 3000, y: 0 },
      thickness: 180,
      material: 'concrete',
      properties3D: { height: 2400, baseElevation: 450 },
    }];
    const doc = wallGraphFromLegacyWalls(legacy, ids('r'));
    expect(doc.edges['raised-wall']!.baseOffset).toBe(450);

    const mirrored = legacyWallsFromGraph(doc, legacy, callbacks);
    expect(mirrored[0]!.properties3D?.baseElevation).toBe(450);
  });

  it('preserves the canonical material id through graph splits', () => {
    const legacy: LegacyWallLike[] = [{
      id: 'wood-wall',
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 5000, y: 0 },
      thickness: 180,
      material: 'partition',
      properties3D: {
        height: 2700,
        materialId: 'exterior-wood-siding-25',
      },
    }];
    const doc = wallGraphFromLegacyWalls(legacy, ids('s'));
    const edge = doc.edges['wood-wall']!;
    const midpoint = { x: 2500, y: 0 };
    const node = findNodeNear(doc, [midpoint.x, midpoint.y], 1);
    expect(node).toBeNull();

    // Adding a crossing chain splits the existing host edge; both child edges
    // must keep the detailed material, not collapse to generic partition.
    addWallChain(doc, [[2500, -1000], [2500, 1000]], DEFAULT_WALL_PARAMS, ids('x'));
    const inherited = Object.values(doc.edges).filter(
      (candidate) => candidate.materialId === edge.materialId
    );
    expect(inherited).toHaveLength(2);
    inherited.forEach((candidate) => {
      expect(candidate.materialId).toBe('exterior-wood-siding-25');
    });
  });
});
