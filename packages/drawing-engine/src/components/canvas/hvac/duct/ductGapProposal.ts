/**
 * Reconnecting a gap left by deleted pieces: the ways to join what is left,
 * each planned and judged before it is offered.
 *
 *  - The two open ends of a cut (a run in two parts): the stretch as it was,
 *    when it is still clear; the shortest route between the ends that the
 *    orthogonal router finds round what stands at the duct's level (elbow room
 *    at every turn, a riser where the two levels differ, the section of the
 *    part before the gap with a transition into the part after); and the route
 *    with the fewest fittings. The joined run keeps the first part's id.
 *  - A lone open end: back to what it was connected to — the unit's collar,
 *    the terminal it served (its runout drawn again), its parent run (a
 *    take-off on the run wall behind it), a split or a plenum (with the
 *    branches it carried).
 *
 * A way is offered only when it clashes with nothing and the run it makes
 * plans with no error the parts did not already have. Best first: as it was
 * when that is still as good as the shortest, else the shortest. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { findObstacleAwareOrthogonalRoute } from '../obstacleAwareOrthogonalRoute';

import { findAirPort } from './ductAirPorts';
import { errorCodes, noNewErrors } from './ductBranchReaim';
import { findReattachTarget } from './ductBranchTargets';
import { getActiveDuctBuilding, type DuctBuilding } from './ductBuilding';
import { boxOf, cardinalOf, corners, ductClash, elbowRoomMm, frame, planObstacles, runClashes } from './ductCollarReroute';
import { ductOpenEnds, type DuctOpenEndRef } from './ductCut';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { ductLegs } from './ductGeometry';
import { joinDuctRuns, mergeInlineLegs, type DuctRunRef } from './ductJoin';
import { ductBranchesOf } from './ductNetwork';
import type { DuctDesignSettings } from './ductSettings';
import { findTerminalPort } from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctEnd, type DuctGapRef, type DuctLeg, type DuctPoint3, type DuctRunSpec } from './ductTypes';

export type DuctGapCandidateKey = 'as-before' | 'shortest' | 'fewest' | 'collar' | 'terminal' | 'reattach' | 'restore';

export interface DuctGapCandidate {
  key: DuctGapCandidateKey;
  /** "As it was", "Shortest", "Fewest fittings", "To the unit's collar", … */
  label: string;
  /** What Apply commits (one undo). */
  updates: HvacElement[];
  removeIds: string[];
  /** The new stretch: its centreline (plan and levels), its length and its turns. */
  bridge: DuctPoint3[];
  lengthMm: number;
  elbows: number;
}

export interface DuctGapProposals {
  gapId: string;
  candidates: DuctGapCandidate[];
  /** Why none is offered. */
  reason: string | null;
  /** Where the gap is: its ends (the chip goes beside them). */
  ends: Point2D[];
}

const MARGIN_MM = 50;
const SIDE_CLEARANCE_MM = 25;
const BEND_PENALTY_MM = 1500;
/** As it was is offered first while it costs no more than this times the shortest. */
const AS_BEFORE_TOLERANCE = 1.1;
const NEAR_MM = 1;

const near = (a: Point2D, b: Point2D, tolerance = NEAR_MM) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

/** Errors a scene's runs have now (open ends aside): what a reconnection may not add to. */
function baselineErrors(runs: readonly DuctRunRef[], scene: readonly HvacElement[], settings: DuctDesignSettings, building: Pick<DuctBuilding, 'walls' | 'rooms'>) {
  const out = new Map<string, number>();
  for (const run of runs) {
    for (const [code, count] of errorCodes(planDuctRunSpec(run.element.id, run.spec, { settings, scene, building }))) {
      if (code === 'DU_OPEN_END') continue;
      out.set(code, (out.get(code) ?? 0) + count);
    }
  }
  return out;
}

function sectionWidth(section: DuctLeg): number {
  return section.diameterMm ?? section.widthMm;
}

function sectionHeight(section: DuctLeg): number {
  return section.diameterMm ?? section.heightMm;
}

