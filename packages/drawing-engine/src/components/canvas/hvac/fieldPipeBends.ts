import type { Point2D } from '../../../types';

import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import { bendRadiusFromDiameterMm } from './pipeTopology';

/** Shared saved radius policy for field geometry, elevation lifting and mesh. */
export function resolveFieldPipeBendRadiusMm(outerDiameterMm: number, storedFactor?: unknown): number {
  return bendRadiusFromDiameterMm(outerDiameterMm,
    typeof storedFactor === 'number' && Number.isFinite(storedFactor) && storedFactor > 0
      ? storedFactor : getActivePipeRoutingSettings().bendRadiusFactor);
}

/** A field tube bend has constant curvature and tangent straight legs. A
 * manufactured elbow additionally needs its own catalogue takeoffs and
 * sockets; a drawn 90-degree turn alone does not identify a purchasable part. */
export interface FieldPipeBend {
  vertexIndex: number;
  angleDeg: number;
  standardAngleDeg: 45 | 90 | null;
  radiusMm: number;
  setbackMm: number;
  fits: boolean;
  unresolvedReason?: 'direction-reversal' | 'insufficient-straight';
  center: Point2D;
  entry: Point2D;
  exit: Point2D;
  sweepRadians: number;
}

export interface CircularFieldPipeSegment {
  points: Point2D[];
  lengthMm: number;
  invalidBend: boolean;
}

const EPSILON = 1e-6;
const distance = (a: Point2D, b: Point2D) => Math.hypot(b.x - a.x, b.y - a.y);

export interface FieldPipeStraightAllowances {
  startStraightMm?: number;
  endStraightMm?: number;
}

export function resolveFieldPipeBends(points: readonly Point2D[], radiusMm: number,
  allowances: FieldPipeStraightAllowances = {}): FieldPipeBend[] {
  if (!Number.isFinite(radiusMm) || radiusMm <= EPSILON) return [];
  const bends: FieldPipeBend[] = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!; const vertex = points[index]!; const next = points[index + 1]!;
    const before = distance(previous, vertex); const after = distance(vertex, next);
    if (before <= EPSILON || after <= EPSILON) continue;
    const incoming = { x: (vertex.x - previous.x) / before, y: (vertex.y - previous.y) / before };
    const outgoing = { x: (next.x - vertex.x) / after, y: (next.y - vertex.y) / after };
    const angle = Math.acos(Math.max(-1, Math.min(1, incoming.x * outgoing.x + incoming.y * outgoing.y)));
    if (angle < EPSILON) continue;
    if (angle > Math.PI - EPSILON) {
      // A zero-clearance return is not a straight continuation or a formed
      // U-bend. Retain its authored corner but mark both adjoining spans.
      bends.push({ vertexIndex: index, angleDeg: 180, standardAngleDeg: null,
        radiusMm, setbackMm: 0, fits: false, unresolvedReason: 'direction-reversal',
        center: { ...vertex }, entry: { ...vertex }, exit: { ...vertex }, sweepRadians: 0 });
      continue;
    }
    const sign = Math.sign(incoming.x * outgoing.y - incoming.y * outgoing.x);
    const setbackMm = radiusMm * Math.tan(angle / 2);
    const entry = { x: vertex.x - incoming.x * setbackMm, y: vertex.y - incoming.y * setbackMm };
    const exit = { x: vertex.x + outgoing.x * setbackMm, y: vertex.y + outgoing.y * setbackMm };
    const angleDeg = angle * 180 / Math.PI;
    bends.push({ vertexIndex: index, angleDeg,
      standardAngleDeg: Math.abs(angleDeg - 90) < 1e-4 ? 90 : Math.abs(angleDeg - 45) < 1e-4 ? 45 : null,
      radiusMm, setbackMm, fits: true, entry, exit, sweepRadians: sign * angle,
      center: { x: entry.x - incoming.y * sign * radiusMm, y: entry.y + incoming.x * sign * radiusMm } });
  }
  const atVertex = new Map(bends.map(bend => [bend.vertexIndex, bend]));
  // Adjacent fittings share the available straight. Check both takeoffs
  // together; never squeeze a specified elbow down to a cosmetic radius.
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = atVertex.get(index); const to = atVertex.get(index + 1);
    const required = (from?.setbackMm ?? 0) + (to?.setbackMm ?? 0)
      + (index === 0 ? Math.max(0, allowances.startStraightMm ?? 0) : 0)
      + (index === points.length - 2 ? Math.max(0, allowances.endStraightMm ?? 0) : 0);
    if (required > distance(points[index]!, points[index + 1]!) + EPSILON) {
      for (const bend of [from, to]) if (bend && bend.fits) {
        bend.fits = false;
        bend.unresolvedReason = 'insufficient-straight';
      }
    }
  }
  return bends;
}

/** One output per authored span, split at the midpoint of each adjacent bend.
 * This keeps editing/material identities while drawing each elbow only once.
 * Insufficient space remains an unresolved corner, not a distorted fitting. */
export function buildCircularFieldPipeSegments(
  route: readonly Point2D[],
  radiusMm: number,
  allowances: FieldPipeStraightAllowances = {},
): CircularFieldPipeSegment[] {
  const bends = new Map(resolveFieldPipeBends(route, radiusMm, allowances).map(bend => [bend.vertexIndex, bend]));
  const sampleHalf = (bend: FieldPipeBend, second: boolean): Point2D[] => {
    const divisions = Math.max(2, Math.ceil(Math.abs(bend.sweepRadians) / (Math.PI / 24)));
    const initial = Math.atan2(bend.entry.y - bend.center.y, bend.entry.x - bend.center.x);
    return Array.from({ length: divisions + 1 }, (_, index) => {
      const t = (second ? 0.5 : 0) + index / divisions * 0.5;
      if (t === 0) return { ...bend.entry };
      if (t === 1) return { ...bend.exit };
      const angle = initial + bend.sweepRadians * t;
      return { x: bend.center.x + Math.cos(angle) * bend.radiusMm, y: bend.center.y + Math.sin(angle) * bend.radiusMm };
    });
  };
  return route.slice(1).map((end, index) => {
    const before = bends.get(index); const after = bends.get(index + 1);
    const prefix = before?.fits ? sampleHalf(before, true) : [{ ...route[index]! }];
    const suffix = after?.fits ? sampleHalf(after, false) : [{ ...end }];
    const lengthMm = distance(prefix.at(-1)!, suffix[0]!)
      + (before?.fits ? before.radiusMm * Math.abs(before.sweepRadians) / 2 : 0)
      + (after?.fits ? after.radiusMm * Math.abs(after.sweepRadians) / 2 : 0);
    const points = [...prefix, ...suffix].filter((point, i, all) => i === 0 || distance(all[i - 1]!, point) > EPSILON);
    return { points, lengthMm, invalidBend: before?.fits === false || after?.fits === false };
  });
}
