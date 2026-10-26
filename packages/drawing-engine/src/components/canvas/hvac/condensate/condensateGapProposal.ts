/**
 * Reconnecting a gap left by deleted condensate pieces: the ways to join what
 * is left, each one the network as it would then be.
 *
 *  - As it was: the stretch deleted and its fittings put back exactly, while
 *    the parts are where they were; a lone end back to the connection it had;
 *    a drop deleted whole back as it was. Nothing else changes.
 *  - Shortest / fewest bends: the run routed on the plan between its open ends
 *    round what stands at its level, then the whole network solved again along
 *    it, as Auto route solves one: continuous fall, risers, sizes, wyes. The
 *    levels of the rest may shift to keep the fall (the way says so).
 *
 * The joined run keeps the first part's id. Best first: as it was while it is
 * about as good. Pure (the network solve included).
 */
import type { HvacElement, Point2D } from '../../../../types';
import { boxOf, cardinalOf, corners, frame, planObstacles } from '../duct/ductCollarReroute';
import { findObstacleAwareOrthogonalRoute } from '../obstacleAwareOrthogonalRoute';

import { condensateOpenEnds, DRAIN_GAP_PROPERTY, drainGapRecord, readDrainGaps } from './condensateCut';
import { createCondensateEditSession, type CondensateEditContext } from './condensateEditing';
import { condensateRunOf } from './condensatePieces';
import { fixedPrefixLength, tidyRoute } from './condensateRouteOps';
import { formatFallRatio } from './condensateSettings';
import { condensateInsulatedRadiusMm, getCondensateOwnership, readCondensatePipeSpec, type CondensateFitting, type Point3 } from './condensateTypes';

export interface DrainGapCandidate {
  key: 'as-before' | 'shortest' | 'fewest' | 'restore';
  label: string;
  updates: HvacElement[];
  add: HvacElement[];
  removeIds: string[];
  /** The new stretch (on the plan, at the level of the gap's ends). */
  bridge: Point3[];
  lengthMm: number;
  elbows: number;
  /** What else changes: a network solved again (its levels). */
  note: string | null;
}

export interface DrainGapProposals {
  gapId: string;
  candidates: DrainGapCandidate[];
  reason: string | null;
}

const AS_BEFORE_TOLERANCE = 1.1;
const BEND_PENALTY_MM = 600;
const near = (a: Point2D, b: Point2D, tolerance = 1) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

function nodesOf(element: HvacElement): Point3[] {
  return condensateRunOf(element)?.nodes.map((node) => ({ ...node })) ?? [];
}

function measure(points: readonly Point3[]): { lengthMm: number; elbows: number } {
  let lengthMm = 0;
  let elbows = 0;
  let heading: Point2D | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    lengthMm += Math.hypot(plan, b.z - a.z);
    if (plan < 0.5) continue;
    const way = { x: (b.x - a.x) / plan, y: (b.y - a.y) / plan };
    if (heading && heading.x * way.x + heading.y * way.y < 1 - 1e-6) elbows += 1;
    heading = way;
  }
  return { lengthMm, elbows };
}

type Spliced = { x: number; y: number; z?: number };

/**
 * Lines put back end to end, the joints that are points the cut made (`introduced`) dropped; every other point stays
 * (one the cut fell on included), so a run put back as it was is the run it was.
 */
function splice<T extends Spliced>(introduced: readonly Spliced[] | undefined, ...parts: ReadonlyArray<readonly T[]>): T[] {
  const out: T[] = [];
  const joints: number[] = [];
  parts.forEach((part, index) => {
    if (!part.length) return;
    if (index > 0 && out.length) joints.push(out.length - 1, out.length);
    out.push(...part.map((point) => ({ ...point })));
  });
  const made = (point: T) => (introduced ?? []).some((cut) => Math.hypot(cut.x - point.x, cut.y - point.y, (cut.z ?? point.z ?? 0) - (point.z ?? 0)) < 0.01);
  const same = (p: T, q: T) => Math.hypot(p.x - q.x, p.y - q.y, (p.z ?? 0) - (q.z ?? 0)) < 0.01;
  // From the last joint back, so earlier indices hold: a point the cut made goes, and a point met twice once.
  for (const index of [...new Set(joints)].sort((p, q) => q - p)) {
    if (index <= 0 || index >= out.length - 1) continue;
    if (made(out[index]!) || same(out[index]!, out[index - 1]!)) out.splice(index, 1);
  }
  return out;
}

