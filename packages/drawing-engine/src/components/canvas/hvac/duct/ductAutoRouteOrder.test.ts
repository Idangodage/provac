import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { applyDuctProposal, betterDuctPass, boxedInUnits, planAutoRouteDucts, proposedDuctLengthMm, type AutoRouteDuctUnit } from './ductAutoRoute';
import { buildDuctRunDraftElement } from './ductDraft';
import { resolveDuctSettings } from './ductSettings';
import type { DuctTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg } from './ductTypes';
import { findDuctClashes } from './ductVolumes';

const settings = resolveDuctSettings({});
const SUPPLY = {
  service: 'supply', mount: 'lay-in', neckDiameterMm: 200, plenumHeightMm: 300, spigotSide: 'back', spigotLengthMm: 60, kind: 'square-4way',
  faceWidthMm: 595, faceDepthMm: 595, faceHeightMm: 35, plenumWidthMm: 530, plenumDepthMm: 530,
} as DuctTerminalSpec;

/** An FDUM22 as placed on the canvas (top-left `x`, `y`). */
const unit = (id: string, x: number, y: number): HvacElement => ({
  id, type: 'ducted-ac', position: { x, y }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
  label: `DU-${id.slice(1)}`, supplyZoneRatio: 0.5, roomId: 'hall',
  properties: { modelCode: 'FDUM22KXE6F-W', capacityKw: 2.2, airflowM3min: { 'p-hi': 13, hi: 10, me: 9, lo: 8 }, maxEspPa: 100, airDataSource: 'mhi-fdum22-data', airSystemTag: `DU-${id.slice(1)}` },
});
const diffuser = (id: string, x: number, y: number, unitId: string): HvacElement => ({
  id, type: 'diffuser', position: { x, y }, rotation: 0, width: 595, depth: 595, height: 335, elevation: 2400, mountType: 'ceiling',
  label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'hall', properties: { terminal: SUPPLY, airSystem: { unitId } },
});
let outcomes = 0;
const outcome = (status: AutoRouteDuctUnit['status'], clash = false): AutoRouteDuctUnit => ({
  unitId: `unit-${(outcomes += 1)}`, unitLabel: 'FDUM22', status, services: [], requiredEspPa: null, maxEspPa: null, firstCost: null, lifeCycleCost: null,
  currency: 'USD', runIds: [], exact: null, notes: [],
  diagnostics: clash ? [{ code: 'DU_CLASH', severity: 'error', message: 'The trunk crosses 2 pieces of equipment at duct level.' }] : [{ code: 'DU_AUTO_ESP', severity: 'error', message: 'Over the fan pressure.' }],
});
/** A straight run `length` long off a unit's supply collar. */
const run = (id: string, length: number): HvacElement => {
  const port = resolveUnitAirPorts(unit('u9', 0, 0)).find((entry) => entry.kind === 'supply')!;
  return buildDuctRunDraftElement({ port, points: [{ x: port.lip.x, y: port.lip.y - length }], legSizes: [roundLeg(200)] }, id);
};

describe('Auto route: a unit boxed in by the ducts proposed before it', () => {
  it('a second pass puts first the units that failed on a clash after another unit was designed', () => {
    const [a, b, c, d] = [outcome('designed'), outcome('kept', true), outcome('kept'), outcome('kept', true)];
    expect(boxedInUnits([a, b, c, d])).toEqual([b.unitId, d.unitId]);
    // Failing first, or for another reason, the order did not do it.
    expect(boxedInUnits([b, a])).toEqual([]);
    expect(boxedInUnits([a, c])).toEqual([]);
  });

  it('keeps the pass that designs more units, then the one with less duct, else the first', () => {
    const one = { units: [outcome('designed'), outcome('kept', true)], elementsToAdd: [run('r1', 3000)] };
    const two = { units: [outcome('designed'), outcome('designed')], elementsToAdd: [run('r2', 9000), run('r3', 4000)] };
    expect(proposedDuctLengthMm(two.elementsToAdd)).toBeCloseTo(13000, 6);
    expect(betterDuctPass(two, one)).toBe(true);
    expect(betterDuctPass(one, two)).toBe(false);
    const shorter = { units: one.units, elementsToAdd: [run('r4', 2000)] };
    expect(betterDuctPass(shorter, one)).toBe(true);
    expect(betterDuctPass(one, one)).toBe(false);
  });

  it('designs both units when the first order boxes one in: DU-1 serves a diffuser beyond DU-2', () => {
    // From the user's 26 m room (as placed on the canvas): DU-1's second diffuser is 20 m away, past DU-2's.
    const scene = [
      unit('u1', 5386.0, 6915.4), diffuser('sad-2', 5901.0, 2698.3, 'u1'), diffuser('sad-8', 25198.0, 1676.3, 'u1'),
      unit('u2', 11367.5, 7035.7), diffuser('sad-3', 11131.1, 2848.5, 'u2'), diffuser('sad-4', 13295.2, 1075.1, 'u2'),
    ];
    const corners = [{ x: 600, y: 380 }, { x: 26700, y: 380 }, { x: 26700, y: 13030 }, { x: 600, y: 13030 }];
    const walls = corners.map((a, index) => ({ id: `w${index}`, startPoint: a, endPoint: corners[(index + 1) % 4]!, thickness: 150, baseZ: 0, topZ: 2700, structural: false }));
    const stages: string[] = [];
    const result = planAutoRouteDucts(scene, { supply: true, return: false }, {
      settings, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing', walls, rooms: [{ id: 'hall', vertices: corners }],
    }, (progress) => stages.push(progress.stage));
    // The first pass designed DU-1 and boxed DU-2 in; the second designs DU-2 first, then DU-1 around it.
    expect(stages.some((stage) => stage.startsWith('Second pass, boxed-in units first: DU-2'))).toBe(true);
    expect(result.units.map((entry) => `${entry.tag}:${entry.status}`)).toEqual(['DU-2:designed', 'DU-1:designed']);
    expect(result.units[0]!.notes[0]).toMatch(/^Designed before the other units, on a second pass/);
    const served = new Set(result.elementsToAdd.flatMap((element) => {
      const end = readDuctRunSpec(element)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    }));
    expect(served).toEqual(new Set(['sad-2', 'sad-8', 'sad-3', 'sad-4']));
    expect(findDuctClashes(applyDuctProposal(scene, result), settings, [])).toEqual([]);
  }, 180000);
});
