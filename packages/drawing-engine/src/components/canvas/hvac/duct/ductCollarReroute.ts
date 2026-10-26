/**
 * A run re-routed from a unit's turned collar back onto its own route.
 *
 * A unit turned a quarter (or half) turn has its collar on another face: the
 * run's first straight now leads off the wrong way, and the take-offs along it
 * serve diffusers that stay where they are. So the run leaves the turned
 * collar square to it (its connector and the collar's transition first), goes
 * round the unit clear of its casing, and joins its old line before its first
 * take-off: from there on the route, its take-offs, its accessories and
 * everything downstream are exactly as they were.
 *
 * A collar turned off the route's axes (a unit turned 45°) leaves on a stub
 * square to the collar that turns onto one of them at an elbow of its angle,
 * so the ducts stay square to the room and only the connection is angled.
 *
 * The route is found by the obstacle-aware orthogonal router in the old
 * route's own frame (so a skewed room works as a square one), with elbow room
 * for a square-throat elbow with vanes at each turn (what the planner makes
 * where a radius elbow does not fit), round the unit's casing and what else
 * stands at the duct's level (equipment, other runs, the walls: a re-route
 * stays in its room). Each candidate is
 * planned and checked for clashes with what it keeps (its own legs and
 * branches included); the cheapest that breaks no rule the run did not
 * already break and clashes with nothing is taken. Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { isCondensatePipe } from '../condensate/condensateTypes';
import { findObstacleAwareOrthogonalRoute, type OrthogonalRouteObstacle } from '../obstacleAwareOrthogonalRoute';
import { isRefrigerantPipeElementType } from '../refrigerantPipePairModel';

import { findAirPort } from './ductAirPorts';
import { errorCodes, noNewErrors } from './ductBranchReaim';
import { getActiveDuctBuilding, type DuctWall } from './ductBuilding';
import { getDuctRunPlan, planDuctRunSpec, transitionLengthMm, transitionMinLengthMm } from './ductFabricationPlanner';
import { ductRunElementWithSpec, type DuctAnchor } from './ductFollow';
import { ductLegs } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import { SMACNA_TABLE_3_1 } from './ductRoundRules';
import type { DuctDesignSettings } from './ductSettings';
import { isDuctElement, isRoundLeg, readDuctRunSpec, type DuctLeg, type DuctNodeOverride, type DuctPoint3, type DuctRunSpec } from './ductTypes';

export interface CollarReroute {
  spec: DuctRunSpec;
  /** Where a place on an old leg (a take-off, an accessory) is on the re-routed run. */
  relocate: (legIndex: number, stationMm: number) => { legIndex: number; stationMm: number };
  /** Elbows the new part of the route makes (the one onto the old line included). */
  elbows: number;
}

export interface CollarRerouteInput {
  /** The drawing with the turned unit in place. */
  scene: readonly HvacElement[];
  /** The drawing before the turn (the run's own errors then may stay). */
  baseline: readonly HvacElement[];
  settings: DuctDesignSettings;
  run: HvacElement;
  spec: DuctRunSpec;
  /** The turned collar: its lip, its outward normal and the run's level there. */
  to: DuctAnchor;
  /** The turned unit's plan corners: the route keeps clear of its casing. */
  unit: readonly Point2D[];
  /** Other plan outlines to keep clear of (runs just re-routed off the same unit). */
  avoid?: ReadonlyArray<readonly Point2D[]>;
}

/** Straight kept between neighbouring fittings for their joints (mm). */
const MARGIN_MM = 50;
/** An elbow costs this many mm of duct (fewer fittings: less loss, less to make). */
const BEND_PENALTY_MM = 1500;
/** Side clearance kept from what stands beside a duct (mm). */
const SIDE_CLEARANCE_MM = 25;
const EPS = 1e-6;

/**
 * What an elbow takes of each leg it joins (setback plus neck, mm). A 90° turn
 * of a rectangular duct may be a square-throat elbow with vanes (W/2), which
 * the planner makes where its radius elbow does not fit; round ducts turn on
 * gored elbows (R/D by the velocity band, SMACNA Table 3-1).
 */
