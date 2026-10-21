import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { planHvacMove } from '../move/hvacMoveModel';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { portEntryDirection, resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct } from './ductAutoLayout';
import { legNormal } from './ductBranches';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { FLEX_STRAIGHT_LEAD_MM } from './ductFlex';
import { airTerminalMarkup } from './ductOverlayMarkup';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg } from './ductTypes';

// A deep void: the unit hung high (its underside at 3,000 mm), the soffit at 3,600 mm, the ceiling at 2,400 mm.
const settings = resolveDuctSettings({ soffitMm: 3600 });
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 3000, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W', airSystemTag: 'DU-1' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const n = port.normal;
const t = legNormal(n);
/** A plan point `along` out from the supply collar and `across` beside it. */
const at = (along: number, across = 0): Point2D => ({ x: port.lip.x + n.x * along + t.x * across, y: port.lip.y + n.y * along + t.y * across });

/** A square Ø200 diffuser centred at `centre`, its face in the ceiling (2,400 mm); `top`: its collar on top. */
function diffuser(id: string, centre: Point2D, top: boolean): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), ...(top ? { spigotEntry: 'top' as const } : {}) };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}
const lipBottom = (terminal: HvacElement) => {
  const lip = terminalSpigotPort(terminal)!.lip;
  return { x: lip.x, y: lip.y, z: lip.z - 100 };
};
const errorsOf = (scene: readonly HvacElement[], id: string) => getDuctRunPlan(scene.find((element) => element.id === id)!, scene, settings)!.issues
  .filter((issue) => issue.severity === 'error').map((issue) => issue.code);
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};

