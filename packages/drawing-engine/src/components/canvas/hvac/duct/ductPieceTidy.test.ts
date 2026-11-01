// The stacked short pieces of the user's screenshots: a take-off and its damper are one assembly, and a make-up too
// short to be a piece of its own goes into the transition beside it.
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctFabricationSchedule } from './ductBom';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { resolveDuctSettings, savedDuctSettings } from './ductSettings';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const along = (mm: number): Point2D => ({ x: supply.lip.x + supply.normal.x * mm, y: supply.lip.y + supply.normal.y * mm });

describe('a take-off and its damper', () => {
  const main = buildDuctRunDraftElement({ origin: { kind: 'port', port: supply }, points: [along(6000)], end: 'end-cap' }, 'main');
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'spin-in', vcd: true }, { widthMm: 300, heightMm: 150 })!;
  const branch = buildDuctRunDraftElement({ origin, points: [{ x: origin.point.x + 2000, y: origin.point.y }], end: 'end-cap' }, 'branch');
  const scene = [unit, main, branch];
  const plan = planDuctRun(branch, { settings, scene })!;

  it('have no joint between them', () => {
    const [takeoff, damper] = plan.pieces;
    expect(takeoff!.kind).toBe('takeoff');
    expect(damper!.kind).toBe('damper');
    expect(plan.joints.some((joint) => joint.between[0] === takeoff!.mark && joint.between[1] === damper!.mark)).toBe(false);
  });

  it('are one row on the schedule, with both figures', () => {
    const [takeoff, damper] = plan.pieces;
    const rows = buildDuctFabricationSchedule([plan]);
    expect(rows.filter((row) => row.mark === damper!.mark)).toEqual([]);
    const row = rows.find((candidate) => candidate.mark === `${takeoff!.mark}+${damper!.mark}`)!;
    expect(row.kind).toMatch(/, with .*VCD/);
    expect(row.lengthMm).toBe(Math.round(takeoff!.lengthMm + damper!.lengthMm));
    expect(row.massKg).toBeCloseTo(takeoff!.massKg + damper!.massKg, 1);
  });
});

describe('a make-up too short to be a piece', () => {
  /** A collar's section stepping down on a straight leg, with this much left after the reducer. */
  const stepped = (leftOverMm: number) => {
    const probe = buildDuctRunDraftElement({ origin: { kind: 'port', port: supply }, points: [along(1000), along(4000)],
      legSizes: [{ widthMm: 674, heightMm: 164 }, { widthMm: 500, heightMm: 164 }], end: 'open' }, 'run');
    const first = planDuctRun(probe, { settings, scene: [unit, probe] })!.pieces.find((piece) => piece.kind === 'transition')!;
    const element = buildDuctRunDraftElement({ origin: { kind: 'port', port: supply }, points: [along(1000), along(1000 + first.lengthMm + leftOverMm)],
      legSizes: [{ widthMm: 674, heightMm: 164 }, { widthMm: 500, heightMm: 164 }], end: 'open' }, 'run');
    return { plan: planDuctRun(element, { settings, scene: [unit, element] })!, wanted: first.lengthMm };
  };

  it('goes into the transition beside it: gentler, one joint fewer', () => {
    const { plan, wanted } = stepped(250);
    const pieces = plan.pieces.filter((piece) => piece.legIndex === 1);
    expect(pieces.map((piece) => piece.kind)).toEqual(['transition']);
    expect(pieces[0]!.lengthMm).toBeCloseTo(wanted + 250, 3);
    expect(pieces[0]!.transition!.slopeMm).toBeCloseTo(wanted + 250 - 2 * pieces[0]!.transition!.neckMm, 3);
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('one long enough stays a piece', () => {
    const { plan, wanted } = stepped(400);
    const pieces = plan.pieces.filter((piece) => piece.legIndex === 1);
    expect(pieces.map((piece) => piece.kind)).toEqual(['transition', 'straight']);
    expect(pieces[0]!.lengthMm).toBeCloseTo(wanted, 3);
  });

  it('300 mm is the shortest, for a drawing saved with the former 200 too', () => {
    expect(settings.minMakeUpPieceMm).toBe(300);
    expect(savedDuctSettings({ minMakeUpPieceMm: 200 }).minMakeUpPieceMm).toBe(300);
    expect(savedDuctSettings({ minMakeUpPieceMm: 500 }).minMakeUpPieceMm).toBe(500);
  });
});