export function elbowRoomMm(section: DuctLeg, angleDeg: number, settings: DuctDesignSettings, inPlaneMm = section.diameterMm ?? section.widthMm): number {
  const half = Math.tan((Math.abs(angleDeg) * Math.PI) / 360);
  if (isRoundLeg(section)) return SMACNA_TABLE_3_1[settings.roundVelocityBand].ratio * inPlaneMm * half + settings.elbowNeckMm;
  const squareThroat = Math.abs(Math.abs(angleDeg) - 90) < 1 && settings.elbowStyle !== 'radius';
  return (squareThroat ? inPlaneMm / 2 : settings.elbowCentrelineRatio * inPlaneMm * half) + settings.elbowNeckMm;
}

/**
 * What a run off a unit's collar carries at the start of its first leg before
 * anything may turn it: the flexible connector, then the transition from the
 * collar's size to the duct's (mm) at the design taper, or (`compressed`) at
 * the steepest SMACNA allows, where room is short.
 */
export function collarReserveMm(spec: DuctRunSpec, scene: readonly HvacElement[], settings: DuctDesignSettings, compressed = false): number {
  if (spec.start.kind !== 'unit-port') return 0;
  const connector = spec.start.connector ? settings.connectorFabricMm + 2 * settings.connectorMetalMm : 0;
  const port = spec.legacy ? null : findAirPort(scene, spec.start.unitId, spec.start.portId);
  const first = spec.legs[0];
  if (!port || !first) return connector;
  const collar = { widthMm: port.widthMm, heightMm: port.heightMm };
  return connector + (compressed ? transitionMinLengthMm(collar, first, settings, spec.service === 'supply') : transitionLengthMm(collar, first, settings));
}

/** What a compressed transition costs against the design taper in a route's comparison (mm of duct). */
const COMPRESSED_TRANSITION_COST_MM = 2000;

// ---- What stands in the plan, and whether a duct along a line clashes with it. ----

/** Something standing in the plan at a level band: a duct leg (its centreline and half its width) or a body (its outline). */
export interface PlanObstacle {
  ownerId: string;
  shape: { kind: 'leg'; a: Point2D; b: Point2D; halfWidthMm: number } | { kind: 'outline'; corners: readonly Point2D[] };
  zMin: number;
  zMax: number;
}

/** A plan point turned `angleDeg` about `centre` (clockwise on the plan, as an element's rotation). */
function turned(point: Point2D, centre: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const x = point.x - centre.x;
  const y = point.y - centre.y;
  return { x: centre.x + x * Math.cos(radians) - y * Math.sin(radians), y: centre.y + x * Math.sin(radians) + y * Math.cos(radians) };
}

/** An element's plan corners (its footprint, turned). */
export function footprintOf(element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'rotation'>): Point2D[] {
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => turned({ x: centre.x + (sx! * element.width) / 2, y: centre.y + (sy! * element.depth) / 2 }, centre, element.rotation ?? 0));
}

/** A run's rigid legs as obstacles (a flexible runout bends round what it meets, so it is left out). */
export function runObstacles(ownerId: string, spec: DuctRunSpec, fromLeg = 0, toLeg = spec.legs.length): PlanObstacle[] {
  const flexTail = spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 3;
  const legs = ductLegs(spec);
  const out: PlanObstacle[] = [];
  for (let index = Math.max(0, fromLeg); index < Math.min(toLeg, legs.length - (flexTail ? 1 : 0)); index += 1) {
    const leg = legs[index]!;
    const section = spec.legs[index]!;
    const height = section.diameterMm ?? section.heightMm;
    out.push({
      ownerId,
      shape: { kind: 'leg', a: { x: leg.start.x, y: leg.start.y }, b: { x: leg.end.x, y: leg.end.y }, halfWidthMm: (section.diameterMm ?? section.widthMm) / 2 + spec.insulationThicknessMm },
      zMin: Math.min(leg.start.z, leg.end.z), zMax: Math.max(leg.start.z, leg.end.z) + height + 2 * spec.insulationThicknessMm,
    });
  }
  return out;
}

