// Side by side on one level: the liquid dips under the gas where they would meet, on plumb steps (two full bends
// each), and nowhere else.
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { dippedNodes, withPairDips } from './pairDips';

const CORRIDOR = 2800;
const DIP = 125;
const BEND = 60;
const level = (points: Array<[number, number]>, z = CORRIDOR) => points.map(([x, y]) => ({ x, y, z }));
const options = { corridorZ: CORRIDOR, dipMm: DIP, bendMm: BEND, kitClearanceMm: 300 };
const xz = (nodes: Array<{ x: number; z: number }>) => nodes.map((node) => [Math.round(node.x), Math.round(node.z)]);

function pipe(id: string, lineKind: 'gas' | 'liquid', nodes: Array<{ x: number; y: number; z: number }>, extra: Record<string, unknown> = {}): HvacElement {
  const routePoints: Point2D[] = nodes.map(({ x, y }) => ({ x, y }));
  return {
    id, type: 'refrigerant-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 1, depth: 1, height: 60, elevation: CORRIDOR - 30, mountType: 'ceiling', label: id, supplyZoneRatio: 0,
    properties: { lineKind, routePoints, routeNodes3d: nodes, pipeDiameterMm: lineKind === 'gas' ? 15.875 : 9.525, outerDiameterMm: lineKind === 'gas' ? 66.675 : 60.325, ...extra },
  } as HvacElement;
}

describe('the level along a dipped run', () => {
  it('steps down and up plumb, a bend and a margin clear of the meeting, level either side', () => {
    expect(xz(dippedNodes(level([[0, 0], [4000, 0]]), [[1800, 2000]], options)!)).toEqual([
      [0, 2800], [1715, 2800], [1715, 2675], [2085, 2675], [2085, 2800], [4000, 2800],
    ]);
  });

  it('a meeting at the run\'s end leaves it dipped there', () => {
    expect(xz(dippedNodes(level([[0, 0], [4000, 0]]), [[0, 300]], options)!)).toEqual([[0, 2675], [385, 2675], [385, 2800], [4000, 2800]]);
    expect(xz(dippedNodes(level([[0, 0], [4000, 0]]), [[3700, 4000]], options)!)).toEqual([[0, 2800], [3615, 2800], [3615, 2675], [4000, 2675]]);
  });

  it('two meetings without room between them for the bottom bends are one dip; one inside another does not cut it short', () => {
    const one = dippedNodes(level([[0, 0], [4000, 0]]), [[1000, 1200], [1400, 1500]], options)!;
    expect(one.filter((node) => node.z === CORRIDOR - DIP).map((node) => Math.round(node.x))).toEqual([915, 1585]);
    const inside = dippedNodes(level([[0, 0], [4000, 0]]), [[0, 500], [0, 300]], options)!;
    expect(inside.filter((node) => node.z === CORRIDOR - DIP).map((node) => Math.round(node.x))).toEqual([0, 585]);
  });

  it('a step never stands on a bend: it moves along to a straight with a bend\'s room either side', () => {
    // A corner at (2000, 0): the meeting ends 30 mm before it; the step up goes past it, a bend along the next straight.
    const nodes = dippedNodes(level([[0, 0], [2000, 0], [2000, 3000]]), [[1500, 1970]], options)!;
    const up = nodes.findIndex((node, index) => index > 0 && node.z > nodes[index - 1]!.z);
    expect(nodes[up - 1]).toMatchObject({ x: 2000, y: BEND });
    expect(nodes[up]).toMatchObject({ x: 2000, y: BEND, z: CORRIDOR });
  });

  it('every change of level is plumb, and the risers stay where they are', () => {
    const nodes = [{ x: 0, y: 0, z: 2500 }, { x: 500, y: 0, z: 2500 }, { x: 500, y: 0, z: CORRIDOR }, { x: 4000, y: 0, z: CORRIDOR }];
    const dipped = dippedNodes(nodes, [[500, 800]], options)!;
    expect(dipped.slice(0, 3).map((node) => node.z)).toEqual([2500, 2500, 2675]);
    expect(dipped.at(-1)!.z).toBe(CORRIDOR);
    for (let index = 1; index < dipped.length; index += 1) {
      const a = dipped[index - 1]!; const b = dipped[index]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 || Math.abs(b.z - a.z) < 1e-6).toBe(true);
    }
  });
});

describe('a side-by-side pair', () => {
  it('dips only the liquid, only where it crosses the gas', () => {
    const gas = pipe('gas', 'gas', level([[0, 0], [6000, 0]]));
    const liquid = pipe('liquid', 'liquid', level([[3000, -3000], [3000, 3000]]));
    const out = withPairDips([gas, liquid], options);
    expect(out[0]).toBe(gas);
    const nodes = out[1]!.properties.routeNodes3d as Array<{ x: number; y: number; z: number }>;
    // The tubes meet within 63 mm of the gas's centreline (found every 10 mm); a bend and 25 mm further the dip ends.
    expect(nodes.filter((node) => node.z === CORRIDOR - DIP).map((node) => Math.round(node.y))).toEqual([-145, 145]);
    expect(nodes[0]!.z).toBe(CORRIDOR);
    expect(nodes.at(-1)!.z).toBe(CORRIDOR);
    expect(out[1]!.elevation).toBeCloseTo(CORRIDOR - DIP - 60.325 / 2, 6);
  });

  it('a pair side by side and clear of each other is left as it is', () => {
    const gas = pipe('gas', 'gas', level([[0, 0], [6000, 0]]));
    const liquid = pipe('liquid', 'liquid', level([[0, 90], [6000, 90]]));
    expect(withPairDips([gas, liquid], options)[1]).toBe(liquid);
  });

  it('a gas line at another level is no meeting', () => {
    const gas = pipe('gas', 'gas', level([[0, 0], [6000, 0]], 2500));
    const liquid = pipe('liquid', 'liquid', level([[3000, -3000], [3000, 3000]]));
    expect(withPairDips([gas, liquid], options)[1]).toBe(liquid);
  });

  it('a liquid line off a kit stays down past the kit\'s straight, and its connection with it', () => {
    const gas = pipe('gas', 'gas', level([[0, 500], [6000, 500]]));
    const startConnection = { connectionKind: 'field-pipe', terminalRole: 'run-outlet', elevationMm: CORRIDOR, portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };
    const liquid = pipe('liquid', 'liquid', level([[0, 0], [3000, 0]]), { startConnection });
    const out = withPairDips([gas, liquid], options)[1]!;
    const nodes = out.properties.routeNodes3d as Array<{ x: number; z: number }>;
    expect(nodes[0]!.z).toBe(CORRIDOR - DIP);
    expect((out.properties.startConnection as { elevationMm: number }).elevationMm).toBe(CORRIDOR - DIP);
    const up = nodes.findIndex((node) => node.z === CORRIDOR);
    expect(nodes[up - 1]!.x).toBeGreaterThanOrEqual(300 + BEND);
  });
});
