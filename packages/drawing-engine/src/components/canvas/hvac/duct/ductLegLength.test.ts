import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A plan point `along` up from the supply collar (−y) and `across` to its right (+x). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const trunk = { widthMm: 400, heightMm: 250 };
const branchSection = { widthMm: 250, heightMm: 150 };

/** A square Ø200 diffuser whose spigot's lip is at `lip` (plan), the lip's bottom at `lipBottomZ`. */
function diffuser(id: string, lip: Point2D, lipBottomZ = 2085): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const draft: HvacElement = {
    id, type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 0, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const at = terminalSpigotPort(draft)!.lip;
  return { ...draft, position: { x: lip.x - at.x, y: lip.y - at.y }, elevation: lipBottomZ + 100 - at.z };
}
const lipBottom = (terminal: HvacElement) => {
  const lip = terminalSpigotPort(terminal)!.lip;
  return { x: lip.x, y: lip.y, z: lip.z - 100 };
};

const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string): DuctRunSpec => readDuctRunSpec(byId(list, id))!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const issues = (list: readonly HvacElement[], id: string, severity: string) => getDuctRunPlan(byId(list, id), list, settings)!.issues
  .filter((issue) => issue.severity === severity).map((issue) => issue.code);
const near = (a: { x: number; y: number; z?: number }, b: { x: number; y: number; z?: number }, tolerance = 0.02) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)) <= tolerance;
const lengthEdit = (runId: string, legIndex: number, lengthMm: number) => ({ kind: 'leg-length' as const, runId, legIndex, lengthMm });

