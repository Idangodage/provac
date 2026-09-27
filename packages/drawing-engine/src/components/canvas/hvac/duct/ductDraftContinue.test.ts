import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { findReattachTarget } from './ductBranchTargets';
import { buildDuctRunDraftElement, constrainDuctLeg, continueDuctRunSpec, reverseDuctRunSpec } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const main = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'main');

describe('continuing, free starts and ending on a run', () => {
  it('continues an open-ended run: new legs appended at its level, one element', () => {
    const open = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }], end: 'open' }, 'open');
    const spec = readDuctRunSpec(open)!;
    const next = continueDuctRunSpec(spec, [{ x: supply.lip.x + 2000, y: supply.lip.y - 3000 }], [{ widthMm: 674, heightMm: 164 }], 'end-cap');
    expect(next.path).toHaveLength(3);
    expect(next.path[2]!.z).toBe(spec.path[1]!.z);
    expect(next.legs).toHaveLength(2);
    expect(next.end).toEqual({ kind: 'end-cap' });
    const plan = planDuctRun(ductRunElementWithSpec(open, next), { settings, scene: [unit] })!;
    expect(plan.pieces.some((piece) => piece.kind === 'elbow')).toBe(true);
    expect(plan.status).toBe('ok');
  });

  it('a free start may leave in any grid direction', () => {
    const west = constrainDuctLeg({ x: 0, y: 0 }, { x: -800, y: 30 }, { x: 1, y: 0 }, { first: true, mode: '90', free: true });
    expect(west.direction).toEqual({ x: -1, y: 0 });
    expect(west.lengthMm).toBe(800);
  });

  it('a free run finished on a run side becomes a take-off drawn from that wall', () => {
    // Drawn from free space at x + 2000 toward the main's +x wall, finishing on it.
    const wallX = supply.lip.x + 674 / 2 + 0.6;
    const free = buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: supply.lip.x + 2500, y: supply.lip.y - 3000 }, bottomZ: 2400, service: 'supply' },
      points: [{ x: wallX + 20, y: supply.lip.y - 3000 }], legSizes: [{ widthMm: 300, heightMm: 150 }],
    }, 'free');
    const reversed = ductRunElementWithSpec(free, reverseDuctRunSpec(readDuctRunSpec(free)!, 'end-cap'));
    const target = findReattachTarget(reversed, [unit, main, reversed], settings, { style: 'shoe-45', vcd: true, reachMm: 300 })!;
    expect(target.parent.id).toBe('main');
    expect(target.spec.start).toMatchObject({ kind: 'tap', legIndex: 0, stationMm: 3000, side: 1 });
    // Now level with the main's bottom, starting on its wall, leaving outward.
    const branch = ductRunElementWithSpec(reversed, target.spec);
    const plan = planDuctRun(branch, { settings, scene: [unit, main, branch] })!;
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(plan.pieces[0]!.kind).toBe('takeoff');
    expect(target.spec.path[0]!.z).toBe(readDuctRunSpec(main)!.path[0]!.z);
  });
});
