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
    const door = { id: 'door-1', position: 1000, width: 900 };
    const decorated = mirrored.map((w) => ({ ...w, openings: [door] }));

    const corner = findNodeNear(doc, [4000, 0], 1)!;
    moveWallNode(doc, corner.id, [4200, 500]);
    const next = legacyWallsFromGraph(doc, decorated, callbacks);
    expect(next[0]!.endPoint).toEqual({ x: 4200, y: 500 });
    expect(next[0]!.openings).toEqual([door]); // survived
  });

  describe('a split wall keeps everything it carried', () => {
    const hostWith = (openings: LegacyWallLike['openings'], extra: Record<string, unknown> = {}) => {
      const doc = createEmptyWallGraph();
      const gen = ids('h');
      const [hostId] = addWallChain(doc, [[0, 0], [6000, 0]], DEFAULT_WALL_PARAMS, gen);
      const walls = legacyWallsFromGraph(doc, [], callbacks).map((w) => ({ ...w, openings, ...extra }));
      const graph = wallGraphFromLegacyWalls(walls, gen);
      return { hostId: hostId!, walls, graph, gen };
    };
    const atWorld = (wall: LegacyWallLike, position: number) => {
      const length = Math.hypot(wall.endPoint.x - wall.startPoint.x, wall.endPoint.y - wall.startPoint.y);
      return wall.startPoint.x + ((wall.endPoint.x - wall.startPoint.x) * position) / length;
    };

    it('the longer piece stays the same wall; doors stay where they are in the room', () => {
      const { hostId, walls, graph, gen } = hostWith([
        { id: 'near', position: 1000, width: 900 },
        { id: 'far', position: 5000, width: 900 },
      ]);
      addWallChain(graph, [[4000, 0], [4000, 3000]], DEFAULT_WALL_PARAMS, gen);
      const next = legacyWallsFromGraph(graph, walls, callbacks);
      const kept = next.find((w) => w.id === hostId)!;
      expect(kept.endPoint.x).toBe(4000);
      expect(kept.openings?.map((o) => o.id)).toEqual(['near']);
      expect(kept.openings![0]!.position).toBe(1000);
      const other = next.find((w) => w.openings?.some((o) => o.id === 'far'))!;
      expect(other.id).not.toBe(hostId);
      expect(atWorld(other, other.openings![0]!.position)).toBeCloseTo(5000, 6);
    });

    it('the new piece is that wall in everything but its extent', () => {
      const { hostId, walls, graph, gen } = hostWith([], { layer: 'structural', custom: 'keep me' });
      addWallChain(graph, [[1000, 0], [1000, 3000]], DEFAULT_WALL_PARAMS, gen);
      const pieces = legacyWallsFromGraph(graph, walls, callbacks).filter((w) => w.startPoint.y === 0 && w.endPoint.y === 0);
      expect(pieces).toHaveLength(2);
      expect(pieces.map((w) => w.id)).toContain(hostId);
      for (const piece of pieces) {
        expect((piece as { layer?: string }).layer).toBe('structural');
        expect((piece as { custom?: string }).custom).toBe('keep me');
      }
    });

    it('a door a new wall lands on stays whole: it moves the minimum and says so', () => {
      const { walls, graph, gen } = hostWith([{ id: 'door', position: 2000, width: 900 }]);
      addWallChain(graph, [[2200, 0], [2200, 3000]], DEFAULT_WALL_PARAMS, gen);
      const moved: Array<[string, number]> = [];
      const next = legacyWallsFromGraph(graph, walls, {
        ...callbacks,
        onOpeningMoved: (id, mm) => moved.push([id, mm]),
      });
      const host = next.find((w) => w.openings?.length)!;
      const centre = atWorld(host, host.openings![0]!.position);
      // Centre was left of the new wall: 450 half-width + 50 margin clear of x = 2200.
      expect(centre).toBeCloseTo(1700, 6);
      expect(moved).toEqual([['door', 300]]);
    });

    it('a door its own piece cannot hold goes to the longest piece, never deleted', () => {
      const { walls, graph, gen } = hostWith([{ id: 'door', position: 300, width: 900 }]);
      addWallChain(graph, [[600, 0], [600, 3000]], DEFAULT_WALL_PARAMS, gen);
      const next = legacyWallsFromGraph(graph, walls, callbacks);
      const hosts = next.filter((w) => w.openings?.length);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.startPoint.x).toBe(600);
      expect(atWorld(hosts[0]!, hosts[0]!.openings![0]!.position)).toBeCloseTo(1100, 6);
    });

    it('a door already close to the wall’s own end is not pushed by a split elsewhere', () => {
      const { hostId, walls, graph, gen } = hostWith([{ id: 'door', position: 460, width: 900 }]);
      addWallChain(graph, [[4000, 0], [4000, 3000]], DEFAULT_WALL_PARAMS, gen);
      const moved: string[] = [];
      const next = legacyWallsFromGraph(graph, walls, { ...callbacks, onOpeningMoved: (id) => moved.push(id) });
      expect(next.find((w) => w.id === hostId)!.openings![0]!.position).toBe(460);
      expect(moved).toEqual([]);
    });

    it('splitting twice in one operation still lands each door on its own piece', () => {
      const { walls, graph, gen } = hostWith([
        { id: 'a', position: 500, width: 600 },
        { id: 'b', position: 2500, width: 600 },
        { id: 'c', position: 5500, width: 600 },
      ]);
      addWallChain(graph, [[1500, -1000], [1500, 1000]], DEFAULT_WALL_PARAMS, gen);
      addWallChain(graph, [[4000, -1000], [4000, 1000]], DEFAULT_WALL_PARAMS, gen);
      const next = legacyWallsFromGraph(graph, walls, callbacks);
      const seen = next.flatMap((w) => (w.openings ?? []).map((o) => [o.id, Math.round(atWorld(w, o.position))]));
      expect(seen.sort()).toEqual([['a', 500], ['b', 2500], ['c', 5500]]);
    });
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