/**
 * What stands in the plan: equipment bodies (units, terminals, gullies), duct
 * runs' rigid legs (`exclude` left out) and the walls (the active building's,
 * as the plans read them).
 */
export function planObstacles(scene: readonly HvacElement[], exclude: ReadonlySet<string>, walls: readonly DuctWall[] = getActiveDuctBuilding().walls): PlanObstacle[] {
  const out: PlanObstacle[] = walls.map((wall) => ({
    ownerId: wall.id, shape: { kind: 'leg' as const, a: wall.a, b: wall.b, halfWidthMm: wall.thicknessMm / 2 }, zMin: wall.baseZ, zMax: wall.topZ,
  }));
  for (const element of scene) {
    if (exclude.has(element.id)) continue;
    if (isDuctElement(element)) {
      const spec = readDuctRunSpec(element);
      if (spec && !spec.legacy) out.push(...runObstacles(element.id, spec));
      continue;
    }
    if (isRefrigerantPipeElementType(element.type) || isCondensatePipe(element) || element.type === 'refrigerant-branch-kit') continue;
    out.push({ ownerId: element.id, shape: { kind: 'outline', corners: footprintOf(element) }, zMin: element.elevation, zMax: element.elevation + element.height });
  }
  return out;
}

/** How far a plan point is from a convex outline (0 inside it). */
export function distanceToOutline(point: Point2D, outline: readonly Point2D[]): number {
  let left = true;
  let right = true;
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index]!;
    const b = outline[(index + 1) % outline.length]!;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const side = ab.x * (point.y - a.y) - ab.y * (point.x - a.x);
    if (side < 0) left = false;
    if (side > 0) right = false;
    const lengthSq = ab.x * ab.x + ab.y * ab.y || 1;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lengthSq));
    nearest = Math.min(nearest, Math.hypot(a.x + ab.x * t - point.x, a.y + ab.y * t - point.y));
  }
  // Inside: on the same side of every edge (the outline may wind either way).
  return left || right ? 0 : nearest;
}

function distanceToSegment(point: Point2D, a: Point2D, b: Point2D): number {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const lengthSq = ab.x * ab.x + ab.y * ab.y;
  const t = lengthSq < EPS ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / lengthSq));
  return Math.hypot(a.x + ab.x * t - point.x, a.y + ab.y * t - point.y);
}

/**
 * The first obstacle a duct along a→b (half its width, its level band)
 * clashes with, sampled every 25 mm; `trimStartMm` / `trimEndMm` leave its
 * ends out (where it meets what it is joined to).
 */
export function ductClash(
  a: Point2D, b: Point2D, halfWidthMm: number, zMin: number, zMax: number, obstacles: readonly PlanObstacle[], trimStartMm = 0, trimEndMm = 0,
): PlanObstacle | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const near = obstacles.filter((obstacle) => obstacle.zMin < zMax - 1 && obstacle.zMax > zMin + 1);
  if (!near.length || length - trimStartMm - trimEndMm < 0) return null;
  const steps = Math.max(1, Math.ceil((length - trimStartMm - trimEndMm) / 25));
  for (let step = 0; step <= steps; step += 1) {
    const along = trimStartMm + ((length - trimStartMm - trimEndMm) * step) / steps;
    const point = length < EPS ? a : { x: a.x + ((b.x - a.x) * along) / length, y: a.y + ((b.y - a.y) * along) / length };
    for (const obstacle of near) {
      const gap = obstacle.shape.kind === 'leg'
        ? distanceToSegment(point, obstacle.shape.a, obstacle.shape.b) - obstacle.shape.halfWidthMm
        : distanceToOutline(point, obstacle.shape.corners);
      if (gap < halfWidthMm - 1) return obstacle;
    }
  }
  return null;
}

/**
 * Whether a run's rigid legs clash with `obstacles` or cross themselves (legs
 * that are not neighbours overlapping). `skipFirst`: its first leg leaves a
 * casing in the obstacles (it is not checked against the outlines).
 */
