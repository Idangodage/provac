import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { splitOrigin, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec } from './ductFollow';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctLeg } from './ductTypes';

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
const startsOnItsFitting = (list: readonly HvacElement[], parentId: string, id: string) => {
  const spec = specOf(list, id);
  const anchor = branchAnchor(specOf(list, parentId), spec, settings)!;
  const first = spec.path[1]!;
  const length = Math.hypot(first.x - spec.path[0]!.x, first.y - spec.path[0]!.y);
  return Math.hypot(spec.path[0]!.x - anchor.point.x, spec.path[0]!.y - anchor.point.y) < 0.05
    && Math.abs(((first.x - spec.path[0]!.x) * anchor.direction.x + (first.y - spec.path[0]!.y) * anchor.direction.y) / length - 1) < 1e-6;
};

function roundMain(): HvacElement {
  return buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [roundLeg(355)] }, 'main');
}

/** A branch off `main` at 3 m: `moves` are relative points from its start, along the take-off's own direction first. */
function tap(main: HvacElement, id: string, style: 'round-lateral' | 'round-tee', moves: (direction: Point2D) => Point2D[], section: DuctLeg = roundLeg(200)): HvacElement {
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style, vcd: true }, section)!;
  if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
  let cursor = origin.point;
  const points = moves(origin.direction).map((move) => (cursor = { x: cursor.x + move.x, y: cursor.y + move.y }));
  return buildDuctRunDraftElement({ origin, points, legSizes: [section] }, id);
}

