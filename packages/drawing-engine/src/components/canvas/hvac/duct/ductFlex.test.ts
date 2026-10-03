import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { spigotOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { FLEX_RULES, FLEX_STRAIGHT_LEAD_MM, flexCurve, flexSupportStations, saggedFlexPoints } from './ductFlex';
import { followDuctsForUnitMove } from './ductFollow';
import { expandDuctDeletion } from './ductNetwork';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import { planDuctSupports } from './ductSupports';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg } from './ductTypes';
import { findDuctClashes, terminalBoxOf } from './ductVolumes';

const settings = resolveDuctSettings({ soffitMm: 3400 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const main = buildDuctRunDraftElement({
  port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 1000 }], end: { kind: 'plenum', widthMm: 900, heightMm: 350, lengthMm: 500 },
}, 'plenum-run');
const found = spigotOrigin(main, settings, { face: 'left', alongMm: 250, acrossMm: 0, style: 'spin-in', vcd: true }, roundLeg(200))!;
if (found.kind !== 'spigot') throw new Error('expected a spigot origin');
const origin = found;
const out = origin.direction;
/** The collar and damper of an all-runout branch (100 + 150). */
const stubMm = settings.tapCollarMm + settings.vcdLengthMm;
const branchCentreZ = origin.bottomZ + 100;

/** A square diffuser whose spigot faces back at the branch, its lip at `lip` (plan) and `dropMm` below the branch centre. */
function diffuserAt(id: string, lip: Point2D, dropMm: number, neck = 200): HvacElement {
  const spec = typicalTerminalSpec('square-4way', neck);
  const envelope = terminalEnvelope(spec);
  // Local back (0, −1) turned onto −out: (sin θ, −cos θ) = −out.
  const rotation = (Math.atan2(-out.x, out.y) * 180) / Math.PI;
  const elevation = branchCentreZ - dropMm - (spec.faceHeightMm + spec.plenumHeightMm / 2);
  const draft: HvacElement = {
    id, type: 'diffuser', position: { x: 0, y: 0 }, rotation, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const port = terminalSpigotPort(draft)!;
  return { ...draft, position: { x: lip.x - port.lip.x, y: lip.y - port.lip.y } };
}

/** An all-runout branch from the left spigot to `terminal`: the collar stub, then the flex. */
function runoutTo(id: string, terminal: HvacElement, scene: HvacElement[], flex = true, diameter = 200, withStub = flex): HvacElement {
  const port = terminalSpigotPort(terminal)!;
  const stub = { x: origin.point.x + out.x * stubMm, y: origin.point.y + out.y * stubMm, z: origin.bottomZ };
  const spigot = { x: port.lip.x, y: port.lip.y, z: port.lip.z - diameter / 2 };
  return buildDuctRunDraft({
    origin: { ...origin }, points: withStub ? [stub, spigot] : [spigot], legSizes: [roundLeg(diameter), roundLeg(diameter)],
    end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex },
  }, id, scene).element;
}

const along = (distance: number, side = 0): Point2D => ({
  x: origin.point.x + out.x * distance - out.y * side,
  y: origin.point.y + out.y * distance + out.x * side,
});

const near = diffuserAt('sd1', along(stubMm + 900, 300), 200);
const nearRun = runoutTo('run1', near, [unit, main, near]);
const scene = [unit, main, near, nearRun];

