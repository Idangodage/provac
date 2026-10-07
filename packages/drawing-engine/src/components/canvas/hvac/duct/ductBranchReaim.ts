/**
 * Re-aiming a branch whose fitting now leaves its parent at another angle —
 * a 45° lateral becoming a 90° tee (or back), a Y or bullhead becoming a wye.
 * Moving the branch rigidly would swing its whole route off its terminal, so
 * instead its start moves onto the new fitting, leaves at its angle, and the
 * route rejoins the old one as soon as it can: the rest of the branch and the
 * terminal at its end stay where they are. Candidates, cheapest first:
 *
 *  1. straight on: the take-off slides along its main until the new first
 *     leg runs straight into a later leg of the route (a lateral with its 45°
 *     elbow becoming a tee: the elbow goes);
 *  2. one turn: the new first leg meets a later leg — or the old first leg's
 *     line — at a new elbow;
 *  3. one turn, sliding: as 2, the take-off sliding just far enough;
 *  4. a stub turning onto a flexible runout, which re-curves to its terminal;
 *  5. two turns: a short stub at the new angle, then a leg parallel to an old
 *     one meeting the route's next leg at a new elbow (a wye's 45° outlets
 *     replacing a Y's square ones);
 *  6. onto a flexible runout, back on its old heading: the take-off slides so
 *     a new elbow turns the stub onto the line it ran on (a lateral and its
 *     45° elbow), the runout re-curving from the stub's end.
 *
 * Each candidate is planned with its parent; the first that breaks no rule
 * the branch (or its parent) did not already break is taken. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { getDuctRunPlan, planDuctRunSpec } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec, startAnchor } from './ductFollow';
import { cross, dot, ductLegs } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import type { DuctDesignSettings } from './ductSettings';
import type { DuctLeg, DuctNodeOverride, DuctPoint3, DuctRunSpec } from './ductTypes';

export interface DuctReaim {
  spec: DuctRunSpec;
  /** How far the take-off slid along its main (mm; 0 at a split). */
  slideMm: number;
  /** What happened to the route, in the designer's words. */
  note: string;
  /** Take-offs off this branch, renumbered onto its kept legs. */
  subBranches: HvacElement[];
}

interface Candidate {
  /** New plan points from the start (the first is the new anchor). */
  prefix: Point2D[];
  /** The first retained rigid vertex (index into the old rigid path). */
  keepFrom: number;
  /** The old leg the last new leg runs on (its section carries on); -1 = the first leg's section. */
  joinLeg: number;
  slideMm: number;
  cost: number;
  note: string;
}

const LEVEL_EPSILON_MM = 0.5;
/** Straight kept between neighbouring fittings for their joints (mm). */
const MARGIN_MM = 50;
/** A new elbow costs this many mm of sliding (fewer fittings: less loss, less to make). */
const ELBOW_COST = 300;

function solve2(a: Point2D, b: Point2D, c: Point2D): { s: number; t: number } | null {
  // s·a + t·b = c
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;
  return { s: (c.x * b.y - c.y * b.x) / det, t: (a.x * c.y - a.y * c.x) / det };
}

const add = (a: Point2D, b: Point2D, k = 1): Point2D => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });

/** A plan's errors, counted by code. */
export function errorCodes(plan: { issues: ReadonlyArray<{ severity: string; code: string }> } | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of plan?.issues ?? []) if (issue.severity === 'error') counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  return counts;
}

/** Whether `after` has no more errors of any code than `before`. */
export function noNewErrors(before: Map<string, number>, after: Map<string, number>): boolean {
  for (const [code, count] of after) if (count > (before.get(code) ?? 0)) return false;
  return true;
}

/**
 * Re-aim `branch` (whose spec already names its new fitting: a tap style, a
 * split outlet of the parent's new split) on `parent` as it now is. `scene`
 * holds the drawing with the parent's new version in place. Null when no
 * route keeps the branch's end without breaking a rule.
 */