/** A run put back together: its centreline, its plan route, with the fittings and ends given (as stored). */
function rebuilt(base: HvacElement, nodes: Point3[], plan: Point2D[], fittings: readonly CondensateFitting[], ends: Record<string, unknown>): HvacElement {
  return {
    ...base,
    properties: { ...base.properties, routePoints: plan, routeNodes3d: nodes, fittings: [...fittings], ...ends },
  } as HvacElement;
}

export type DrainJoin =
  | { ok: true; updates: HvacElement[]; add: HvacElement[]; removeIds: string[]; note: string }
  | { ok: false; message: string };

/**
 * A drain gap closed along `via` (plan points between its two open ends, in the direction of flow): the run joined
 * on the plan, then its whole network solved again along every run, this one included (falls, risers, sizes, wyes).
 * Refused, saying why, when the gap is no longer there, another gap of the network is open (it would not drain), or
 * the network cannot drain along it.
 */
export function joinDrainAlong(scene: readonly HvacElement[], gapId: string, via: readonly Point2D[], context: CondensateEditContext): DrainJoin {
  const ends = condensateOpenEnds(scene).filter((end) => end.gap.id === gapId);
  const upstream = ends.find((end) => end.end === 'end');
  const downstream = ends.find((end) => end.end === 'start');
  const a = upstream ? scene.find((element) => element.id === upstream.runId) ?? null : null;
  const b = downstream ? scene.find((element) => element.id === downstream.runId) ?? null : null;
  if (!a || !b) return { ok: false, message: 'This gap is no longer open.' };
  const networkId = getCondensateOwnership(a)?.networkId;
  if (!networkId) return { ok: false, message: 'This drain is not part of a network.' };
  const otherGaps = scene.some((element) => element.id !== a.id && element.id !== b.id
    && getCondensateOwnership(element)?.networkId === networkId && (readDrainGaps(element).start || readDrainGaps(element).end));
  if (otherGaps || readDrainGaps(a).start || readDrainGaps(b).end) return { ok: false, message: 'Another gap of this drain network is open: reconnect it first.' };
  const specA = readCondensatePipeSpec(a);
  const specB = readCondensatePipeSpec(b);
  const routePoints = tidyRoute([...specA.routePoints, ...via, ...specB.routePoints], fixedPrefixLength(specA.drainStart?.kind === 'unit-drain'));
  const joined = {
    ...a,
    properties: { ...a.properties, routePoints, drainEnd: specB.drainEnd, [DRAIN_GAP_PROPERTY]: undefined },
  } as HvacElement;
  const trial = scene.filter((element) => element.id !== b.id).map((element) => (element.id === a.id ? joined : element));
  const solved = createCondensateEditSession([...trial], networkId, context)?.solve({ routes: new Map([[a.id, routePoints]]) });
  if (!solved) return { ok: false, message: 'This drain network could not be read.' };
  if (!solved.ok) return { ok: false, message: solved.message };
  const network = solved.generation?.networks[0];
  // The solve makes its runs afresh: the joined run's closed gap is cleared outright (the store merges properties).
  const updates = solved.updates.map((element) => (element.id === a.id
    ? { ...element, properties: { ...element.properties, [DRAIN_GAP_PROPERTY]: undefined } } : element));
  return {
    ok: true, updates, add: solved.add, removeIds: [...new Set([...solved.removeIds, b.id])],
    note: `levels solved again${network ? ` for the ${formatFallRatio(network.mainSlopePercent)} fall` : ''}`,
  };
}

