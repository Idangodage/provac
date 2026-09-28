/**
 * Editing a run in place (the plan handles and the inspector), as pure spec
 * edits. Every edit keeps the run's directions, so no elbow changes angle:
 *
 *  - a leg dragged sideways stays parallel; the legs before and after it
 *    stretch along their own lines (a riser stacked at a moved corner goes
 *    with it). A leg starting on a collar or parent wall cannot move;
 *  - the run's end moves along its last leg;
 *  - a riser moves along its heading, the level legs either side stretching;
 *  - a riser's rise (or drop) changes, and everything after it moves up or
 *    down with it.
 *
 * Take-offs on a leg whose start slid along it keep their place in the world:
 * the edit reports the station shift, and the branches re-anchor on the new
 * parent in the same command (applyDuctRunEdit).
 */
import type { HvacElement, Point2D } from '../../../../types';

import { ductRunElementWithSpec, reanchorBranches } from './ductFollow';
import { cross, dot, ductLegs, type DuctLegGeometry } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import type { DuctDesignSettings } from './ductSettings';
import type { DuctPoint3, DuctRunSpec } from './ductTypes';

export interface DuctEditResult {
  spec: DuctRunSpec;
  /** Add to the station of every take-off on these legs (their leg start slid along the leg). */
  stationShiftByLeg: Map<number, number>;
}

/** A leg may not be shortened below this (mm); the planner judges whether its fittings still fit. */
export const MIN_EDITED_LEG_MM = 50;

const perp = (d: Point2D): Point2D => ({ x: -d.y, y: d.x });

/** Where the line through `a` along `da` meets the line through `b` along `db` (null when parallel). */
function intersect(a: Point2D, da: Point2D, b: Point2D, db: Point2D): Point2D | null {
  const denominator = cross(da, db);
  if (Math.abs(denominator) < 1e-9) return null;
  const t = cross({ x: b.x - a.x, y: b.y - a.y }, db) / denominator;
  return { x: a.x + da.x * t, y: a.y + da.y * t };
}

/** The nearest level leg before (step −1) or after (step +1) leg `index`, skipping risers. */
function levelNeighbour(legs: DuctLegGeometry[], index: number, step: -1 | 1): number {
  for (let k = index + step; k >= 0 && k < legs.length; k += step) if (!legs[k]!.vertical) return k;
  return -1;
}

function withPlanPoint(path: DuctPoint3[], from: number, to: number, point: Point2D): void {
  for (let v = from; v <= to; v += 1) path[v] = { ...path[v]!, x: point.x, y: point.y };
}

/** Every level leg still runs its old way and is long enough. */
function directionsKept(before: DuctLegGeometry[], spec: DuctRunSpec): boolean {
  const after = ductLegs(spec);
  return after.every((leg, index) => {
    const old = before[index]!;
    if (old.vertical || leg.vertical) return Boolean(old.vertical) === Boolean(leg.vertical);
    return leg.lengthMm >= MIN_EDITED_LEG_MM - 1e-6 && dot(leg.direction, old.direction) > 0.999;
  });
}

export function moveDuctLegSideways(spec: DuctRunSpec, legIndex: number, offset: Point2D): DuctEditResult | null {
  const legs = ductLegs(spec);
  const leg = legs[legIndex];
  if (!leg || leg.vertical || leg.sloped) return null;
  const n = perp(leg.direction);
  const delta = dot(offset, n);
  if (Math.abs(delta) < 0.5) return null;
  const anchored = spec.start.kind !== 'open';
  const path = spec.path.map((point) => ({ ...point }));
  const shifted = (point: Point2D) => ({ x: point.x + n.x * delta, y: point.y + n.y * delta });
  const shifts = new Map<number, number>();

  // Start side: the leg's first vertex (and any riser stacked under it).
  const before = levelNeighbour(legs, legIndex, -1);
  const startVertex = spec.path[legIndex]!;
  let newStart: Point2D;
  if (legIndex === 0 || (before < 0 && anchored)) {
    if (anchored) return null;
    newStart = shifted(startVertex);
    withPlanPoint(path, 0, legIndex, newStart);
  } else if (before < 0) {
    newStart = shifted(startVertex);
    withPlanPoint(path, 0, legIndex, newStart);
  } else {
    const previous = legs[before]!;
    newStart = intersect(previous.start, previous.direction, shifted(startVertex), leg.direction) ?? shifted(startVertex);
    withPlanPoint(path, before + 1, legIndex, newStart);
  }
  const startSlide = dot({ x: newStart.x - startVertex.x, y: newStart.y - startVertex.y }, leg.direction);
  if (Math.abs(startSlide) > 1e-6) shifts.set(legIndex, -startSlide);

  // End side: the leg's last vertex (and any riser stacked on it); the next level leg keeps its far end.
  const after = levelNeighbour(legs, legIndex, 1);
  const endVertex = spec.path[legIndex + 1]!;
  if (after < 0) {
    withPlanPoint(path, legIndex + 1, spec.path.length - 1, shifted(endVertex));
  } else {
    const next = legs[after]!;
    const newEnd = intersect(shifted(endVertex), leg.direction, next.end, next.direction) ?? shifted(endVertex);
    withPlanPoint(path, legIndex + 1, after, newEnd);
    const nextSlide = dot({ x: newEnd.x - next.start.x, y: newEnd.y - next.start.y }, next.direction);
    if (Math.abs(nextSlide) > 1e-6) shifts.set(after, -nextSlide);
  }
  const edited = { ...spec, path };
  return directionsKept(legs, edited) ? { spec: edited, stationShiftByLeg: shifts } : null;
}

