/**
 * Geometry of a duct run: leg directions, turn angles and elbow setbacks/arcs.
 * Coordinates are model millimetres (X right, Y down, z up); turn sides come
 * from the cross product, so the formulas hold in either handedness.
 *
 * A leg is level (both ends at one z) or vertical (both ends at one plan
 * point): a riser or a drop. A vertical leg keeps the heading of the level leg
 * it leaves (its W stays horizontal, square to that heading, so both of its
 * elbows bend the easy way). Its fittings are laid out in a vertical plane
 * through the riser: local (s, t) = (distance along the heading, elevation).
 */
import type { Point2D } from '../../../../types';

import type { DuctPoint3, DuctRunSpec } from './ductTypes';

export const TURN_EPSILON_DEG = 2;

export function sub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(a: Point2D, k: number): Point2D {
  return { x: a.x * k, y: a.y * k };
}

export function length(a: Point2D): number {
  return Math.hypot(a.x, a.y);
}

export function unit(a: Point2D): Point2D {
  const l = length(a);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

export function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

/** Perpendicular to `d`, rotated toward the side the run turns to. */
export function perpToward(d: Point2D, sign: number): Point2D {
  return sign >= 0 ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };
}

export interface DuctLegGeometry {
  index: number;
  start: DuctPoint3;
  end: DuctPoint3;
  /** Plan direction; a vertical leg's is the heading of the level leg it leaves (or joins). */
  direction: Point2D;
  /** Centreline length: the plan length of a level leg, the centreline rise of a vertical one. */
  lengthMm: number;
  /** +1 riser, −1 drop, 0 level (or sloped). */
  vertical: 0 | 1 | -1;
  /** Both the plan position and the level change: ducts are level or vertical, so this is refused. */
  sloped: boolean;
  /** Centreline elevation at the leg's start and end (vertical legs; level legs follow their sections). */
  startCentreZ: number;
  endCentreZ: number;
}

const LEVEL_EPSILON_MM = 0.5;

/**
 * Centreline elevation at path vertex `i`: its clear bottom plus half the
 * height of the section arriving there (the first leg's at the start).
 */
export function vertexCentreZ(spec: Pick<DuctRunSpec, 'path' | 'legs'>, index: number): number {
  const section = spec.legs[Math.max(0, index - 1)] ?? spec.legs[0];
  return spec.path[index]!.z + (section?.heightMm ?? 0) / 2;
}

export function ductLegs(spec: DuctRunSpec): DuctLegGeometry[] {
  const raw = spec.path.slice(1).map((end, index) => {
    const start = spec.path[index]!;
    const plan = sub(end, start);
    const planLength = length(plan);
    const rise = end.z - start.z;
    const vertical: 0 | 1 | -1 = planLength < LEVEL_EPSILON_MM && Math.abs(rise) > LEVEL_EPSILON_MM ? (rise > 0 ? 1 : -1) : 0;
    return { index, start, end, plan, planLength, vertical, sloped: planLength >= LEVEL_EPSILON_MM && Math.abs(rise) > LEVEL_EPSILON_MM };
  });
  // A vertical leg's heading: the level leg before it, else the one after it.
  const headingOf = (index: number): Point2D => {
    for (let k = index - 1; k >= 0; k -= 1) if (!raw[k]!.vertical) return unit(raw[k]!.plan);
    for (let k = index + 1; k < raw.length; k += 1) if (!raw[k]!.vertical) return unit(raw[k]!.plan);
    return { x: 1, y: 0 };
  };
  return raw.map((leg) => {
    const startCentreZ = vertexCentreZ(spec, leg.index);
    const endCentreZ = vertexCentreZ(spec, leg.index + 1);
    return {
      index: leg.index,
      start: leg.start,
      end: leg.end,
      direction: leg.vertical ? headingOf(leg.index) : unit(leg.plan),
      lengthMm: leg.vertical ? Math.abs(endCentreZ - startCentreZ) : leg.planLength,
      vertical: leg.vertical,
      sloped: leg.sloped,
      startCentreZ,
      endCentreZ,
    };
  });
}

/** A vertical plane through `origin` containing `heading`: local (s, t) ↦ plan origin + s·heading, elevation t. */
export interface DuctVerticalFrame {
  origin: Point2D;
  heading: Point2D;
}

export function frameToPlan(frame: DuctVerticalFrame, local: Point2D): Point2D {
  return add(frame.origin, scale(frame.heading, local.x));
}

