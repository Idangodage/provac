import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { spigotOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { FLEX_RULES, FLEX_STRAIGHT_LEAD_MM, flexCurve, flexPointAt, flexSupportStations, saggedFlexPoints } from './ductFlex';
import { followDuctsForUnitMove } from './ductFollow';
import { expandDuctDeletion } from './ductNetwork';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import { planDuctSupports } from './ductSupports';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctPoint3 } from './ductTypes';
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

/** The runout model before 23 October 2026, kept here as the reference: one cubic Bezier between the leads, handles 0.4 of the chord. */
function curveBefore(start: DuctPoint3, startDirection: DuctPoint3, end: DuctPoint3, endDirection: DuctPoint3) {
  const unit = (a: DuctPoint3) => {
    const length = Math.hypot(a.x, a.y, a.z);
    return { x: a.x / length, y: a.y / length, z: a.z / length };
  };
  const d0 = unit(startDirection);
  const d1 = unit(endDirection);
  const p0 = { x: start.x + d0.x * FLEX_STRAIGHT_LEAD_MM, y: start.y + d0.y * FLEX_STRAIGHT_LEAD_MM, z: start.z + d0.z * FLEX_STRAIGHT_LEAD_MM };
  const p3 = { x: end.x - d1.x * FLEX_STRAIGHT_LEAD_MM, y: end.y - d1.y * FLEX_STRAIGHT_LEAD_MM, z: end.z - d1.z * FLEX_STRAIGHT_LEAD_MM };
  const handle = Math.max(1, 0.4 * Math.hypot(p3.x - p0.x, p3.y - p0.y, p3.z - p0.z));
  const p1 = { x: p0.x + d0.x * handle, y: p0.y + d0.y * handle, z: p0.z + d0.z * handle };
  const p2 = { x: p3.x - d1.x * handle, y: p3.y - d1.y * handle, z: p3.z - d1.z * handle };
  const points = [start];
  for (let index = 0; index <= 32; index += 1) {
    const t = index / 32;
    const u = 1 - t;
    const mix = (k: 'x' | 'y' | 'z') => (u * u * u * p0[k] + 3 * u * u * t * p1[k]) + (3 * u * t * t * p2[k] + t * t * t * p3[k]);
    points.push({ x: mix('x'), y: mix('y'), z: mix('z') });
  }
  points.push(end);
  return { lengthMm: polylineLength(points), minBendRadiusMm: tightestCircle(points) };
}

function polylineLength(points: readonly DuctPoint3[]): number {
  return points.reduce((sum, point, index) => (index ? sum + Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y, point.z - points[index - 1]!.z) : 0), 0);
}

/** The tightest circle through three samples in a row. */
function tightestCircle(points: readonly DuctPoint3[]): number {
  let tightest = Number.POSITIVE_INFINITY;
  for (let index = 1; index + 1 < points.length; index += 1) {
    const [a, b, c] = [points[index - 1]!, points[index]!, points[index + 1]!];
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const area2 = Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, u.x * v.y - u.y * v.x);
    if (area2 < 1e-9) continue;
    tightest = Math.min(tightest, Math.hypot(u.x, u.y, u.z) * Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z) * Math.hypot(v.x, v.y, v.z) / (2 * area2));
  }
  return tightest;
}

/** The largest turn between one sample's chord and the next (radians). */
function sharpestTurn(points: readonly DuctPoint3[]): number {
  let sharpest = 0;
  for (let index = 1; index + 1 < points.length; index += 1) {
    const [a, b, c] = [points[index - 1]!, points[index]!, points[index + 1]!];
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const lengths = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
    if (lengths < 1e-12) continue;
    sharpest = Math.max(sharpest, Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y + u.z * v.z) / lengths))));
  }
  return sharpest;
}