export function reaimBranch(
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  parent: HvacElement,
  parentSpec: DuctRunSpec,
  branch: HvacElement,
  spec: DuctRunSpec,
): DuctReaim | null {
  const start = spec.start;
  if (start.kind !== 'tap' && start.kind !== 'split-branch') return null;
  const from = startAnchor(spec);
  const to = branchAnchor(parentSpec, spec, settings);
  if (!from || !to) return null;
  const flexTail = spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 3;
  const rigid = flexTail ? spec.path.slice(0, -1) : spec.path;
  const lip = flexTail ? spec.path[spec.path.length - 1]! : null;
  // (A level change below a micron is rounding, not a move.)
  const dz = Math.abs(to.z - from.z) < 1e-6 ? 0 : to.z - from.z;
  const d = to.direction;
  const first = spec.legs[0]!;
  const width = first.diameterMm ?? first.widthMm;
  // An elbow takes R·tan(θ/2) of each leg, plus its neck (R = 1.5 W, SMACNA RE1 / Table 3-1).
  const setback = (from: Point2D, to2: Point2D) => {
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(from, to2))));
    return 1.5 * width * Math.tan(angle / 2) + settings.elbowNeckMm;
  };
  const collar = (start.kind === 'tap' ? settings.tapCollarMm : 0) + (start.vcd ? settings.vcdLengthMm : 0);
  const legs = ductLegs({ ...spec, path: rigid, legs: spec.legs.slice(0, rigid.length - 1) });
  const level = (index: number) => {
    const leg = legs[index];
    return Boolean(leg) && !leg!.vertical && Math.abs(leg!.end.z - leg!.start.z) < LEVEL_EPSILON_MM && leg!.lengthMm > 1;
  };
  /** Room the fitting at the far end of leg k takes of it (an elbow, a runout's start, nothing at a cap). */
  const endRoom = (k: number) => (k + 1 < legs.length ? setback(legs[k]!.direction, legs[k + 1]!.direction) + MARGIN_MM : flexTail ? 100 : 0);
  const isTap = start.kind === 'tap';
  const main = isTap ? ductLegs(parentSpec)[start.legIndex] : undefined;
  const m = main?.direction ?? null;
  const candidates: Candidate[] = [];

  // 1. Straight on: slide until the new first leg lines up with a later leg (the elbows before it go).
  for (let k = 1; k < legs.length; k += 1) {
    if (!level(k)) continue;
    const e = legs[k]!.direction;
    if (dot(e, d) < 0.9999) continue;
    const offset = cross(sub(to.point, legs[k]!.start), e);
    let slide = 0;
    if (Math.abs(offset) > 0.5) {
      if (!m || Math.abs(cross(m, e)) < 1e-6) continue;
      slide = -offset / cross(m, e);
    }
    const anchor = m ? add(to.point, m, slide) : to.point;
    const run = dot(sub(legs[k]!.end, anchor), e);
    if (run < collar + endRoom(k)) continue;
    candidates.push({ prefix: [anchor], keepFrom: k + 1, joinLeg: k, slideMm: slide, cost: Math.abs(slide) * 0.05,
      note: `it runs straight off its new fitting into its route${Math.abs(slide) > 0.5 ? `, the take-off sliding ${Math.round(Math.abs(slide))} mm along the main` : ''}` });
  }

  // 2. One turn: the new first leg meets the line of leg k (k = 0: the old first leg's) at a new elbow; the vertices before go.
  for (let k = 0; k < legs.length; k += 1) {
    if (!level(k)) continue;
    const e = legs[k]!.direction;
    if (Math.abs(cross(d, e)) < 1e-3 || dot(d, e) < -1e-6) continue;
    const hit = solve2(d, { x: -e.x, y: -e.y }, sub(legs[k]!.start, to.point));
    if (!hit) continue;
    const t = hit.s;
    const u = hit.t;
    const turn = setback(d, e);
    if (t < collar + turn + MARGIN_MM || legs[k]!.lengthMm - u < turn + endRoom(k)) continue;
    candidates.push({ prefix: [to.point, add(to.point, d, t)], keepFrom: k + 1, joinLeg: k, slideMm: 0, cost: ELBOW_COST + t * 0.001,
      note: 'it leaves at its new angle and turns back onto its route at a new elbow' });
  }

  // 3. One turn, sliding the take-off just far enough for the shortest first leg.
  if (m) {
    for (let k = 0; k < legs.length; k += 1) {
      if (!level(k)) continue;
      const e = legs[k]!.direction;
      if (Math.abs(cross(d, e)) < 1e-3 || dot(d, e) < -1e-6 || Math.abs(cross(m, e)) < 1e-6) continue;
      const turn = setback(d, e);
      let best: Candidate | null = null;
      for (let extra = 0; extra <= 1500; extra += 100) {
        const t = collar + turn + MARGIN_MM + extra;
        const hit = solve2(m, { x: -e.x, y: -e.y }, sub(sub(legs[k]!.start, to.point), { x: d.x * t, y: d.y * t }));
        if (!hit) continue;
        const slide = hit.s;
        const u = hit.t;
        if (legs[k]!.lengthMm - u < turn + endRoom(k)) continue;
        const anchor = add(to.point, m, slide);
        const cost = ELBOW_COST + Math.abs(slide) * 0.05 + t * 0.001;
        if (!best || cost < best.cost) {
          best = { prefix: [anchor, add(anchor, d, t)], keepFrom: k + 1, joinLeg: k, slideMm: slide, cost,
            note: `the take-off slides ${Math.round(Math.abs(slide))} mm along the main; it leaves at its new angle and turns back onto its route at a new elbow` };
        }
      }
      if (best) candidates.push(best);
    }
  }

  // 5. Two turns: a stub at the new angle, then parallel to the old leg j, meeting leg k (k > j) at a new elbow.
  for (let j = 0; j < legs.length; j += 1) {
    if (!level(j)) continue;
    const g = legs[j]!.direction;
    if (Math.abs(cross(d, g)) < 1e-3 || dot(d, g) < -1e-6) continue;
    const first2 = setback(d, g);
    for (let k = j + 1; k < legs.length; k += 1) {
      if (!level(k)) continue;
      const e = legs[k]!.direction;
      if (Math.abs(cross(g, e)) < 1e-3 || dot(g, e) < -1e-6) continue;
      const second = setback(g, e);
      let found: Candidate | null = null;
      for (let extra = 0; extra <= 1200 && !found; extra += 100) {
        const t = collar + first2 + MARGIN_MM + extra;
        const stub = add(to.point, d, t);
        const hit = solve2(g, { x: -e.x, y: -e.y }, sub(legs[k]!.start, stub));
        if (!hit) continue;
        const run = hit.s;
        const u = hit.t;
        if (run < first2 + second + MARGIN_MM || legs[k]!.lengthMm - u < second + endRoom(k)) continue;
        found = { prefix: [to.point, stub, add(stub, g, run)], keepFrom: k + 1, joinLeg: k, slideMm: 0, cost: 2 * ELBOW_COST + t * 0.001,
          note: 'it leaves at its new angle, turns parallel to its old route and meets it at a new elbow' };
      }
      if (found) candidates.push(found);
    }
  }

  // 4. A stub onto a flexible runout: the stub turns with the fitting, the runout re-curves to its terminal.
  if (flexTail && rigid.length === 2) {
    const oldEnd = rigid[1]!;
    const reach = Math.max(collar + 100, dot(sub(oldEnd, to.point), d));
    candidates.push({ prefix: [to.point, add(to.point, d, reach)], keepFrom: rigid.length, joinLeg: -1, slideMm: 0, cost: ELBOW_COST / 3,
      note: 'the stub leaves at its new angle; its flexible runout re-curves to the terminal' });
  }

  // 6. Onto a flexible runout, back on its old heading: the take-off slides so its new first leg meets the line of the
  //    last rigid leg at a new elbow (a lateral and its 45° elbow); that leg runs on at least as far as it did, and the
  //    runout re-curves from its end (the rigid end is free: the flexible duct takes up the difference).
  const lastRigid = legs.length - 1;
  if (flexTail && m && lastRigid >= 0 && level(lastRigid)) {
    const e = legs[lastRigid]!.direction;
    if (Math.abs(cross(d, e)) > 1e-3 && dot(d, e) > -1e-6 && Math.abs(cross(m, e)) > 1e-6) {
      const turn = setback(d, e);
      for (const extra of [0, 100, 200, 400]) {
        const t = collar + turn + MARGIN_MM + extra;
        const hit = solve2(m, { x: -e.x, y: -e.y }, sub(sub(legs[lastRigid]!.start, to.point), { x: d.x * t, y: d.y * t }));
        if (!hit) continue;
        const anchor = add(to.point, m, hit.s);
        const corner = add(anchor, d, t);
        const reach = Math.max(turn + 100, dot(sub(legs[lastRigid]!.end, corner), e));
        // Earlier rigid legs stay only where the new first leg leaves from the first of them (a one-leg stub here).
        if (lastRigid > 0) break;
        candidates.push({ prefix: [anchor, corner, add(corner, e, reach)], keepFrom: rigid.length, joinLeg: -1, slideMm: hit.s,
          cost: ELBOW_COST + Math.abs(hit.s) * 0.05 + t * 0.001,
          note: `the take-off slides ${Math.round(Math.abs(hit.s))} mm along the main; it leaves at its new angle, a new elbow turns it back onto its old heading and its flexible runout re-curves to the terminal` });
      }
    }
  }

  candidates.sort((a, b) => a.cost - b.cost);
  const original = getDuctRunPlan(branch, scene, settings);
  const parentPlan = getDuctRunPlan(parent, scene, settings);
  const before = errorCodes(original);
  const parentBefore = errorCodes(parentPlan);
  const subBranches = ductBranchesOf(branch.id, scene);
  for (const candidate of candidates) {
    const keep = rigid.slice(candidate.keepFrom).map((point) => ({ ...point, z: point.z + dz }));
    const prefix: DuctPoint3[] = candidate.prefix.map((point) => ({ x: point.x, y: point.y, z: to.z }));
    const path = [...prefix, ...keep, ...(lip ? [lip] : [])];
    if (path.length < 2) continue;
    // Sections: the first new leg takes the take-off's (the first leg's); a leg run onto an old one carries its section.
    const newLegCount = prefix.length - 1 + (keep.length > 0 ? 1 : 0);
    const joined = candidate.joinLeg >= 0 ? spec.legs[candidate.joinLeg]! : first;
    const prefixLegs: DuctLeg[] = Array.from({ length: Math.max(0, newLegCount) }, (_, index) => (index === newLegCount - 1 && index > 0 ? joined : first));
    const keptLegs = spec.legs.slice(candidate.keepFrom, rigid.length - 1);
    const flexLeg = flexTail ? [spec.legs[spec.legs.length - 1]!] : [];
    const nextLegs = [...prefixLegs, ...keptLegs, ...flexLeg];
    if (nextLegs.length !== path.length - 1) continue;
    // Elbow choices follow their vertices; take-offs off this branch must sit on a kept leg.
    const shift = prefix.length - candidate.keepFrom;
    const nodeOverrides: Record<string, DuctNodeOverride> = {};
    for (const [node, override] of Object.entries(spec.nodeOverrides)) {
      const index = Number(node);
      if (index >= candidate.keepFrom) nodeOverrides[String(index + shift)] = override;
    }
    // Take-offs off this branch: those on kept legs are renumbered; one on a leg that goes rules the candidate out.
    if (subBranches.some((child) => child.start.kind === 'tap' && child.start.legIndex < candidate.keepFrom)) continue;
    const renumbered = subBranches.flatMap((child) => {
      if (child.start.kind !== 'tap') return [];
      const legIndex = child.start.legIndex - candidate.keepFrom + newLegCount;
      return legIndex === child.start.legIndex ? [] : [ductRunElementWithSpec(child.element, { ...child.spec, start: { ...child.start, legIndex } })];
    });
    const nextStart = isTap && Math.abs(candidate.slideMm) > 1e-6
      // Exact: the new first leg runs straight into the route it joins (a rounded station would bend it by a hair).
      ? { ...start, stationMm: (start as { stationMm: number }).stationMm + candidate.slideMm }
      : start;
    // Accessories on kept legs are renumbered with them; those on legs that go, go.
    const inline = (spec.inline ?? []).flatMap((item) => (item.legIndex >= candidate.keepFrom && item.legIndex < rigid.length - 1
      ? [{ ...item, legIndex: item.legIndex - candidate.keepFrom + newLegCount }] : []));
    const { inline: _inline, ...rest } = spec;
    const next: DuctRunSpec = { ...rest, start: nextStart, path, legs: nextLegs, nodeOverrides, ...(inline.length ? { inline } : {}) };
    const nextBranch = ductRunElementWithSpec(branch, next);
    const replaced = new Map([[branch.id, nextBranch], ...renumbered.map((element) => [element.id, element] as const)]);
    const trial = scene.map((element) => replaced.get(element.id) ?? element);
    const branchPlan = planDuctRunSpec(branch.id, next, { settings, scene: trial });
    const parentTrial = planDuctRunSpec(parent.id, parentSpec, { settings, scene: trial });
    if (!noNewErrors(before, errorCodes(branchPlan)) || !noNewErrors(parentBefore, errorCodes(parentTrial))) continue;
    return { spec: next, slideMm: candidate.slideMm, note: candidate.note, subBranches: renumbered };
  }
  return null;
}

/** Whether a branch's new fitting leaves its parent at another angle than its route does now. */
export function branchTurns(parentSpec: DuctRunSpec, spec: DuctRunSpec, settings: DuctDesignSettings): boolean {
  const from = startAnchor(spec);
  const to = branchAnchor(parentSpec, spec, settings);
  return Boolean(from && to && dot(from.direction, to.direction) < Math.cos(Math.PI / 180));
}

