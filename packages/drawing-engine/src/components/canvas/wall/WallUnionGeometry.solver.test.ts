import { describe, expect, it } from 'vitest';

import type { Wall } from '../../../types';
import { legacyWallsFromGraph, type MirrorCallbacks } from '../../../wallcore/legacyBridge';
import { createEmptyWallGraph, DEFAULT_WALL_PARAMS, type WallIdSource } from '../../../wallcore/wallModel';
import { addWallChain } from '../../../wallcore/wallOps';
import { wallPolygonsArea } from '../../../wallcore/wallUnion';

import { computeWallPolygon } from './WallGeometry';
import { computeSelectableWallPolygon } from './WallSelectionGeometry';
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
  rebuildGeometry: (wall) => {
    const dx = wall.endPoint.x - wall.startPoint.x;
    const dy = wall.endPoint.y - wall.startPoint.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = (-dy / length) * (wall.thickness / 2);
    const ny = (dx / length) * (wall.thickness / 2);
    return {
      ...wall,
      interiorLine: {
        start: { x: wall.startPoint.x + nx, y: wall.startPoint.y + ny },
        end: { x: wall.endPoint.x + nx, y: wall.endPoint.y + ny },
      },
      exteriorLine: {
        start: { x: wall.startPoint.x - nx, y: wall.startPoint.y - ny },
        end: { x: wall.endPoint.x - nx, y: wall.endPoint.y - ny },
      },
    };
  },
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
  it('walls keep their square face lines; corners come from the solve, never stored', () => {
    const walls = buildStampedWalls([[[0, 0], [3000, 0], [3000, 3000]]]);
    const horizontal = walls.find((w) => w.startPoint.y === w.endPoint.y)!;
    expect(Math.max(horizontal.interiorLine.end.x, horizontal.exteriorLine.end.x)).toBe(3000);
    // The L-corner shape itself reaches the miter point, ±100 past the centerline node.
    const shape = computeSelectableWallPolygon(horizontal, new Map(), walls);
    expect(Math.max(...shape.map((point) => point.x))).toBeCloseTo(3100, 3);
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

  it('computeWallPolygon is a graph wall’s square body, alone it knows no neighbours', () => {
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

describe('every wall in a junction is selected as what is drawn', () => {
  const star = (): Wall[] => {
    const at = (deg: number): [number, number] => [3000 * Math.cos((deg * Math.PI) / 180), 3000 * Math.sin((deg * Math.PI) / 180)];
    return buildStampedWalls([-90, 0, 41.4, 101.8, 151.6, 180].map((deg) => [[0, 0], at(deg)]));
  };

  it('a tight wall’s shape follows its true corners, not a square end', () => {
    const walls = star();
    const west = walls.find((w) => w.endPoint.x < -2900)!;
    const shape = computeSelectableWallPolygon(west, new Map(), walls);
    // The lower face runs on to where the 28.4° neighbour really meets it, about 390 mm from the node...
    expect(shape.some((p) => Math.abs(p.y - 100) < 1 && Math.abs(p.x + 100 / Math.tan((28.4 * Math.PI) / 360)) < 1)).toBe(true);
    // ...and no corner sits where the square end used to.
    expect(shape.some((p) => Math.abs(p.x) < 1 && Math.abs(p.y - 100) < 1)).toBe(false);
  });

  it('the walls’ shapes together are exactly the drawn body: nothing missing, nothing extra', () => {
    const walls = star();
    const drawn = computeWallUnionRenderData(walls).components;
    expect(drawn).toHaveLength(1);
    const drawnArea = wallPolygonsArea(drawn[0]!.polygons.map((polygon) => polygon.map((ring) => ring.map((p): [number, number] => [p.x, p.y]))));
    const shapes = walls.map((wall) => computeSelectableWallPolygon(wall, new Map(), walls));
    const shapesArea = shapes.reduce((total, shape) => {
      let doubled = 0;
      shape.forEach((a, i) => {
        const b = shape[(i + 1) % shape.length]!;
        doubled += a.x * b.y - b.x * a.y;
      });
      return total + Math.abs(doubled / 2);
    }, 0);
    // About 3.6 m² in all: what remains is only the drawn body's rounding to the 0.01 mm grid along 3 m edges.
    expect(Math.abs(shapesArea - drawnArea)).toBeLessThan(25);
  });
});