export function moveDuctRunEnd(spec: DuctRunSpec, point: Point2D): DuctEditResult | null {
  const legs = ductLegs(spec);
  const last = legs[legs.length - 1];
  if (!last || last.vertical || last.sloped) return null;
  const length = Math.max(MIN_EDITED_LEG_MM, dot({ x: point.x - last.start.x, y: point.y - last.start.y }, last.direction));
  const end = { x: last.start.x + last.direction.x * length, y: last.start.y + last.direction.y * length };
  if (Math.hypot(end.x - last.end.x, end.y - last.end.y) < 0.5) return null;
  const path = spec.path.map((vertex, index) => (index === spec.path.length - 1 ? { ...vertex, ...end } : { ...vertex }));
  return { spec: { ...spec, path }, stationShiftByLeg: new Map() };
}

export function moveDuctRiser(spec: DuctRunSpec, legIndex: number, offset: Point2D): DuctEditResult | null {
  const legs = ductLegs(spec);
  const riser = legs[legIndex];
  if (!riser?.vertical) return null;
  const heading = riser.direction;
  const along = dot(offset, heading);
  if (Math.abs(along) < 0.5) return null;
  // The whole stack of vertical legs at this plan point moves.
  let first = legIndex;
  while (first > 0 && legs[first - 1]!.vertical) first -= 1;
  let last = legIndex;
  while (last + 1 < legs.length && legs[last + 1]!.vertical) last += 1;
  if (first === 0 && spec.start.kind !== 'open') return null;
  const point = { x: riser.start.x + heading.x * along, y: riser.start.y + heading.y * along };
  const path = spec.path.map((vertex) => ({ ...vertex }));
  withPlanPoint(path, first, last + 1, point);
  const shifts = new Map<number, number>();
  const next = legs[last + 1];
  if (next && !next.vertical) {
    const slide = dot({ x: point.x - riser.start.x, y: point.y - riser.start.y }, next.direction);
    if (Math.abs(slide) > 1e-6) shifts.set(last + 1, -slide);
  }
  const edited = { ...spec, path };
  return directionsKept(legs, edited) ? { spec: edited, stationShiftByLeg: shifts } : null;
}

/** Set a riser's rise (+ up, − down, mm); the run after it moves up or down with it. */
export function setDuctRiserRise(spec: DuctRunSpec, legIndex: number, riseMm: number): DuctEditResult | null {
  const legs = ductLegs(spec);
  const riser = legs[legIndex];
  if (!riser?.vertical || Math.abs(riseMm) < MIN_EDITED_LEG_MM) return null;
  const change = riseMm - (riser.end.z - riser.start.z);
  if (Math.abs(change) < 0.5) return null;
  const path = spec.path.map((vertex, index) => (index > legIndex ? { ...vertex, z: vertex.z + change } : { ...vertex }));
  return { spec: { ...spec, path }, stationShiftByLeg: new Map() };
}

/**
 * The edited run and everything that follows it, as they will be stored: its
 * take-offs on slid legs keep their place, and the branch tree re-anchors.
 */
export function applyDuctRunEdit(
  scene: readonly HvacElement[],
  element: HvacElement,
  result: DuctEditResult,
  settings: DuctDesignSettings,
): HvacElement[] {
  const next = ductRunElementWithSpec(element, result.spec);
  const adjusted = new Map<string, HvacElement>();
  for (const branch of ductBranchesOf(element.id, scene)) {
    if (branch.start.kind !== 'tap') continue;
    const shift = result.stationShiftByLeg.get(branch.start.legIndex);
    if (!shift) continue;
    adjusted.set(branch.element.id, ductRunElementWithSpec(branch.element, {
      ...branch.spec, start: { ...branch.start, stationMm: Math.round((branch.start.stationMm + shift) * 10) / 10 },
    }));
  }
  const updated = scene.map((candidate) => (candidate.id === element.id ? next : adjusted.get(candidate.id) ?? candidate));
  const followers = reanchorBranches(updated, new Map([[element.id, next]]), settings);
  const followerIds = new Set(followers.map((follower) => follower.id));
  return [next, ...followers, ...[...adjusted.values()].filter((branch) => !followerIds.has(branch.id))];
}