/** A seeded generator (mulberry32), so a sweep is the same every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('runouts bent as a fitter bends them (23 October 2026)', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const east = { x: 1, y: 0, z: 0 };
  const north = { x: 0, y: 1, z: 0 };
  const down = { x: 0, y: 0, z: -1 };

  it('a turn with unequal legs takes one arc as large as the shorter leg, then runs straight', () => {
    // Leads end at (100, 0) and (400, 800); the lead lines meet at (400, 0): legs 300 and 800.
    const curve = flexCurve(origin, east, { x: 400, y: 900, z: 0 }, north);
    expect(curve.minBendRadiusMm).toBeCloseTo(300, 6);
    expect(curveBefore(origin, east, { x: 400, y: 900, z: 0 }, north).minBendRadiusMm).toBeLessThan(225);
    // The arc about (100, 300), then straight up the far leg.
    for (const point of curve.points.slice(1, -1)) {
      if (point.y <= 300) expect(Math.hypot(point.x - 100, point.y - 300)).toBeCloseTo(300, 6);
      else expect(point.x).toBeCloseTo(400, 6);
    }
    // Lead, quarter arc, straight, lead (the samples' chords fall short of the arc by a fraction of a millimetre).
    expect(curve.lengthMm).toBeCloseTo(100 + (Math.PI / 2) * 300 + 500 + 100, 0);
  });

  it('leads parallel and offset: two equal arcs, an S as large as the offset allows', () => {
    // 900 along, 300 across between the leads: each arc turns 2·atan(1/3), radius 900 / (2 sin) = 750.
    const curve = flexCurve(origin, east, { x: 1100, y: 300, z: 0 }, east);
    expect(curve.minBendRadiusMm).toBeCloseTo(750, 6);
    expect(curveBefore(origin, east, { x: 1100, y: 300, z: 0 }, east).minBendRadiusMm).toBeLessThan(660);
    // Point-symmetric about its middle: half way along it, half way across.
    const middle = flexPointAt(curve, curve.lengthMm / 2);
    expect(middle.x).toBeCloseTo(550, 6);
    expect(middle.y).toBeCloseTo(150, 6);
  });

  it('a top collar straight ahead: the bend is in its vertical plane, as large as the drop allows', () => {
    // Leads end at (100, 0, 0) and (600, 0, −200): legs 500 across and 200 down.
    const curve = flexCurve(origin, east, { x: 600, y: 0, z: -300 }, down);
    expect(curve.minBendRadiusMm).toBeCloseTo(200, 6);
    expect(curveBefore(origin, east, { x: 600, y: 0, z: -300 }, down).minBendRadiusMm).toBeLessThan(150);
    expect(curve.points.every((point) => Math.abs(point.y) < 1e-9)).toBe(true);
  });

  it('a turn with a drop bends twice in tilted planes with a sloped straight between, and never climbs', () => {
    const end = { x: 350, y: 350, z: -200 };
    const curve = flexCurve(origin, east, end, north);
    const before = curveBefore(origin, east, end, north);
    expect(curve.minBendRadiusMm).toBeGreaterThan(before.minBendRadiusMm + 30);
    expect(curve.points.every((point, index) => index === 0 || point.z <= curve.points[index - 1]!.z + 1e-9)).toBe(true);
    // Level where it meets each collar.
    expect(curve.points[1]!.z).toBe(0);
    expect(curve.points.at(-2)!.z).toBeCloseTo(-200, 9);
  });

  it('a spigot facing away (a turn over 90°, a U-turn) keeps the earlier curve: bent round, the runout would pass its face', () => {
    const southWest = { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 };
    for (const [end, endDirection] of [[{ x: 1000, y: 600, z: 0 }, { x: -1, y: 0, z: 0 }], [{ x: 600, y: 700, z: -150 }, southWest]] as const) {
      const curve = flexCurve(origin, east, end, endDirection);
      const before = curveBefore(origin, east, end, endDirection);
      expect(curve.minBendRadiusMm).toBe(before.minBendRadiusMm);
      expect(curve.lengthMm).toBe(before.lengthMm);
    }
  });

  it('never bends tighter than before, over thousands of runouts; turns to 90° and offsets stay within 5% of their length', () => {
    const random = seeded(20261023);
    const ratios: number[] = [];
    for (let index = 0; index < 4000; index += 1) {
      const anyWay = index % 2 === 0;
      const angle0 = random() * 2 * Math.PI;
      const startDirection = !anyWay || random() < 0.8 ? { x: Math.cos(angle0), y: Math.sin(angle0), z: 0 } : { x: 0, y: 0, z: random() < 0.5 ? -1 : 1 };
      let end: DuctPoint3;
      let endDirection: DuctPoint3;
      if (anyWay) {
        // Anywhere, any way in: behind the collar, U-turns, top collars.
        end = { x: (random() * 2 - 1) * 1500, y: (random() * 2 - 1) * 1500, z: random() < 0.4 ? 0 : random() * 900 - 600 };
        const angle1 = random() * 2 * Math.PI;
        endDirection = random() < 0.75 ? { x: Math.cos(angle1), y: Math.sin(angle1), z: 0 } : down;
      } else {
        // As runouts are drawn: ahead of the collar, turning up to 90° (or not at all), level or dropping.
        const along = 200 + random() * 1300;
        const across = (random() * 1.2 - 0.1) * 1300;
        const turn = random() < 0.3 ? 0 : random() * (Math.PI / 2);
        const heading = { x: Math.cos(turn), y: Math.sin(turn) };
        const forward = { x: startDirection.x, y: startDirection.y };
        const side = { x: -forward.y, y: forward.x };
        end = { x: forward.x * along + side.x * across, y: forward.y * along + side.y * across, z: random() < 0.5 ? 0 : -random() * 500 };
        endDirection = { x: forward.x * heading.x + side.x * heading.y, y: forward.y * heading.x + side.y * heading.y, z: 0 };
      }
      const curve = flexCurve(origin, startDirection, end, endDirection);
      const before = curveBefore(origin, startDirection, end, endDirection);
      expect(curve.minBendRadiusMm, `runout ${index}`).toBeGreaterThanOrEqual(before.minBendRadiusMm * (1 - 1e-12));
      // On the collars exactly, straight for the leads.
      const points = curve.points;
      expect(points[0]).toEqual(origin);
      expect(points.at(-1)).toEqual(end);
      expect(Math.hypot(points[1]!.x - startDirection.x * FLEX_STRAIGHT_LEAD_MM, points[1]!.y - startDirection.y * FLEX_STRAIGHT_LEAD_MM, points[1]!.z - startDirection.z * FLEX_STRAIGHT_LEAD_MM)).toBeLessThan(1e-9);
      const length = Math.hypot(endDirection.x, endDirection.y, endDirection.z);
      const leadStart = { x: end.x - (endDirection.x / length) * FLEX_STRAIGHT_LEAD_MM, y: end.y - (endDirection.y / length) * FLEX_STRAIGHT_LEAD_MM, z: end.z - (endDirection.z / length) * FLEX_STRAIGHT_LEAD_MM };
      expect(Math.hypot(points.at(-2)!.x - leadStart.x, points.at(-2)!.y - leadStart.y, points.at(-2)!.z - leadStart.z)).toBeLessThan(1e-6);
      // The radius it reports is the samples' own (never kinder than what is drawn); the stations add up.
      expect(tightestCircle(points)).toBeGreaterThanOrEqual(curve.minBendRadiusMm * (1 - 1e-6));
      expect(curve.lengthMm).toBeCloseTo(polylineLength(points), 6);
      const bent = Math.abs(curve.lengthMm - before.lengthMm) > 1e-9 || Math.abs(curve.minBendRadiusMm - before.minBendRadiusMm) > 1e-9;
      const into = { x: endDirection.x / length, y: endDirection.y / length, z: endDirection.z / length };
      if (bent) {
        // Smooth, and heading on toward the spigot all the way: never past the lead's start, so never its face.
        expect(sharpestTurn(points), `runout ${index}`).toBeLessThan((5.05 * Math.PI) / 180);
        const pastLead = (point: DuctPoint3) => (point.x - leadStart.x) * into.x + (point.y - leadStart.y) * into.y + (point.z - leadStart.z) * into.z;
        expect(Math.max(...points.slice(0, -1).map(pastLead)), `runout ${index}`).toBeLessThan(1e-6);
      }
      // A spigot facing away keeps the earlier curve.
      if (startDirection.x * into.x + startDirection.y * into.y + startDirection.z * into.z < -1e-6) expect(bent, `runout ${index}`).toBe(false);
      if (!anyWay) ratios.push(curve.lengthMm / before.lengthMm);
    }
    expect(Math.min(...ratios)).toBeGreaterThan(0.95);
    expect(Math.max(...ratios)).toBeLessThan(1.05);
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
