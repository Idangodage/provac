import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../../types';

import {
  assignmentCostMm,
  solveAirSystemAssignment,
  type AssignmentOptions,
  type AssignmentTerminal,
  type AssignmentUnit,
  type AssignmentWall,
} from './airSystemAssignment';
import type { DuctService } from './ductTypes';

const options: AssignmentOptions = { wallPenaltyMm: 4000, overloadMm: 2500, nearbyMm: 10000 };

function unit(id: string, at: Point2D, roomId: string | null = 'r1', airflowM3h = 600, preload?: AssignmentUnit['preload']): AssignmentUnit {
  // Supply collar facing −Y, return collar facing +Y, both at the unit.
  return {
    id, airflowM3h, roomId, ...(preload ? { preload } : {}),
    collars: { supply: { lip: { x: at.x, y: at.y - 350 }, normal: { x: 0, y: -1 } }, return: { lip: { x: at.x, y: at.y + 350 }, normal: { x: 0, y: 1 } } },
  };
}
const terminal = (id: string, at: Point2D, service: DuctService = 'supply', roomId: string | null = 'r1'): AssignmentTerminal => ({ id, service, lip: at, roomId });

/** Every assignment respecting the eligibility rules, priced as the solver's objective: the exact optimum. */
function bruteForce(units: AssignmentUnit[], terminals: AssignmentTerminal[], walls: AssignmentWall[]): number {
  const service = terminals[0]!.service;
  const eligible = terminals.map((t) => {
    const withCollar = units.filter((u) => u.collars[service]);
    const sameRoom = t.roomId ? withCollar.filter((u) => u.roomId === t.roomId) : [];
    return t.roomId ? (sameRoom.length ? sameRoom : withCollar) : withCollar;
  });
  // Fair share as the solver defines it: pre-loaded terminals split among their room's units, then each new one among its units.
  const share = new Map(units.map((u) => [u.id, 0]));
  for (const u of units) {
    const preload = u.preload?.[service] ?? 0;
    const peers = u.roomId ? units.filter((v) => v.collars[service] && v.roomId === u.roomId) : [u];
    const total = peers.reduce((sum, v) => sum + Math.max(v.airflowM3h, 1), 0);
    for (const v of peers) share.set(v.id, share.get(v.id)! + (preload * Math.max(v.airflowM3h, 1)) / total);
  }
  for (const list of eligible) {
    const total = list.reduce((sum, u) => sum + Math.max(u.airflowM3h, 1), 0);
    for (const u of list) share.set(u.id, share.get(u.id)! + Math.max(u.airflowM3h, 1) / total);
  }
  const free = new Map(units.map((u) => [u.id, Math.max(0, Math.round(share.get(u.id)!) - (u.preload?.[service] ?? 0))]));
  let best = Number.POSITIVE_INFINITY;
  const loads = new Map(units.map((u) => [u.id, 0]));
  const walk = (index: number, cost: number) => {
    if (index === terminals.length) {
      let total = cost;
      for (const u of units) total += Math.max(0, loads.get(u.id)! - free.get(u.id)!) * options.overloadMm;
      best = Math.min(best, total);
      return;
    }
    for (const u of eligible[index]!) {
      loads.set(u.id, loads.get(u.id)! + 1);
      walk(index + 1, cost + assignmentCostMm(u.collars[service]!, terminals[index]!, walls, options.wallPenaltyMm));
      loads.set(u.id, loads.get(u.id)! - 1);
    }
  };
  walk(0, 0);
  return best;
}

