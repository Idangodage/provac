/**
 * How close a unit's gas and liquid lines come to each other near the unit,
 * surface to surface of their insulation: the check that the field pair
 * leaves the maker's stubs without its insulation running into itself.
 */
import type { HvacElement } from '../../../types';

import { resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import { liftPipePlanRouteTo3d, readPipeRouteNodes3d } from './pipeRoute3d';
import { buildRefrigerantPipeVisual, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

interface Point3 { x: number; y: number; z: number }

const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Closest points of two 3D segments (Ericson, Real-Time Collision Detection §5.1.9): their distance and midpoint. */
export function segmentDistance3(p1: Point3, q1: Point3, p2: Point3, q2: Point3): { distance: number; at: Point3 } {
  const d1 = sub(q1, p1); const d2 = sub(q2, p2); const r = sub(p1, p2);
  const a = dot(d1, d1); const e = dot(d2, d2); const f = dot(d2, r);
  let s = 0; let t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0; t = 0;
  } else if (a <= 1e-12) {
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1 = { x: p1.x + d1.x * s, y: p1.y + d1.y * s, z: p1.z + d1.z * s };
  const c2 = { x: p2.x + d2.x * t, y: p2.y + d2.y * t, z: p2.z + d2.z * t };
  const gap = sub(c1, c2);
  return { distance: Math.sqrt(dot(gap, gap)), at: { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2, z: (c1.z + c2.z) / 2 } };
}

/** The polyline cut to its first `lengthMm` of run. */
function leading(nodes: readonly Point3[], lengthMm: number): Point3[] {
  const result: Point3[] = nodes.length ? [nodes[0]!] : [];
  let travelled = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!; const b = nodes[index]!;
    const step = Math.sqrt(dot(sub(b, a), sub(b, a)));
    if (travelled + step >= lengthMm) {
      const t = step > 1e-9 ? (lengthMm - travelled) / step : 0;
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      return result;
    }
    travelled += step;
    result.push(b);
  }
  return result;
}

export interface InsulatedLine {
  /** Centreline from the unit outward. */
  nodes: readonly Point3[];
  /** Outside radius of the insulation (mm). */
  outerRadiusMm: number;
}

/**
 * The least surface-to-surface gap between two insulated lines along their
 * first `withinMm` from the unit (negative: the insulation interpenetrates),
 * and where it is.
 */
export function insulationGapNearUnit(gas: InsulatedLine, liquid: InsulatedLine, withinMm = 1500): { gapMm: number; at: Point3 } {
  const a = leading(gas.nodes, withinMm);
  const b = leading(liquid.nodes, withinMm);
  let best = { gapMm: Number.POSITIVE_INFINITY, at: a[0] ?? { x: 0, y: 0, z: 0 } };
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      const { distance, at } = segmentDistance3(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!);
      const gapMm = distance - gas.outerRadiusMm - liquid.outerRadiusMm;
      if (gapMm < best.gapMm) best = { gapMm, at };
    }
  }
  return best;
}

/**
 * A refrigerant line's 3D centreline as the renderer and the clash check lift
 * it: its plan path at its authored levels (or its own level), with the risers
 * at its unit ports.
 */
export function refrigerantLineNodes3d(element: HvacElement, elements: readonly HvacElement[]): Point3[] {
  const visual = buildRefrigerantPipeVisual(element, [...elements]);
  const points = visual.continuousOuterPoints;
  const authored = readPipeRouteNodes3d(element);
  const guide = authored.length >= 2 ? authored : points.map((point) => ({ ...point, z: element.elevation + visual.localZMm }));
  return liftPipePlanRouteTo3d(points, guide, {
    startConnection: visual.startConnection,
    endConnection: visual.endConnection,
    outerDiameterMm: visual.outerRadiusMm * 2,
    bendRadiusMm: resolveFieldPipeBendRadiusMm(visual.outerRadiusMm * 2, element.properties.bendRadiusFactor),
    pipeDiameterMm: usesCopperSocketElbows(element.properties) ? visual.coreRadiusMm * 2 : undefined,
    minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
  });
}

/** A refrigerant line element as an insulated centreline running out from the unit it joins. */
export function insulatedLineFromUnit(element: HvacElement, unitId: string, elements: readonly HvacElement[]): InsulatedLine | null {
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const startsAtUnit = spec.startConnection?.connectionKind === 'unit-port' && spec.startConnection.sourceElementId === unitId;
  const endsAtUnit = spec.endConnection?.connectionKind === 'unit-port' && spec.endConnection.sourceElementId === unitId;
  if (!startsAtUnit && !endsAtUnit) return null;
  const nodes = refrigerantLineNodes3d(element, elements);
  if (nodes.length < 2) return null;
  return { nodes: startsAtUnit ? nodes : [...nodes].reverse(), outerRadiusMm: spec.outerDiameterMm / 2 };
}
