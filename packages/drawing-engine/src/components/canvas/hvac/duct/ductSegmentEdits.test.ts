import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { branchAnchor } from './ductFollow';
import { applyDuctSegmentEdit, roundBranchFor, tapStyleForMain } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctLeg, type DuctTapStyle } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: null };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 270,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

function branch(main: HvacElement, id: string, stationMm: number, side: 1 | -1, style: DuctTapStyle, section: DuctLeg, out: number, then: Point2D): HvacElement {
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm, side, style, vcd: true }, section)!;
  if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
  const a = { x: origin.point.x + origin.direction.x * out, y: origin.point.y + origin.direction.y * out };
  return buildDuctRunDraftElement({ origin, points: [a, { x: a.x + then.x, y: a.y + then.y }], legSizes: [section, section] }, id);
}

/** A 600×300 main with a straight take-off (300×200), a shoe (250×200) and a round spin-in to a diffuser. */
function scene(mainSection: DuctLeg = { widthMm: 600, heightMm: 300 }) {
  const main = buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [mainSection] }, 'main');
  const a = branch(main, 'a', 2000, 1, isRoundMain(mainSection) ? 'round-tee' : 'straight', { widthMm: 300, heightMm: 200 }, 800, { x: 0, y: -1500 });
  const b = branch(main, 'b', 4200, -1, isRoundMain(mainSection) ? 'round-conical' : 'shoe-45', { widthMm: 250, heightMm: 200 }, 900, { x: 0, y: -1200 });
  const terminal = diffuser('sad', S(3000, 1800));
  const round = roundLeg(200);
  const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: isRoundMain(mainSection) ? 'round-tee' : 'spin-in', vcd: true }, round)!;
  if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
  const lip = terminalSpigotPort(terminal)!;
  const c = buildDuctRunDraftElement({
    origin, points: [{ x: origin.point.x + origin.direction.x * 500, y: origin.point.y + origin.direction.y * 500 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
    legSizes: [round, round], end: { kind: 'terminal', terminalId: terminal.id, portId: lip.portId, flex: true },
  }, 'c');
  return [unit, terminal, main, a, b, c];
}
function isRoundMain(section: DuctLeg) { return section.diameterMm !== undefined; }

const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string) => readDuctRunSpec(byId(list, id))!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const errors = (list: readonly HvacElement[], id: string) => getDuctRunPlan(byId(list, id), list, settings)!.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);

describe('a take-off\'s fitting follows its main\'s shape, leaving at the same angle', () => {
  it('rectangular → round main, and back', () => {
    const round = roundLeg(500);
    const rect = { widthMm: 600, heightMm: 300 };
    expect(tapStyleForMain('straight', true, round, 300, settings)).toEqual({ style: 'round-tee' });
    expect(tapStyleForMain('spin-in', true, round, 300, settings)).toEqual({ style: 'round-tee' });
    expect(tapStyleForMain('shoe-45', true, round, 300, settings)).toEqual({ style: 'round-conical' });
    expect(tapStyleForMain('conical', true, round, 300, settings)).toEqual({ style: 'round-conical' });
    expect(tapStyleForMain('round-tee', false, rect, 200, settings)).toEqual({ style: 'spin-in' });
    // A cone needs the main to be Ø + flare + 20 high: 200 + 50 + 20 = 270 ≤ 300.
    expect(tapStyleForMain('round-conical', false, rect, 200, settings)).toEqual({ style: 'conical' });
    expect(tapStyleForMain('round-conical', false, rect, 250, settings)).toEqual({ style: 'spin-in' });
    expect(tapStyleForMain('round-lateral', false, rect, 200, settings)).toHaveProperty('refused');
  });

  it('a rectangular branch off a main turned round takes its equal-friction size, at most ⅔ of the main (S3.4)', () => {
    // 300×200 is Ø267 in friction: Ø300 from the stock, within ⅔ × 500 = 333.
    expect(roundBranchFor({ widthMm: 300, heightMm: 200 }, 500, settings.autoRoundSizesMm)).toEqual(roundLeg(300));
    // Off a Ø400 main the cap is 266: Ø250.
    expect(roundBranchFor({ widthMm: 300, heightMm: 200 }, 400, settings.autoRoundSizesMm)).toEqual(roundLeg(250));
  });
});

