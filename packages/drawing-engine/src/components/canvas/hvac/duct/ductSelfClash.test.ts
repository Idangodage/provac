/**
 * A duct run that crosses itself is a clash: its pieces against its own
 * pieces further along (not the piece each is joined to). On the canvas for
 * drawn runs, and in Auto duct's verification (where it steers the router).
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuctInShape, type AutoDuctShape } from './ductAutoLayout';
import { buildDuctRunDraftElement } from './ductDraft';
import { DEFAULT_DUCT_SETTINGS } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';
import { validateDuctRuns } from './ductValidation';
import { clashMessage, findDuctClashes } from './ductVolumes';

const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const bottom = port.lip.z - port.heightMm / 2;

/** A 250 × 250 run off the supply collar through `points` ([along, across] from the collar, mm), ending capped. */
function run(id: string, points: Array<[number, number]>, size = 250): HvacElement {
  return buildDuctRunDraftElement({
    port, points: points.map(([along, across]) => ({ x: port.lip.x + across, y: port.lip.y - along, z: bottom })),
    legSizes: [{ widthMm: size, heightMm: size }], end: 'end-cap',
  }, id);
}
const selfClashes = (element: HvacElement) => findDuctClashes([unit, element], DEFAULT_DUCT_SETTINGS, []).filter((clash) => clash.kind === 'self');

describe('a run that crosses itself', () => {
  it('doubling back over itself (the return leg closer than the duct is wide) is a clash, named piece by piece', () => {
    const element = run('back', [[2500, 0], [2500, 200], [900, 200]]);
    const [clash] = selfClashes(element);
    expect(clash).toMatchObject({ ductId: 'back', otherId: 'back', kind: 'self' });
    expect(clash!.otherMark).toMatch(/^[A-Z]-\d+/);
    expect(clashMessage(clash!)).toBe(`${clash!.mark} crosses ${clash!.otherMark} of its own run.`);
  });

  it('crossing its own straight further back is a clash', () => {
    expect(selfClashes(run('loop', [[2500, 0], [2500, 1200], [1500, 1200], [1500, -1000]]))).toHaveLength(1);
  });

  it('an offset, two elbows back to back, and a U-turn with room between its legs keep clear of themselves', () => {
    expect(selfClashes(run('offset', [[1200, 0], [1700, 500], [3200, 500]]))).toEqual([]);
    expect(selfClashes(run('s-bend', [[1500, 0], [1500, 700], [3000, 700]]))).toEqual([]);
    expect(selfClashes(run('u-turn', [[2500, 0], [2500, 1500], [900, 1500]]))).toEqual([]);
  });

  it('on the canvas: the check names both pieces and says how to clear it', () => {
    const element = run('drawn', [[2500, 0], [2500, 1200], [1500, 1200], [1500, -1000]]);
    const issue = validateDuctRuns([unit, element], DEFAULT_DUCT_SETTINGS).issues.find((entry) => entry.id === 'DU_CLASH:drawn:self');
    expect(issue).toMatchObject({ level: 'error', code: 'DU_CLASH', entityId: 'drawn' });
    expect(issue!.message).toMatch(/: [A-Z]-\d+ crosses [A-Z]-\d+ of the same run at \(-?\d+, -?\d+, z \d+\)\.$/);
    expect(issue!.suggestedFix).toMatch(/does not double back over itself/);
  });
});

describe('two diffusers close to the unit, in the project\'s 6.45 × 4.65 m room', () => {
  // The FDUM22 2.8 m from the wall its collar faces; two square Ø200 diffusers 1.6 m out, 0.8 m either side.
  const roomUnit: HvacElement = { ...unit, id: 'fdum', position: { x: 5053.94, y: 4242.02 } };
  const lip = resolveUnitAirPorts(roomUnit).find((entry) => entry.kind === 'supply')!.lip;
  function diffuser(id: string, centre: Point2D): HvacElement {
    const spec = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(spec);
    return {
      id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
      label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
    };
  }
  const terminals = [diffuser('d1', { x: lip.x - 800, y: lip.y - 1600 }), diffuser('d2', { x: lip.x + 800, y: lip.y - 1600 })];
  const walls = [
    { id: 'w1', startPoint: { x: 2300, y: 1350 }, endPoint: { x: 8900, y: 1350 }, thickness: 150 },
    { id: 'w2', startPoint: { x: 8900, y: 1350 }, endPoint: { x: 8900, y: 6150 }, thickness: 150 },
    { id: 'w3', startPoint: { x: 8900, y: 6150 }, endPoint: { x: 2300, y: 6150 }, thickness: 150 },
    { id: 'w4', startPoint: { x: 2300, y: 6150 }, endPoint: { x: 2300, y: 1350 }, thickness: 150 },
  ];
  const rooms = [{ id: 'r', vertices: [{ x: 2375, y: 1425 }, { x: 8825, y: 1425 }, { x: 8825, y: 6075 }, { x: 2375, y: 6075 }] }];
  const design = (shape: AutoDuctShape) => {
    const drawing = [roomUnit, ...terminals];
    const result = generateAutoDuctInShape(drawing, {
      unitId: 'fdum', terminalIds: ['d1', 'd2'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false },
      rebuildExisting: false, shape, walls, rooms,
    }, DEFAULT_DUCT_SETTINGS);
    const turned = new Map(result.terminalUpdates.map((element) => [element.id, element]));
    return { result, scene: [...drawing.map((element) => turned.get(element.id) ?? element), ...result.runs] };
  };

  it('no shape keeps a design that crosses itself (Rect + round once kept a trunk running back over its own straight)', () => {
    for (const shape of ['rect', 'round', 'optimal'] as const) {
      const { scene } = design(shape);
      expect(findDuctClashes(scene, DEFAULT_DUCT_SETTINGS, []).filter((clash) => clash.kind === 'self'), shape).toEqual([]);
    }
  }, 240000);

  it('Rect + round keeps a plenum on the collar, its spigots placed for the runouts, both on its end face', () => {
    const { result } = design('rect');
    const specs = result.runs.map((run) => readDuctRunSpec(run)!);
    expect(specs.find((spec) => spec.start.kind === 'unit-port')!.end.kind).toBe('plenum');
    const spigots = specs.filter((spec) => spec.start.kind === 'spigot');
    expect(spigots).toHaveLength(2);
    expect(spigots.every((spec) => spec.start.kind === 'spigot' && spec.start.face === 'end')).toBe(true);
  }, 240000);

  it('Round and Optimal keep a wye whose branches wind round the diffusers, and say so, naming each', () => {
    for (const shape of ['round', 'optimal'] as const) {
      const { result } = design(shape);
      const winding = result.issues.filter((issue) => issue.code === 'DU_AUTO_WINDING');
      expect(winding.map((issue) => issue.message.slice(0, 3)).sort(), shape).toEqual(['D1:', 'D2:']);
    }
  }, 240000);
});
