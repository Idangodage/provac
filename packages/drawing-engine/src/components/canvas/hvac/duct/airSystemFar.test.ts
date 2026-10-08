import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { assignmentOptions, assignmentProblemFromScene, farAssignments, solveAirSystemAssignment } from './airSystemAssignment';
import { resolveUnitAirPorts } from './ductAirPorts';
import { checkAirSystems } from './ductAirSystemChecks';
import { buildDuctRunDraftElement } from './ductDraft';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec, type DuctTerminalSpec } from './ductTerminals';
import { roundLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const supply = typicalTerminalSpec('square-4way', 200);
const ret = typicalTerminalSpec('return-egg-crate', 250);

/** An FDUM22 centred on `centre` (supply collar to −y, return to +y). */
function unit(id: string, centre: Point2D, roomId = 'hall', properties: Record<string, unknown> = {}): HvacElement {
  return {
    id, type: 'ducted-ac', position: { x: centre.x - 542, y: centre.y - 348.5 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400,
    mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId, properties: { modelCode: 'FDUM22KXE6F-W', airSystemTag: `DU-${id.slice(1)}`, ...properties },
  };
}

function terminal(id: string, centre: Point2D, spec: DuctTerminalSpec, unitId: string | null, roomId = 'hall'): HvacElement {
  const envelope = terminalEnvelope(spec);
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId, properties: { terminal: spec, ...(unitId ? { airSystem: { unitId } } : {}) },
  };
}

/**
 * The user's 26 m room (read off their plan): four FDUM22 in a row, two
 * diffusers above and two grilles below each, each terminal on its own unit;
 * `swap` gives SAD-1 to DU-4 and SAD-8 to DU-1.
 */
function userRoom(swap = false): HvacElement[] {
  const units = [{ x: 5956, y: 7286 }, { x: 11937, y: 7413 }, { x: 17742, y: 7464 }, { x: 23522, y: 7514 }];
  const supplies = [[{ x: 2111, y: 2859 }, { x: 6207, y: 3011 }], [{ x: 11434, y: 3163 }, { x: 13621, y: 1391 }],
    [{ x: 15907, y: 3416 }, { x: 19551, y: 3365 }], [{ x: 23848, y: 3365 }, { x: 25500, y: 2000 }]];
  const returns = [[{ x: 1733, y: 11640 }, { x: 8343, y: 12100 }], [{ x: 12389, y: 11562 }, { x: 15731, y: 11714 }],
    [{ x: 18496, y: 11815 }, { x: 21009, y: 11815 }], [{ x: 23446, y: 11765 }, { x: 25884, y: 9741 }]];
  const scene: HvacElement[] = units.map((at, index) => unit(`u${index + 1}`, at));
  supplies.forEach((pair, index) => pair.forEach((at, k) => {
    const n = index * 2 + k + 1;
    const owner = swap && n === 1 ? 'u4' : swap && n === 8 ? 'u1' : `u${index + 1}`;
    scene.push(terminal(`sad-${n}`, at, supply, owner));
  }));
  returns.forEach((pair, index) => pair.forEach((at, k) => scene.push(terminal(`rag-${index * 2 + k + 1}`, at, ret, `u${index + 1}`))));
  return scene;
}

const farCodes = (scene: readonly HvacElement[], rule = settings) => checkAirSystems(scene, rule).filter((issue) => issue.code === 'DU_SYSTEM_FAR');

describe('terminals served by far units (DU_SYSTEM_FAR)', () => {
  it('flags the two diffusers swapped across the room, each with its nearer unit and a fix; nothing when each is on its own unit', () => {
    expect(farCodes(userRoom())).toEqual([]);
    const far = farAssignments(userRoom(true), [], [], settings);
    expect(far.map((entry) => `${entry.tag}:${entry.unitTag}>${entry.nearestTag}`)).toEqual(['SAD-1:DU-4>DU-1', 'SAD-8:DU-1>DU-4']);
    for (const entry of far) {
      expect(entry.distanceMm - entry.nearestDistanceMm).toBeGreaterThan(settings.farAssignmentExtraMm);
      expect(entry.distanceMm).toBeGreaterThan(entry.nearestDistanceMm * settings.farAssignmentRatio);
      expect(entry.ducted).toBe(false);
    }
    const issues = farCodes(userRoom(true));
    expect(issues.map((issue) => `${issue.level}:${issue.entityId}`)).toEqual(['warning:sad-1', 'warning:sad-8']);
    expect(issues[0]!.message).toMatch(/^SAD-1 is served by DU-4, about \d+\.\d m of duct away; DU-1 in its room is about \d+\.\d m away\.$/);
    expect(issues[0]!.fix).toEqual({ kind: 'reassign-far-terminals', terminalIds: ['sad-1'] });
  });

  it('needs both: more than the margin farther, and more than the factor as far', () => {
    expect(farCodes(userRoom(true), { ...settings, farAssignmentExtraMm: 30000 })).toEqual([]);
    expect(farCodes(userRoom(true), { ...settings, farAssignmentRatio: 10 })).toEqual([]);
    // A neighbour's diffuser 2 m past the midpoint: farther, but not far.
    const near = [unit('u1', { x: 0, y: 0 }), unit('u2', { x: 8000, y: 0 }), terminal('sad-1', { x: 2000, y: -3000 }, supply, 'u2')];
    expect(farAssignments(near, [], [], settings)).toEqual([]);
    const far = [unit('u1', { x: 0, y: 0 }), unit('u2', { x: 20000, y: 0 }), terminal('sad-1', { x: 1000, y: -3000 }, supply, 'u2')];
    expect(farAssignments(far, [], [], settings).map((entry) => entry.terminalId)).toEqual(['sad-1']);
  });

  it("compares only units in the terminal's room with a collar of its service", () => {
    const scene = [unit('u1', { x: 0, y: 0 }), unit('u2', { x: 20000, y: 0 }), terminal('sad-1', { x: 1000, y: -3000 }, supply, 'u2')];
    // The near unit in another room does not count: serving the hall from there is not shorter.
    expect(farAssignments([{ ...scene[0]!, roomId: 'annex' }, ...scene.slice(1)], [], [], settings)).toEqual([]);
    // A return grille by a unit with no return collar: nothing nearer can take it.
    const supplyOnly = unit('u1', { x: 0, y: 0 }, 'hall', { airPorts: [{ id: 'supply', kind: 'supply', lip: { x: -117, y: -348.5, z: 152 }, normal: { x: 0, y: -1 }, widthMm: 674, heightMm: 164 }] });
    const grille = terminal('rag-1', { x: 1000, y: 2500 }, ret, 'u2');
    expect(farAssignments([supplyOnly, scene[1]!, grille], [], [], settings)).toEqual([]);
    expect(farAssignments([scene[0]!, scene[1]!, grille], [], [], settings).map((entry) => entry.tag)).toEqual(['RAG-1']);
  });

  it('a terminal its far unit already ducts is flagged with how to re-route it, and no automatic fix', () => {
    const u1 = unit('u1', { x: 0, y: 0 });
    const u2 = unit('u2', { x: 20000, y: 0 });
    const s1 = terminal('sad-1', { x: 1000, y: -3000 }, { ...supply, spigotSide: 'front' }, 'u2');
    const collar = resolveUnitAirPorts(u2).find((port) => port.kind === 'supply')!;
    const lip = terminalSpigotPort(s1)!.lip;
    const run = buildDuctRunDraftElement({
      port: collar, points: [{ x: collar.lip.x, y: lip.y + 400 }, { x: lip.x, y: lip.y + 400 }, { x: lip.x, y: lip.y, z: lip.z - 100 }],
      legSizes: [{ widthMm: collar.widthMm, heightMm: collar.heightMm }, roundLeg(200), roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'sad-1', portId: 'spigot', flex: true },
    }, 'run');
    const [issue] = farCodes([u1, u2, s1, run]);
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
    expect(issue!.suggestedFix).toContain('Rebuild existing ducts');
  });

  it('a balanced assignment is never flagged (moving a terminal costs at most one fair-share overload, under the margin)', () => {
    const point = fc.record({ x: fc.integer({ min: 1000, max: 25000 }), y: fc.integer({ min: 1000, max: 12000 }) });
    fc.assert(fc.property(
      fc.array(point, { minLength: 2, maxLength: 4 }),
      fc.array(fc.record({ at: point, isReturn: fc.boolean() }), { minLength: 1, maxLength: 8 }),
      (unitSpots, terminalSeeds) => {
        const units = unitSpots.map((at, index) => unit(`u${index + 1}`, at));
        const terminals = terminalSeeds.map((seed, index) => terminal(`t-${index + 1}`, seed.at, seed.isReturn ? ret : supply, null));
        const scene = [...units, ...terminals];
        const problem = assignmentProblemFromScene(scene, [], []);
        const solved = solveAirSystemAssignment(problem.units, problem.terminals, problem.walls, assignmentOptions(settings));
        const owner = new Map(solved.assignments.map((entry) => [entry.terminalId, entry.unitId]));
        const assigned = scene.map((element) => (owner.has(element.id) ? { ...element, properties: { ...element.properties, airSystem: { unitId: owner.get(element.id)! } } } : element));
        expect(farAssignments(assigned, [], [], settings)).toEqual([]);
      },
    ), { numRuns: 120, seed: 20261008 });
  });

  it('the margin and the factor are settings (6 m and 2× by default), kept in range', () => {
    expect([settings.farAssignmentExtraMm, settings.farAssignmentRatio]).toEqual([6000, 2]);
    const clamped = resolveDuctSettings({ farAssignmentExtraMm: -5, farAssignmentRatio: 0.5 });
    expect([clamped.farAssignmentExtraMm, clamped.farAssignmentRatio]).toEqual([0, 1]);
  });
});
