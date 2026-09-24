/**
 * Hanger / bracket layout for condensate runs: horizontal runs at the
 * horizontal spacing, vertical runs at the vertical spacing, plus a support
 * within the near-fitting distance of every fitting and direction change so
 * a PVC socket joint never carries a sagging span. Derived, never stored.
 */
import type { HvacElement } from '../../../../types';

import type { CondensateDesignSettings } from './condensateSettings';
import { condensateInsulatedRadiusMm, isCondensatePipe, readCondensatePipeSpec, type Point3 } from './condensateTypes';

export interface CondensateSupport {
  elementId: string;
  point: Point3;
  orientation: 'horizontal' | 'vertical';
  nominalSize: string;
  /** Run direction through the clip. */
  axis: Point3;
  /**
   * Threaded rod from the slab down to the clip (mm); 0 when the support is a
   * bracket instead (a vertical run too far below the slab to hang from it).
   */
  rodLengthMm: number;
}

/** A vertical run's clip hangs from the slab when within this distance of it; lower ones are bracketed (mm). */
const RISER_ROD_REACH_MM = 1000;

function lerp3(a: Point3, b: Point3, t: number): Point3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function length3(a: Point3, b: Point3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

export function layoutCondensateSupports(
  element: HvacElement,
  settings: Pick<CondensateDesignSettings, 'supportSpacingHorizontalMm' | 'supportSpacingVerticalMm' | 'supportNearFittingMm'>,
): CondensateSupport[] {
  if (!isCondensatePipe(element)) return [];
  const spec = readCondensatePipeSpec(element);
  const nodes = spec.routeNodes3d;
  const radius = condensateInsulatedRadiusMm(spec);
  const topZ = spec.hangers?.topZ ?? null;
  const supports: CondensateSupport[] = [];
  let station = 0;
  let axis: Point3 = { x: 1, y: 0, z: 0 };
  let segmentStart: Point3 = nodes[0] ?? { x: 0, y: 0, z: 0 };
  const addSupport = (point: Point3, orientation: CondensateSupport['orientation']) => {
    // The unit's flexible drain hose is carried by its own clamps, not hangers.
    if (station + length3(segmentStart, point) < spec.drainHoseLengthMm) return;
    if (supports.some((existing) => length3(existing.point, point) < settings.supportNearFittingMm * 0.5)) return;
    const clipTop = orientation === 'vertical' ? point.z : point.z + radius;
    const reach = topZ === null ? 0 : topZ - clipTop;
    const rodLengthMm = reach > 5 && (orientation === 'horizontal' || reach <= RISER_ROD_REACH_MM) ? reach : 0;
    supports.push({ elementId: element.id, point, orientation, nominalSize: spec.nominalSize, axis, rodLengthMm });
  };
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const span = length3(a, b);
    if (span < 1) continue;
    axis = { x: (b.x - a.x) / span, y: (b.y - a.y) / span, z: (b.z - a.z) / span };
    segmentStart = a;
    const plan = Math.hypot(b.x - a.x, b.y - a.y);
    const vertical = plan < Math.abs(b.z - a.z);
    const spacing = vertical ? settings.supportSpacingVerticalMm : settings.supportSpacingHorizontalMm;
    // A support just clear of each end joint, then evenly within the span.
    const near = Math.min(settings.supportNearFittingMm, span / 2);
    const inner = span - 2 * near;
    const count = inner > 0 ? Math.ceil(inner / spacing) : 0;
    addSupport(lerp3(a, b, near / span), vertical ? 'vertical' : 'horizontal');
    for (let k = 1; k < count; k += 1) addSupport(lerp3(a, b, (near + (inner * k) / count) / span), vertical ? 'vertical' : 'horizontal');
    if (span > 2 * near + 1) addSupport(lerp3(a, b, (span - near) / span), vertical ? 'vertical' : 'horizontal');
    station += span;
  }
  return supports;
}

export function layoutCondensateSupportsForScene(
  elements: readonly HvacElement[],
  settings: Pick<CondensateDesignSettings, 'supportSpacingHorizontalMm' | 'supportSpacingVerticalMm' | 'supportNearFittingMm'>,
): CondensateSupport[] {
  return elements.flatMap((element) => layoutCondensateSupports(element, settings));
}
