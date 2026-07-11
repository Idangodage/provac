import { describe, expect, it } from 'vitest';

import { edgesAtNode, findNodeNear, nodePos } from './wallGraph';
import {
  DEFAULT_WALL_PARAMS,
  createEmptyWallGraph,
  type WallGraphDoc,
  type WallIdSource,
} from './wallModel';
import {
  addWallChain,
  deleteWalls,
  flipWallJustification,
  mergeAtNode,
  moveWallEdges,
  moveWallNode,
  setWallLength,
  setWallParams,
  splitWall,
} from './wallOps';

function ids(prefix = 'id'): WallIdSource {
  let n = 0;
  return {
    newId: () => {
      n += 1;
      return `${prefix}${n}`;
    },
  };
}

const P = DEFAULT_WALL_PARAMS;

function counts(doc: WallGraphDoc): { nodes: number; edges: number } {
  return { nodes: Object.keys(doc.nodes).length, edges: Object.keys(doc.edges).length };
}

describe('addWallChain (weld / split / crossings — reference wall.addChain)', () => {
  it('draws a chain of shared-node segments', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], P, ids());
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 });
    // corner node is SHARED by both edges
    const corner = findNodeNear(doc, [4000, 0], 1)!;
    expect(edgesAtNode(doc, corner.id)).toHaveLength(2);
  });

  it('welds a new chain endpoint onto an existing node (within WELD_EPS)', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0]], P, ids('a'));
    addWallChain(doc, [[4000.3, 0.2], [4000, 3000]], P, ids('b'));
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 }); // no 4th node — welded
  });

  it('starting on a wall body splits it (T-junction)', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0]], P, ids('a'));
    addWallChain(doc, [[2000, 0], [2000, 3000]], P, ids('b'));
    // host split into two + the new stem = 3 edges, 4 nodes, T node valence 3
    expect(counts(doc)).toEqual({ nodes: 4, edges: 3 });
    const tNode = findNodeNear(doc, [2000, 0], 1)!;
    expect(edgesAtNode(doc, tNode.id)).toHaveLength(3);
  });

  it('drawing THROUGH a wall splits both at the crossing (X-junction)', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0]], P, ids('a'));
    addWallChain(doc, [[2000, -1500], [2000, 1500]], P, ids('b'));
    // both split at [2000,0]: 4 edges, 5 nodes, X node valence 4
    expect(counts(doc)).toEqual({ nodes: 5, edges: 4 });
    const xNode = findNodeNear(doc, [2000, 0], 1)!;
    expect(edgesAtNode(doc, xNode.id)).toHaveLength(4);
  });

  it('closed rectangle: 4 nodes, 4 edges, every corner valence 2', () => {
    const doc = createEmptyWallGraph();
    addWallChain(
      doc,
      [[0, 0], [5000, 0], [5000, 3000], [0, 3000], [0, 0]],
      P,
      ids(),
    );
    expect(counts(doc)).toEqual({ nodes: 4, edges: 4 });
    for (const node of Object.values(doc.nodes)) {
      expect(edgesAtNode(doc, node.id)).toHaveLength(2);
    }
  });
});

describe('moveWallNode (endpoint drag with weld — reference wall.moveNode)', () => {
  it('plain move relocates the shared corner, both edges follow', () => {
    const doc = createEmptyWallGraph();
    addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], P, ids());
    const corner = findNodeNear(doc, [4000, 0], 1)!;
    moveWallNode(doc, corner.id, [4500, 500]);
    expect(nodePos(doc, corner.id)).toEqual([4500, 500]);
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 });
  });

  it('weld-drop onto another node merges them and drops zero-length edges', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [4000, 0]], P, gen);
    addWallChain(doc, [[0, 3000], [4000, 3000]], P, gen);
    const dragged = findNodeNear(doc, [4000, 3000], 1)!;
    const target = findNodeNear(doc, [4000, 0], 1)!;
    moveWallNode(doc, dragged.id, [4000, 0], { weld: true }, gen);
    expect(doc.nodes[dragged.id]).toBeUndefined(); // merged away
    expect(edgesAtNode(doc, target.id)).toHaveLength(2); // both walls end here now
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 });
  });

  it('weld-drop onto a wall body splits it and rewires there', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [4000, 0]], P, gen);
    addWallChain(doc, [[2000, 3000], [2500, 5000]], P, gen);
    const dragged = findNodeNear(doc, [2000, 3000], 1)!;
    moveWallNode(doc, dragged.id, [2000, 0], { weld: true }, gen);
    const tNode = findNodeNear(doc, [2000, 0], 1)!;
    expect(edgesAtNode(doc, tNode.id)).toHaveLength(3); // host split + welded stem
  });
});

