import { describe, expect, it } from 'vitest';

import {
  bendRadiusFromDiameterMm,
  buildRouteCornerNodes,
  classifyNode,
  filletPolyline,
  splitPolylineAtStation,
  type IncidentSegment,
} from './pipeTopology';

const seg = (segmentId: string, x: number, y: number, diameterMm: number): IncidentSegment => ({
  segmentId,
  direction: { x, y },
  diameterMm,
});

describe('classifyNode', () => {
  it('1 segment -> cap', () => {
    expect(classifyNode([seg('a', 1, 0, 10)])).toBe('cap');
  });

  it('2 collinear segments, same diameter -> coupling', () => {
    expect(classifyNode([seg('a', 1, 0, 10), seg('b', -1, 0, 10)])).toBe('coupling');
  });

  it('2 collinear segments, different diameter -> reducer', () => {
    expect(classifyNode([seg('a', 1, 0, 10), seg('b', -1, 0, 16)])).toBe('reducer');
  });

  it('2 segments at 90 degrees -> elbow', () => {
    expect(classifyNode([seg('a', 1, 0, 10), seg('b', 0, 1, 10)])).toBe('elbow');
  });

  it('a bent diameter change stays an elbow (geometry wins over diameter)', () => {
    expect(classifyNode([seg('a', 1, 0, 10), seg('b', 0, 1, 16)])).toBe('elbow');
  });

  it('3 segments -> tee', () => {
    expect(classifyNode([seg('a', 1, 0, 10), seg('b', -1, 0, 10), seg('c', 0, 1, 6)])).toBe('tee');
  });

  it('4 segments -> cross (never silently a tee)', () => {
    expect(
      classifyNode([seg('a', 1, 0, 10), seg('b', -1, 0, 10), seg('c', 0, 1, 6), seg('d', 0, -1, 6)]),
    ).toBe('cross');
  });

  it('near-collinear within tolerance -> coupling', () => {
    expect(classifyNode([seg('a', 1, 0, 10), seg('b', -0.999, 0.03, 10)])).toBe('coupling');
  });
});

describe('splitPolylineAtStation', () => {
  it('splits a straight run at an interior station', () => {
    const r = splitPolylineAtStation([{ x: 0, y: 0 }, { x: 1000, y: 0 }], { x: 400, y: 0 });
    expect(r).not.toBeNull();
    expect(r!.before).toEqual([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
    expect(r!.after).toEqual([{ x: 400, y: 0 }, { x: 1000, y: 0 }]);
    expect(r!.station).toEqual({ x: 400, y: 0 });
  });

  it('splits an L-run on the correct leg and keeps the corner', () => {
    const r = splitPolylineAtStation(
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }],
      { x: 1000, y: 400 },
    );
    expect(r).not.toBeNull();
    expect(r!.before).toEqual([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 400 }]);
    expect(r!.after).toEqual([{ x: 1000, y: 400 }, { x: 1000, y: 1000 }]);
  });

  it('projects an off-line station onto the nearest leg', () => {
    const r = splitPolylineAtStation([{ x: 0, y: 0 }, { x: 1000, y: 0 }], { x: 400, y: 50 });
    expect(r!.station).toEqual({ x: 400, y: 0 });
  });

  it('returns null when the station lands on an endpoint', () => {
    expect(splitPolylineAtStation([{ x: 0, y: 0 }, { x: 1000, y: 0 }], { x: 0, y: 0 })).toBeNull();
  });

  it('returns null for a degenerate polyline', () => {
    expect(splitPolylineAtStation([{ x: 0, y: 0 }], { x: 0, y: 0 })).toBeNull();
  });
});

describe('buildRouteCornerNodes', () => {
  it('returns no corners for a route with fewer than 3 points', () => {
    expect(buildRouteCornerNodes([{ x: 0, y: 0 }, { x: 100, y: 0 }], 28.6)).toEqual([]);
  });

  it('classifies a straight pass-through vertex as a coupling (no bend radius)', () => {
    const nodes = buildRouteCornerNodes(
      [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 1000, y: 0 }],
      28.6,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe('coupling');
    expect(nodes[0]!.turnAngleDeg).toBeCloseTo(0, 6);
    expect(nodes[0]!.bendRadiusMm).toBe(0);
  });

  it('classifies a right-angle corner as an elbow with k=1.5 bend radius', () => {
    const nodes = buildRouteCornerNodes(
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }],
      28.6,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe('elbow');
    expect(nodes[0]!.index).toBe(1);
    expect(nodes[0]!.turnAngleDeg).toBeCloseTo(90, 6);
    expect(nodes[0]!.bendRadiusMm).toBeCloseTo(42.9, 6);
  });

  it('reports each bend of a multi-corner route', () => {
    const nodes = buildRouteCornerNodes(
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 2000, y: 1000 }],
      28.6,
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.type === 'elbow')).toBe(true);
  });
});

describe('filletPolyline', () => {
  it('returns the polyline unchanged for < 3 points or radius <= 0', () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    expect(filletPolyline(line, 50)).toEqual(line);
    const corner = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(filletPolyline(corner, 0)).toEqual(corner);
  });

  it('leaves a straight pass-through vertex untouched', () => {
    const straight = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 1000, y: 0 }];
    expect(filletPolyline(straight, 100)).toEqual(straight);
  });

  it('replaces a right-angle corner with an arc (removes the sharp vertex)', () => {
    const r = 100;
    const out = filletPolyline([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }], r, 6);
    // endpoints preserved, more points than the original 3, sharp corner gone
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 1000, y: 1000 });
    expect(out.length).toBeGreaterThan(3);
    expect(out.some((p) => p.x === 1000 && p.y === 0)).toBe(false);
    // every arc point sits radius r from the fillet center (900,100) for this 90° corner
    const center = { x: 900, y: 100 };
    const arc = out.slice(1, -1);
    for (const p of arc) {
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeCloseTo(r, 3);
    }
  });

  it('clamps the setback so a tight corner cannot overshoot its legs', () => {
    // Legs of length 100; a huge radius would overshoot, so setback clamps to 50.
    const out = filletPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10000, 4);
    const t1 = out[1]!; // first tangent point, along the incoming leg from the corner
    expect(t1.x).toBeCloseTo(50, 6); // corner.x(100) - setback(50)
    expect(t1.y).toBeCloseTo(0, 6);
  });
});

describe('bendRadiusFromDiameterMm', () => {
  it('defaults to long-radius k=1.5', () => {
    expect(bendRadiusFromDiameterMm(28.6)).toBeCloseTo(42.9, 9);
  });

  it('honors a custom bend-radius factor', () => {
    expect(bendRadiusFromDiameterMm(28.6, 1)).toBeCloseTo(28.6, 9);
  });
});
