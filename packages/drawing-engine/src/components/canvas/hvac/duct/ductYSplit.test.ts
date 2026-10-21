import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { DIVIDED_FLOW_MIN_LEG_MM, dividedFlowLeg, legNormal } from './ductBranches';
import { splitOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { dividedFlowOutletLossPa, elbowCoefficient, transitionCoefficient } from './ductPressure';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { splitAirflowShare } from './ductSegmentFigures';
import { ductSegmentOf } from './ductSegments';
import { ductSegmentOptions } from './ductSegmentOptions';
import { resolveDuctSettings } from './ductSettings';
import { velocityMs, velocityPressurePa } from './ductSizing';
import { defaultSizingBasis, sizeDuctSystem } from './ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, splitEnd, type DuctLeg } from './ductTypes';
import { geometryModel } from './optimizer/sizingModel';

// A deep void (the unit hung at 3,000 mm, the soffit at 3,600 mm): each outlet's run drops into a top-collar diffuser.
const settings = resolveDuctSettings({ soffitMm: 3600 });
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 3000, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W', airSystemTag: 'DU-1' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const n = port.normal;
const t = legNormal(n);
const at = (along: number, across = 0): Point2D => ({ x: port.lip.x + n.x * along + t.x * across, y: port.lip.y + n.y * along + t.y * across });
const rect = (widthMm: number, heightMm = 250): DuctLeg => ({ widthMm, heightMm });
const dot = (a: Point2D, b: Point2D) => a.x * b.x + a.y * b.y;

function diffuser(id: string, centre: Point2D, airflowM3h: number): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), spigotEntry: 'top' as const, designAirflowM3h: airflowM3h };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

/**
 * A 400×250 main 2,000 mm off the collar ending in a Y (its splitter at `share`, or none), and each outlet's run:
 * 1,200 mm at its section, then a flexible runout into a diffuser (+1: `airflows[0]` m³/h, −1: `airflows[1]`).
 */
function ySystem(share: number | null, plus: DuctLeg, minus: DuctLeg, options: { angle?: 45 | 90; airflows?: [number, number] } = {}) {
  const angle = options.angle ?? 90;
  const [plusAir, minusAir] = options.airflows ?? [600, 400];
  let main = buildDuctRunDraftElement({ port, points: [at(2000)], legSizes: [rect(400)] }, 'main');
  main = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, end: splitEnd('y', angle, share) });
  const scene: HvacElement[] = [unit, main];
  for (const [side, section, id, airflow] of [[1, plus, 'plus', plusAir], [-1, minus, 'minus', minusAir]] as const) {
    const origin = splitOrigin(main, settings, { side, style: 'y', vcd: false }, section)!;
    if (origin.kind === 'port' || origin.kind === 'free') throw new Error('no outlet');
    const end = { x: origin.point.x + origin.direction.x * 1200, y: origin.point.y + origin.direction.y * 1200 };
    const terminal = diffuser(`d-${id}`, { x: end.x + origin.direction.x * 900, y: end.y + origin.direction.y * 900 }, airflow);
    const lip = terminalSpigotPort(terminal)!.lip;
    const draft = buildDuctRunDraft({
      origin, points: [{ ...end, z: origin.bottomZ }, { x: lip.x, y: lip.y, z: lip.z - 100 }], legSizes: [section, roundLeg(200)],
      end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: true },
    }, id, scene);
    scene.push(terminal, draft.element);
  }
  return scene;
}
const planOf = (scene: readonly HvacElement[], id: string) => getDuctRunPlan(scene.find((element) => element.id === id)!, scene, settings)!;
const errorsOf = (plan: DuctFabricationPlan) => plan.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
const splitOf = (scene: readonly HvacElement[]) => planOf(scene, 'main').pieces.find((piece) => piece.kind === 'split')!.split!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
/** Every run on its outlet or collar and clean. */
function clean(scene: readonly HvacElement[]) {
  return ['main', 'plus', 'minus'].map((id) => ({ id, errors: errorsOf(planOf(scene, id)), stale: planOf(scene, id).issues.filter((issue) => issue.code === 'DU_STALE').length }));
}

