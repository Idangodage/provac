import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { pickCondensatePipeAtWorldPoint } from './condensateGeometry';
import {
  insertRouteVertex,
  moveRiserFoot,
  moveRouteVertex,
  offsetRouteLeg,
  reendRoute,
  removeRouteVertex,
  restartRoute,
  snapPlanPoint,
  tidyRoute,
  translateRouteInterior,
} from './condensateRouteOps';

const p = (x: number, y: number) => ({ x, y });
const square = (route: Array<{ x: number; y: number }>) => route.slice(1).every((point, index) => {
  const previous = route[index]!;
  return Math.abs(point.x - previous.x) < 1e-6 || Math.abs(point.y - previous.y) < 1e-6;
});

describe('condensate route operations', () => {
  // A unit branch: outlet, riser foot, then the run to its joint.
  const branch = [p(0, 0), p(150, 0), p(1000, 0), p(1000, 2000), p(3000, 2000)];

  it('tidies collinear points but always keeps the outlet and riser foot', () => {
    const route = [p(0, 0), p(150, 0), p(400, 0), p(1000, 0), p(1000, 1000)];
    expect(tidyRoute(route, 2)).toEqual([p(0, 0), p(150, 0), p(1000, 0), p(1000, 1000)]);
  });

  it('moves, inserts and removes bends without touching the fixed ends', () => {
    expect(moveRouteVertex(branch, 1, p(9, 9), 2)).toBe(branch);
    expect(moveRouteVertex(branch, 4, p(9, 9), 2)).toBe(branch);
    const moved = moveRouteVertex(branch, 2, p(1100, 50), 2);
    expect(moved[2]).toEqual(p(1100, 50));
    const inserted = insertRouteVertex(branch, 2, p(1000, 1000), 2);
    expect(inserted).toHaveLength(branch.length + 1);
    expect(removeRouteVertex(inserted, 3, 2)).toEqual(branch);
    expect(removeRouteVertex(branch, 1, 2)).toBe(branch);
  });

  it('moves a leg sideways, with square jogs where an end cannot move', () => {
    const middle = offsetRouteLeg(branch, 3, p(40, 300), 2);
    expect(middle[3]).toEqual(p(1000, 2300));
    expect(middle[middle.length - 1]).toEqual(p(3000, 2000));
    expect(square(middle.slice(1))).toBe(true);
    const first = offsetRouteLeg(branch, 1, p(0, 200), 2);
    expect(first.slice(0, 2)).toEqual(branch.slice(0, 2));
    expect(first[2]).toEqual(p(150, 200));
  });

  it('moves the whole run while its ends stay attached and square', () => {
    const shifted = translateRouteInterior(branch, p(0, 250), 2);
    expect(shifted.slice(0, 2)).toEqual(branch.slice(0, 2));
    expect(shifted[shifted.length - 1]).toEqual(branch[branch.length - 1]);
    expect(square(shifted.slice(1))).toBe(true);
  });

  it('keeps the riser foot within reach of the outlet and the first run straight', () => {
    const moved = moveRiserFoot(branch, p(0, 900), 300);
    expect(Math.hypot(moved[1]!.x, moved[1]!.y)).toBeCloseTo(300, 6);
    expect(moved[2]!.y).toBeCloseTo(moved[1]!.y, 6);
  });

  it('reconnects square to a moved outlet or joint', () => {
    const restarted = restartRoute(branch, p(0, 120), p(150, 120));
    expect(restarted.slice(0, 2)).toEqual([p(0, 120), p(150, 120)]);
    expect(square(restarted.slice(1))).toBe(true);
    const reended = reendRoute(branch, p(3200, 2100));
    expect(reended[reended.length - 1]).toEqual(p(3200, 2100));
    expect(square(reended.slice(1))).toBe(true);
  });

  it('snaps to alignment first, then 45°, and never beyond the tolerance', () => {
    expect(snapPlanPoint(p(1004, 507), [p(0, 0)], [p(1000, 900)], 8).point).toEqual(p(1000, 507));
    const diagonal = snapPlanPoint(p(503, 497), [p(0, 0)], [], 8).point;
    expect(Math.abs(diagonal.x)).toBeCloseTo(Math.abs(diagonal.y), 6);
    expect(snapPlanPoint(p(1030, 507), [p(0, 0)], [p(1000, 900)], 8).point).toEqual(p(1030, 507));
  });
});

describe('condensate plan pick', () => {
  const gully = {
    id: 'fg', type: 'condensate-gully', position: { x: 900, y: -100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: {},
  } as HvacElement;
  const run = {
    id: 'cd', type: 'condensate-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 1000, depth: 10, height: 50, elevation: 2500,
    mountType: 'ceiling', label: 'CD', supplyZoneRatio: 0.5,
    properties: { routePoints: [p(0, 0), p(1000, 0)], routeNodes3d: [{ x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2590 }, { x: 1000, y: 0, z: 150 }], outerDiameterMm: 32, insulationThicknessMm: 9 },
  } as HvacElement;

  it('picks the run along its length, but the gully where the run ends on it', () => {
    expect(pickCondensatePipeAtWorldPoint(p(500, 5), [gully, run], 10)?.id).toBe('cd');
    expect(pickCondensatePipeAtWorldPoint(p(1000, 0), [gully, run], 10)).toBeNull();
  });
});