describe('a segment edit carries everything that follows it', () => {
  it('a main turned round: its take-offs become round-main taps on round branches, every branch on the new wall, every end kept', () => {
    const before = scene();
    expect(errors(before, 'main')).toEqual([]);
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: roundLeg(500) }] });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(before, result.updates);
    expect(specOf(after, 'main').legs[0]).toEqual(roundLeg(500));
    expect(specOf(after, 'a').start).toMatchObject({ kind: 'tap', style: 'round-tee' });
    expect(specOf(after, 'b').start).toMatchObject({ kind: 'tap', style: 'round-conical' });
    expect(specOf(after, 'c').start).toMatchObject({ kind: 'tap', style: 'round-tee' });
    expect(specOf(after, 'a').legs[0]).toEqual(roundLeg(300));
    expect(specOf(after, 'b').legs[0]).toEqual(roundLeg(250));
    // First legs only: the rest of each branch keeps its rectangle (a square-to-round follows its first fitting).
    expect(specOf(after, 'a').legs[1]).toEqual({ widthMm: 300, heightMm: 200 });
    expect(result.notes.join(' ')).toMatch(/first leg becomes Ø300/);
    expect(result.notes.join(' ')).toMatch(/conical tee/);
    for (const id of ['a', 'b', 'c']) {
      const spec = specOf(after, id);
      const anchor = branchAnchor(specOf(after, 'main'), spec, settings)!;
      // Each starts on the main's new wall …
      expect(Math.hypot(spec.path[0]!.x - anchor.point.x, spec.path[0]!.y - anchor.point.y)).toBeLessThan(0.01);
      // … and still ends where it did in plan (a runout's lip exactly).
      const was = specOf(before, id).path.at(-1)!;
      const now = spec.path.at(-1)!;
      expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeLessThan(0.01);
      if (id === 'c') expect(now.z).toBeCloseTo(was.z, 6);
      expect(errors(after, id)).toEqual([]);
    }
    expect(errors(after, 'main')).toEqual([]);
  });

  it('whole branches round when asked', () => {
    const before = scene();
    const result = applyDuctSegmentEdit(before, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: roundLeg(500) }], wholeBranches: true });
    const after = withUpdates(before, result.updates);
    expect(specOf(after, 'a').legs).toEqual([roundLeg(300), roundLeg(300)]);
  });

  it('a round main with a 45° lateral cannot turn rectangular until the lateral is changed', () => {
    const main = buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [roundLeg(355)] }, 'main');
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'round-lateral', vcd: true }, roundLeg(200))!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const d = origin.direction;
    const lateral = buildDuctRunDraftElement({
      origin, points: [{ x: origin.point.x + d.x * 800, y: origin.point.y + d.y * 800 }, { x: origin.point.x + d.x * 800 + Math.sign(d.x) * 1500, y: origin.point.y + d.y * 800 }],
      legSizes: [roundLeg(200)],
    }, 'lateral');
    const list = [unit, main, lateral];
    const result = applyDuctSegmentEdit(list, settings, { kind: 'leg-section', runId: 'main', sections: [{ leg: 0, section: { widthMm: 500, heightMm: 300 } }] });
    expect(result.refused).toMatch(/45° lateral/);
    expect(result.updates).toEqual([]);
    expect(applyDuctSegmentEdit(list, settings, { kind: 'tap', runId: 'lateral', style: 'round-tee' }).refused).toMatch(/another angle/);
  });

  it('a take-off swapped for a round collar takes a round branch; its end stays', () => {
    const before = scene();
    const result = applyDuctSegmentEdit(before, settings, { kind: 'tap', runId: 'a', style: 'spin-in', firstLeg: roundLeg(250) });
    const after = withUpdates(before, result.updates);
    expect(specOf(after, 'a').start).toMatchObject({ style: 'spin-in' });
    expect(specOf(after, 'a').legs[0]).toEqual(roundLeg(250));
    expect(specOf(after, 'a').path.at(-1)).toEqual(specOf(before, 'a').path.at(-1));
    expect(errors(after, 'a')).toEqual([]);
  });

  it('an elbow\'s choices are set and cleared; a damper and a connector come and go', () => {
    const run = buildDuctRunDraftElement({ port, points: [S(3000), S(3000, 2500)], legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }] }, 'l');
    const list = [unit, run];
    const set = applyDuctSegmentEdit(list, settings, { kind: 'node', runId: 'l', node: 1, override: { elbowStyle: 'radius', centrelineRatio: 1 } });
    expect(readDuctRunSpec(set.updates[0]!)!.nodeOverrides['1']).toEqual({ elbowStyle: 'radius', centrelineRatio: 1 });
    const cleared = applyDuctSegmentEdit(withUpdates(list, set.updates), settings, { kind: 'node', runId: 'l', node: 1, override: null });
    expect(readDuctRunSpec(cleared.updates[0]!)!.nodeOverrides['1']).toBeUndefined();
    const connector = applyDuctSegmentEdit(list, settings, { kind: 'start', runId: 'l', connector: false });
    expect(getDuctRunPlan(connector.updates[0]!, withUpdates(list, connector.updates), settings)!.pieces.some((piece) => piece.kind === 'connector')).toBe(false);
    const before = scene();
    const damper = applyDuctSegmentEdit(before, settings, { kind: 'start', runId: 'a', vcd: false });
    expect(getDuctRunPlan(damper.updates.find((element) => element.id === 'a')!, withUpdates(before, damper.updates), settings)!.pieces.some((piece) => piece.kind === 'damper')).toBe(false);
  });

  it('nothing is edited on a locked run', () => {
    const run = buildDuctRunDraftElement({ port, points: [S(3000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'k');
    const locked = { ...run, properties: { ...run.properties, ductRun: { ...readDuctRunSpec(run)!, locked: true } } };
    expect(applyDuctSegmentEdit([unit, locked], settings, { kind: 'leg-section', runId: 'k', sections: [{ leg: 0, section: roundLeg(450) }] }).refused).toMatch(/locked/);
  });
});
