/**
 * A run's runout onto its air terminal, made flexible or rigid: the rigid
 * route kept to where a flexible runout leaves it, or spiral duct arriving as
 * the planner asks of a rigid end (level, square to a side collar and on its
 * axis; straight down onto a top collar). Shared by the segment card's edits
 * and by moves, which re-make a rigid runout their legs cannot stretch to.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { findAirPort, type DuctAirPort } from './ductAirPorts';
import { errorCodes, noNewErrors } from './ductBranchReaim';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { branchAnchor, startAnchor } from './ductFollow';
import { cross, dot } from './ductGeometry';
import { ductParentOf } from './ductNetwork';
import { sameSectionSize } from './ductSectionEquivalents';
import type { DuctDesignSettings } from './ductSettings';
import { findTerminalPort } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctLeg, type DuctPoint3, type DuctRunSpec } from './ductTypes';

const unitOf = (a: Point2D): Point2D => {
  const size = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / size, y: a.y / size };
};
const add2 = (a: Point2D, b: Point2D, k = 1): Point2D => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub2 = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
const at = (point: Point2D, z: number): DuctPoint3 => ({ x: point.x, y: point.y, z });

/** s·a + t·b = c, or null when a ∥ b. */
function solve2(a: Point2D, b: Point2D, c: Point2D): { s: number; t: number } | null {
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;
  return { s: (c.x * b.y - c.y * b.x) / det, t: (a.x * c.y - a.y * c.x) / det };
}

export type TerminalEnd = Extract<DuctRunSpec['end'], { kind: 'terminal' }>;

/** Straights tried before the spigot for a rigid runout's drop (on its axis, at the run's level), shortest first (mm). */
const RIGID_APPROACH_MM = [150, 300, 500, 800, 1200];
/**
 * Straights tried between a jog onto the spigot's axis and what follows it,
 * longest first: jogging early leaves a straight on the axis that a flexible
 * runout can later take over (FLEX_RUNOUT_MM and its 300 mm behind it) (mm).
 */
const JOG_RUN_MM = [1100, 800, 500, 300];
/** Where a flexible runout leaves rigid duct that runs straight into the spigot: this far before it (the auto layout's first target; mm). */
const FLEX_RUNOUT_MM = 800;

/** The plan direction a run leaves its start in: its fitting's (a take-off's, a collar's), else its first leg's. */
function leavingDirection(scene: readonly HvacElement[], settings: DuctDesignSettings, spec: DuctRunSpec): Point2D | null {
  if (spec.start.kind === 'unit-port') return findAirPort(scene, spec.start.unitId, spec.start.portId)?.normal ?? null;
  const parent = ductParentOf(spec, scene);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  return (parentSpec ? branchAnchor(parentSpec, spec, settings)?.direction : null) ?? startAnchor(spec)?.direction ?? null;
}

/**
 * The run with a flexible runout: the rigid route kept to the top of its drop
 * onto the spigot (or to its last vertex), the flexible duct leaving about
 * FLEX_RUNOUT_MM before the spigot where a level leg heads straight at it —
 * long enough to bend gently onto the spigot, short as SMACNA S3.23 asks —
 * leaving room behind it for the fitting the leg starts at. With a scene, the
 * first of those that plans without a rule the run did not already break
 * (else the first).
 */