describe('flexible runout geometry (SMACNA §3.5–3.7)', () => {
  it('leaves and enters each collar straight for the lead, and is exact when straight', () => {
    const start = { x: 0, y: 0, z: 0 };
    const curve = flexCurve(start, { x: 1, y: 0, z: 0 }, { x: 1000, y: 600, z: -200 }, { x: 0, y: 1, z: 0 });
    expect(curve.points[1]).toEqual({ x: FLEX_STRAIGHT_LEAD_MM, y: 0, z: 0 });
    const beforeEnd = curve.points[curve.points.length - 2]!;
    expect(beforeEnd.x).toBeCloseTo(1000, 9);
    expect(beforeEnd.y).toBeCloseTo(600 - FLEX_STRAIGHT_LEAD_MM, 9);
    expect(curve.lengthMm).toBeGreaterThan(Math.hypot(1000, 600, 200));
    const straight = flexCurve(start, { x: 1, y: 0, z: 0 }, { x: 1200, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(straight.lengthMm).toBeCloseTo(1200, 6);
    expect(straight.minBendRadiusMm).toBeGreaterThan(1e6);
  });

  it('keeps horizontal support spans within 1.2 m, with 40 mm saddles and sag within 41.7 mm/m', () => {
    expect(flexSupportStations(1200)).toEqual([]);
    expect(flexSupportStations(1500)).toEqual([750]);
    expect(flexSupportStations(2000)).toEqual([1000]);
    expect(FLEX_RULES.minStrapWidthMm).toBeGreaterThanOrEqual(38.1);
    for (const length of [1200, 1201, 1500, 2400, 2401, 5000]) {
      const stations = [0, ...flexSupportStations(length), length];
      for (let index = 1; index < stations.length; index += 1) {
        expect(stations[index]! - stations[index - 1]!).toBeLessThanOrEqual(1200);
      }
    }
    const three = flexSupportStations(3100);
    expect(three).toHaveLength(2);
    expect(three[0]).toBeCloseTo(3100 / 3, 6);
    const curve = flexCurve({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const supports = flexSupportStations(curve.lengthMm);
    const sagged = saggedFlexPoints(curve, supports);
    expect(sagged[0]!.z).toBe(0);
    expect(sagged[sagged.length - 1]!.z).toBe(0);
    const deepest = Math.min(...sagged.map((point) => point.z));
    expect(deepest).toBeLessThan(0);
    expect(-deepest).toBeLessThanOrEqual(FLEX_RULES.maxSagMmPerM * 1.0 + 1e-9);
  });
});

describe('runs ending on air terminals', () => {
  it('an all-runout branch keeps its spin-in and damper, then a flex to the spigot with bands at both ends', () => {
    const plan = planDuctRun(nearRun, { settings, scene })!;
    expect(plan.pieces.map((piece) => piece.kind)).toEqual(['takeoff', 'damper', 'flex']);
    const flex = plan.pieces.at(-1)!;
    const port = terminalSpigotPort(near)!;
    expect(flex.flex!.points.at(-1)).toEqual(port.lip);
    expect(flex.stationStartMm).toBeCloseTo(stubMm, 6);
    expect(flex.lengthMm).toBeGreaterThan(900);
    expect(flex.lengthMm).toBeLessThan(settings.flexMaxLengthMm);
    expect(flex.flex).toMatchObject({ type: 'nm-il', jacketMm: 25, terminalId: 'sd1' });
    expect(plan.joints.map((joint) => joint.kind)).toEqual(expect.arrayContaining(['tap-connection', 'flex-connection', 'terminal-connection']));
    expect(plan.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.code)).toEqual([]);
    // The run's length includes the runout.
    expect(plan.polylineLengthMm).toBeCloseTo(stubMm + flex.lengthMm, 6);
  });

  it('flags a runout over the maximum, a wrong size, a tight bend and a deep drop', () => {
    const far = diffuserAt('sd2', along(stubMm + 1800, 900), 200);
    const farPlan = planDuctRun(runoutTo('run2', far, [unit, main, far]), { settings, scene: [unit, main, far] })!;
    expect(farPlan.issues.map((issue) => issue.code)).toContain('DU_FLEX_LENGTH');
    const big = diffuserAt('sd3', along(stubMm + 900, 300), 200, 250);
    const bigPlan = planDuctRun(runoutTo('run3', big, [unit, main, big]), { settings, scene: [unit, main, big] })!;
    expect(bigPlan.issues.map((issue) => issue.code)).toContain('DU_FLEX_SIZE');
    const tight = diffuserAt('sd4', along(stubMm + 150, 600), 0);
    const tightPlan = planDuctRun(runoutTo('run4', tight, [unit, main, tight]), { settings, scene: [unit, main, tight] })!;
    expect(tightPlan.issues.map((issue) => issue.code)).toContain('DU_FLEX_BEND');
    const deep = diffuserAt('sd5', along(stubMm + 600, 0), 1000);
    const deepPlan = planDuctRun(runoutTo('run5', deep, [unit, main, deep]), { settings, scene: [unit, main, deep] })!;
    expect(deepPlan.issues.find((issue) => issue.code === 'DU_FLEX_DROP')?.severity).toBe('info');
  });

  it('rigid duct must meet the spigot square and on its axis', () => {
    const inline = diffuserAt('sd6', along(stubMm + 800, 0), 0);
    const straight = planDuctRun(runoutTo('run6', inline, [unit, main, inline], false), { settings, scene: [unit, main, inline] })!;
    expect(straight.pieces.some((piece) => piece.kind === 'flex')).toBe(false);
    expect(straight.issues.map((issue) => issue.code)).not.toContain('DU_TERMINAL_ALIGN');
    expect(straight.issues.map((issue) => issue.code)).not.toContain('DU_TERMINAL_SIZE');
    // Level, but the last leg comes in at an angle and meets the spigot off its axis.
    const aside = diffuserAt('sd7', along(stubMm + 800, 150), 0);
    const skewed = planDuctRun(runoutTo('run7', aside, [unit, main, aside], false, 200, true), { settings, scene: [unit, main, aside] })!;
    expect(skewed.issues.map((issue) => issue.code)).toContain('DU_TERMINAL_ALIGN');
  });

  it('straps a long runout at ≤ 1.2 m on hanger wire, and lists the flex, bands, straps and the terminal', () => {
    const far = diffuserAt('sd2', along(stubMm + 1800, 900), 200);
    const run = runoutTo('run2', far, [unit, main, far]);
    const farScene = [unit, main, far, run];
    const plan = planDuctRun(run, { settings, scene: farScene })!;
    const flex = plan.pieces.at(-1)!;
    const supports = planDuctSupports(plan, farScene, settings, 3400);
    const straps = supports.hangers.filter((hanger) => hanger.kind === 'strap');
    expect(straps).toHaveLength(Math.ceil(flex.lengthMm / 1200) - 1);
    expect(straps[0]!.rods[0]!.lengthMm).toBeGreaterThan(0);
    const bom = buildDuctBom([plan], [supports], farScene);
    const describe = (row: { description: string; size: string }) => `${row.description} | ${row.size}`;
    const rows = bom.map(describe);
    expect(rows).toContain('Flexible duct, non-metallic, insulated (NM-IL) | Ø200');
    expect(bom.find((row) => row.description.startsWith('Flexible duct'))!.quantity).toBeCloseTo(Math.round(flex.lengthMm / 10) / 100, 2);
    expect(bom.find((row) => row.description === 'Draw band (flex core)')!.quantity).toBe(2);
    expect(bom.find((row) => row.description === 'Draw band (flex jacket)')!.size).toBe('Ø250');
    expect(bom.some((row) => row.category === 'Supports' && row.description === 'Flex duct strap 40 mm')).toBe(true);
    expect(bom.filter((row) => row.category === 'Air terminals')).toHaveLength(1);
    const wired = planDuctSupports(plan, farScene, resolveDuctSettings({ soffitMm: 3400, terminalHangerWires: true }), 3400);
    expect(wired.terminalWires).toEqual([{ terminalId: 'sd2', count: 2, lengthMm: 3400 - (far.elevation + far.height) }]);
  });

  it('a moved terminal pulls its runout along; a deleted one leaves the run open', () => {
    const moved = { ...near, position: { x: near.position.x + 300, y: near.position.y + 200 } };
    const after = scene.map((element) => (element.id === near.id ? moved : element));
    const followed = followDuctsForUnitMove(scene, after, [near.id], settings);
    expect(followed.map((element) => element.id)).toEqual(['run1']);
    const last = readDuctRunSpec(followed[0]!)!.path.at(-1)!;
    const port = terminalSpigotPort(moved)!;
    expect(last).toEqual({ x: port.lip.x, y: port.lip.y, z: port.lip.z - 100 });
    const replanned = planDuctRun(followed[0]!, { settings, scene: after.map((element) => (element.id === 'run1' ? followed[0]! : element)) })!;
    expect(replanned.issues.map((issue) => issue.code)).not.toContain('DU_STALE');
    const kept = expandDuctDeletion(scene, new Set([near.id]));
    const orphan = kept.find((element) => element.id === 'run1')!;
    const orphanSpec = readDuctRunSpec(orphan)!;
    expect(orphanSpec.end).toEqual({ kind: 'open', orphaned: true });
    // The runout went with the diffuser: the collar stub is left, open.
    expect(orphanSpec.path).toHaveLength(readDuctRunSpec(nearRun)!.path.length - 1);
    const orphanPlan = planDuctRun(orphan, { settings, scene: kept })!;
    expect(orphanPlan.pieces.map((piece) => piece.kind)).toEqual(['takeoff', 'damper']);
    expect(orphanPlan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(orphanPlan.issues.find((issue) => issue.code === 'DU_OPEN_END')?.severity).toBe('warning');
  });

  it('terminal boxes join the clash check, except against the run that serves them', () => {
    const body = terminalBoxOf(near)!;
    expect(body.halfHeight).toBe(150);
    expect(findDuctClashes(scene, settings, []).filter((clash) => clash.otherId === near.id)).toEqual([]);
    // A second supply run straight through the diffuser's box.
    const centre = body.centre;
    const through = buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: centre.x - 1500, y: centre.y }, bottomZ: centre.z - 100, service: 'supply' },
      points: [{ x: centre.x + 1500, y: centre.y }], legSizes: [{ widthMm: 300, heightMm: 200 }],
    }, 'through');
    const clashes = findDuctClashes([...scene, through], settings, []);
    expect(clashes).toEqual(expect.arrayContaining([expect.objectContaining({ ductId: 'through', otherId: near.id, kind: 'terminal' })]));
  });

  it('draws the runout with its tag in plan, and a corrugated flex in 3D', () => {
    const plan = planDuctRun(nearRun, { settings, scene })!;
    const presentation = buildDuctPlanPresentation(plan);
    expect(presentation.tags.some((tag) => /^FLEX Ø200 · \d\.\d\d m · insulated$/.test(tag.text))).toBe(true);
    expect(presentation.jointTicks.every((tick) => tick.kind !== 'flex-connection' && tick.kind !== 'terminal-connection')).toBe(true);
    const group = new THREE.Group();
    addDuctRunMeshes(group, nearRun, { allElements: scene, ductSettings: resolveDuctSettings({ showSupports: false }) });
    const flexMesh = group.getObjectByName('duct-flex') as THREE.Mesh | undefined;
    expect(flexMesh).toBeDefined();
    const bounds = new THREE.Box3().setFromObject(flexMesh!);
    expect(bounds.isEmpty()).toBe(false);
  });
});