/** Plan length and turns of a centreline from `incoming` to `outgoing` (vertical steps count two elbows). */
function measure(points: readonly DuctPoint3[], incoming: Point2D, outgoing: Point2D): { lengthMm: number; elbows: number } {
  let lengthMm = 0;
  let elbows = 0;
  let heading = incoming;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    lengthMm += plan + Math.abs(b.z - a.z);
    if (plan < 0.5) {
      if (Math.abs(b.z - a.z) > 0.5) elbows += 2;
      continue;
    }
    const direction = { x: (b.x - a.x) / plan, y: (b.y - a.y) / plan };
    if (heading.x * direction.x + heading.y * direction.y < 1 - 1e-6) elbows += 1;
    heading = direction;
  }
  if (heading.x * outgoing.x + heading.y * outgoing.y < 1 - 1e-6) elbows += 1;
  return { lengthMm, elbows };
}

/** Whether a candidate run plans with no new error and keeps clear of what stands round it. */
function judge(
  scene: readonly HvacElement[],
  updates: readonly HvacElement[],
  removeIds: readonly string[],
  runId: string,
  spec: DuctRunSpec,
  baseline: Map<string, number>,
  settings: DuctDesignSettings,
  building: Pick<DuctBuilding, 'walls' | 'rooms'>,
): boolean {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  const removed = new Set(removeIds);
  const trial = scene.filter((element) => !removed.has(element.id)).map((element) => replaced.get(element.id) ?? element);
  if (runClashes(spec, [])) return false;
  const plan = planDuctRunSpec(runId, spec, { settings, scene: trial, building });
  return noNewErrors(baseline, errorCodes(plan));
}

/** The new stretch's level legs clash with nothing standing at their level (its joints left out). */
function bridgeClear(points: readonly DuctPoint3[], section: DuctLeg, insulationMm: number, scene: readonly HvacElement[], exclude: ReadonlySet<string>, building: Pick<DuctBuilding, 'walls' | 'rooms'>): boolean {
  const obstacles = planObstacles(scene, exclude, building.walls);
  const half = sectionWidth(section) / 2 + insulationMm;
  const trim = sectionWidth(section) / 2;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) continue;
    const zMin = Math.min(a.z, b.z);
    const zMax = Math.max(a.z, b.z) + sectionHeight(section) + 2 * insulationMm;
    if (ductClash(a, b, half, zMin, zMax, obstacles, index === 1 ? trim : 0, index === points.length - 1 ? trim : 0)) return false;
  }
  return true;
}

// ---- A cut: the two parts joined again. ----