export function withFlexRunout(
  spec: DuctRunSpec, end: TerminalEnd, neck: number, settings: DuctDesignSettings, check?: { scene: readonly HvacElement[]; runId: string },
): DuctRunSpec {
  const path = spec.path;
  const lip = path[path.length - 1]!;
  let keep = path.length - 2;
  const vertical = (index: number) => Math.hypot(path[index]!.x - path[index - 1]!.x, path[index]!.y - path[index - 1]!.y) < 1 && Math.abs(path[index]!.z - path[index - 1]!.z) > 1;
  const dropped = keep >= 1 && vertical(keep);
  if (dropped) keep -= 1;
  const room = (index: number) => (index === 0 ? settings.tapCollarMm + settings.vcdLengthMm + 150 : 300);
  /** Where on leg `index` (level, heading at the lip) the runout leaves; null to leave from the leg's end. */
  const leave = (index: number, upTo: (length: number) => number): DuctPoint3 | null => {
    const from = path[index]!;
    const to = path[index + 1]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length < 1 || Math.abs(to.z - from.z) > 1) return null;
    const d = unitOf(sub2(to, from));
    if (Math.abs(cross(sub2(lip, from), d)) > 1 || dot(sub2(lip, from), d) <= 0) return null;
    const station = Math.min(Math.max(dot(sub2(lip, from), d) - FLEX_RUNOUT_MM, room(index)), upTo(length));
    return station > 1 && station < length - 1 ? at(add2(from, d, station), from.z) : null;
  };
  const runout = roundLeg(neck);
  const overridesUpTo = (last: number) => Object.fromEntries(Object.entries(spec.nodeOverrides).filter(([node]) => Number(node) <= last));
  const cutAt = (index: number, point: DuctPoint3): DuctRunSpec => keepInlineOnLegs({
    ...spec, path: [...path.slice(0, index + 1), point, lip], legs: [...spec.legs.slice(0, index + 1), runout], nodeOverrides: overridesUpTo(index), end: { ...end, flex: true },
  }, (leg) => (leg <= index ? leg : null));
  const fromVertex = (index: number): DuctRunSpec => keepInlineOnLegs({
    ...spec, path: [...path.slice(0, index + 1), lip], legs: [...spec.legs.slice(0, index), runout], nodeOverrides: overridesUpTo(index - 1), end: { ...end, flex: true },
  }, (leg) => (leg < index ? leg : null));
  const candidates: DuctRunSpec[] = [];
  // The last leg itself, level into the spigot (300 mm of flexible duct at the least) …
  const into = !dropped ? leave(keep, (length) => length - 300) : null;
  if (into) candidates.push(cutAt(keep, into));
  // … the leg before the drop, heading along the spigot's axis …
  const before = keep >= 1 ? leave(keep - 1, (length) => length) : null;
  if (before) candidates.push(cutAt(keep - 1, before));
  // … else from the end of the rigid route, or the vertex before it on the same level.
  candidates.push(fromVertex(keep));
  if (keep >= 1 && Math.abs(path[keep - 1]!.z - path[keep]!.z) <= 1) candidates.push(fromVertex(keep - 1));
  if (!check || candidates.length === 1) return candidates[0]!;
  const baseline = errorCodes(planDuctRunSpec(check.runId, spec, { settings, scene: check.scene }));
  return candidates.find((candidate) => noNewErrors(baseline, errorCodes(planDuctRunSpec(check.runId, candidate, { settings, scene: check.scene })))) ?? candidates[0]!;
}

/**
 * The run with a rigid runout onto the spigot, arriving as the planner asks of
 * a rigid end: level, square to the spigot and on its axis, at its height.
 * Routes are tried with the fewest new fittings first — straight on (the
 * run's last leg already on the spigot's axis), one turn onto the axis, a jog
 * onto it (the last leg parallel to it) — each with the shortest straights
 * that plan without a rule the run did not already break. A spigot above or
 * below the run is reached by a drop on its axis: two elbows, or an offset
 * where the drop is short (the planner's choice). Why not, when none fits.
 */