/** The ways to reconnect the drain gap `gapId` (see the module comment), best first. */
export function proposeCondensateGap(scene: readonly HvacElement[], gapId: string, context: CondensateEditContext): DrainGapProposals {
  const ends = condensateOpenEnds(scene).filter((end) => end.gap.id === gapId);
  if (!ends.length) return { gapId, candidates: [], reason: 'This gap is no longer open.' };
  const byId = new Map(scene.map((element) => [element.id, element]));
  const upstream = ends.find((end) => end.end === 'end');
  const downstream = ends.find((end) => end.end === 'start');
  const a = upstream ? byId.get(upstream.runId) ?? null : null;
  const b = downstream ? byId.get(downstream.runId) ?? null : null;
  const candidates: DrainGapCandidate[] = [];

  // ---- As it was. ----
  if (a && b && upstream && downstream) {
    const gap = upstream.gap;
    const removed = gap.removed;
    if (removed && removed.length >= 2 && near(removed[0]!, upstream.point) && near(removed[removed.length - 1]!, downstream.point)) {
      const specA = readCondensatePipeSpec(a);
      const specB = readCondensatePipeSpec(b);
      const joined = rebuilt(a, splice(gap.introduced?.nodes, nodesOf(a), removed.slice(1, -1), nodesOf(b)),
        splice(gap.introduced?.plan, specA.routePoints, (gap.removedPlan ?? []).slice(1, -1), specB.routePoints),
        [...specA.fittings, ...gap.removedFittings, ...specB.fittings],
        { drainEnd: b.properties.drainEnd ?? specB.drainEnd, [DRAIN_GAP_PROPERTY]: drainGapRecord(readDrainGaps(a).start, readDrainGaps(b).end) });
      candidates.push({ key: 'as-before', label: 'As it was', updates: [joined], add: [], removeIds: [b.id], bridge: removed, ...measure(removed), note: null });
    }
  } else if (a && upstream?.gap.was) {
    // A lone end: back to what it ran into (its joint, the gully), or its drop put back.
    const gap = upstream.gap;
    if (gap.removedRun) {
      const drained = ends.filter((end) => end.end === 'end' && end.gap.removedRun);
      const updates = drained.map((end) => {
        const run = byId.get(end.runId)!;
        return { ...run, properties: { ...run.properties, drainEnd: end.gap.was, [DRAIN_GAP_PROPERTY]: drainGapRecord(readDrainGaps(run).start, null) } } as HvacElement;
      });
      const drop = readCondensatePipeSpec(gap.removedRun).routeNodes3d;
      candidates.push({ key: 'restore', label: 'Its drop back', updates, add: [gap.removedRun], removeIds: [], bridge: drop, ...measure(drop), note: null });
    } else if (gap.removed && gap.removed.length >= 2 && near(gap.removed[0]!, upstream.point)) {
      const spec = readCondensatePipeSpec(a);
      const joined = rebuilt(a, splice(gap.introduced?.nodes, nodesOf(a), gap.removed.slice(1)), splice(gap.introduced?.plan, spec.routePoints, (gap.removedPlan ?? []).slice(1)),
        [...spec.fittings, ...gap.removedFittings], { drainEnd: gap.was, [DRAIN_GAP_PROPERTY]: drainGapRecord(readDrainGaps(a).start, null) });
      candidates.push({ key: 'as-before', label: 'As it was', updates: [joined], add: [], removeIds: [], bridge: gap.removed, ...measure(gap.removed), note: null });
    }
  } else if (b && downstream?.gap.was) {
    // A unit's connection deleted: the run back to the unit's outlet.
    const gap = downstream.gap;
    const removed = gap.removed;
    if (removed && removed.length >= 2 && near(removed[removed.length - 1]!, downstream.point)) {
      const spec = readCondensatePipeSpec(b);
      const restored = rebuilt(b, splice(gap.introduced?.nodes, removed.slice(0, -1), nodesOf(b)), splice(gap.introduced?.plan, (gap.removedPlan ?? []).slice(0, -1), spec.routePoints),
        [...gap.removedFittings, ...spec.fittings], { drainStart: gap.was, [DRAIN_GAP_PROPERTY]: drainGapRecord(null, readDrainGaps(b).end) });
      candidates.push({ key: 'as-before', label: 'As it was', updates: [restored], add: [], removeIds: [], bridge: removed, ...measure(removed), note: null });
    }
  }

  // ---- Routed on the plan, the network solved again along it (a network with no other gap open: it must drain). ----
  const networkId = a ? getCondensateOwnership(a)?.networkId : null;
  const otherGaps = networkId !== null && scene.some((element) => element.id !== a?.id && element.id !== b?.id
    && getCondensateOwnership(element)?.networkId === networkId && (readDrainGaps(element).start || readDrainGaps(element).end));
  if (a && b && upstream && downstream && networkId && !otherGaps && !readDrainGaps(a).start && !readDrainGaps(b).end) {
    const pA = upstream.point;
    const pB = downstream.point;
    const dA = upstream.outward;
    const f = frame(pA, dA);
    const arrive = cardinalOf(f.dirToLocal({ x: -downstream.outward.x, y: -downstream.outward.y }));
    if (arrive && cardinalOf(f.dirToLocal(dA))) {
      const radius = condensateInsulatedRadiusMm(readCondensatePipeSpec(a));
      const half = radius + 25;
      const low = Math.min(pA.z, pB.z);
      const high = Math.max(pA.z, pB.z);
      const obstacles = planObstacles(scene, new Set([a.id, b.id]), [])
        .filter((obstacle) => obstacle.zMin < high + half && obstacle.zMax > low - half)
        .map((obstacle) => (obstacle.shape.kind === 'leg'
          ? boxOf([obstacle.shape.a, obstacle.shape.b].map(f.toLocal), obstacle.shape.halfWidthMm)
          : boxOf(obstacle.shape.corners.map(f.toLocal))));
      for (const route of [{ key: 'shortest' as const, label: 'Shortest', penalty: BEND_PENALTY_MM }, { key: 'fewest' as const, label: 'Fewest bends', penalty: 20000 }]) {
        const found = findObstacleAwareOrthogonalRoute({
          start: { x: 0, y: 0 }, startDirection: { x: 1, y: 0 }, end: f.toLocal(pB), endDirection: arrive,
          startStraightMm: 0, endStraightMm: 0, bendRadiusMm: Math.max(60, radius * 3), obstacles, clearanceMm: half, bendPenaltyMm: route.penalty,
        });
        if (!found) continue;
        const plan = corners([pA, ...found.points.map(f.toWorld), pB]);
        if (candidates.some((candidate) => candidate.key !== 'restore' && candidate.bridge.length === plan.length
          && candidate.bridge.every((point, index) => near(point, plan[index]!)))) continue;
        const joined = joinDrainAlong(scene, gapId, plan.slice(1, -1), context);
        if (!joined.ok) continue;
        const bridge = plan.map((point) => ({ ...point, z: low }));
        candidates.push({
          key: route.key, label: route.label, updates: joined.updates, add: joined.add, removeIds: joined.removeIds,
          bridge, ...measure(bridge), note: joined.note,
        });
      }
    }
  }

  const cost = (candidate: DrainGapCandidate) => candidate.lengthMm + candidate.elbows * BEND_PENALTY_MM;
  const first = candidates.find((candidate) => candidate.key === 'as-before' || candidate.key === 'restore');
  const rest = candidates.filter((candidate) => candidate !== first).sort((p, q) => cost(p) - cost(q));
  const ordered = first && (!rest.length || cost(first) <= cost(rest[0]!) * AS_BEFORE_TOLERANCE) ? [first, ...rest] : first ? [...rest, first] : rest;
  return { gapId, candidates: ordered, reason: ordered.length ? null : 'No clear way found: draw it with the drain tool from its open end.' };
}