describe('a terminal\'s collar on top', () => {
  it('stands on the box\'s top centre, its air going down into it', () => {
    const terminal = diffuser('d1', at(2400), true);
    const spec = readDuctTerminalSpec(terminal)!;
    expect(spec.spigotEntry).toBe('top');
    const top = terminalSpigotPort(terminal)!;
    expect(top.vertical).toBe(true);
    expect(top.lip.x).toBeCloseTo(terminal.position.x + terminal.width / 2, 6);
    expect(top.lip.y).toBeCloseTo(terminal.position.y + terminal.depth / 2, 6);
    expect(top.lip.z).toBeCloseTo(2400 + spec.faceHeightMm + spec.plenumHeightMm + spec.spigotLengthMm, 6);
    expect(portEntryDirection(top)).toEqual({ x: 0, y: 0, z: -1 });
    // A side collar's air goes in square to it.
    const side = terminalSpigotPort(diffuser('d2', at(2400), false))!;
    expect(side.vertical).toBeUndefined();
    expect(portEntryDirection(side)).toEqual({ x: -side.normal.x, y: -side.normal.y, z: 0 });
  });

  it('a flexible runout comes down into it, bending at a diameter or more, from a duct running high enough', () => {
    const terminal = diffuser('d1', at(2400), true);
    const run = buildDuctRunDraftElement({
      port, points: [at(1500), lipBottom(terminal)], legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'run');
    const scene = [unit, terminal, run];
    expect(errorsOf(scene, 'run')).toEqual([]);
    const flex = getDuctRunPlan(run, scene, settings)!.pieces.find((piece) => piece.kind === 'flex')!;
    const points = flex.flex!.points;
    // Its lead goes straight down onto the collar, and the bend arrives at it heading down.
    const [into, lead, last] = points.slice(-3);
    expect(Math.hypot(last!.x - lead!.x, last!.y - lead!.y)).toBeLessThan(1e-6);
    expect(lead!.z - last!.z).toBeCloseTo(FLEX_STRAIGHT_LEAD_MM, 6);
    expect(into!.z - lead!.z).toBeGreaterThan(Math.hypot(into!.x - lead!.x, into!.y - lead!.y));
    expect(flex.flex!.minBendRadiusMm).toBeGreaterThanOrEqual(200 - 0.5);
  });

  it('where the soffit is too low for its runout to come down into it, the planner says so with the numbers', () => {
    const low = resolveDuctSettings({ soffitMm: 3000 });
    const terminal = diffuser('d1', at(2400), true);
    const run = buildDuctRunDraftElement({
      port: resolveUnitAirPorts({ ...unit, elevation: 2550 }).find((entry) => entry.kind === 'supply')!, points: [at(1500), lipBottom(terminal)],
      legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)], end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'run');
    const scene = [{ ...unit, elevation: 2550 }, terminal, run];
    const issue = getDuctRunPlan(run, scene, low)!.issues.find((entry) => entry.code === 'DU_TOP_COLLAR_VOID');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toMatch(/top collar needs \d+ mm above its box .* soffit is at 3,000 mm/);
  });

  it('a terminal\'s collar moved to the top and back: its runout follows (re-curving), its spec says so', () => {
    const terminal = diffuser('d1', at(2400), false);
    const run = buildDuctRunDraftElement({
      port, points: [at(1500), lipBottom(terminal)], legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'run');
    const scene = [unit, terminal, run];
    const topped = applyDuctSegmentEdit(scene, settings, { kind: 'terminal', terminalId: 'd1', spigotEntry: 'top' });
    expect(topped.refused).toBeUndefined();
    expect(topped.action).toBe('Terminal D1: collar on top');
    const after = withUpdates(scene, topped.updates);
    const moved = after.find((element) => element.id === 'd1')!;
    expect(readDuctTerminalSpec(moved)!.spigotEntry).toBe('top');
    const end = readDuctRunSpec(after.find((element) => element.id === 'run')!)!.path.at(-1)!;
    const lip = terminalSpigotPort(moved)!.lip;
    expect(Math.hypot(end.x - lip.x, end.y - lip.y)).toBeLessThan(1);
    expect(errorsOf(after, 'run')).toEqual([]);
    const back = applyDuctSegmentEdit(after, settings, { kind: 'terminal', terminalId: 'd1', spigotEntry: 'side' });
    expect(back.refused).toBeUndefined();
    expect(readDuctTerminalSpec(withUpdates(after, back.updates).find((element) => element.id === 'd1')!)!.spigotEntry).toBeUndefined();
  });

  it('a collar moved off the top goes on the side its runout reaches cleanly (its own side when that is clean)', () => {
    // The side it kept from before faces away from the duct: its runout would have to double back round the box.
    const sideOf = (side: 'back' | 'front' | 'left' | 'right') => terminalSpigotPort({
      ...diffuser('probe', at(2400), false), properties: { terminal: { ...typicalTerminalSpec('square-4way', 200), spigotSide: side } },
    })!;
    const away = (['back', 'front', 'left', 'right'] as const).find((side) => sideOf(side).normal.x * n.x + sideOf(side).normal.y * n.y > 0.9)!;
    const base = diffuser('d1', at(2400), true);
    const terminal = { ...base, properties: { terminal: { ...readDuctTerminalSpec(base)!, spigotSide: away } } };
    const run = buildDuctRunDraftElement({
      port, points: [at(1000), lipBottom(terminal)], legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'run');
    const scene = [unit, terminal, run];
    expect(errorsOf(scene, 'run')).toEqual([]);
    const result = applyDuctSegmentEdit(scene, settings, { kind: 'terminal', terminalId: 'd1', spigotEntry: 'side' });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(scene, result.updates);
    const moved = after.find((element) => element.id === 'd1')!;
    const chosen = terminalSpigotPort(moved)!;
    expect(readDuctTerminalSpec(moved)!.spigotSide).not.toBe(away);
    // It faces the duct, and the runout comes in clean.
    expect(chosen.normal.x * -n.x + chosen.normal.y * -n.y).toBeGreaterThan(0.9);
    expect(result.notes[0]).toMatch(/collar on the box's \w+ side, the side its runout reaches best/);
    expect(errorsOf(after, 'run')).toEqual([]);
    // Where its own side is clean, it keeps it.
    const near = { ...base, properties: { terminal: { ...readDuctTerminalSpec(base)!, spigotSide: readDuctTerminalSpec(moved)!.spigotSide } } };
    const kept = applyDuctSegmentEdit([unit, near, run], settings, { kind: 'terminal', terminalId: 'd1', spigotEntry: 'side' });
    expect(readDuctTerminalSpec(withUpdates([unit, near, run], kept.updates).find((element) => element.id === 'd1')!)!.spigotSide).toBe(readDuctTerminalSpec(near)!.spigotSide);
    expect(kept.notes[0]).not.toMatch(/reaches best/);
    // Where spigots may not be turned, it keeps the side it had, and the status says what its runout now breaks.
    const fixed = resolveDuctSettings({ soffitMm: 3600, autoChooseSpigotSide: false });
    const stays = applyDuctSegmentEdit(scene, fixed, { kind: 'terminal', terminalId: 'd1', spigotEntry: 'side' });
    expect(readDuctTerminalSpec(withUpdates(scene, stays.updates).find((element) => element.id === 'd1')!)!.spigotSide).toBe(away);
    expect(stays.notes.at(-1)).toMatch(/^its runout now breaks a rule: The runout bends at \d+ mm radius/);
  });

  it.each([
    ['on the run\'s line', 0],
    ['beside it', 900],
  ])('a rigid runout drops onto it (%s): reduced on the level, on to above the collar, an elbow, straight down', (_, across) => {
    const terminal = diffuser('d1', at(2400, across), true);
    const run = buildDuctRunDraftElement({
      port, points: [at(1500), lipBottom(terminal)], legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'run');
    const scene = [unit, terminal, run];
    const rigid = applyDuctSegmentEdit(scene, settings, { kind: 'runout', runId: 'run', flex: false });
    expect(rigid.refused).toBeUndefined();
    expect(rigid.notes?.[0]).toMatch(/rigid Ø200 runout.*dropping to its height/);
    const after = withUpdates(scene, rigid.updates);
    const spec = readDuctRunSpec(after.find((element) => element.id === 'run')!)!;
    expect(spec.end).toMatchObject({ kind: 'terminal', flex: false });
    const lip = terminalSpigotPort(terminal)!.lip;
    const [above, end] = spec.path.slice(-2);
    expect(Math.hypot(above!.x - lip.x, above!.y - lip.y)).toBeLessThan(1);
    expect(Math.hypot(end!.x - lip.x, end!.y - lip.y)).toBeLessThan(1);
    expect(above!.z).toBeGreaterThan(end!.z);
    // Only the trunk's first straight keeps its size; the rest is the collar's Ø200.
    expect(spec.legs.slice(1).every((leg) => leg.diameterMm === 200)).toBe(true);
    expect(errorsOf(after, 'run')).toEqual([]);
  });

  it('a rigid runout is refused, with the reason, where the duct runs too low to drop onto the collar', () => {
    const terminal = diffuser('d1', at(2400), true);
    const lower = { ...unit, elevation: 2500 };
    const run = buildDuctRunDraftElement({
      port: resolveUnitAirPorts(lower).find((entry) => entry.kind === 'supply')!, points: [at(1500), lipBottom(terminal)],
      legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)], end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
    }, 'run');
    const rigid = applyDuctSegmentEdit([lower, terminal, run], settings, { kind: 'runout', runId: 'run', flex: false });
    expect(rigid.refused).toMatch(/too low to drop onto a top collar/);
  });

  it('Auto duct with every collar on top: each runout comes down into its terminal\'s top collar, and the collars are written with the runs', () => {
    const scene = [unit, diffuser('d1', at(2400, 1500), false), diffuser('d2', at(2400, -1500), false)];
    const result = generateAutoDuct(scene, {
      unitId: 'u', terminalIds: ['d1', 'd2'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false,
      shape: 'rect', collarEntry: 'top',
    }, settings);
    expect(result.runs.length).toBeGreaterThan(0);
    // A top collar's side is only the way its runout comes in: no spigot is turned.
    expect(result.terminalUpdates).toEqual([]);
    const written = new Map(result.terminalAirflowUpdates.map((element) => [element.id, element]));
    for (const id of ['d1', 'd2']) expect(readDuctTerminalSpec(written.get(id)!)!.spigotEntry).toBe('top');
    const after = [...scene.map((element) => written.get(element.id) ?? element), ...result.runs];
    for (const run of result.runs) {
      const spec = readDuctRunSpec(run)!;
      if (spec.end.kind !== 'terminal') continue;
      const terminalId = spec.end.terminalId;
      const lip = terminalSpigotPort(after.find((element) => element.id === terminalId)!)!.lip;
      const end = spec.path.at(-1)!;
      expect(Math.hypot(end.x - lip.x, end.y - lip.y)).toBeLessThan(1);
      expect(errorsOf(after, run.id)).toEqual([]);
    }
  });
});

describe('a terminal with a top collar moved or turned', () => {
  const terminal = diffuser('d1', at(2400), true);
  const draft = buildDuctRunDraftElement({
    port, points: [at(1500), lipBottom(terminal)], legSizes: [{ widthMm: 400, heightMm: 250 }, roundLeg(200)],
    end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
  }, 'run');
  const flexScene = [unit, terminal, draft];
  const rigidScene = withUpdates(flexScene, applyDuctSegmentEdit(flexScene, settings, { kind: 'runout', runId: 'run', flex: false }).updates);
  const context = { ductSettings: settings };
  /** The run's end and the vertex before it, against the terminal's collar. */
  const tail = (scene: readonly HvacElement[]) => {
    const spec = readDuctRunSpec(scene.find((element) => element.id === 'run')!)!;
    const lip = terminalSpigotPort(scene.find((element) => element.id === 'd1')!)!.lip;
    const [above, end] = spec.path.slice(-2);
    return { lip, above: above!, end: end!, flex: spec.end.kind === 'terminal' && spec.end.flex };
  };

  it.each([
    ['along the run (its straights stretch)', 300, 0, []],
    ['a short step across (re-made: reduced further back, a 45° offset onto its line)', 0, 400, ['The run to D1 has its rigid runout re-made onto D1\'s spigot.']],
    ['well across (re-made: a turn onto it)', 0, 900, ['The run to D1 has its rigid runout re-made onto D1\'s spigot.']],
  ])('moved %s: its rigid drop follows it, still straight down onto the collar', (_, along, across, messages) => {
    const delta = { x: n.x * along + t.x * across, y: n.y * along + t.y * across, z: 0 };
    const plan = planHvacMove(rigidScene, { ids: ['d1'], delta }, context);
    expect(plan.fraction).toBe(1);
    expect(plan.messages).toEqual(messages);
    const after = withUpdates(rigidScene, plan.updated);
    const { lip, above, end, flex } = tail(after);
    expect(flex).toBe(false);
    expect(Math.hypot(end.x - lip.x, end.y - lip.y)).toBeLessThan(1);
    expect(Math.hypot(above.x - lip.x, above.y - lip.y)).toBeLessThan(1);
    expect(above.z).toBeGreaterThan(end.z);
    expect(errorsOf(after, 'run')).toEqual([]);
  });

  it('moved back toward its unit: its drop follows, the straight before it shortening', () => {
    const plan = planHvacMove(rigidScene, { ids: ['d1'], delta: { x: -n.x * 300, y: -n.y * 300, z: 0 } }, context);
    expect(plan.fraction).toBe(1);
    const after = withUpdates(rigidScene, plan.updated);
    const { lip, above, end } = tail(after);
    expect(Math.hypot(end.x - lip.x, end.y - lip.y)).toBeLessThan(1);
    expect(Math.hypot(above.x - lip.x, above.y - lip.y)).toBeLessThan(1);
    expect(errorsOf(after, 'run')).toEqual([]);
  });

  it('turned about its own centre: its top collar stays put, and so does its runout', () => {
    const before = tail(rigidScene);
    const plan = planHvacMove(rigidScene, { ids: ['d1'], delta: { x: 0, y: 0, z: 0 }, rotation: { angleDeg: 90, pivot: 'each' } }, context);
    expect(plan.rotation?.appliedDeg).toBe(90);
    const after = withUpdates(rigidScene, plan.updated);
    expect(after.find((element) => element.id === 'd1')!.rotation).toBe(90);
    const turned = tail(after);
    expect(Math.hypot(turned.lip.x - before.lip.x, turned.lip.y - before.lip.y)).toBeLessThan(1e-6);
    expect(Math.hypot(turned.end.x - before.end.x, turned.end.y - before.end.y)).toBeLessThan(1);
    expect(errorsOf(after, 'run')).toEqual([]);
  });

  it('a flexible runout follows a moved top collar, re-curving down into it', () => {
    const plan = planHvacMove(flexScene, { ids: ['d1'], delta: { x: t.x * 500, y: t.y * 500, z: 0 } }, context);
    const after = withUpdates(flexScene, plan.updated);
    const { lip, end } = tail(after);
    expect(Math.hypot(end.x - lip.x, end.y - lip.y)).toBeLessThan(1);
    expect(errorsOf(after, 'run')).toEqual([]);
  });
});

describe('a top collar drawn', () => {
  it('on the plan: a dashed circle at the box\'s centre', () => {
    const top = diffuser('d1', { x: 0, y: 0 }, true);
    expect(airTerminalMarkup(top, readDuctTerminalSpec(top)!, 1, false)).toContain('data-terminal-collar="top"');
    const side = diffuser('d2', { x: 0, y: 0 }, false);
    expect(airTerminalMarkup(side, readDuctTerminalSpec(side)!, 1, false)).toContain('data-terminal-collar="side"');
  });

  it('in 3D: the collar stands on the roof, which is open under it', () => {
    const group = buildHvacElementMesh(diffuser('d1', { x: 0, y: 0 }, true), { allElements: [] } as never)!;
    const roof = group.getObjectByName('terminal-plenum-roof') as THREE.Mesh;
    expect(roof).toBeTruthy();
    roof.geometry.computeBoundingBox();
    // A sheet (not a box): its thickness is nil.
    expect(roof.geometry.boundingBox!.max.z - roof.geometry.boundingBox!.min.z).toBeLessThan(0.01);
    expect(group.getObjectByName('terminal-plenum-spigot-wall')).toBeUndefined();
  });
});