export function withRigidRunout(
  scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, spec: DuctRunSpec, end: TerminalEnd, port: DuctAirPort, neck: number,
): DuctRunSpec | string {
  const runout = roundLeg(neck);
  const lip: DuctPoint3 = { x: port.lip.x, y: port.lip.y, z: port.lip.z - neck / 2 };
  const rigid = spec.path.slice(0, -1);
  const last = rigid[rigid.length - 1]!;
  const before = rigid.length >= 2 ? rigid[rigid.length - 2]! : null;
  if (before && Math.abs(last.z - before.z) > 1) return 'the run reaches its runout down a riser; draw the rigid runout by hand';
  const into = unitOf({ x: -port.normal.x, y: -port.normal.y });
  const e = before ? unitOf(sub2(last, before)) : leavingDirection(scene, settings, spec);
  if (!e) return 'the run has no direction to leave in';
  const base = before ? rigid.slice(0, -1) : rigid;
  const from = base[base.length - 1]!;
  const baseLegs = spec.legs.slice(0, base.length - 1);
  const lastSection = before ? spec.legs[rigid.length - 2]! : runout;
  const reduce = !sameSectionSize(lastSection, runout);
  const level = last.z;
  const drop = Math.abs(level - lip.z) > 1;
  const nodeOverrides = Object.fromEntries(Object.entries(spec.nodeOverrides).filter(([node]) => Number(node) < base.length));
  const baseline = errorCodes(planDuctRunSpec(runId, spec, { settings, scene }));
  const accept = (points: DuctPoint3[], legs: DuctLeg[]): DuctRunSpec | null => {
    // Every rigid leg keeps its start and heading (the last one runs on, or to a new corner): their accessories stay.
    const candidate: DuctRunSpec = keepInlineOnLegs({ ...spec, path: [...base, ...points], legs: [...baseLegs, ...legs], nodeOverrides, end: { ...end, flex: false } },
      (leg) => (before && leg <= base.length - 1 ? leg : null));
    return noNewErrors(baseline, errorCodes(planDuctRunSpec(runId, candidate, { settings, scene }))) ? candidate : null;
  };
  if (port.vertical) {
    // Onto a top collar: the level duct runs on to above it, an elbow turns it down, and it drops onto the collar.
    if (level < lip.z + neck) return 'the duct runs too low to drop onto a top collar (run it higher, or use a side collar)';
    const above = at(lip, level);
    const r = sub2(lip, from);
    const along = dot(r, e);
    if (along <= 0) return 'the top collar is behind the run';
    const beside = { x: r.x - e.x * along, y: r.y - e.y * along };
    const off = Math.hypot(beside.x, beside.y);
    const lastAlong = before ? dot(sub2(last, from), e) : 0;
    /** Stations along the run (from `from`) where the reducer may go, before it leaves its line `leaves` along. */
    const reducers = (leaves: number) => (reduce
      ? [...(lastAlong > 1 && leaves - lastAlong > 1 ? [lastAlong] : []), ...RIGID_APPROACH_MM.map((approach) => leaves - approach)]
        .filter((station) => station > 1 && leaves - station > 1)
      : []);
    // The routes, fewest new fittings first, each with the station where it leaves the run's line: on the line, on to
    // above the collar and down; beside it, on to abeam it, across to above it and down — else (a step too short for
    // two square turns) a 45° offset onto the collar's line and on to above it.
    const routes: Array<{ leaves: number; points: DuctPoint3[] }> = off < 1
      ? [{ leaves: along, points: [above, lip] }]
      : [
        { leaves: along, points: [at(add2(from, e, along), level), above, lip] },
        ...RIGID_APPROACH_MM.map((approach) => along - off - approach).filter((leaves) => leaves > 1).map((leaves) => {
          const o1 = add2(from, e, leaves);
          return { leaves, points: [at(o1, level), at(add2(add2(o1, e, off), beside), level), above, lip] };
        }),
      ];
    for (const route of routes) {
      const legs = route.points.map(() => runout);
      // A larger duct reduces on the level first: at its last vertex, else a straight back from where it leaves its line …
      for (const station of reducers(route.leaves)) {
        const found = accept([at(add2(from, e, station), level), ...route.points], [lastSection, ...legs]);
        if (found) return found;
      }
      // … or (no room for that, or nothing to reduce) at its first fitting.
      const found = accept(route.points, [lastSection, ...legs.slice(1)]);
      if (found) return found;
    }
    return 'no level route turns down onto the top collar here (keep the runout flexible, or move the terminal)';
  }
  // From a point on the spigot's axis at the run's level: down (or up) to its height, then in; level: straight in.
  const approaches = drop ? RIGID_APPROACH_MM : [0];
  const tail = (approach: number) => {
    const a = add2(lip, port.normal, approach);
    return drop ? { a, points: [at(a, level), at(a, lip.z), lip], legs: [runout, runout, runout] } : { a, points: [lip], legs: [runout] };
  };
  const onAxis = (point: Point2D) => Math.abs(cross(sub2(point, lip), into)) < 1;
  const parallel = dot(e, into) > 0.9999;
  // 1. Straight on: the last leg already on the spigot's axis, heading into it (a reducer where it was larger).
  if (parallel && onAxis(last)) {
    for (const approach of approaches) {
      const { a, points, legs } = tail(approach);
      if (dot(sub2(a, reduce ? last : from), into) < 1) continue;
      const found = reduce ? accept([at(last, level), ...points], [lastSection, ...legs]) : accept(points, legs);
      if (found) return found;
    }
  }
  // 2. One turn: off the last leg's line onto the spigot's axis.
  const hit = !parallel ? solve2(e, into, sub2(lip, from)) : null;
  if (hit && hit.s > 1 && hit.t > 1) {
    const corner = at(add2(from, e, hit.s), level);
    for (const approach of approaches) {
      if (hit.t - approach < 1) break;
      const { points, legs } = tail(approach);
      const found = accept([corner, ...points], [lastSection, ...legs]);
      if (found) return found;
    }
  }
  // 3. A jog onto the axis: the last leg parallel to it, beside it.
  if (parallel && !onAxis(last)) {
    const r = sub2(lip, from);
    const along = dot(r, into);
    const beside = { x: r.x - into.x * along, y: r.y - into.y * along };
    for (const approach of approaches) {
      for (const straight of JOG_RUN_MM) {
        const { a, points, legs } = tail(approach);
        const j2 = add2(a, port.normal, straight);
        const j1 = sub2(j2, beside);
        if (dot(sub2(j1, from), e) < 1) continue;
        const found = accept([at(j1, level), at(j2, level), ...points], [lastSection, runout, ...legs]);
        if (found) return found;
      }
    }
  }
  return dot(e, into) < -1e-6 || (hit !== null && hit.t <= 1) ? 'its spigot faces away from the run (turn the terminal\'s spigot, or keep the runout flexible)'
    : 'no rigid route fits between the run and the spigot (keep the runout flexible, or move the terminal)';
}