// ---- An L: up 3000 from the collar, right 2000, a flexible runout to D1. ----
const d1 = diffuser('d1', S(3400, 2600));
const ell = buildDuctRunDraftElement({
  port, points: [S(3000), S(3000, 2000), lipBottom(d1)], legSizes: [trunk, trunk, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'ell');
const scene = [unit, ell, d1];

describe('leg-length: a straight sized on its card', () => {
  it('lengthened: its far end moves on, the runout takes it up, everything before it stays', () => {
    const result = applyDuctSegmentEdit(scene, settings, lengthEdit('ell', 1, 2500));
    expect(result.refused).toBeUndefined();
    expect(result.action).toBe('Duct straight 2 2500 mm');
    const after = withUpdates(scene, result.updates);
    const before = specOf(scene, 'ell');
    const spec = specOf(after, 'ell');
    expect(ductLegs(spec)[1]!.lengthMm).toBeCloseTo(2500, 1);
    expect(spec.path[0]).toEqual(before.path[0]);
    expect(near(spec.path[1]!, before.path[1]!)).toBe(true);
    expect(near(spec.path[2]!, { ...before.path[2]!, x: before.path[2]!.x + 500 })).toBe(true);
    // The runout still ends on D1.
    expect(spec.path.at(-1)).toEqual(before.path.at(-1));
    expect(issues(after, 'ell', 'error')).toEqual(issues(scene, 'ell', 'error'));
  });

  it('the first straight shortened: the straight after it comes back with it', () => {
    const result = applyDuctSegmentEdit(scene, settings, lengthEdit('ell', 0, 2400));
    expect(result.refused).toBeUndefined();
    const before = specOf(scene, 'ell');
    const spec = specOf(withUpdates(scene, result.updates), 'ell');
    expect(ductLegs(spec)[0]!.lengthMm).toBeCloseTo(2400, 1);
    expect(spec.path[0]).toEqual(before.path[0]);
    expect(near(spec.path[1]!, { ...before.path[1]!, y: before.path[1]!.y + 600 })).toBe(true);
    expect(near(spec.path[2]!, { ...before.path[2]!, y: before.path[2]!.y + 600 })).toBe(true);
    expect(ductLegs(spec)[1]!.lengthMm).toBeCloseTo(2000, 1);
    expect(spec.path.at(-1)).toEqual(before.path.at(-1));
  });

  it('a riser made taller: what follows drops with it, the runout takes it up', () => {
    const low = buildDuctRunDraftElement({
      port, points: [S(1500), { ...S(1500, 1000), z: port.lip.z - 82 - 300 }, lipBottom(d1)], legSizes: [trunk, trunk, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'low');
    const list = [unit, low, d1];
    const before = specOf(list, 'low');
    const riser = ductLegs(before).findIndex((leg) => leg.vertical !== 0);
    expect(riser).toBe(1);
    const result = applyDuctSegmentEdit(list, settings, lengthEdit('low', riser, ductLegs(before)[riser]!.lengthMm + 200));
    expect(result.refused).toBeUndefined();
    expect(result.action).toMatch(/^Duct riser 2 \d+ mm$/);
    const spec = specOf(withUpdates(list, result.updates), 'low');
    expect(spec.path[2]!.z).toBeCloseTo(before.path[2]!.z - 200, 1);
    expect(spec.path[3]!.z).toBeCloseTo(before.path[3]!.z - 200, 1);
    expect(spec.path.at(-1)).toEqual(before.path.at(-1));
  });

  it('refused when nothing can give: a rigid run held at its collar and its diffuser', () => {
    // The diffuser's spigot level with the duct, so the run is level all the way.
    const d3 = diffuser('d3', S(2000, 1600), specOf(scene, 'ell').path[0]!.z);
    const rigid = buildDuctRunDraftElement({
      port, points: [S(2000), lipBottom(d3)], legSizes: [roundLeg(200), roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd3', portId: 'spigot', flex: false },
    }, 'rigid');
    const list = [unit, rigid, d3];
    const result = applyDuctSegmentEdit(list, settings, lengthEdit('rigid', 1, 2000));
    expect(result.updates).toEqual([]);
    expect(result.refused).toMatch(/^Straight 2 cannot be 2000 mm: the run to D3 is held at its collar and D3's spigot, and no other straight can give way: move D3, or change a straight that runs the same way\.$/);
  });

  it('refuses a flexible runout (its own length), a length under 50 mm, the length it has, a locked run', () => {
    expect(applyDuctSegmentEdit(scene, settings, lengthEdit('ell', 2, 900)).refused).toMatch(/flexible runout/);
    expect(applyDuctSegmentEdit(scene, settings, lengthEdit('ell', 1, 30)).refused).toBe('A straight is at least 50 mm long.');
    expect(applyDuctSegmentEdit(scene, settings, lengthEdit('ell', 1, 2000)).refused).toBe('Straight 2 is 2000 mm already.');
    const locked = { ...ell, properties: { ...ell.properties, ductRun: { ...(ell.properties.ductRun as object), locked: true } } };
    expect(applyDuctSegmentEdit([unit, locked, d1], settings, lengthEdit('ell', 1, 2500)).refused).toBe('The run is locked.');
  });
});

describe('leg-length: take-offs and their branches', () => {
  // A main up 2000 then right 3000 to an end cap; a take-off on its second straight, 1500 mm along, down the plan to D2.
  const main = buildDuctRunDraftElement({ port, points: [S(2000), S(2000, 3000)], legSizes: [trunk, trunk] }, 'main');
  const origin = tapOrigin(main, settings, { legIndex: 1, stationMm: 1500, side: -1, style: 'shoe-45', vcd: true }, branchSection) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
  const stub = { x: origin.point.x + 600 * origin.direction.x, y: origin.point.y + 600 * origin.direction.y };
  const d2 = diffuser('d2', { x: stub.x + 300, y: stub.y + 500 });
  const branch = buildDuctRunDraftElement({
    origin, points: [stub, lipBottom(d2)], legSizes: [branchSection, roundLeg(200)],
    end: { kind: 'terminal', terminalId: 'd2', portId: 'spigot', flex: true },
  }, 'branch');
  const list = [unit, main, branch, d2];

  it('a take-off on the straight that is lengthened keeps its place in the room; its branch is untouched', () => {
    const result = applyDuctSegmentEdit(list, settings, lengthEdit('main', 1, 3500));
    expect(result.refused).toBeUndefined();
    const after = withUpdates(list, result.updates);
    expect(ductLegs(specOf(after, 'main'))[1]!.lengthMm).toBeCloseTo(3500, 1);
    expect(specOf(after, 'branch').path).toEqual(specOf(list, 'branch').path);
    expect(specOf(after, 'branch').start).toMatchObject({ legIndex: 1, stationMm: 1500 });
  });

  it('the straight before it lengthened: the take-off moves with its wall, the branch stretches and keeps D2', () => {
    const result = applyDuctSegmentEdit(list, settings, lengthEdit('main', 0, 2400));
    expect(result.refused).toBeUndefined();
    const after = withUpdates(list, result.updates);
    const spec = specOf(after, 'branch');
    const before = specOf(list, 'branch');
    // The main's second straight is 400 mm further up the plan: so is the take-off.
    expect(spec.path[0]!.y).toBeCloseTo(before.path[0]!.y - 400, 1);
    expect(spec.path.at(-1)).toEqual(before.path.at(-1));
    expect(issues(after, 'branch', 'warning').filter((code) => code === 'DU_STALE')).toEqual([]);
    expect(issues(after, 'branch', 'error')).toEqual(issues(list, 'branch', 'error'));
  });
});
