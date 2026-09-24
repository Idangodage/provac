/**
 * Plan-route operations behind condensate micro-editing. Pure: each takes a
 * run's plan polyline and returns a new one; the network is then re-solved in
 * Z by the planner (fall, risers, 45° offsets, wyes, sizes, fittings).
 *
 * A unit branch starts [drain outlet, riser foot, …]: those two points belong
 * to the unit connection (flexible hose + riser) and only move with their own
 * handle. Every route's last point is its joint (wye / termination) and only
 * moves when that joint moves.
 */
import type { Point2D } from '../../../../types';

import { distance, simplifyPolyline, sub } from './condensateGeometry';

export type PlanRoute = Point2D[];

/** Points at the start of a route that the leg / bend handles never move. */
export function fixedPrefixLength(isUnitBranch: boolean): number {
  return isUnitBranch ? 2 : 1;
}

/** Removes duplicates and collinear points after the fixed prefix (the outlet and riser foot always stay). */
export function tidyRoute(route: PlanRoute, fixedPrefix: number): PlanRoute {
  const keep = Math.max(0, fixedPrefix - 1);
  const head = route.slice(0, keep).map((point) => ({ ...point }));
  const tail = simplifyPolyline(route.slice(keep), 0.5);
  return [...head, ...tail];
}

function dominantAxis(a: Point2D, b: Point2D): 'x' | 'y' {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'x' : 'y';
}

/**
 * Elbow that keeps `fixed → elbow` along `axis` and turns square into `moved`
 * (an orthogonal dog-leg absorbs the displacement).
 */
function elbowFrom(fixed: Point2D, moved: Point2D, axis: 'x' | 'y'): Point2D {
  return axis === 'x' ? { x: moved.x, y: fixed.y } : { x: fixed.x, y: moved.y };
}

export function moveRouteVertex(route: PlanRoute, index: number, point: Point2D, fixedPrefix: number): PlanRoute {
  if (index < fixedPrefix || index >= route.length - 1) return route;
  const next = route.map((candidate) => ({ ...candidate }));
  next[index] = { ...point };
  return next;
}

export function insertRouteVertex(route: PlanRoute, segmentIndex: number, point: Point2D, fixedPrefix: number): PlanRoute {
  if (segmentIndex < fixedPrefix - 1 || segmentIndex >= route.length - 1) return route;
  return [...route.slice(0, segmentIndex + 1), { ...point }, ...route.slice(segmentIndex + 1)].map((candidate) => ({ ...candidate }));
}

export function removeRouteVertex(route: PlanRoute, index: number, fixedPrefix: number): PlanRoute {
  if (index < fixedPrefix || index >= route.length - 1) return route;
  return route.filter((_, candidate) => candidate !== index).map((point) => ({ ...point }));
}

/**
 * Moves one straight leg sideways by the component of `offset` across it. An
 * end that cannot move (riser foot, joint) gets a square jog instead.
 */
export function offsetRouteLeg(route: PlanRoute, segmentIndex: number, offset: Point2D, fixedPrefix: number): PlanRoute {
  if (segmentIndex < fixedPrefix - 1 || segmentIndex >= route.length - 1) return route;
  const a = route[segmentIndex]!;
  const b = route[segmentIndex + 1]!;
  const length = distance(a, b);
  if (length < 1e-6) return route;
  const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const across = offset.x * normal.x + offset.y * normal.y;
  const shift = { x: normal.x * across, y: normal.y * across };
  const movedA = { x: a.x + shift.x, y: a.y + shift.y };
  const movedB = { x: b.x + shift.x, y: b.y + shift.y };
  const startFixed = segmentIndex < fixedPrefix;
  const endFixed = segmentIndex + 1 >= route.length - 1;
  const next: PlanRoute = [];
  route.forEach((point, index) => {
    if (index === segmentIndex) {
      next.push({ ...point });
      if (startFixed) next.push(movedA);
      else next[next.length - 1] = movedA;
      return;
    }
    if (index === segmentIndex + 1) {
      if (endFixed) next.push(movedB, { ...point });
      else next.push(movedB);
      return;
    }
    next.push({ ...point });
  });
  return next;
}

/** Moves every editable bend by `delta`; the fixed start and the joint stay put, square dog-legs reconnect them. */
export function translateRouteInterior(route: PlanRoute, delta: Point2D, fixedPrefix: number): PlanRoute {
  const last = route.length - 1;
  if (last < fixedPrefix) return route;
  const moved = route.map((point, index) => (index >= fixedPrefix && index < last ? { x: point.x + delta.x, y: point.y + delta.y } : { ...point }));
  if (fixedPrefix >= last) {
    // No bend of its own: the whole straight shifts sideways with square jogs at both ends.
    return offsetRouteLeg(route, fixedPrefix - 1, delta, fixedPrefix);
  }
  const startFixed = moved[fixedPrefix - 1]!;
  const firstMoved = moved[fixedPrefix]!;
  const lastMoved = moved[last - 1]!;
  const end = moved[last]!;
  const startAxis = dominantAxis(route[fixedPrefix - 1]!, route[fixedPrefix]!);
  const endAxis = dominantAxis(route[last - 1]!, route[last]!);
  return [
    ...moved.slice(0, fixedPrefix),
    elbowFrom(startFixed, firstMoved, startAxis),
    ...moved.slice(fixedPrefix, last),
    elbowFrom(end, lastMoved, endAxis),
    end,
  ].filter((point, index, all) => index === 0 || distance(point, all[index - 1]!) > 0.5);
}