/**
 * A run's accessories on the legs it keeps after its path changed: `legOf`
 * maps an old leg to its new index, null where the leg went (and its
 * accessories with it).
 */
export function keepInlineOnLegs(spec: DuctRunSpec, legOf: (legIndex: number) => number | null): DuctRunSpec {
  if (!spec.inline?.length) return spec;
  const { inline, ...rest } = spec;
  const kept = inline.flatMap((item) => {
    const legIndex = legOf(item.legIndex);
    return legIndex === null ? [] : [{ ...item, legIndex }];
  });
  return kept.length ? { ...rest, inline: kept } : rest;
}

/** Level vertices a re-made rigid runout may give up behind where a flexible one would leave the route. */
const REMAKE_BACK_VERTICES = 2;

/**
 * A run's rigid runout re-made onto its terminal's spigot where it now is (a
 * moved or reshaped terminal): the route kept to where a flexible runout would
 * leave it, then straight on, a turn or a jog onto the spigot — the fewest new
 * fittings that break no rule the run did not already break. Where none fits,
 * the route kept to a level vertex further back (room for its reducer and an
 * offset). Null when the run's runout is flexible, its terminal is gone, or no
 * rigid route fits.
 */
export function remadeRigidRunout(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, spec: DuctRunSpec): DuctRunSpec | null {
  const end = spec.end;
  if (end.kind !== 'terminal' || end.flex) return null;
  const port = findTerminalPort(scene, end.terminalId, end.portId);
  if (!port) return null;
  const neck = port.diameterMm ?? spec.legs[spec.legs.length - 1]!.diameterMm ?? 200;
  const onSpigot: DuctRunSpec = { ...spec, path: [...spec.path.slice(0, -1), { x: port.lip.x, y: port.lip.y, z: port.lip.z - neck / 2 }] };
  let kept = withFlexRunout(onSpigot, end, neck, settings);
  for (let back = 0; ; back += 1) {
    const rigid = withRigidRunout(scene, settings, runId, kept, end, port, neck);
    if (typeof rigid !== 'string') return rigid;
    // The route kept to the vertex before its last rigid one, where both are on one level (not past its start).
    const path = kept.path;
    const last = path.length - 2;
    if (back >= REMAKE_BACK_VERTICES || last < 2 || Math.abs(path[last]!.z - path[last - 1]!.z) > 1) return null;
    kept = keepInlineOnLegs({
      ...kept, path: [...path.slice(0, last), path[path.length - 1]!], legs: [...kept.legs.slice(0, last - 1), roundLeg(neck)],
      nodeOverrides: Object.fromEntries(Object.entries(kept.nodeOverrides).filter(([node]) => Number(node) < last - 1)),
    }, (leg) => (leg < last - 1 ? leg : null));
  }
}