describe('a branch turns with its new fitting, keeping its end', () => {
  it('a 45° lateral and its 45° elbow become a 90° tee: the take-off slides on, the elbow goes', () => {
    const main = roundMain();
    // 800 mm at 45° downstream, then square off the main for 1.5 m.
    const lateral = tap(main, 'b', 'round-lateral', (d) => [{ x: d.x * 800, y: d.y * 800 }, { x: Math.sign(d.x) * 1500, y: 0 }]);
    const before = [unit, main, lateral];
    expect(errors(before, 'b')).toEqual([]);
    const result = applyDuctSegmentEdit(before, settings, { kind: 'tap', runId: 'b', style: 'round-tee' });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    const spec = specOf(after, 'b');
    expect(spec.start).toMatchObject({ kind: 'tap', style: 'round-tee' });
    // It slid 800 × sin 45° downstream, onto the line of its square leg: one straight leg now.
    expect((spec.start as { stationMm: number }).stationMm).toBeCloseTo(3000 + 800 * Math.SQRT1_2, 0);
    expect(spec.path).toHaveLength(2);
    expect(spec.path.at(-1)).toEqual(specOf(before, 'b').path.at(-1));
    expect(startsOnItsFitting(after, 'main', 'b')).toBe(true);
    expect(errors(after, 'b')).toEqual([]);
    expect(errors(after, 'main')).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/turns with it/);
  });

  it('a straight 90° tee becomes a lateral: the take-off slides back and a 45° elbow brings the branch onto its line', () => {
    const main = roundMain();
    const tee = tap(main, 'b', 'round-tee', (d) => [{ x: d.x * 1500, y: d.y * 1500 }]);
    const before = [unit, main, tee];
    const result = applyDuctSegmentEdit(before, settings, { kind: 'tap', runId: 'b', style: 'round-lateral' });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    const spec = specOf(after, 'b');
    expect(spec.start).toMatchObject({ style: 'round-lateral' });
    expect((spec.start as { stationMm: number }).stationMm).toBeLessThan(3000);
    expect(spec.path).toHaveLength(3);
    expect(spec.path.at(-1)).toEqual(specOf(before, 'b').path.at(-1));
    expect(startsOnItsFitting(after, 'main', 'b')).toBe(true);
    const elbow = getDuctRunPlan(byId(after, 'b'), after, settings)!.pieces.find((piece) => piece.kind === 'elbow')!;
    expect(Math.round(elbow.elbow!.angleDeg)).toBe(45);
    expect(errors(after, 'b')).toEqual([]);
  });

  it('a lateral\'s main made rectangular: the lateral becomes a spin-in and its branch turns with it', () => {
    const main = roundMain();
    const lateral = tap(main, 'b', 'round-lateral', (d) => [{ x: d.x * 800, y: d.y * 800 }, { x: Math.sign(d.x) * 1500, y: 0 }]);
    const before = [unit, main, lateral];
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: { widthMm: 450, heightMm: 300 } }] });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    expect(specOf(after, 'b').start).toMatchObject({ style: 'spin-in' });
    // Flat on the rectangular main's bottom instead of centred on the round one: the capped end keeps its place in plan.
    const was = specOf(before, 'b').path.at(-1)!;
    const now = specOf(after, 'b').path.at(-1)!;
    expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeLessThan(0.01);
    expect(startsOnItsFitting(after, 'main', 'b')).toBe(true);
    expect(errors(after, 'b')).toEqual([]);
    expect(errors(after, 'main')).toEqual([]);
  });

  it('a tee onto a flexible runout made a lateral: the take-off slides back and a 45° elbow brings the stub onto its old heading; the runout stays straight', () => {
    const main = roundMain();
    const terminalSpec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: null };
    const envelope = terminalEnvelope(terminalSpec);
    const centre = S(3000, 1800);
    // Straight ahead of the take-off, its spigot facing it.
    const terminal: HvacElement = {
      id: 'sad', type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 270,
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
      label: 'SAD-1', supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: terminalSpec },
    };
    const lip = terminalSpigotPort(terminal)!;
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'round-tee', vcd: true }, roundLeg(200))!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const tee = buildDuctRunDraftElement({
      origin, points: [{ x: origin.point.x + origin.direction.x * 300, y: origin.point.y + origin.direction.y * 300 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
      legSizes: [roundLeg(200), roundLeg(200)], end: { kind: 'terminal', terminalId: 'sad', portId: lip.portId, flex: true },
    }, 'b');
    const before = [unit, main, terminal, tee];
    expect(errors(before, 'b')).toEqual([]);
    const result = applyDuctSegmentEdit(before, settings, { kind: 'tap', runId: 'b', style: 'round-lateral' });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    const spec = specOf(after, 'b');
    expect(spec.start).toMatchObject({ style: 'round-lateral' });
    // A bare 45° stub would leave the runout bending under one diameter: instead the take-off slides upstream by the
    // lateral's reach along the main (collar, damper, the elbow's setback and a joint: 474 mm × sin 45°).
    expect((spec.start as { stationMm: number }).stationMm).toBeCloseTo(3000 - 335.4, 0);
    expect(spec.path).toHaveLength(4);
    const [a, b, c] = spec.path;
    // The stub runs on along its old heading, straight at the spigot.
    expect(Math.abs(c!.y - b!.y)).toBeLessThan(1e-6);
    expect(Math.hypot(b!.x - a!.x, b!.y - a!.y)).toBeGreaterThan(400);
    expect(spec.path.at(-1)).toEqual(specOf(before, 'b').path.at(-1));
    expect(startsOnItsFitting(after, 'main', 'b')).toBe(true);
    expect(errors(after, 'b')).toEqual([]);
    expect(errors(after, 'main')).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/old heading/);
  });

  it('a Y split\'s run made round: a wye, its outlets round and turned, each branch still ending where it did', () => {
    const main = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'main');
    const withSplit = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, end: { kind: 'split', style: 'y' } });
    const branch = (id: string, side: 1 | -1) => {
      const origin = splitOrigin(withSplit, settings, { side, style: 'y', vcd: false }, { widthMm: 300, heightMm: 300 })!;
      if (origin.kind !== 'split') throw new Error('Expected a split origin');
      const out = { x: origin.point.x + origin.direction.x * 1800, y: origin.point.y + origin.direction.y * 1800 };
      return buildDuctRunDraftElement({ origin, points: [out, { x: out.x, y: out.y - 1500 }], legSizes: [{ widthMm: 300, heightMm: 300 }] }, id);
    };
    const before = [unit, withSplit, branch('l', 1), branch('r', -1)];
    expect(errors(before, 'main')).toEqual([]);
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: roundLeg(500) }] });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    expect(specOf(after, 'main').end).toEqual({ kind: 'split', style: 'wye' });
    for (const id of ['l', 'r']) {
      const spec = specOf(after, id);
      expect(spec.legs[0]!.diameterMm).toBeGreaterThan(0);
      const was = specOf(before, id).path.at(-1)!;
      const now = spec.path.at(-1)!;
      expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeLessThan(0.01);
      expect(startsOnItsFitting(after, 'main', id)).toBe(true);
      expect(errors(after, id)).toEqual([]);
    }
    expect(errors(after, 'main')).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/wye/);
  });
});