describe('a divided-flow Y (SMACNA Fig. 2-5)', () => {
  it('divides the run in the airflow ratio: each leg its share of the width, the splitter where they meet', () => {
    const scene = ySystem(0.6, rect(250), rect(200));
    const split = splitOf(scene);
    expect(split.share).toBe(0.6);
    const plus = split.branches.find((branch) => branch.side === 1)!;
    const minus = split.branches.find((branch) => branch.side === -1)!;
    expect(plus.leg).toEqual(rect(240));
    expect(minus.leg).toEqual(rect(160));
    // The splitter, 40 mm off the run's axis toward the smaller leg, over the elbows' necks.
    expect(dot({ x: split.splitter!.from.x - split.origin.x, y: split.splitter!.from.y - split.origin.y }, split.normal)).toBeCloseTo(-40, 6);
    expect(Math.hypot(split.splitter!.to.x - split.splitter!.from.x, split.splitter!.to.y - split.splitter!.from.y)).toBeCloseTo(settings.elbowNeckMm, 6);
    expect(clean(scene)).toEqual(['main', 'plus', 'minus'].map((id) => ({ id, errors: [], stale: 0 })));
  });

  it('each leg turns on its own radius elbow (R/W at least 1 on its width) and tapers to its outlet inside the fitting', () => {
    const scene = ySystem(0.6, rect(250), rect(200));
    const split = splitOf(scene);
    for (const [side, legWidth, outlet] of [[1, 240, rect(250)], [-1, 160, rect(200)]] as const) {
      const branch = split.branches.find((candidate) => candidate.side === side)!;
      expect(branch.elbow!.centrelineRadiusMm).toBeCloseTo(Math.max(1, settings.elbowCentrelineRatio) * legWidth, 6);
      expect(branch.transition).toMatchObject({ from: rect(legWidth), to: outlet });
      // Its outlet's flange is where the fitting's own model puts it; the outlet's run starts there.
      const model = dividedFlowLeg(rect(400), outlet, 0.6, side, 90, settings);
      const r = { x: branch.outlet.point.x - split.origin.x, y: branch.outlet.point.y - split.origin.y };
      expect(dot(r, split.direction)).toBeCloseTo(model.alongMm, 6);
      expect(dot(r, split.normal)).toBeCloseTo(model.acrossMm, 6);
      const runStart = readDuctRunSpec(scene.find((element) => element.id === (side === 1 ? 'plus' : 'minus'))!)!.path[0]!;
      expect(Math.hypot(runStart.x - branch.outlet.point.x, runStart.y - branch.outlet.point.y)).toBeLessThan(0.01);
    }
  });

  it('as a Y junction (45°), the same legs leave at 45°', () => {
    const scene = ySystem(0.6, rect(250), rect(200), { angle: 45 });
    const split = splitOf(scene);
    expect(split.angleDeg).toBe(45);
    for (const branch of split.branches) {
      expect(dot(branch.outlet.direction, split.direction)).toBeCloseTo(Math.SQRT1_2, 6);
      expect(branch.leg.widthMm).toBe(branch.side === 1 ? 240 : 160);
    }
    expect(clean(scene).flatMap((entry) => entry.errors)).toEqual([]);
  });

  it('a leg under 100 mm is an error that names the bullhead tee', () => {
    const scene = ySystem(0.2, rect(150), rect(300), { airflows: [200, 800] });
    const issue = planOf(scene, 'main').issues.find((entry) => entry.code === 'DU_SPLIT_SIZE');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toMatch(new RegExp(`80 mm wide \\(its 20 % of the air\\), under ${DIVIDED_FLOW_MIN_LEG_MM} mm: split here with a bullhead tee`));
  });

  it('a Y drawn before the splitter keeps its geometry: each outlet against its side wall at its own width', () => {
    const scene = ySystem(null, rect(250), rect(150));
    const split = splitOf(scene);
    expect(split.share).toBeNull();
    expect(split.splitter).toBeNull();
    for (const branch of split.branches) {
      expect(branch.leg).toEqual(branch.section);
      expect(branch.transition).toBeNull();
    }
    expect(clean(scene).flatMap((entry) => entry.errors)).toEqual([]);
  });

  it('the card and the BOM say it in full', () => {
    const scene = ySystem(0.6, rect(250), rect(200));
    const plan = planOf(scene, 'main');
    const segment = ductSegmentOf(plan, 'end:split')!;
    expect(segment.detail).toBe('divided 60 / 40 % · legs 240×250 + 160×250 · to 250×250 + 200×250');
  });
});