export function frameToWorld(frame: DuctVerticalFrame, local: Point2D): DuctPoint3 {
  const plan = frameToPlan(frame, local);
  return { x: plan.x, y: plan.y, z: local.y };
}

/** Turn angle at an interior node (degrees, 0 = straight on). */
export function turnAngleDeg(incoming: Point2D, outgoing: Point2D): number {
  const cosine = Math.max(-1, Math.min(1, dot(incoming, outgoing)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

export interface ElbowPlanGeometry {
  angleDeg: number;
  /** +1 / −1: side the run turns to (sign of cross(in, out)). */
  turnSign: number;
  corner: Point2D;
  inDirection: Point2D;
  outDirection: Point2D;
  /** Radius elbow: centreline radius; square elbow: 0. */
  centrelineRadiusMm: number;
  /** Distance from the corner to where the fitting's bend starts, on each leg. */
  setbackMm: number;
  neckMm: number;
  /** Fitting ends (after the necks), on the incoming and outgoing legs. */
  startPoint: Point2D;
  endPoint: Point2D;
  /** Bend start/end and arc centre (radius elbows). */
  bendStart: Point2D;
  bendEnd: Point2D;
  arcCentre: Point2D | null;
}

export function radiusElbowGeometry(
  corner: Point2D, inDirection: Point2D, outDirection: Point2D, centrelineRadiusMm: number, neckMm: number,
): ElbowPlanGeometry {
  const angleDeg = turnAngleDeg(inDirection, outDirection);
  const theta = (angleDeg * Math.PI) / 180;
  const setbackMm = centrelineRadiusMm * Math.tan(theta / 2);
  const turnSign = Math.sign(cross(inDirection, outDirection)) || 1;
  const bendStart = sub(corner, scale(inDirection, setbackMm));
  const bendEnd = add(corner, scale(outDirection, setbackMm));
  return {
    angleDeg, turnSign, corner, inDirection, outDirection,
    centrelineRadiusMm, setbackMm, neckMm,
    startPoint: sub(bendStart, scale(inDirection, neckMm)),
    endPoint: add(bendEnd, scale(outDirection, neckMm)),
    bendStart, bendEnd,
    arcCentre: add(bendStart, scale(perpToward(inDirection, turnSign), centrelineRadiusMm)),
  };
}

/** Square-throat elbow with turning vanes: the fitting occupies the W × W corner square. */
export function squareElbowGeometry(
  corner: Point2D, inDirection: Point2D, outDirection: Point2D, inPlaneWidthMm: number, neckMm: number,
): ElbowPlanGeometry {
  const setbackMm = inPlaneWidthMm / 2;
  const bendStart = sub(corner, scale(inDirection, setbackMm));
  const bendEnd = add(corner, scale(outDirection, setbackMm));
  return {
    angleDeg: turnAngleDeg(inDirection, outDirection),
    turnSign: Math.sign(cross(inDirection, outDirection)) || 1,
    corner, inDirection, outDirection,
    centrelineRadiusMm: 0, setbackMm, neckMm,
    startPoint: sub(bendStart, scale(inDirection, neckMm)),
    endPoint: add(bendEnd, scale(outDirection, neckMm)),
    bendStart, bendEnd, arcCentre: null,
  };
}

/** Sample a radius elbow's centreline (bend only), inclusive of both ends. */
export function sampleElbowArc(elbow: ElbowPlanGeometry, segments: number): Point2D[] {
  return sampleArc(elbow, elbow.centrelineRadiusMm, segments);
}

/**
 * Sample the arc concentric with a radius elbow at `radiusMm` (centreline,
 * heel or throat). The sweep runs the way that makes the arc's tangent at the
 * start match the incoming leg.
 */
export function sampleArc(elbow: ElbowPlanGeometry, radiusMm: number, segments: number): Point2D[] {
  const centre = elbow.arcCentre;
  if (!centre) return [elbow.bendStart, elbow.corner, elbow.bendEnd];
  const startAngle = Math.atan2(elbow.bendStart.y - centre.y, elbow.bendStart.x - centre.x);
  const increasingTangent = { x: -Math.sin(startAngle), y: Math.cos(startAngle) };
  const direction = dot(increasingTangent, elbow.inDirection) >= 0 ? 1 : -1;
  const sweep = (elbow.angleDeg * Math.PI) / 180;
  const points: Point2D[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + (direction * sweep * index) / segments;
    points.push({ x: centre.x + radiusMm * Math.cos(angle), y: centre.y + radiusMm * Math.sin(angle) });
  }
  return points;
}