export function runClashes(spec: DuctRunSpec, obstacles: readonly PlanObstacle[], options: { firstLegClearOf?: ReadonlySet<string> } = {}): boolean {
  const own = runObstacles('self', spec);
  for (let index = 0; index < own.length; index += 1) {
    const leg = own[index]!;
    if (leg.shape.kind !== 'leg') continue;
    const others = index === 0 && options.firstLegClearOf ? obstacles.filter((obstacle) => !options.firstLegClearOf!.has(obstacle.ownerId)) : obstacles;
    // Neighbouring legs meet at their elbow: only legs two or more apart may not overlap.
    const self = own.filter((_, other) => Math.abs(other - index) >= 2);
    if (ductClash(leg.shape.a, leg.shape.b, leg.shape.halfWidthMm, leg.zMin, leg.zMax, [...others, ...self])) return true;
  }
  return false;
}

// ---- The re-route. ----

/** Plan frame with its x along `axis` (a unit vector): a route square to it is cardinal there. */
export function frame(origin: Point2D, axis: Point2D) {
  const v = { x: -axis.y, y: axis.x };
  return {
    toLocal: (p: Point2D): Point2D => ({ x: (p.x - origin.x) * axis.x + (p.y - origin.y) * axis.y, y: (p.x - origin.x) * v.x + (p.y - origin.y) * v.y }),
    dirToLocal: (d: Point2D): Point2D => ({ x: d.x * axis.x + d.y * axis.y, y: d.x * v.x + d.y * v.y }),
    toWorld: (q: Point2D): Point2D => ({ x: origin.x + axis.x * q.x + v.x * q.y, y: origin.y + axis.y * q.x + v.y * q.y }),
  };
}

/** The cardinal direction `d` is (within 0.06°), or null. */
export function cardinalOf(d: Point2D): Point2D | null {
  if (Math.abs(Math.abs(d.x) - 1) < 1e-3 && Math.abs(d.y) < 1e-3) return { x: Math.sign(d.x), y: 0 };
  if (Math.abs(Math.abs(d.y) - 1) < 1e-3 && Math.abs(d.x) < 1e-3) return { x: 0, y: Math.sign(d.y) };
  return null;
}

export function boxOf(points: readonly Point2D[], pad = 0): OrthogonalRouteObstacle {
  return {
    minX: Math.min(...points.map((point) => point.x)) - pad, minY: Math.min(...points.map((point) => point.y)) - pad,
    maxX: Math.max(...points.map((point) => point.x)) + pad, maxY: Math.max(...points.map((point) => point.y)) + pad,
  };
}

/** Points with those in the middle of a straight run dropped. */
export function corners(points: readonly Point2D[]): Point2D[] {
  const out: Point2D[] = [];
  for (const point of points) {
    if (out.length && Math.hypot(point.x - out[out.length - 1]!.x, point.y - out[out.length - 1]!.y) < 0.01) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const forward = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      if (Math.abs(cross) > 0.01 * Math.hypot(b.x - a.x, b.y - a.y) || forward < 0) break;
      out.pop();
    }
    out.push(point);
  }
  return out;
}

/**
 * Re-route `spec` (a run on a unit's collar) from the turned collar `to` back
 * onto its route before its first take-off; null when no route keeps the rest
 * of the run as it is without breaking a rule or clashing.
 */
