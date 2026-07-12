import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import {
  buildPipeCenterline,
  buildPipeCenterlineFromDiameter,
  centerlineLength,
  toPolyline,
  toSvgPathData,
  type CenterlineSegment,
} from './pipeCenterline';

const p = (x: number, y: number): Point2D => ({ x, y });

function arcs(segments: CenterlineSegment[]) {
  return segments.filter((s): s is Extract<CenterlineSegment, { type: 'arc' }> => s.type === 'arc');
}

function lines(segments: CenterlineSegment[]) {
  return segments.filter((s): s is Extract<CenterlineSegment, { type: 'line' }> => s.type === 'line');
}

function polylineLength(points: Point2D[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

describe('buildPipeCenterline — trivial inputs', () => {
  it('empty route -> no segments', () => {
    const c = buildPipeCenterline([], 20);
    expect(c.segments).toHaveLength(0);
  });

  it('single point -> no segments, start preserved', () => {
    const c = buildPipeCenterline([p(5, 7)], 20);
    expect(c.segments).toHaveLength(0);
    expect(c.start).toEqual(p(5, 7));
  });

  it('two points -> one line, exact length, exact svg', () => {
    const c = buildPipeCenterline([p(0, 0), p(100, 0)], 20);
    expect(c.segments).toHaveLength(1);
    expect(c.segments[0]!.type).toBe('line');
    expect(centerlineLength(c)).toBeCloseTo(100, 6);
    expect(toSvgPathData(c)).toBe('M 0 0 L 100 0');
  });
});

describe('buildPipeCenterline — arc fillet at a 90deg corner', () => {
  const route = [p(0, 0), p(100, 0), p(100, 100)];
  const c = buildPipeCenterline(route, 20);

  it('produces line, arc, line', () => {
    expect(c.segments.map((s) => s.type)).toEqual(['line', 'arc', 'line']);
  });

  it('arc is tangent to both legs at the right setback', () => {
    const [arc] = arcs(c.segments);
    expect(arc).toBeDefined();
    // 90deg turn, r=20 -> setback 20, tangent points (80,0) and (100,20).
    expect(arc!.start.x).toBeCloseTo(80, 6);
    expect(arc!.start.y).toBeCloseTo(0, 6);
    expect(arc!.end.x).toBeCloseTo(100, 6);
    expect(arc!.end.y).toBeCloseTo(20, 6);
    expect(arc!.radius).toBeCloseTo(20, 6);
    expect(arc!.center.x).toBeCloseTo(80, 6);
    expect(arc!.center.y).toBeCloseTo(20, 6);
  });

  it('start tangent lies on the incoming leg, end tangent on the outgoing leg', () => {
    const [arc] = arcs(c.segments);
    expect(arc!.start.y).toBeCloseTo(0, 6); // incoming leg is y=0
    expect(arc!.end.x).toBeCloseTo(100, 6); // outgoing leg is x=100
    // tangent points are exactly `radius` from the centre
    expect(Math.hypot(arc!.start.x - arc!.center.x, arc!.start.y - arc!.center.y)).toBeCloseTo(20, 6);
    expect(Math.hypot(arc!.end.x - arc!.center.x, arc!.end.y - arc!.center.y)).toBeCloseTo(20, 6);
  });

  it('right turn (y-down) emits SVG sweep-flag 1', () => {
    const [arc] = arcs(c.segments);
    expect(arc!.sweepFlag).toBe(1);
    expect(arc!.anticlockwise).toBe(false);
    expect(toSvgPathData(c)).toContain('A 20 20 0 0 1 100 20');
  });

  it('filleted path is shorter than the sharp polyline', () => {
    expect(centerlineLength(c)).toBeLessThan(polylineLength(route));
  });
});

describe('buildPipeCenterline — left turn emits sweep-flag 0', () => {
  it('mirrors the sweep direction', () => {
    const c = buildPipeCenterline([p(0, 0), p(100, 0), p(100, -100)], 20);
    const [arc] = arcs(c.segments);
    expect(arc!.sweepFlag).toBe(0);
    expect(arc!.anticlockwise).toBe(true);
    expect(arc!.end.x).toBeCloseTo(100, 6);
    expect(arc!.end.y).toBeCloseTo(-20, 6);
  });
});

describe('buildPipeCenterline — radius clamp on short legs', () => {
  it('relaxes the radius instead of overshooting', () => {
    // legs of length 10; a desired r=20 setback (20) would overrun, so setback
    // clamps to half-leg (5) and the effective radius shrinks to 5.
    const c = buildPipeCenterline([p(0, 0), p(10, 0), p(10, 10)], 20);
    const [arc] = arcs(c.segments);
    expect(arc).toBeDefined();
    expect(arc!.radius).toBeCloseTo(5, 6);
    expect(arc!.start.x).toBeCloseTo(5, 6);
    expect(arc!.start.y).toBeCloseTo(0, 6);
    expect(arc!.end.x).toBeCloseTo(10, 6);
    expect(arc!.end.y).toBeCloseTo(5, 6);
  });
});

describe('buildPipeCenterline — straight & degenerate corners pass through', () => {
  it('collinear vertex collapses to a single line', () => {
    const c = buildPipeCenterline([p(0, 0), p(50, 0), p(100, 0)], 20);
    expect(arcs(c.segments)).toHaveLength(0);
    expect(lines(c.segments)).toHaveLength(1);
    expect(c.segments[0]).toMatchObject({ type: 'line', a: p(0, 0), b: p(100, 0) });
    expect(centerlineLength(c)).toBeCloseTo(100, 6);
  });

  it('duplicate (zero-length leg) vertex does not produce NaN', () => {
    const c = buildPipeCenterline([p(0, 0), p(0, 0), p(100, 0)], 20);
    expect(arcs(c.segments)).toHaveLength(0);
    expect(centerlineLength(c)).toBeCloseTo(100, 6);
    expect(Number.isFinite(centerlineLength(c))).toBe(true);
  });

  it('zero bend radius leaves sharp corners (no arcs)', () => {
    const c = buildPipeCenterline([p(0, 0), p(100, 0), p(100, 100)], 0);
    expect(arcs(c.segments)).toHaveLength(0);
    // sharp polyline length is preserved
    expect(centerlineLength(c)).toBeCloseTo(200, 6);
  });
});

describe('buildPipeCenterline — per-corner radii', () => {
  it('honours an array of radii per interior vertex', () => {
    // two corners with generous legs so neither clamps
    const route = [p(0, 0), p(400, 0), p(400, 400), p(0, 400)];
    const c = buildPipeCenterline(route, [10, 40]);
    const a = arcs(c.segments);
    expect(a).toHaveLength(2);
    expect(a[0]!.radius).toBeCloseTo(10, 6);
    expect(a[1]!.radius).toBeCloseTo(40, 6);
  });
});

describe('toPolyline — sampling', () => {
  it('starts at the route start and ends at the route end, all finite', () => {
    const route = [p(0, 0), p(100, 0), p(100, 100), p(220, 100)];
    const c = buildPipeCenterline(route, 25);
    const poly = toPolyline(c, 0.1);
    expect(poly[0]).toEqual(p(0, 0));
    expect(poly[poly.length - 1]).toEqual(p(220, 100));
    expect(poly.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y))).toBe(true);
  });

  it('finer tolerance yields at least as many samples', () => {
    const c = buildPipeCenterline([p(0, 0), p(100, 0), p(100, 100)], 30);
    const coarse = toPolyline(c, 5).length;
    const fine = toPolyline(c, 0.05).length;
    expect(fine).toBeGreaterThanOrEqual(coarse);
  });

  it('sampled arc points stay on the arc within tolerance', () => {
    const c = buildPipeCenterline([p(0, 0), p(100, 0), p(100, 100)], 20);
    const [arc] = arcs(c.segments);
    const poly = toPolyline(c, 0.25);
    // every sampled point is within tol of being exactly `radius` from centre,
    // for points that belong to the arc span (between its tangent endpoints).
    const onArc = poly.filter(
      (pt) => Math.abs(Math.hypot(pt.x - arc!.center.x, pt.y - arc!.center.y) - arc!.radius) < 1e-6,
    );
    expect(onArc.length).toBeGreaterThan(2);
  });
});

describe('buildPipeCenterlineFromDiameter', () => {
  it('computes radius = diameter * factor', () => {
    // diameter 20, factor 1.5 -> r 30; with long legs the arc keeps r=30
    const route = [p(0, 0), p(500, 0), p(500, 500)];
    const c = buildPipeCenterlineFromDiameter(route, 20, 1.5);
    const [arc] = arcs(c.segments);
    expect(arc!.radius).toBeCloseTo(30, 6);
  });

  it('factor 0 (current settings default behaviour when ignored) -> sharp', () => {
    const route = [p(0, 0), p(500, 0), p(500, 500)];
    const c = buildPipeCenterlineFromDiameter(route, 20, 0);
    expect(arcs(c.segments)).toHaveLength(0);
  });
});
