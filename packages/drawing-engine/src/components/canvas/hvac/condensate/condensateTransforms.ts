/**
 * Geometry-preserving transforms for condensate pipes. The sloped 3D route,
 * the plan route, the fittings and the element bounds move together, so a
 * nudge can never leave the persisted centreline behind its bounding box.
 */
import type { HvacElement } from '../../../../types';

import { condensateInsulatedRadiusMm, readCondensatePipeSpec, type Point3 } from './condensateTypes';

export function condensatePipeBounds(
  nodes: readonly Point3[],
  radiusMm: number,
): Pick<HvacElement, 'position' | 'width' | 'depth' | 'elevation' | 'height'> {
  if (!nodes.length) return { position: { x: 0, y: 0 }, width: 1, depth: 1, elevation: 0, height: 1 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const zs = nodes.map((node) => node.z);
  const minX = Math.min(...xs) - radiusMm;
  const minY = Math.min(...ys) - radiusMm;
  const minZ = Math.min(...zs) - radiusMm;
  return {
    position: { x: minX, y: minY },
    width: Math.max(1, Math.max(...xs) + radiusMm - minX),
    depth: Math.max(1, Math.max(...ys) + radiusMm - minY),
    elevation: minZ,
    height: Math.max(1, Math.max(...zs) + radiusMm - minZ),
  };
}

/** Whole-pipe translation in model millimetres. */
export function translateCondensatePipe(
  element: HvacElement,
  delta: { x: number; y: number; z: number },
): Partial<HvacElement> {
  const spec = readCondensatePipeSpec(element);
  const move = (point: Point3): Point3 => ({ x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z });
  const routeNodes3d = spec.routeNodes3d.map(move);
  const properties: Record<string, unknown> = {
    ...element.properties,
    routeNodes3d,
    routePoints: spec.routePoints.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
    fittings: spec.fittings.map((fitting) => ({ ...fitting, point: move(fitting.point) })),
    ...(spec.drainStart ? { drainStart: { ...spec.drainStart, point: { x: spec.drainStart.point.x + delta.x, y: spec.drainStart.point.y + delta.y }, z: spec.drainStart.z + delta.z } } : {}),
    ...(spec.drainEnd ? { drainEnd: { ...spec.drainEnd, point: { x: spec.drainEnd.point.x + delta.x, y: spec.drainEnd.point.y + delta.y }, z: spec.drainEnd.z + delta.z } } : {}),
  };
  return {
    ...condensatePipeBounds(routeNodes3d, condensateInsulatedRadiusMm(spec)),
    properties,
  };
}
