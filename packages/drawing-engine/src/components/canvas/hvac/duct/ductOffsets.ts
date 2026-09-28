/**
 * Offsets (SMACNA Fig. 2-7, p.2.9): a jog between two parallel legs made as
 * one fitting when two elbows do not fit on the short leg between them.
 *
 *  - Type 2 mitred: the jog leg itself with mitred ends; 60° maximum. A 45°
 *    jog drawn in 45° mode is exactly this.
 *  - Type 3 radiussed (ogee): two opposite arcs, throat radius 150 mm minimum.
 *    Used for a 90° Z, which a mitred offset may not make.
 *
 * All geometry is plan (x, y); the section stays constant through the offset.
 */
import type { Point2D } from '../../../../types';

import { OFFSET_LIMITS } from './ductFittingRules';
import { add, cross, dot, length, scale, sub, unit } from './ductGeometry';

export type DuctOffsetType = 'mitered' | 'ogee';

export interface DuctOffsetGeometry {
  type: DuctOffsetType;
  /** Centreline neck to neck (the ogee sampled along its arcs). */
  centreline: Point2D[];
  /** Direction of the parallel legs. */
  direction: Point2D;
  /** Unit vector from the incoming leg's line toward the outgoing leg's line. */
  lateral: Point2D;
  lateralOffsetMm: number;
  /** Mitred: the jog angle from the leg axis; ogee: each arc's turn angle. */
  angleDeg: number;
  /** Ogee only. */
  centrelineRadiusMm: number | null;
  throatRadiusMm: number | null;
  neckMm: number;
  /** Polyline length taken from the leg before node A and after node B. */
  consumeInMm: number;
  consumeOutMm: number;
  developedLengthMm: number;
}

function sampleOgee(start: Point2D, end: Point2D, d: Point2D, lateral: Point2D, radius: number, phi: number, segments: number): Point2D[] {
  const c1 = add(start, scale(lateral, radius));
  const c2 = sub(end, scale(lateral, radius));
  const points: Point2D[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = (phi * index) / segments;
    points.push(add(c1, add(scale(lateral, -radius * Math.cos(t)), scale(d, radius * Math.sin(t)))));
  }
  for (let index = segments - 1; index >= 0; index -= 1) {
    const t = (phi * index) / segments;
    points.push(add(c2, add(scale(lateral, radius * Math.cos(t)), scale(d, -radius * Math.sin(t)))));
  }
  return points;
}

/**
 * The offset between node A (end of the incoming leg) and node B (start of the
 * outgoing leg), both legs running along `direction`. Null when the jog is not
 * an offset (legs not parallel, or an ogee that would need more than 90°).
 */
export function jogOffset(
  nodeA: Point2D,
  nodeB: Point2D,
  direction: Point2D,
  inPlaneWidthMm: number,
  neckMm: number,
  preferredCentrelineRadiusMm: number,
): DuctOffsetGeometry | null {
  const d = unit(direction);
  const jog = sub(nodeB, nodeA);
  const along = dot(jog, d);
  const signedLateral = cross(d, jog);
  const offset = Math.abs(signedLateral);
  if (offset < 1) return null;
  const lateral = scale({ x: -d.y, y: d.x }, Math.sign(signedLateral));
  const jogAngleDeg = (Math.atan2(offset, along) * 180) / Math.PI;

  if (jogAngleDeg <= OFFSET_LIMITS.miteredMaxDeg + 1e-6) {
    const start = sub(nodeA, scale(d, neckMm));
    const end = add(nodeB, scale(d, neckMm));
    return {
      type: 'mitered', centreline: [start, nodeA, nodeB, end], direction: d, lateral, lateralOffsetMm: offset,
      angleDeg: jogAngleDeg, centrelineRadiusMm: null, throatRadiusMm: null, neckMm,
      consumeInMm: neckMm, consumeOutMm: neckMm, developedLengthMm: 2 * neckMm + length(jog),
    };
  }

  // Ogee: centreline radius R with the throat (R − W/2) at least 150 mm.
  const minimum = OFFSET_LIMITS.ogeeMinThroatRadiusMm + inPlaneWidthMm / 2;
  const radius = Math.max(minimum, preferredCentrelineRadiusMm);
  if (offset >= 2 * radius) return null;
  const phi = Math.acos(1 - offset / (2 * radius));
  const run = 2 * radius * Math.sin(phi);
  // A jog longer along the axis than the S needs a straight between its arcs: that is two elbows.
  if (along > run) return null;
  // The S is centred on the jog; it takes (run − along) / 2 from each parallel leg.
  const share = (run - along) / 2;
  const start = sub(nodeA, scale(d, share));
  const end = add(nodeB, scale(d, share));
  const curve = sampleOgee(start, end, d, lateral, radius, phi, 12);
  return {
    type: 'ogee',
    centreline: [sub(start, scale(d, neckMm)), ...curve, add(end, scale(d, neckMm))],
    direction: d, lateral, lateralOffsetMm: offset,
    angleDeg: (phi * 180) / Math.PI, centrelineRadiusMm: radius, throatRadiusMm: radius - inPlaneWidthMm / 2, neckMm,
    consumeInMm: share + neckMm, consumeOutMm: share + neckMm,
    developedLengthMm: 2 * radius * phi + 2 * neckMm,
  };
}

/** The smallest-radius ogee (tightest SMACNA allows), for when the preferred one does not fit. */
export function tightestOgee(nodeA: Point2D, nodeB: Point2D, direction: Point2D, inPlaneWidthMm: number, neckMm: number): DuctOffsetGeometry | null {
  return jogOffset(nodeA, nodeB, direction, inPlaneWidthMm, neckMm, 0);
}
