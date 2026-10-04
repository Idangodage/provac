import type { DuctBox } from '../duct/ductVolumes';

import type { IndoorDrainPort } from './condensatePorts';
import type { Point3 } from './condensateTypes';

const EPS = 1e-8;
const TOLERANCE_MM = 0.5;
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const length = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The catalog footprint can include the projecting drain socket. A falling
 * hose may leave that envelope at its live outlet, but only through a narrow
 * outward corridor. The allowance ends at the casing face plus pipe radius;
 * an upward lift, sideways turn or later re-entry is never exempted. */
export function condensateSocketExitLength(
  port: IndoorDrainPort, body: DuctBox, radiusMm: number, points: readonly Point3[],
): number {
  if (body.elementId !== port.unitId || body.mark !== 'equipment casing' || points.length < 2) return 0;
  const origin = { ...port.point, z: port.z };
  if (length(points[0]!, origin) > TOLERANCE_MM) return 0;
  const magnitude = Math.hypot(port.direction.x, port.direction.y);
  if (magnitude < EPS) return 0;
  const outward = { x: port.direction.x / magnitude, y: port.direction.y / magnitude, z: 0 };
  const axes = [body.axisT, body.axisN, body.axisU];
  const halves = [body.halfLength, body.halfWidth, body.halfHeight];
  let exit = Number.POSITIVE_INFINITY;
  for (let index = 0; index < axes.length; index++) {
    const axis = axes[index]!;
    const position = dot(sub(origin, body.centre), axis);
    const extent = halves[index]! + radiusMm;
    if (Math.abs(position) > extent + TOLERANCE_MM) return 0;
    const advance = dot(outward, axis);
    if (Math.abs(advance) > EPS) exit = Math.min(exit, (Math.sign(advance) * extent - position) / advance);
  }
  if (!Number.isFinite(exit) || exit < 0) return 0;
  exit += TOLERANCE_MM;
  const corridorRadius = port.outletOuterDiameterMm / 2;
  let travelled = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!; const b = points[index]!;
    const from = dot(sub(a, origin), outward); const to = dot(sub(b, origin), outward);
    if (to <= from + EPS || b.z > a.z + EPS) return 0;
    const fraction = Math.min(1, (exit - from) / (to - from));
    const end = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction,
      z: a.z + (b.z - a.z) * fraction };
    const forward = dot(sub(end, origin), outward);
    // Distance to the outlet axis is convex on a segment: endpoint checks
    // bound the whole departure, including a sloping gravity connection.
    if (Math.hypot(end.x - origin.x - outward.x * forward,
      end.y - origin.y - outward.y * forward, end.z - origin.z) > corridorRadius + TOLERANCE_MM) return 0;
    travelled += length(a, end);
    if (to >= exit) return travelled;
  }
  return 0;
}