/**
 * Moves a unit branch's riser foot (index 1) to `foot`, kept within
 * `maxRadiusMm` of the outlet. The first run keeps its direction by sliding
 * its far bend, or turning square when that bend is the joint.
 */
export function moveRiserFoot(route: PlanRoute, foot: Point2D, maxRadiusMm: number): PlanRoute {
  if (route.length < 3) return route;
  const outlet = route[0]!;
  const reach = distance(outlet, foot);
  const clamped = reach > maxRadiusMm && reach > 1e-9
    ? { x: outlet.x + ((foot.x - outlet.x) / reach) * maxRadiusMm, y: outlet.y + ((foot.y - outlet.y) / reach) * maxRadiusMm }
    : { ...foot };
  const oldFoot = route[1]!;
  const next = route.map((point) => ({ ...point }));
  next[1] = clamped;
  const axis = dominantAxis(oldFoot, route[2]!);
  if (route.length > 3) {
    // Slide the bend so the first run stays straight along its axis.
    next[2] = axis === 'x' ? { x: next[2]!.x, y: clamped.y } : { x: clamped.x, y: next[2]!.y };
    return next;
  }
  return [next[0]!, clamped, elbowFrom(clamped, next[2]!, axis), next[2]!]
    .filter((point, index, all) => index === 0 || distance(point, all[index - 1]!) > 0.5);
}

/**
 * The start of a unit branch after its unit moved: outlet and riser foot are
 * placed by the caller; the first run reconnects square to the rest.
 */
export function restartRoute(route: PlanRoute, outlet: Point2D, foot: Point2D): PlanRoute {
  if (route.length < 3) return [outlet, foot, ...route.slice(2)];
  const axis = dominantAxis(route[1]!, route[2]!);
  return [outlet, foot, elbowFrom(foot, route[2]!, axis), ...route.slice(2)]
    .filter((point, index, all) => index === 0 || distance(point, all[index - 1]!) > 0.5);
}

/** The end of a run after its joint / termination moved to `end`: the last run reconnects square. */
export function reendRoute(route: PlanRoute, end: Point2D): PlanRoute {
  if (route.length < 2) return route;
  const last = route.length - 1;
  const axis = dominantAxis(route[last - 1]!, route[last]!);
  return [...route.slice(0, last), elbowFrom(end, route[last - 1]!, axis), { ...end }]
    .filter((point, index, all) => index === 0 || distance(point, all[index - 1]!) > 0.5);
}

export interface PlanSnap {
  point: Point2D;
  /** Guide lines to draw (alignment or angle). */
  guides: Array<{ from: Point2D; to: Point2D }>;
}

/**
 * Snaps a dragged plan point: square / 45° to its neighbours first, then to
 * the x / y of nearby points (other bends, runs, equipment faces).
 */
export function snapPlanPoint(raw: Point2D, neighbours: readonly Point2D[], alignTargets: readonly Point2D[], toleranceMm: number): PlanSnap {
  const guides: PlanSnap['guides'] = [];
  let x = raw.x;
  let y = raw.y;
  let bestX: { value: number; gap: number; from: Point2D } | null = null;
  let bestY: { value: number; gap: number; from: Point2D } | null = null;
  for (const target of [...neighbours, ...alignTargets]) {
    const gapX = Math.abs(target.x - raw.x);
    const gapY = Math.abs(target.y - raw.y);
    if (gapX <= toleranceMm && (!bestX || gapX < bestX.gap)) bestX = { value: target.x, gap: gapX, from: target };
    if (gapY <= toleranceMm && (!bestY || gapY < bestY.gap)) bestY = { value: target.y, gap: gapY, from: target };
  }
  if (bestX) { x = bestX.value; }
  if (bestY) { y = bestY.value; }
  if (!bestX && !bestY) {
    // 45° to a neighbour.
    for (const neighbour of neighbours) {
      const d = sub(raw, neighbour);
      if (Math.abs(Math.abs(d.x) - Math.abs(d.y)) <= toleranceMm * 1.4 && Math.hypot(d.x, d.y) > toleranceMm) {
        const size = (Math.abs(d.x) + Math.abs(d.y)) / 2;
        x = neighbour.x + Math.sign(d.x) * size;
        y = neighbour.y + Math.sign(d.y) * size;
        guides.push({ from: neighbour, to: { x, y } });
        break;
      }
    }
  }
  const point = { x, y };
  if (bestX) guides.push({ from: bestX.from, to: point });
  if (bestY) guides.push({ from: bestY.from, to: point });
  return { point, guides };
}
