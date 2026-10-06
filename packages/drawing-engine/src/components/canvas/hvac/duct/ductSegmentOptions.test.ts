import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { ductRunElementWithSpec } from './ductFollow';
import {
  ductSegmentOptions,
  evaluateDuctSegmentOption,
  rankDuctOptions,
  scopeLegs,
  type DuctOptionEvaluation,
  type DuctSegmentOption,
} from './ductSegmentOptions';
import { resolveDuctSettings } from './ductSettings';
import { equivalentDiameterMm } from './ductSizing';
import { defaultSizingBasis, linkSizingBasis } from './ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctLeg } from './ductTypes';

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

/** A 600×300 main, 3 m then a turn and 2.5 m on, with two round take-offs to diffusers; sized for 900 m³/h. */
function system() {
  let main = buildDuctRunDraftElement({ port, points: [S(3000), S(3000, 2500)], legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }] }, 'main');
  main = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, sizing: linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 900 }, 900) });
  const terminals = [diffuser('d1', S(1700, 1500)), diffuser('d2', S(3000 + 1500, 1500))];
  const branches = [
    { id: 'b1', legIndex: 0, station: 1700, terminal: terminals[0]! },
    { id: 'b2', legIndex: 1, station: 1500, terminal: terminals[1]! },
  ].map(({ id, legIndex, station, terminal }) => {
    const round = roundLeg(200);
    const origin = tapOrigin(main, settings, { legIndex, stationMm: station, side: legIndex === 0 ? -1 : 1, style: 'spin-in', vcd: true }, round)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const lip = terminalSpigotPort(terminal)!;
    return buildDuctRunDraftElement({
      origin, points: [{ x: origin.point.x + origin.direction.x * 400, y: origin.point.y + origin.direction.y * 400 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
      legSizes: [round, round], end: { kind: 'terminal', terminalId: terminal.id, portId: lip.portId, flex: true },
    }, id);
  });
  return [unit, ...terminals, main, ...branches];
}

const ids = (options: readonly DuctSegmentOption[]) => options.map((option) => option.id);

describe('the options of a segment', () => {
  it('a rectangular straight: the equal-friction spiral, flatter and squarer rectangles, and the size for its air', () => {
    const scene = system();
    const options = ductSegmentOptions(scene, settings, 'main', 'leg:0');
    // 600×300 ≈ Ø457: Ø500 at or above it, Ø450 just below.
    expect(ids(options)).toEqual(expect.arrayContaining(['round:500', 'round:450']));
    const rects = options.filter((option) => option.id.startsWith('rect:'));
    expect(rects.length).toBeGreaterThan(0);
    for (const option of rects) {
      if (option.edit.kind !== 'leg-section') throw new Error('expected a size');
      const section = option.edit.sections[0]!.section;
      expect(equivalentDiameterMm(section)).toBeGreaterThanOrEqual(equivalentDiameterMm({ widthMm: 600, heightMm: 300 }) - 0.5);
    }
    const sized = options.find((option) => option.group === 'size');
    expect(sized?.detail).toMatch(/sized for 900 m³\/h/);
    // Leg only by default; every leg of the size when asked.
    expect(scopeLegs(readDuctRunSpec(scene.find((element) => element.id === 'main')!)!, 0, 'size')).toEqual([0, 1]);
  });

  it('an elbow: radius ratios (the current marked), square with vanes, and the turn in spiral duct', () => {
    const options = ductSegmentOptions(system(), settings, 'main', 'node:1');
    expect(ids(options)).toEqual(expect.arrayContaining(['radius:1.5', 'radius:1', 'radius:0.75', 'vaned:auto', 'vaned:double-large', 'gored']));
    expect(options.find((option) => option.id === 'radius:1.5')?.current).toBe(true);
  });

  it('a round take-off off a rectangular main: the four collars, the current marked, and its damper', () => {
    const options = ductSegmentOptions(system(), settings, 'b1', 'start:takeoff');
    expect(ids(options)).toEqual(expect.arrayContaining(['tap:shoe-45', 'tap:straight', 'tap:conical', 'tap:spin-in', 'vcd:false']));
    expect(options.find((option) => option.id === 'tap:spin-in')?.current).toBe(true);
    // A square collar takes a rectangular branch with it.
    expect((options.find((option) => option.id === 'tap:shoe-45')!.edit as { firstLeg?: DuctLeg }).firstLeg?.diameterMm).toBeUndefined();
  });
});

describe("a transition's taper", () => {
  it("is offered gentler and steeper (the project taper marked current); gentler makes it longer", () => {
    const scene = system();
    const options = ductSegmentOptions(scene, settings, 'main', 'transition:0');
    expect(ids(options)).toEqual(expect.arrayContaining(['taper:10', `taper:${settings.transitionTaperDeg}`, 'taper:20', 'taper:30']));
    expect(options.find((option) => option.id === `taper:${settings.transitionTaperDeg}`)?.current).toBe(true);
    const gentle = evaluateDuctSegmentOption(scene, settings, 'main', 'transition:0', options.find((option) => option.id === 'taper:10')!);
    const steep = evaluateDuctSegmentOption(scene, settings, 'main', 'transition:0', options.find((option) => option.id === 'taper:30')!);
    expect(gentle.after!.fabrication.lengthMm).toBeGreaterThan(steep.after!.fabrication.lengthMm);
  });
});

describe('what an option would do', () => {
  it('the spiral equivalent: what it changes before it is applied; the take-off its transition would overlap moves clear', () => {
    const scene = system();
    const option = ductSegmentOptions(scene, settings, 'main', 'leg:0').find((candidate) => candidate.id === 'round:500')!;
    const evaluation = evaluateDuctSegmentOption(scene, settings, 'main', 'leg:0', option);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.section).toEqual(roundLeg(500));
    expect(evaluation.velocityMs).toBeGreaterThan(0);
    expect(evaluation.deltaIndexPa).not.toBeNull();
    // The take-off on that leg becomes a 90° tee, and the planner adds a square-to-round.
    const notes = evaluation.notes.join(' ');
    expect(notes).toMatch(/90° tee/);
    expect(notes).toMatch(/transition/);
    // The square-to-round from the flat 674 × 164 collar up to Ø500 is long enough to reach the take-off 1.7 m
    // along the leg: the take-off slides on, just clear of it, and its branch still ends on its diffuser.
    expect(notes).toMatch(/slides \d+ mm on along the main/);
    expect(evaluation.newIssues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const branch = evaluation.updates.find((element) => element.id === 'b1')!;
    const before = readDuctRunSpec(scene.find((element) => element.id === 'b1')!)!;
    expect((readDuctRunSpec(branch)!.start as { stationMm: number }).stationMm).toBeGreaterThan((before.start as { stationMm: number }).stationMm);
    expect(readDuctRunSpec(branch)!.path.at(-1)).toEqual(before.path.at(-1));
    // Round is 200 mm taller than the 300 mm rectangle.
    expect(evaluation.deltaOuterHeightMm).toBeGreaterThan(150);
    // Cached per drawing.
    expect(evaluateDuctSegmentOption(scene, settings, 'main', 'leg:0', option)).toBe(evaluation);
  });

  it('on the second leg, every equal-friction swap fits once its take-off moves clear', () => {
    const scene = system();
    for (const option of ductSegmentOptions(scene, settings, 'main', 'leg:1').filter((candidate) => candidate.group === 'swap')) {
      const evaluation = evaluateDuctSegmentOption(scene, settings, 'main', 'leg:1', option);
      expect(evaluation.refused, option.id).toBeUndefined();
      expect(evaluation.newIssues.filter((issue) => issue.code === 'DU_TAP_CLASH'), option.id).toEqual([]);
    }
  });

  it('a refused edit is reported, not applied', () => {
    const scene = system();
    const option: DuctSegmentOption = { id: 'x', group: 'swap', glyph: 'rect', title: 'x', detail: '', edit: { kind: 'split', runId: 'main', style: 'y' } };
    const evaluation = evaluateDuctSegmentOption(scene, settings, 'main', 'leg:0', option);
    expect(evaluation.refused).toMatch(/does not end in a split/);
    expect(evaluation.updates).toEqual([]);
  });
});

describe('badges over the evaluated options', () => {
  const evaluation = (patch: Partial<DuctOptionEvaluation>): DuctOptionEvaluation => ({
    optionId: '', updates: [], action: '', notes: [], after: null, section: null, velocityMs: 3, velocityStatus: 'ok', deltaSegmentPa: 0, deltaIndexPa: 0,
    deltaFirstCost: 0, deltaLifeCycleCost: 0, deltaMassKg: 0, outerHeightMm: 300, deltaOuterHeightMm: 0, newIssues: [], clearedIssues: 0, ...patch,
  });
  const option = (id: string): DuctSegmentOption => ({ id, group: 'swap', glyph: 'rect', title: id, detail: '', edit: { kind: 'end', runId: 'r', end: 'open' } });

  it('recommends the lowest life-cycle cost that breaks no rule and keeps the velocity in its limit', () => {
    const options = ['a', 'b', 'c', 'd'].map(option);
    const evaluations = new Map([
      ['a', evaluation({ deltaLifeCycleCost: -50, deltaIndexPa: -3, deltaFirstCost: 20 })],
      ['b', evaluation({ deltaLifeCycleCost: -80, velocityStatus: 'over' })],
      ['c', evaluation({ deltaLifeCycleCost: -90, newIssues: [{ severity: 'error', code: 'DU_TAP_TOO_BIG', message: '' }] })],
      ['d', evaluation({ deltaLifeCycleCost: 10, deltaFirstCost: -30, deltaOuterHeightMm: -50 })],
    ]);
    const badges = rankDuctOptions(options, evaluations);
    expect(badges.get('a')).toEqual(expect.arrayContaining(['recommended', 'lowest-pressure']));
    expect(badges.get('b')).toBeUndefined();
    expect(badges.get('c')).toBeUndefined();
    expect(badges.get('d')).toEqual(expect.arrayContaining(['lowest-cost', 'saves-height']));
  });

  it('recommends nothing when no option beats the segment as it is', () => {
    const badges = rankDuctOptions([option('a')], new Map([['a', evaluation({ deltaLifeCycleCost: 5 })]]));
    expect(badges.get('a') ?? []).not.toContain('recommended');
  });
});