describe('params, flip, length', () => {
  it('setWallParams patches multiple edges', () => {
    const doc = createEmptyWallGraph();
    const created = addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], P, ids());
    setWallParams(doc, created, { thickness: 300, height: 3000 });
    for (const id of created) {
      expect(doc.edges[id]!.thickness).toBe(300);
      expect(doc.edges[id]!.height).toBe(3000);
    }
  });

  it('flipWallJustification swaps left↔right and leaves center + nodes untouched', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    const [left] = addWallChain(doc, [[0, 0], [1000, 0]], { ...P, justification: 'left' }, gen);
    const [center] = addWallChain(doc, [[0, 2000], [1000, 2000]], P, gen);
    const before = JSON.parse(JSON.stringify(doc.nodes));
    flipWallJustification(doc, [left!, center!]);
    expect(doc.edges[left!]!.justification).toBe('right');
    expect(doc.edges[center!]!.justification).toBe('center');
    expect(doc.nodes).toEqual(before); // flip NEVER moves the centerline
    flipWallJustification(doc, [left!]);
    expect(doc.edges[left!]!.justification).toBe('left'); // involutive
  });

  it('setWallLength moves only the un-anchored end along the segment direction', () => {
    const doc = createEmptyWallGraph();
    const [edge] = addWallChain(doc, [[0, 0], [4000, 0]], P, ids());
    setWallLength(doc, edge!, 2500, 'a');
    const e = doc.edges[edge!]!;
    expect(nodePos(doc, e.a)).toEqual([0, 0]);
    expect(nodePos(doc, e.b)[0]).toBeCloseTo(2500, 9);
  });
});

describe('split / merge / delete / body-drag', () => {
  it('splitWall inserts a node; mergeAtNode dissolves it back', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    const [edge] = addWallChain(doc, [[0, 0], [4000, 0]], P, gen);
    const nodeId = splitWall(doc, edge!, 0.25, gen)!;
    expect(nodePos(doc, nodeId)[0]).toBeCloseTo(1000, 9);
    expect(counts(doc)).toEqual({ nodes: 3, edges: 2 });
    expect(mergeAtNode(doc, nodeId)).toBe(true);
    expect(counts(doc)).toEqual({ nodes: 2, edges: 1 });
  });

  it('mergeAtNode refuses non-collinear or mismatched-params joins', () => {
    const doc = createEmptyWallGraph();
    const gen = ids();
    addWallChain(doc, [[0, 0], [2000, 0], [2000, 2000]], P, gen); // 90° corner
    const corner = findNodeNear(doc, [2000, 0], 1)!;
    expect(mergeAtNode(doc, corner.id)).toBe(false);
  });

  it('deleteWalls garbage-collects orphaned nodes but keeps shared ones', () => {
    const doc = createEmptyWallGraph();
    const created = addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], P, ids());
    deleteWalls(doc, [created[0]!]);
    expect(counts(doc)).toEqual({ nodes: 2, edges: 1 }); // corner survives (shared), far end GC'd
  });

  it('moveWallEdges translates shared nodes exactly once (no tearing)', () => {
    const doc = createEmptyWallGraph();
    const created = addWallChain(doc, [[0, 0], [4000, 0], [4000, 3000]], P, ids());
    moveWallEdges(doc, created, [100, 50]);
    const corner = findNodeNear(doc, [4100, 50], 1);
    expect(corner).not.toBeNull(); // moved once, not twice
    expect(nodePos(doc, doc.edges[created[0]!]!.a)).toEqual([100, 50]);
  });
});