export function rerouteFromCollar(input: CollarRerouteInput): CollarReroute | null {
  const { scene, settings, run, spec, to } = input;
  if (spec.legacy || spec.start.kind !== 'unit-port' || spec.path.length < 2) return null;
  const unitId = spec.start.unitId;
  const legs = ductLegs(spec);
  const firstGeometry = legs[0];
  if (!firstGeometry || firstGeometry.vertical || firstGeometry.sloped) return null;
  const f = frame(to.point, firstGeometry.direction);
  const leaving = f.dirToLocal(to.direction);
  /** The collar's direction when it is square to the route's axes (null: turned off them). */
  const d = cardinalOf(leaving);

  const flexTail = spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 3;
  const rigidLegs = spec.legs.length - (flexTail ? 1 : 0);
  const first = spec.legs[0]!;
  const width = first.diameterMm ?? first.widthMm;
  const half = width / 2 + spec.insulationThicknessMm;
  const band = { zMin: to.z, zMax: to.z + (first.diameterMm ?? first.heightMm) + 2 * spec.insulationThicknessMm };
  const turnRoom = elbowRoomMm(first, 90, settings);
  // The router's elbow allowance on each side of a turn: the elbow's room and half the joint margin.
  const radius = turnRoom + MARGIN_MM / 2;
  // The router keeps the centreline `clearance + radius` off what it avoids: at least the duct's half width and a side clearance.
  const clearance = Math.max(0, half + SIDE_CLEARANCE_MM - radius);
  const pad = clearance + radius;
  const reserve = collarReserveMm(spec, scene, settings);
  const tightReserve = collarReserveMm(spec, scene, settings, true);

  // ---- What must stay: take-offs and accessories on the run, by leg (the route joins before the first). ----
  const children = ductBranchesOf(run.id, scene);
  const keepBefore = new Map<number, number>();
  const hold = (legIndex: number, stationMm: number) => keepBefore.set(legIndex, Math.min(keepBefore.get(legIndex) ?? Infinity, stationMm));
  for (const child of children) {
    if (child.start.kind !== 'tap') continue;
    const section = child.spec.legs[0];
    hold(child.start.legIndex, child.start.stationMm - (section ? (section.diameterMm ?? section.widthMm) / 2 : 0) - MARGIN_MM);
  }
  for (const item of spec.inline ?? []) hold(item.legIndex, item.stationMm - (item.lengthMm ?? 300) / 2 - MARGIN_MM);
  const lastJoinLeg = Math.min(rigidLegs - 1, ...[...keepBefore.keys()]);

  // ---- Obstacles (local): the casing, its collar face drawn back so the route may leave square from the collar; ----
  // ---- what else stands at the duct's level (not the run itself or its branches: the clash check judges those). ----
  const casing = boxOf(input.unit.map(f.toLocal));
  if (d) {
    if (d.x > 0) casing.maxX -= radius; else if (d.x < 0) casing.minX += radius; else if (d.y > 0) casing.maxY -= radius; else casing.minY += radius;
  }
  const others = planObstacles(scene, new Set([run.id, unitId, ...children.map((child) => child.element.id)]))
    .filter((obstacle) => obstacle.zMin < band.zMax - 1 && obstacle.zMax > band.zMin + 1);
  const obstacles: OrthogonalRouteObstacle[] = [
    casing,
    ...(input.avoid ?? []).map((outline) => boxOf(outline.map(f.toLocal), half)),
    ...others.map((obstacle) => (obstacle.shape.kind === 'leg'
      ? boxOf([obstacle.shape.a, obstacle.shape.b].map(f.toLocal), obstacle.shape.halfWidthMm)
      : boxOf(obstacle.shape.corners.map(f.toLocal)))),
  ];
  const clear = (point: Point2D) => obstacles.every((box) => point.x <= box.minX - pad + EPS || point.x >= box.maxX + pad - EPS
    || point.y <= box.minY - pad + EPS || point.y >= box.maxY + pad - EPS);
  // Where the router starts: square off the collar past the casing's clearance (its connector and transition at
  // least); off the route's axes, at the end of a stub that turns onto one of them (`lead`: what the stub costs).
  const starts: Array<{ point: Point2D; direction: Point2D; straightMm: number; lead: number }> = [];
  if (d) {
    const faceAlong = d.x > 0 ? casing.maxX : d.x < 0 ? -casing.minX : d.y > 0 ? casing.maxY : -casing.minY;
    // The collar's transition at the design taper; where that does not fit (a wall close in front), compressed.
    for (const [first, extra] of [[reserve, 0], [tightReserve, COMPRESSED_TRANSITION_COST_MM]] as const) {
      const along = Math.max(first, faceAlong + pad) + 1;
      if (starts.some((begin) => Math.abs(begin.lead - along) < 1)) continue;
      starts.push({ point: { x: d.x * along, y: d.y * along }, direction: d, straightMm: 0, lead: along + extra });
    }
  } else {
    for (const axis of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      const cos = axis.x * leaving.x + axis.y * leaving.y;
      if (cos < 0.01) continue;
      const room = elbowRoomMm(first, (Math.acos(Math.min(1, cos)) * 180) / Math.PI, settings);
      for (const [held, extra] of [[reserve, 0], [tightReserve, COMPRESSED_TRANSITION_COST_MM]] as const) {
        for (let along = held + room + MARGIN_MM; along <= 4000; along += 100) {
          const point = { x: leaving.x * along, y: leaving.y * along };
          if (!clear(point)) continue;
          if (!starts.some((begin) => Math.hypot(begin.point.x - point.x, begin.point.y - point.y) < 1)) {
            starts.push({ point, direction: axis, straightMm: room + MARGIN_MM / 2, lead: along + BEND_PENALTY_MM + extra });
          }
          break;
        }
      }
    }
  }
  const usable = starts.filter((begin) => clear(begin.point));
  if (!usable.length) return null;

  // ---- What a candidate may not clash with: everything at its level, the run's branches, and the casing past its first leg. ----
  const clashWith = [
    ...planObstacles(scene, new Set([run.id, unitId])),
    { ownerId: unitId, shape: { kind: 'outline' as const, corners: input.unit }, zMin: band.zMin, zMax: band.zMax },
  ];

  const baselineErrors = errorCodes(getDuctRunPlan(run, input.baseline, settings));
  const tried: Array<{ cost: number; build: () => CollarReroute | null }> = [];
  for (let k = 0; k <= lastJoinLeg; k += 1) {
    const leg = legs[k]!;
    if (leg.vertical || leg.sloped || Math.abs(leg.start.z - to.z) > 0.5) continue;
    const e = cardinalOf(f.dirToLocal(leg.direction));
    if (!e) continue;
    // The furthest the join may be: short of its take-offs and accessories, and of the fitting at the leg's end.
    const next = legs[k + 1];
    const endRoom = k + 1 < rigidLegs && next
      ? (next.vertical ? elbowRoomMm(spec.legs[k]!, 90, settings, spec.legs[k]!.heightMm) : elbowRoomMm(spec.legs[k]!, Math.acos(Math.max(-1, Math.min(1, leg.direction.x * next.direction.x + leg.direction.y * next.direction.y))) * 180 / Math.PI, settings)) + MARGIN_MM
      : flexTail && k === rigidLegs - 1 ? 100 : 0;
    const furthest = Math.min(leg.lengthMm - endRoom, keepBefore.get(k) ?? Infinity);
    const legStart = f.toLocal(leg.start);
    const at = (station: number) => ({ x: legStart.x + e.x * station, y: legStart.y + e.y * station });
    // The nearest join clear of every obstacle (the router needs its last turn clear too), and the furthest.
    let nearest: number | null = null;
    for (let station = radius; station <= furthest; station += 50) {
      if (clear(at(station)) && clear(at(station - radius))) { nearest = station; break; }
    }
    if (nearest === null) continue;
    for (const station of [...new Set([nearest, furthest])]) {
      if (station < nearest) continue;
      const end = at(station);
      for (const begin of usable) {
        const found = findObstacleAwareOrthogonalRoute({
          start: begin.point, startDirection: begin.direction, end, endDirection: { x: -e.x, y: -e.y },
          startStraightMm: begin.straightMm, endStraightMm: 0, bendRadiusMm: radius, obstacles, clearanceMm: clearance, bendPenaltyMm: BEND_PENALTY_MM,
        });
        if (!found) continue;
        // What the route costs against what it drops of the old leg (the rest of the run is the same either way).
        tried.push({ cost: begin.lead + found.objectiveMm - station, build: () => assemble(k, found.points) });
      }
    }
  }

  /** The run with its route up to leg k replaced by the found one (local points from `start` to the join). */
  const assemble = (k: number, route: readonly Point2D[]): CollarReroute | null => {
    const leg = legs[k]!;
    const world = corners([to.point, ...route.map(f.toWorld), { x: leg.end.x, y: leg.end.y }]);
    // The new corners (the collar's lip first, the join on leg k's line last).
    const prefix = world.slice(0, -1);
    const bends = prefix.length - 1;
    if (bends < 1) return null;
    const join = prefix[prefix.length - 1]!;
    const joinStation = (join.x - leg.start.x) * leg.direction.x + (join.y - leg.start.y) * leg.direction.y;
    const z = to.z;
    const path: DuctPoint3[] = [...prefix.map((point) => ({ x: point.x, y: point.y, z })), ...spec.path.slice(k + 1)];
    const nextLegs: DuctLeg[] = [...Array.from({ length: bends }, () => first), spec.legs[k]!, ...spec.legs.slice(k + 1)];
    if (nextLegs.length !== path.length - 1) return null;
    // Old leg j ≥ k is new leg j − k + bends; on leg k, places are measured from the join (exactly: the join is on its line).
    const relocate = (legIndex: number, stationMm: number) => (legIndex < k ? { legIndex, stationMm }
      : legIndex === k ? { legIndex: bends, stationMm: stationMm - joinStation } : { legIndex: legIndex - k + bends, stationMm });
    const nodeOverrides: Record<string, DuctNodeOverride> = {};
    for (const [node, override] of Object.entries(spec.nodeOverrides)) {
      const index = Number(node);
      if (index > k) nodeOverrides[String(index - k + bends)] = override;
    }
    const inline = (spec.inline ?? []).map((item) => ({ ...item, ...relocate(item.legIndex, item.stationMm) }));
    const { inline: _inline, ...rest } = spec;
    const next: DuctRunSpec = { ...rest, path, legs: nextLegs, nodeOverrides, ...(inline.length ? { inline } : {}) };
    // No clash: the new legs against everything at their level, the run's own kept legs and branches, and (past the
    // first, which leaves its face) the casing.
    const kept = runObstacles(run.id, next, bends + 1);
    for (let index = 0; index < bends; index += 1) {
      const against = index === 0 ? [...clashWith.filter((obstacle) => obstacle.ownerId !== unitId), ...kept] : [...clashWith, ...kept];
      if (ductClash(prefix[index]!, prefix[index + 1]!, half, band.zMin, band.zMax, against)) return null;
    }
    const renumbered = children.flatMap((child) => (child.start.kind === 'tap'
      ? [ductRunElementWithSpec(child.element, { ...child.spec, start: { ...child.start, ...relocate(child.start.legIndex, child.start.stationMm) } })]
      : []));
    const replaced = new Map([[run.id, ductRunElementWithSpec(run, next)], ...renumbered.map((child) => [child.id, child] as const)]);
    const trial = scene.map((element) => replaced.get(element.id) ?? element);
    if (!noNewErrors(baselineErrors, errorCodes(planDuctRunSpec(run.id, next, { settings, scene: trial })))) return null;
    return { spec: next, relocate, elbows: bends };
  };

  for (const candidate of tried.sort((a, b) => a.cost - b.cost)) {
    const built = candidate.build();
    if (built) return built;
  }
  return null;
}

/**
 * What a route costs to make and run, to choose between ways of re-routing a
 * run: its rigid legs' length plus an elbow's worth of duct for each turn.
 */
export function routeCostMm(spec: DuctRunSpec): number {
  const flexTail = spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 3;
  const legs = ductLegs(spec).slice(0, spec.legs.length - (flexTail ? 1 : 0));
  let cost = legs.reduce((total, leg) => total + leg.lengthMm, 0);
  for (let index = 1; index < legs.length; index += 1) {
    const a = legs[index - 1]!;
    const b = legs[index]!;
    if (a.vertical || b.vertical || a.direction.x * b.direction.x + a.direction.y * b.direction.y < Math.cos(Math.PI / 180)) cost += BEND_PENALTY_MM;
  }
  return cost;
}

/** The plan outline of a run's level legs (to keep a later route clear of it). */
export function runOutline(spec: DuctRunSpec, fromLeg = 0, toLeg = spec.legs.length): Point2D[][] {
  return ductLegs(spec).slice(fromLeg, toLeg).filter((leg) => !leg.vertical).map((leg) => [
    { x: leg.start.x, y: leg.start.y }, { x: leg.end.x, y: leg.end.y },
  ]);
}