function cutCandidates(
  scene: readonly HvacElement[],
  a: DuctRunRef,
  b: DuctRunRef,
  gap: DuctGapRef,
  settings: DuctDesignSettings,
  building: Pick<DuctBuilding, 'walls' | 'rooms'>,
): DuctGapCandidate[] {
  const pA = a.spec.path[a.spec.path.length - 1]!;
  const pB = b.spec.path[0]!;
  const legsA = ductLegs(a.spec);
  const legsB = ductLegs(b.spec);
  const lastA = legsA[legsA.length - 1]!;
  const firstB = legsB[0]!;
  const sA = a.spec.legs[a.spec.legs.length - 1]!;
  const baseline = baselineErrors([a, b], scene, settings, building);
  const exclude = new Set([a.element.id, b.element.id]);
  const out: DuctGapCandidate[] = [];
  // Branches whose take-off was on what the cut deleted (orphaned, remembering a tap on either part).
  const orphans = scene.filter(isDuctElement).flatMap((element) => {
    const spec = readDuctRunSpec(element);
    const was = spec?.start.kind === 'open' ? spec.start.gap?.was : undefined;
    return spec && was?.kind === 'tap' && (was.parentRunId === a.element.id || was.parentRunId === b.element.id) ? [{ element, spec, was }] : [];
  });
  const offer = (key: DuctGapCandidateKey, label: string, via: DuctPoint3[], sections?: DuctLeg[]) => {
    const bridge = [pA, ...via, pB];
    // Put back as it was, the stretch meets those branches where they were taken off (they are taken off it again).
    const clearOf = key === 'as-before' ? new Set([...exclude, ...orphans.map((orphan) => orphan.element.id)]) : exclude;
    if (!bridgeClear(bridge, sections?.[0] ?? sA, a.spec.insulationThicknessMm, scene, clearOf, building)) return;
    const joined = joinDuctRuns(scene, a, b, via, { sections, building });
    if (!judge(scene, joined.updates, joined.removeIds, a.element.id, joined.spec, baseline, settings, building)) return;
    const signature = bridge.map((point) => `${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`).join(';');
    if (out.some((candidate) => candidate.bridge.map((point) => `${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`).join(';') === signature)) return;
    // Those branches take off the joined run again where it passes square behind their open start.
    const replaced = new Map(joined.updates.map((element) => [element.id, element]));
    const trial = scene.filter((element) => !joined.removeIds.includes(element.id)).map((element) => replaced.get(element.id) ?? element);
    const reattached = orphans.flatMap((orphan) => {
      const target = findReattachTarget(orphan.element, trial, settings, { style: orphan.was.style, vcd: orphan.was.vcd, reachMm: 5 });
      if (!target || target.parent.id !== a.element.id) return [];
      // Back where it was taken off (the stretch put back as it was): its take-off exactly as it was, its path as it is.
      const same = target.legIndex === orphan.was.legIndex && target.side === orphan.was.side && Math.abs(target.stationMm - orphan.was.stationMm) <= 5;
      return [ductRunElementWithSpec(orphan.element, same ? { ...orphan.spec, start: orphan.was } : target.spec)];
    });
    out.push({ key, label, updates: [...joined.updates, ...reattached], removeIds: joined.removeIds, bridge, ...measure(bridge, lastA.direction, firstB.direction) });
  };

  // As it was: the stretch deleted, while the parts are where they were.
  const removed = gap.removed;
  if (removed && near(removed.path[0]!, pA) && near(removed.path[removed.path.length - 1]!, pB)
    && Math.abs(removed.path[0]!.z - pA.z) <= NEAR_MM && Math.abs(removed.path[removed.path.length - 1]!.z - pB.z) <= NEAR_MM) {
    offer('as-before', 'As it was', removed.path.slice(1, -1).map((point) => ({ ...point })), removed.legs);
  }

  // Routed: square to the first part's last leg, round what stands at the duct's level.
  if (!lastA.vertical && !firstB.vertical && !lastA.sloped && !firstB.sloped) {
    const f = frame(pA, lastA.direction);
    const arrive = cardinalOf(f.dirToLocal({ x: -firstB.direction.x, y: -firstB.direction.y }));
    if (arrive) {
      const radius = elbowRoomMm(sA, 90, settings) + MARGIN_MM / 2;
      const half = sectionWidth(sA) / 2 + a.spec.insulationThicknessMm;
      const clearance = Math.max(0, half + SIDE_CLEARANCE_MM - radius);
      const zMin = Math.min(pA.z, pB.z);
      const zMax = Math.max(pA.z, pB.z) + sectionHeight(sA) + 2 * a.spec.insulationThicknessMm;
      const obstacles = planObstacles(scene, exclude, building.walls)
        .filter((obstacle) => obstacle.zMin < zMax - 1 && obstacle.zMax > zMin + 1)
        .map((obstacle) => (obstacle.shape.kind === 'leg'
          ? boxOf([obstacle.shape.a, obstacle.shape.b].map(f.toLocal), obstacle.shape.halfWidthMm)
          : boxOf(obstacle.shape.corners.map(f.toLocal))));
      const routes = [
        { key: 'shortest' as const, label: 'Shortest', penalty: 300 },
        { key: 'fewest' as const, label: 'Fewest fittings', penalty: 20000 },
      ];
      for (const route of routes) {
        const found = findObstacleAwareOrthogonalRoute({
          start: { x: 0, y: 0 }, startDirection: { x: 1, y: 0 }, end: f.toLocal(pB), endDirection: arrive,
          startStraightMm: 0, endStraightMm: 0, bendRadiusMm: radius, obstacles, clearanceMm: clearance, bendPenaltyMm: route.penalty,
        });
        if (!found) continue;
        const plan = corners([pA, ...found.points.map(f.toWorld), pB]).slice(1, -1);
        if (Math.abs(pA.z - pB.z) <= 0.5) {
          offer(route.key, route.label, plan.map((point) => ({ x: point.x, y: point.y, z: pA.z })));
          continue;
        }
        // A riser where the levels differ: on the longest level leg of the new stretch, straight on (a riser
        // bends the easy way only), the first that plans clean.
        const stretch = [pA, ...plan, pB];
        const order = stretch.slice(1).map((point, index) => ({ index, length: Math.hypot(point.x - stretch[index]!.x, point.y - stretch[index]!.y) }))
          .sort((p, q) => q.length - p.length);
        const before = out.length;
        for (const leg of order) {
          if (out.length > before) break;
          const from = stretch[leg.index]!;
          const to = stretch[leg.index + 1]!;
          const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
          const via: DuctPoint3[] = [];
          plan.forEach((point, index) => {
            if (index === leg.index) via.push({ ...middle, z: pA.z }, { ...middle, z: pB.z });
            via.push({ x: point.x, y: point.y, z: index < leg.index ? pA.z : pB.z });
          });
          if (leg.index === plan.length) via.push({ ...middle, z: pA.z }, { ...middle, z: pB.z });
          offer(route.key, route.label, via);
        }
      }
    }
  }
  // Best first: as it was while it is about as good as the shortest; then by length and turns.
  const cost = (candidate: DuctGapCandidate) => candidate.lengthMm + candidate.elbows * BEND_PENALTY_MM;
  const asBefore = out.find((candidate) => candidate.key === 'as-before');
  const rest = out.filter((candidate) => candidate !== asBefore).sort((p, q) => cost(p) - cost(q));
  if (asBefore && (!rest.length || cost(asBefore) <= cost(rest[0]!) * AS_BEFORE_TOLERANCE)) return [asBefore, ...rest];
  return asBefore ? [...rest, asBefore] : rest;
}

