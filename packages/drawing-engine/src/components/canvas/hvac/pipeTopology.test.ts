import { describe, expect, it } from 'vitest';

import {
  bendRadiusFromDiameterMm,
  classifyNode,
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

describe('bendRadiusFromDiameterMm', () => {
  it('defaults to long-radius k=1.5', () => {
    expect(bendRadiusFromDiameterMm(28.6)).toBeCloseTo(42.9, 9);
  });

  it('honors a custom bend-radius factor', () => {
    expect(bendRadiusFromDiameterMm(28.6, 1)).toBeCloseTo(28.6, 9);
  });
});
