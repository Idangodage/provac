import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { tapOrigin } from '../duct/ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from '../duct/ductDraft';
import { resolveDuctSettings } from '../duct/ductSettings';
import { typicalTerminalSpec } from '../duct/ductTerminalCatalog';
import { terminalEnvelope, terminalSpigotPort } from '../duct/ductTerminals';
import { readDuctRunSpec, roundLeg } from '../duct/ductTypes';

import { hvacMoveCommand, hvacMoveLabel, planHvacMove, resolveHvacCeilingVoid, type HvacMoveContext, type HvacPlacementCheck } from './hvacMoveModel';

const ductSettings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const at = (dx: number, dy: number, from: Point2D = supply.lip) => ({ x: from.x + dx, y: from.y + dy });
const main = buildDuctRunDraftElement({ port: supply, points: [at(0, -4000)] }, 'main');
const tap = tapOrigin(main, ductSettings, { legIndex: 0, stationMm: 2000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 }) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const straightEnd = at(1500 * tap.direction.x, 1500 * tap.direction.y, tap.point);
const spec = typicalTerminalSpec('square-4way', 200);
const envelope = terminalEnvelope(spec);
const d1Draft: HvacElement = {
  id: 'd1', type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
  elevation: 2400, mountType: 'ceiling', label: 'SAD-1', supplyZoneRatio: 0.5, properties: { terminal: spec },
};
const d1 = { ...d1Draft, position: { x: straightEnd.x + 400, y: straightEnd.y + 300 } };
const d1Lip = terminalSpigotPort(d1)!.lip;
const branch = buildDuctRunDraftElement({
  origin: tap, points: [straightEnd, { x: d1Lip.x, y: d1Lip.y, z: d1Lip.z - 100 }], legSizes: [{ widthMm: 300, heightMm: 150 }, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'branch');
const scene = [unit, main, branch, d1];
const byId = (elements: readonly HvacElement[], id: string) => elements.find((element) => element.id === id);

/** Room rule: a centre inside x < `limitX`. */
function roomUpTo(limitX: number): (center: Point2D, element: HvacElement) => HvacPlacementCheck {
  return (center, element) => ({
    valid: center.x < limitX,
    invalidReason: center.x < limitX ? null : 'Equipment must be placed inside a valid room.',
    point: { x: center.x - element.width / 2, y: center.y - element.depth / 2 },
    rotationDeg: element.rotation, widthMm: element.width, depthMm: element.depth, heightMm: element.height,
    roomId: 'room', wallId: null,
  });
}
const context: HvacMoveContext = { ductSettings };

describe('planHvacMove', () => {
  it('moves a unit alone: its runs stretch, its diffuser stays, one step named after it', () => {
    const plan = planHvacMove(scene, { ids: ['fdum'], delta: { x: 200, y: 0, z: 0 } }, context);
    expect(plan.fraction).toBe(1);
    expect(plan.label).toBe('Move FDUM22');
    expect(plan.updated.map((element) => element.id).sort()).toEqual(['branch', 'fdum', 'main']);
    expect(byId(plan.updated, 'fdum')!.position).toEqual({ x: 200, y: 0 });
    expect(plan.outcomes.get('fdum')).toEqual({ kind: 'moved' });
    expect(plan.outcomes.get('main')).toEqual({ kind: 'follows' });
    // The runout still ends where it did, on SAD-1.
    const runout = readDuctRunSpec(byId(plan.updated, 'branch')!)!;
    expect(runout.path[runout.path.length - 1]).toEqual(readDuctRunSpec(branch)!.path[2]);
  });

  it('moves a whole air system rigidly', () => {
    const d = { x: -300, y: 450, z: 0 };
    const plan = planHvacMove(scene, { ids: ['fdum', 'main', 'branch', 'd1'], delta: d }, context);
    expect(plan.label).toBe('Move FDUM22, 2 duct runs and SAD-1');
    expect(byId(plan.updated, 'd1')!.position).toEqual({ x: d1.position.x - 300, y: d1.position.y + 450 });
    for (const [id, element] of [['main', main], ['branch', branch]] as const) {
      const before = readDuctRunSpec(element)!.path;
      readDuctRunSpec(byId(plan.updated, id)!)!.path.forEach((point, index) => {
        expect(point.x - before[index]!.x).toBeCloseTo(-300, 6);
        expect(point.y - before[index]!.y).toBeCloseTo(450, 6);
      });
    }
  });

  it('stops the whole selection where the first rule would break', () => {
    // The unit's centre (542) may go up to x = 1000: of a 2000 mm move, 458 mm happen.
    const plan = planHvacMove(scene, { ids: ['fdum', 'd1'], delta: { x: 2000, y: 0, z: 0 } }, { ...context, place: roomUpTo(1000) });
    expect(plan.applied.x).toBeGreaterThan(457);
    expect(plan.applied.x).toBeLessThan(458.1);
    expect(plan.limitedBy).toMatchObject({ id: 'fdum' });
    expect(plan.messages[0]).toMatch(/^Stopped short: FDUM22: Equipment must be placed inside a valid room\./);
    // The diffuser stopped with it: moved together, moved the same.
    expect(byId(plan.updated, 'd1')!.position.x - d1.position.x).toBeCloseTo(plan.applied.x, 6);
  });

  it('moves an item that already breaks its rules as it is, without letting it hold the others back', () => {
    // SAD-1 lies past x = 1000 where it is: it moves the whole way (back in, or further out), unchecked.
    const plan = planHvacMove(scene, { ids: ['d1'], delta: { x: 500, y: 0, z: 0 } }, { ...context, place: roomUpTo(1000) });
    expect(plan.fraction).toBe(1);
    expect(byId(plan.updated, 'd1')!.position.x - d1.position.x).toBeCloseTo(500, 6);
  });

  it('raises a ducted unit within the void and stops it at the soffit; its ducts rise with it', () => {
    const plan = planHvacMove(scene, { ids: ['fdum'], delta: { x: 0, y: 0, z: 500 } }, { ...context, ceilingVoid: { ceilingMm: 2400, soffitMm: 3000 } });
    // Its top is at 2900: 100 mm of room.
    expect(plan.applied.z).toBeCloseTo(100, 6);
    expect(plan.limitedBy?.reason).toMatch(/FDUM22 would rise above the soffit \(3000 mm\)/);
    expect(byId(plan.updated, 'fdum')!.elevation).toBeCloseTo(2700, 6);
    const mainAfter = readDuctRunSpec(byId(plan.updated, 'main')!)!;
    mainAfter.path.forEach((point, index) => expect(point.z - readDuctRunSpec(main)!.path[index]!.z).toBeCloseTo(100, 6));
    // The runout takes the height change: its end stays on SAD-1's spigot.
    const runout = readDuctRunSpec(byId(plan.updated, 'branch')!)!;
    expect(runout.path[runout.path.length - 1]).toEqual(readDuctRunSpec(branch)!.path[2]);
  });

  it('keeps air terminals in the ceiling', () => {
    const plan = planHvacMove(scene, { ids: ['d1'], delta: { x: 0, y: 0, z: 100 } }, context);
    expect(plan.updated).toEqual([]);
    expect(plan.messages.join(' ')).toMatch(/SAD-1 sits in the ceiling/);
  });

  it('moves one straight on its own, and says why when it cannot', () => {
    const refused = planHvacMove(scene, { ids: [], segment: { runId: 'main', legIndex: 0 }, delta: { x: 300, y: 0, z: 0 } }, context);
    expect(refused.updated).toEqual([]);
    expect(refused.messages.join(' ')).toMatch(/first straight leaves the unit's collar/);
    expect(refused.label).toBe('Move a straight of Supply duct');
  });

  it('turns into one store command', () => {
    const plan = planHvacMove(scene, { ids: ['fdum'], delta: { x: 0, y: -100, z: 0 } }, context);
    const command = hvacMoveCommand(plan);
    expect(command.add).toEqual([]);
    expect(command.removeIds).toEqual([]);
    expect(command.updates.map((update) => update.id).sort()).toEqual(['branch', 'fdum', 'main']);
    expect(command.updates.find((update) => update.id === 'fdum')!.updates).toMatchObject({ position: { x: 0, y: -100 } });
  });
});

describe('hvacMoveLabel', () => {
  it('names one item by its tag and counts the rest', () => {
    expect(hvacMoveLabel([d1, { ...d1, id: 'd2' }, unit], null)).toBe('Move 2 diffusers and FDUM22');
    expect(hvacMoveLabel([], null)).toBe('Move');
  });
});

describe('resolveHvacCeilingVoid', () => {
  it('takes the ceiling the air terminals sit in, else the rooms\' ceilings', () => {
    expect(resolveHvacCeilingVoid(scene, [], 3200)).toEqual({ ceilingMm: 2400, soffitMm: 3200 });
    expect(resolveHvacCeilingVoid([unit], [{ properties3D: { ceilingHeight: 2700 } }], 3200)).toEqual({ ceilingMm: 2700, soffitMm: 3200 });
  });
});