// ---- A lone end: back to what it was connected to. ----

/** The run with `path` (its first point the new start) put before its open start, and `start` as its start. */
function prepend(scene: readonly HvacElement[], run: DuctRunRef, start: DuctEnd, path: readonly DuctPoint3[], legs: readonly DuctLeg[]): { spec: DuctRunSpec; updates: HvacElement[] } {
  const shift = path.length - 1;
  const nodeOverrides = Object.fromEntries(Object.entries(run.spec.nodeOverrides).map(([key, value]) => [String(Number(key) + shift), value]));
  const inline = (run.spec.inline ?? []).map((item) => ({ ...item, legIndex: item.legIndex + shift }));
  const { inline: _inline, ...rest } = run.spec;
  const raw: DuctRunSpec = {
    ...rest, start, path: [...path.map((point) => ({ ...point })), ...run.spec.path.slice(1)], legs: [...legs, ...run.spec.legs], nodeOverrides,
    ...(inline.length ? { inline } : {}),
  };
  const merged = mergeInlineLegs(raw, new Set([shift]));
  const updates: HvacElement[] = [ductRunElementWithSpec(run.element, merged.spec)];
  for (const branch of ductBranchesOf(run.element.id, scene)) {
    if (branch.start.kind !== 'tap') continue;
    const moved = merged.relocate(branch.start.legIndex + shift, branch.start.stationMm);
    updates.push(ductRunElementWithSpec(branch.element, { ...branch.spec, start: { ...branch.start, legIndex: moved.legIndex, stationMm: moved.stationMm } }));
  }
  return { spec: merged.spec, updates };
}