describe('its losses, from its own flow and area ratios', () => {
  const inlet = rect(400);
  const leg = rect(240);
  const outlet = rect(250);
  const loss = (inletAir: number, outletAir: number) => dividedFlowOutletLossPa({ inlet, leg, outlet, radiusRatio: 1, angleDeg: 90, transitionSlopeMm: 20 }, inletAir, outletAir);

  it('at the designed share the leg starts at the inlet\'s velocity: only its elbow and its transition lose', () => {
    expect(velocityMs(leg, 600)).toBeCloseTo(velocityMs(inlet, 1000), 9);
    const elbow = elbowCoefficient('radius', 1, 90) * velocityPressurePa(velocityMs(leg, 600));
    // 240 to 250 wide over a 20 mm slope: 5 mm a side, a 28° included angle, expanding (on the outlet's velocity).
    const transition = transitionCoefficient((2 * Math.atan2(5, 20) * 180) / Math.PI, true) * velocityPressurePa(velocityMs(outlet, 600));
    expect(loss(1000, 600)).toBeCloseTo(elbow + transition, 9);
  });

  it('air divided off the designed share loses more, either way', () => {
    const at = (outletAir: number) => loss(1000, outletAir) / velocityPressurePa(velocityMs(leg, outletAir));
    expect(at(450)).toBeGreaterThan(at(600));
    expect(at(800)).toBeGreaterThan(at(600));
  });

  it('the optimiser prices the same fitting: its outlets lead from the run\'s end as it is built', () => {
    const model = geometryModel(settings, 'supply', 'gi-bare');
    expect(model.splitLeadMm('y', inlet, outlet, 0.6)).toBeCloseTo(dividedFlowLeg(inlet, outlet, 0.6, 1, 90, settings).alongMm, 6);
    expect(model.dividedFlowShareOk(inlet, 0.6)).toBe(true);
    expect(model.dividedFlowShareOk(inlet, 0.2)).toBe(false);
  });
});

describe('the splitter set at the airflow ratio', () => {
  it('the card offers it on a Y drawn before it; taken, the outlets\' runs follow their new flanges', () => {
    const scene = ySystem(null, rect(250), rect(150), { airflows: [700, 300] });
    expect(splitAirflowShare(scene, settings, 'main')).toBeCloseTo(0.7, 9);
    const option = ductSegmentOptions(scene, settings, 'main', 'end:split').find((entry) => entry.id === 'split:share')!;
    expect(option.title).toBe('Splitter at the airflow ratio (70 / 30 %)');
    const result = applyDuctSegmentEdit(scene, settings, option.edit);
    expect(result.refused).toBeUndefined();
    const after = withUpdates(scene, result.updates);
    expect(readDuctRunSpec(after.find((element) => element.id === 'main')!)!.end).toMatchObject({ kind: 'split', style: 'y', share: 0.7 });
    expect(clean(after)).toEqual(['main', 'plus', 'minus'].map((id) => ({ id, errors: [], stale: 0 })));
    // Set, it is no longer offered.
    expect(ductSegmentOptions(after, settings, 'main', 'end:split').some((entry) => entry.id === 'split:share')).toBe(false);
  });

  it('sizing the system by constant friction sets the splitter at its terminals\' airflow ratio', () => {
    const scene = ySystem(null, rect(250), rect(150), { airflows: [550, 450] });
    const basis = { ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 1000 };
    const result = sizeDuctSystem(scene, 'main', { basis, verify: false }, settings);
    const after = withUpdates(scene, result.runs);
    const end = readDuctRunSpec(after.find((element) => element.id === 'main')!)!.end;
    expect(end).toMatchObject({ kind: 'split', style: 'y' });
    expect(end.kind === 'split' ? end.share : null).toBeCloseTo(0.55, 3);
    expect(clean(after).flatMap((entry) => entry.stale ? [entry.id] : [])).toEqual([]);
  });
});