describe('balanced terminal assignment (exact min-cost flow)', () => {
  it('equals brute force on random small rooms', () => {
    const point = fc.record({ x: fc.integer({ min: -6000, max: 6000 }), y: fc.integer({ min: -6000, max: 6000 }) });
    fc.assert(fc.property(
      fc.array(fc.record({ at: point, airflow: fc.integer({ min: 200, max: 1500 }), room: fc.constantFrom('r1', 'r2'), pre: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 3 }),
      fc.array(fc.record({ at: point, room: fc.constantFrom('r1', 'r2', 'r3') }), { minLength: 1, maxLength: 6 }),
      fc.array(fc.record({ a: point, b: point }), { maxLength: 2 }),
      (unitSeeds, terminalSeeds, walls) => {
        const units = unitSeeds.map((seed, index) => unit(`u${index}`, seed.at, seed.room, seed.airflow, { supply: seed.pre }));
        const terminals = terminalSeeds.map((seed, index) => terminal(`t${index}`, seed.at, 'supply', seed.room));
        const solved = solveAirSystemAssignment(units, terminals, walls, options);
        expect(solved.assignments).toHaveLength(terminals.length);
        expect(solved.totalCostMm).toBeCloseTo(bruteForce(units, terminals, walls), 6);
      },
    ), { numRuns: 150, seed: 20261004 });
  });

  it('splits a room between two equal units, each taking the terminals nearest it', () => {
    const units = [unit('a', { x: 0, y: 0 }), unit('b', { x: 8000, y: 0 })];
    const terminals = [0, 1500, 3000, 5000, 6500, 8000].map((x, index) => terminal(`s${index}`, { x, y: -2500 }));
    const solved = solveAirSystemAssignment(units, terminals, [], options);
    const of = (id: string) => solved.assignments.find((entry) => entry.terminalId === id)!.unitId;
    expect(['s0', 's1', 's2'].map(of)).toEqual(['a', 'a', 'a']);
    expect(['s3', 's4', 's5'].map(of)).toEqual(['b', 'b', 'b']);
    expect(solved.loads.get('a')!.supply).toBe(3);
  });

  it('shares by airflow: a unit moving twice the air takes twice the terminals', () => {
    const units = [unit('big', { x: 0, y: 0 }, 'r1', 1200), unit('small', { x: 300, y: 0 }, 'r1', 600)];
    const terminals = [0, 1, 2, 3, 4, 5].map((index) => terminal(`s${index}`, { x: index * 1000, y: -2500 }));
    const solved = solveAirSystemAssignment(units, terminals, [], options);
    expect(solved.loads.get('big')!.supply).toBe(4);
    expect(solved.loads.get('small')!.supply).toBe(2);
  });

  it('counts the terminals a unit already has before balancing', () => {
    const units = [unit('a', { x: 0, y: 0 }, 'r1', 600, { supply: 3 }), unit('b', { x: 4000, y: 0 })];
    const terminals = [1000, 1500, 2000].map((x, index) => terminal(`s${index}`, { x, y: -2500 }));
    const solved = solveAirSystemAssignment(units, terminals, [], options);
    // Fair: 3 each in all; a already has 3, so the new ones go to b even though a is nearer to some.
    expect(solved.assignments.every((entry) => entry.unitId === 'b')).toBe(true);
  });

  it('keeps a terminal to the units of its own room, and serves a room without one from the nearest through a wall', () => {
    const units = [unit('a', { x: 0, y: 0 }, 'r1'), unit('b', { x: 6000, y: 0 }, 'r2')];
    const walls: AssignmentWall[] = [{ a: { x: 3000, y: -5000 }, b: { x: 3000, y: 5000 } }];
    // t0 sits right beside b but in a's room: it is a's.
    const near = solveAirSystemAssignment(units, [terminal('t0', { x: 5000, y: -2500 }, 'supply', 'r1')], walls, options);
    expect(near.assignments[0]!.unitId).toBe('a');
    // A room with no unit (r3, beyond b): the nearest unit, the wall priced in.
    const adopted = solveAirSystemAssignment(units, [terminal('t1', { x: 9000, y: -2500 }, 'supply', 'r3')], walls, options);
    expect(adopted.assignments[0]!.unitId).toBe('b');
    const crossing = solveAirSystemAssignment(units, [terminal('t2', { x: 2500, y: -2500 }, 'supply', 'r3')], walls, options);
    expect(crossing.assignments[0]!.unitId).toBe('a');
  });

  it('says why a terminal cannot be assigned, and is deterministic', () => {
    const noReturn: AssignmentUnit = { ...unit('a', { x: 0, y: 0 }), collars: { supply: unit('a', { x: 0, y: 0 }).collars.supply! } };
    const solved = solveAirSystemAssignment([noReturn], [terminal('r0', { x: 0, y: 2000 }, 'return')], [], options);
    expect(solved.assignments).toEqual([]);
    expect(solved.unassignable).toEqual([{ terminalId: 'r0', reason: 'no ducted unit has a return collar' }]);
    const far = solveAirSystemAssignment([unit('a', { x: 0, y: 0 }, null)], [terminal('t0', { x: 20000, y: 0 }, 'supply', null)], [], options);
    expect(far.unassignable[0]!.reason).toContain('within 10 m');
    const units = [unit('a', { x: 0, y: 0 }), unit('b', { x: 2000, y: 0 })];
    const terminals = [terminal('x', { x: 1000, y: -2000 }), terminal('y', { x: 1000, y: -3000 })];
    const first = solveAirSystemAssignment(units, terminals, [], options);
    const second = solveAirSystemAssignment([...units].reverse(), [...terminals].reverse(), [], options);
    const key = (result: typeof first) => result.assignments.map((entry) => `${entry.terminalId}>${entry.unitId}`).sort().join(',');
    expect(key(second)).toBe(key(first));
  });
});