/** The run with `path` (its first point the open end) put after its end, and `end` as its end. */
function append(scene: readonly HvacElement[], run: DuctRunRef, end: DuctEnd, path: readonly DuctPoint3[], legs: readonly DuctLeg[]): { spec: DuctRunSpec; updates: HvacElement[] } {
  const joint = run.spec.path.length - 1;
  const raw: DuctRunSpec = { ...run.spec, end, path: [...run.spec.path, ...path.slice(1).map((point) => ({ ...point }))], legs: [...run.spec.legs, ...legs] };
  const merged = mergeInlineLegs(raw, new Set([joint]));
  const updates: HvacElement[] = [ductRunElementWithSpec(run.element, merged.spec)];
  for (const branch of ductBranchesOf(run.element.id, scene)) {
    if (branch.start.kind !== 'tap') continue;
    const moved = merged.relocate(branch.start.legIndex, branch.start.stationMm);
    if (moved.legIndex === branch.start.legIndex && Math.abs(moved.stationMm - branch.start.stationMm) < 1e-6) continue;
    updates.push(ductRunElementWithSpec(branch.element, { ...branch.spec, start: { ...branch.start, legIndex: moved.legIndex, stationMm: moved.stationMm } }));
  }
  return { spec: merged.spec, updates };
}

function loneCandidates(
  scene: readonly HvacElement[],
  run: DuctRunRef,
  end: DuctOpenEndRef,
  gap: DuctGapRef,
  settings: DuctDesignSettings,
  building: Pick<DuctBuilding, 'walls' | 'rooms'>,
): DuctGapCandidate[] {
  const was = gap.was;
  if (!was) return [];
  const baseline = baselineErrors([run], scene, settings, building);
  const out: DuctGapCandidate[] = [];
  const offer = (key: DuctGapCandidateKey, label: string, spec: DuctRunSpec, updates: HvacElement[], bridge: DuctPoint3[], extra: HvacElement[] = []) => {
    const all = [...updates, ...extra];
    if (!judge(scene, all, [], run.element.id, spec, baseline, settings, building)) return;
    const legs = ductLegs(spec);
    out.push({ key, label, updates: all, removeIds: [], bridge, ...measure(bridge, legs[0]?.direction ?? { x: 1, y: 0 }, legs[0]?.direction ?? { x: 1, y: 0 }) });
  };
  const removed = gap.removed;
  if (end.end === 'start' && was.kind === 'unit-port') {
    // The collar: the stretch as it was while the unit is where it was.
    const port = findAirPort(scene, was.unitId, was.portId);
    if (port && removed && near(removed.path[0]!, port.lip, 5) && near(removed.path[removed.path.length - 1]!, end.point)) {
      const { spec, updates } = prepend(scene, run, was, removed.path, removed.legs);
      offer('collar', 'To the unit\'s collar', spec, updates, removed.path);
    }
  } else if (end.end === 'start' && (was.kind === 'tap' || was.kind === 'split-branch' || was.kind === 'spigot')) {
    // Its parent run: a take-off on the run wall behind the open start (a split's or plenum's outlet when that is
    // back where it was).
    const parent = scene.find((element) => element.id === was.parentRunId);
    const parentSpec = parent ? readDuctRunSpec(parent) : null;
    if (was.kind !== 'tap' && parentSpec && parentSpec.end.kind === (was.kind === 'split-branch' ? 'split' : 'plenum')) {
      const spec: DuctRunSpec = { ...run.spec, start: was };
      offer('reattach', `To ${parent!.label || 'its parent run'}`, spec, [ductRunElementWithSpec(run.element, spec)], [end.point, end.point]);
    } else {
      const target = findReattachTarget(run.element, scene, settings, { style: was.kind === 'tap' ? was.style : 'shoe-45', vcd: was.vcd });
      if (target) {
        const bridge = [{ x: target.wallPoint.x, y: target.wallPoint.y, z: end.point.z }, end.point];
        offer('reattach', `A take-off on ${target.parent.label || 'the run behind it'}`, target.spec, [ductRunElementWithSpec(run.element, target.spec)], bridge);
      }
    }
  } else if (end.end === 'end' && was.kind === 'terminal') {
    // Its terminal: the runout drawn again to its spigot, where the terminal is now.
    const port = findTerminalPort(scene, was.terminalId, was.portId);
    if (port) {
      const lipBottom = { x: port.lip.x, y: port.lip.y, z: port.lip.z - sectionHeight(end.section) / 2 };
      const path = removed && removed.path.length >= 2 && near(removed.path[removed.path.length - 1]!, port.lip, 5)
        ? removed.path : [end.point, lipBottom];
      const legs = removed && path === removed.path ? removed.legs : [end.section];
      const { spec, updates } = append(scene, run, was, path, legs);
      offer('terminal', 'To its terminal', spec, updates, path);
    }
  } else if (end.end === 'end' && (was.kind === 'split' || was.kind === 'plenum')) {
    // The split or plenum put back, with the branches that were taken off it.
    const path = removed && removed.path.length >= 2 ? removed.path : [end.point];
    const legs = removed && removed.path.length >= 2 ? removed.legs : [];
    const { spec, updates } = path.length >= 2 ? append(scene, run, was, path, legs) : { spec: { ...run.spec, end: was }, updates: [] as HvacElement[] };
    const restored = updates.length ? updates : [ductRunElementWithSpec(run.element, spec)];
    const children = scene.filter(isDuctElement).flatMap((element) => {
      const childSpec = readDuctRunSpec(element);
      const childGap = childSpec?.start.kind === 'open' ? childSpec.start.gap : undefined;
      const childWas = childGap?.was;
      if (!childSpec || !childWas || (childWas.kind !== 'split-branch' && childWas.kind !== 'spigot') || childWas.parentRunId !== run.element.id) return [];
      return [ductRunElementWithSpec(element, { ...childSpec, start: childWas })];
    });
    offer('restore', was.kind === 'split' ? 'Its split back' : 'Its plenum back', spec, restored, path.length >= 2 ? path : [end.point, end.point], children);
  }
  return out;
}

