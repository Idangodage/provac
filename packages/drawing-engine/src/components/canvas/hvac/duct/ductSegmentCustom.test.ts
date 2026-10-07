import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec } from './ductFollow';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string) => readDuctRunSpec(byId(list, id))!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const errors = (list: readonly HvacElement[], id: string) => getDuctRunPlan(byId(list, id), list, settings)!.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);

function diffuser(centre: Point2D): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: null };
  const envelope = terminalEnvelope(spec);
  return {
    id: 'sad', type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 270,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: 'SAD-1', supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

/** A 600×300 main 6 m long; a Ø200 take-off at 3 m on a 500 mm stub, its flexible runout to a diffuser 2.2 m out. */
function scene(): HvacElement[] {
  const main = buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'main');
  const terminal = diffuser(S(3000, 2200));
  const lip = terminalSpigotPort(terminal)!;
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'spin-in', vcd: true }, roundLeg(200))!;
  if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
  const branch = buildDuctRunDraftElement({
    origin, points: [{ x: origin.point.x + origin.direction.x * 500, y: origin.point.y + origin.direction.y * 500 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
    legSizes: [roundLeg(200), roundLeg(200)], end: { kind: 'terminal', terminalId: 'sad', portId: lip.portId, flex: true },
  }, 'b');
  return [unit, terminal, main, branch];
}
const flexLength = (list: readonly HvacElement[]) => getDuctRunPlan(byId(list, 'b'), list, settings)!.pieces.find((piece) => piece.kind === 'flex')!.lengthMm;

describe("the card's own values", () => {
  it('a take-off moved along its main: the branch slides with it and still ends where it did', () => {
    const before = scene();
    const result = applyDuctSegmentEdit(before, settings, { kind: 'tap-station', runId: 'b', stationMm: 3400 });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    const spec = specOf(after, 'b');
    expect(spec.start).toMatchObject({ kind: 'tap', stationMm: 3400 });
    const anchor = branchAnchor(specOf(after, 'main'), spec, settings)!;
    expect(Math.hypot(spec.path[0]!.x - anchor.point.x, spec.path[0]!.y - anchor.point.y)).toBeLessThan(0.05);
    expect(spec.path.at(-1)).toEqual(specOf(before, 'b').path.at(-1));
    expect(errors(after, 'b')).toEqual([]);
    expect(result.action).toBe('Take-off moved 400 mm on along the main');
    expect(applyDuctSegmentEdit(before, settings, { kind: 'tap-station', runId: 'b', stationMm: 3000 }).refused).toMatch(/already/);
  });

  it('a flexible runout of the length asked; no shorter stub than its take-off needs', () => {
    const before = scene();
    for (const asked of [800, 500]) {
      const result = applyDuctSegmentEdit(before, settings, { kind: 'runout-length', runId: 'b', flexMm: asked });
      expect(result.refused).toBeUndefined();
      const after = withUpdates(before, result.updates);
      expect(Math.abs(flexLength(after) - asked)).toBeLessThan(3);
      expect(specOf(after, 'b').path.at(-1)).toEqual(specOf(before, 'b').path.at(-1));
      expect(errors(after, 'b')).toEqual([]);
    }
    // Longer than the stub can give back: the stub stops at its take-off's collar and damper (and says so).
    const long = applyDuctSegmentEdit(before, settings, { kind: 'runout-length', runId: 'b', flexMm: 2500 });
    expect(long.notes.join(' ')).toMatch(/as long as the rigid duct before it allows/);
    const stub = specOf(withUpdates(before, long.updates), 'b');
    // Collar and damper, and 20 mm of straight.
    expect(Math.hypot(stub.path[1]!.x - stub.path[0]!.x, stub.path[1]!.y - stub.path[0]!.y)).toBeCloseTo(settings.tapCollarMm + settings.vcdLengthMm + 20, 3);
    expect(errors(withUpdates(before, long.updates), 'b')).toEqual([]);
    expect(applyDuctSegmentEdit(before, settings, { kind: 'runout-length', runId: 'main', flexMm: 800 }).refused).toMatch(/flexible runout/);
  });

  it('an accessory moved along its leg; an access door of the size asked', () => {
    const main = buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'main');
    const element = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, inline: [{ id: 'i1', kind: 'access-door', legIndex: 0, stationMm: 3000 }] });
    const before = [unit, element];
    const moved = withUpdates(before, applyDuctSegmentEdit(before, settings, { kind: 'inline-move', runId: 'main', id: 'i1', stationMm: 4000 }).updates);
    const door = getDuctRunPlan(byId(moved, 'main'), moved, settings)!.pieces.find((piece) => piece.inlineId === 'i1')!;
    expect((door.stationStartMm + door.stationEndMm) / 2).toBeCloseTo(4000, 6);
    const sized = withUpdates(before, applyDuctSegmentEdit(before, settings, { kind: 'inline-door', runId: 'main', id: 'i1', doorMm: 300 }).updates);
    const small = getDuctRunPlan(byId(sized, 'main'), sized, settings)!.pieces.find((piece) => piece.inlineId === 'i1')!;
    expect(small.accessDoor).toEqual({ sizeMm: 300, face: 'bottom' });
    expect(small.lengthMm).toBeCloseTo(400, 6);
    expect(specOf(sized, 'main').inline![0]!.doorMm).toBe(300);
    // The size its duct's face takes already (a 600 mm face takes a 450 door): nothing to change.
    expect(applyDuctSegmentEdit(before, settings, { kind: 'inline-door', runId: 'main', id: 'i1', doorMm: 450 }).refused).toMatch(/already/);
  });

  it("a terminal's design airflow, and back to a share of the system's", () => {
    const before = scene();
    const result = applyDuctSegmentEdit(before, settings, { kind: 'terminal', terminalId: 'sad', airflowM3h: 450 });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    expect(readDuctTerminalSpec(byId(after, 'sad'))!.designAirflowM3h).toBe(450);
    expect(byId(after, 'sad').position).toEqual(byId(before, 'sad').position);
    expect(result.action).toBe('Terminal SAD-1: 450 m³/h');
    const shared = withUpdates(after, applyDuctSegmentEdit(after, settings, { kind: 'terminal', terminalId: 'sad', airflowM3h: null }).updates);
    expect(readDuctTerminalSpec(byId(shared, 'sad'))!.designAirflowM3h).toBeNull();
  });
});
