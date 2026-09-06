import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import {
  buildOrthogonalConnectionRouteCandidates,
  getOrthogonalConnectionRouteCost,
  type OrthogonalConnectionRouteOptions,
} from './orthogonalConnectionRoute';

const defaults: OrthogonalConnectionRouteOptions = {
  start: { x: 0, y: 0 }, end: { x: 1000, y: 500 },
  startDirection: { x: 1, y: 0 }, endDirection: { x: 1, y: 0 },
  startStraightMm: 100, endStraightMm: 100, bendRadiusMm: 50,
};

describe('buildOrthogonalConnectionRouteCandidates', () => {
  it('joins same-facing sockets on the nearest common outside lane with only two elbows', () => {
    const routes = buildOrthogonalConnectionRouteCandidates(defaults);
    expect(routes[0]).toEqual([
      { x: 0, y: 0 }, { x: 1150, y: 0 }, { x: 1150, y: 500 }, { x: 1000, y: 500 },
    ]);
    expect(getOrthogonalConnectionRouteCost(routes[0]!)).toEqual({ bends: 2, lengthMm: 1800 });
  });

  it.each([90, 180, 270])('keeps the two-elbow result when the layout rotates by %s degrees', (angle) => {
    const radians = angle * Math.PI / 180;
    const rotate = (point: Point2D) => ({
      x: Math.round(point.x * Math.cos(radians) - point.y * Math.sin(radians)) || 0,
      y: Math.round(point.x * Math.sin(radians) + point.y * Math.cos(radians)) || 0,
    });
    const routes = buildOrthogonalConnectionRouteCandidates({
      ...defaults,
      start: rotate(defaults.start), end: rotate(defaults.end),
      startDirection: rotate(defaults.startDirection!), endDirection: rotate(defaults.endDirection),
    });
    expect(routes[0]).toEqual([
      { x: 0, y: 0 }, { x: 1150, y: 0 }, { x: 1150, y: 500 }, { x: 1000, y: 500 },
    ].map(rotate));
  });

  it('uses a straight connection between aligned facing sockets', () => {
    const options = { ...defaults, end: { x: 1000, y: 0 }, endDirection: { x: -1, y: 0 } };
    expect(buildOrthogonalConnectionRouteCandidates(options)[0]).toEqual([options.start, options.end]);
  });

  it('uses the direct L for perpendicular sockets when both straight lengths fit', () => {
    const routes = buildOrthogonalConnectionRouteCandidates({ ...defaults, endDirection: { x: 0, y: -1 } });
    expect(routes[0]).toEqual([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }]);
  });

  it('allows an authored waypoint to turn immediately instead of forcing a short extra departure', () => {
    const options = {
      ...defaults, start: { x: 800, y: 0 }, end: { x: 1000, y: 500 },
      startDirection: undefined, incomingDirection: { x: 1, y: 0 }, startStraightMm: 0,
      endDirection: { x: -1, y: 0 },
    };
    const routes = buildOrthogonalConnectionRouteCandidates(options);
    expect(routes[0]).toEqual([{ x: 800, y: 0 }, { x: 800, y: 500 }, { x: 1000, y: 500 }]);
    expect(getOrthogonalConnectionRouteCost(routes[0]!, options.incomingDirection).bends).toBe(2);
  });

  it('never reverses immediately over the authored incoming segment', () => {
    const options = { ...defaults, startDirection: undefined, incomingDirection: { x: -1, y: 0 }, startStraightMm: 0 };
    const routes = buildOrthogonalConnectionRouteCandidates(options);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(route[1]!.x).toBeLessThanOrEqual(route[0]!.x);
  });

  it('does not accept elbows whose setbacks overlap on a narrow cross leg', () => {
    const routes = buildOrthogonalConnectionRouteCandidates({ ...defaults, end: { x: 1000, y: 60 } });
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.length > 4)).toBe(true);
    for (const route of routes) {
      for (let index = 1; index < route.length - 2; index += 1) {
        const length = Math.hypot(route[index + 1]!.x - route[index]!.x, route[index + 1]!.y - route[index]!.y);
        expect(length).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it('preserves exact socket positions, provides bounded alternatives, and ranks deterministically', () => {
    const options = { ...defaults, start: { x: 0.12345, y: 0.67891 }, end: { x: 1000.23456, y: 500.78912 } };
    const routes = buildOrthogonalConnectionRouteCandidates(options);
    expect(routes).toEqual(buildOrthogonalConnectionRouteCandidates(options));
    expect(routes.length).toBeGreaterThan(1);
    expect(routes.length).toBeLessThanOrEqual(12);
    for (const [index, route] of routes.entries()) {
      expect(route[0]).toEqual(options.start);
      expect(route[route.length - 1]).toEqual(options.end);
      if (index === 0) continue;
      const previous = getOrthogonalConnectionRouteCost(routes[index - 1]!);
      const current = getOrthogonalConnectionRouteCost(route);
      expect(current.bends > previous.bends || (current.bends === previous.bends && current.lengthMm >= previous.lengthMm)).toBe(true);
    }
  });

  it.each([
    { end: { x: Number.NaN, y: 0 } },
    { endDirection: { x: 0, y: 0 } },
    { startDirection: { x: Infinity, y: 0 } },
    { bendRadiusMm: -1 },
  ])('rejects invalid geometry without generating corrupt routes: %j', (overrides) => {
    expect(buildOrthogonalConnectionRouteCandidates({ ...defaults, ...overrides })).toEqual([]);
  });
});