/** The ways to reconnect the gap `gapId` (see the module comment), best first. */
export function proposeDuctGap(scene: readonly HvacElement[], gapId: string, settings: DuctDesignSettings, building: Pick<DuctBuilding, 'walls' | 'rooms'> = getActiveDuctBuilding()): DuctGapProposals {
  const ends = ductOpenEnds(scene).filter((end) => end.gap?.id === gapId);
  const points = ends.map((end) => ({ x: end.point.x, y: end.point.y }));
  const refOf = (runId: string): DuctRunRef | null => {
    const element = scene.find((candidate) => candidate.id === runId);
    const spec = element ? readDuctRunSpec(element) : null;
    return element && spec ? { element, spec } : null;
  };
  const none = (reason: string): DuctGapProposals => ({ gapId, candidates: [], reason, ends: points });
  if (!ends.length) return none('This gap is no longer open.');
  const gap = ends[0]!.gap!;
  const upstream = ends.find((end) => end.end === 'end');
  const downstream = ends.find((end) => end.end === 'start');
  let candidates: DuctGapCandidate[] = [];
  if (upstream && downstream) {
    const a = refOf(upstream.runId);
    const b = refOf(downstream.runId);
    if (!a || !b) return none('A part of this run is missing.');
    if (a.spec.locked || b.spec.locked) return none('A part of this run is locked.');
    if (a.element.id === b.element.id) return none('Both ends are on one run.');
    candidates = cutCandidates(scene, a, b, gap, settings, building);
  } else {
    const end = ends[0]!;
    const run = refOf(end.runId);
    if (!run) return none('The run is missing.');
    if (run.spec.locked) return none('The run is locked.');
    candidates = loneCandidates(scene, run, end, gap, settings, building);
  }
  return {
    gapId, candidates, ends: points,
    reason: candidates.length ? null : 'No clear way found: draw it with the duct tool from its open end.',
  };
}
