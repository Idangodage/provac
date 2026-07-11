import { describe, expect, it } from 'vitest';

import type { Wall } from '../../../types';
import { legacyWallsFromGraph, type MirrorCallbacks } from '../../../wallcore/legacyBridge';
import { createEmptyWallGraph, DEFAULT_WALL_PARAMS, type WallIdSource } from '../../../wallcore/wallModel';
import { addWallChain } from '../../../wallcore/wallOps';

import { computeWallPolygon } from './WallGeometry';
import { computeWallUnionRenderData } from './WallUnionGeometry';

function ids(prefix = 'u'): WallIdSource {
  let n = 0;
  return { newId: () => `${prefix}${++n}` };
}

/** Minimal legacy-Wall factory mirroring the store's callbacks for tests. */
const callbacks: MirrorCallbacks<Wall> = {
  createWall: (edge, start, end) =>
    ({
      id: edge.id,
      startPoint: { x: start[0], y: start[1] },
      endPoint: { x: end[0], y: end[1] },
      thickness: edge.thickness,
      centerlineOffset: 0,
      material: 'brick',
      layer: 'partition',
      interiorLine: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
      exteriorLine: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
      startBevel: { innerOffset: 0, outerOffset: 0 },
      endBevel: { innerOffset: 0, outerOffset: 0 },
      connectedWalls: [],
      openings: [],
      properties3D: { height: edge.height },
    }) as unknown as Wall,
  rebuildGeometry: (wall) => wall,
  applyFootprint: (wall, corners) => ({
    ...wall,
    interiorLine: {
      start: { x: corners[0][0], y: corners[0][1] },
      end: { x: corners[1][0], y: corners[1][1] },
    },
    exteriorLine: {
      start: { x: corners[3][0], y: corners[3][1] },
      end: { x: corners[2][0], y: corners[2][1] },
    },
  }),
};

function buildStampedWalls(points: [number, number][][]): Wall[] {
  const doc = createEmptyWallGraph();
  const gen = ids();
  for (const chain of points) {
    addWallChain(doc, chain, DEFAULT_WALL_PARAMS, gen);
  }
  return legacyWallsFromGraph(doc, [], callbacks);
}

describe('solver-driven 2D wall union (W3b — reference poché)', () => {
  it('stamped walls carry solver-mitred interior/exterior lines', () => {
    const walls = buildStampedWalls([[[0, 0], [3000, 0], [3000, 3000]]]);
    // The L-corner wall lines must extend to the miter point (±100 past the
    // centerline node for 200mm walls), not stop square at the node.
    const horizontal = walls.find((w) => w.startPoint.y === w.endPoint.y)!;
    const xs = [
      horizontal.interiorLine.start.x,
      horizontal.interiorLine.end.x,
      horizontal.exteriorLine.start.x,
      horizontal.exteriorLine.end.x,
    ];
    expect(Math.max(...xs)).toBeCloseTo(3100, 3); // outer miter reaches past the node
  });

  it('unions a T-junction into ONE component with no interior seam polygons lost', () => {
    const walls = buildStampedWalls([
      [[-3000, 0], [3000, 0]],
      [[0, 0], [0, 3000]],
    ]);
    expect(walls.every((w) => w.graph)).toBe(true);
    const render = computeWallUnionRenderData(walls);
    expect(render.components).toHaveLength(1);
    const [component] = render.components;
    expect(component!.wallIds.sort()).toEqual(walls.map((w) => w.id).sort());
    expect(component!.polygons.length).toBeGreaterThan(0);
  });

  it('keeps disconnected runs as separate components', () => {
    const walls = buildStampedWalls([
      [[0, 0], [2000, 0]],
      [[0, 9000], [2000, 9000]],
    ]);
    const render = computeWallUnionRenderData(walls);
    expect(render.components).toHaveLength(2);
  });

  it('computeWallPolygon returns the stamped quad verbatim for graph walls', () => {
    const walls = buildStampedWalls([[[0, 0], [3000, 0], [3000, 3000]]]);
    const horizontal = walls.find((w) => w.startPoint.y === w.endPoint.y)!;
    const quad = computeWallPolygon(horizontal, []);
    expect(quad).toEqual([
      horizontal.interiorLine.start,
      horizontal.interiorLine.end,
      horizontal.exteriorLine.end,
      horizontal.exteriorLine.start,
    ]);
  });
});
