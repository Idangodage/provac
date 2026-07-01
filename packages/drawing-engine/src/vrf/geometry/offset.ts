/**
 * Offset a filleted centerline by a signed perpendicular distance (world mm).
 * +d = LEFT of the travel direction. Lines shift by the left-normal; arcs stay
 * CONCENTRIC (radius ± d, same centre) — so the gas (+gap/2) and liquid (−gap/2)
 * lines keep a constant perpendicular gap THROUGH bends with no pinch (invariant A).
 */

import {
  add,
  mul,
  norm,
  perpLeft,
  sub,
  type Path,
} from './path';
import { filletSpine, type FilletResult } from './fillet';
import type { PipeRun, Point } from '../model/types';

export function offsetPath(path: Path, d: number): Path {
  return path.map((s): Path[number] => {
    if (s.kind === 'line') {
      const nrm = perpLeft(norm(sub(s.b, s.a)));
      return { kind: 'line', a: add(s.a, mul(nrm, d)), b: add(s.b, mul(nrm, d)) };
    }
    // ccw arc → centre is on the LEFT, so +d moves toward it (radius shrinks).
    const sign = s.ccw ? 1 : -1;
    return { kind: 'arc', center: s.center, radius: Math.max(0, s.radius - d * sign), a0: s.a0, a1: s.a1, ccw: s.ccw };
  });
}

export interface PairedGeometry {
  /** Filleted shared centreline. */
  center: Path;
  /** Gas line = centre offset +gap/2 (left). */
  gas: Path;
  /** Liquid line = centre offset −gap/2 (right). */
  liquid: Path;
  warnings: FilletResult['warnings'];
}

/**
 * The full derived geometry of a paired run from its spine + params. Memoize on
 * (spine, gapMm, bendRadiusMm) — recompute only when those change.
 */
export function buildPairedGeometry(
  spine: Point[],
  gapMm: number,
  bendRadiusMm: number,
): PairedGeometry {
  const { path: center, warnings } = filletSpine(spine, bendRadiusMm);
  return {
    center,
    gas: offsetPath(center, gapMm / 2),
    liquid: offsetPath(center, -gapMm / 2),
    warnings,
  };
}

export function buildRunGeometry(run: PipeRun, gapMm: number): PairedGeometry {
  return buildPairedGeometry(run.spine, gapMm, run.bendRadiusMm);
}
