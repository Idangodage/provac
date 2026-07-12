import type { Point2D } from "../../../types";

/**
 * Rigid-body placement snapping for a copper branch kit (or any placeable with
 * directional ports). Given the kit's ports in LOCAL coordinates (kit origin at
 * 0,0) and a set of open pipe-end targets in WORLD coordinates, it finds the
 * translate+rotate that makes the nearest port meet the nearest target head-to-
 * head (the port's outward direction faces INTO the pipe end).
 *
 * Pure geometry — no rendering, no store — so it is deterministic and unit
 * testable. The interactive placement tool and the overlay both drive it.
 */

export interface PlaceablePort {
  /** inlet | run-outlet | branch-outlet (or any id). */
  role: string;
  /** Port position in the kit's local frame (origin at the kit centre). */
  point: Point2D;
  /** Outward direction of the port in the kit's local frame. */
  direction: Point2D;
}

export interface SnapTargetEnd {
  id: string;
  /** Open pipe-end position in world coordinates. */
  point: Point2D;
  /** The pipe's outward heading at that end (points away from the pipe). */
  direction: Point2D;
}

/** Maps a kit-local point to world: world = rotate(local, rotDeg) + (tx, ty). */
export interface PlacementTransform {
  tx: number;
  ty: number;
  rotDeg: number;
}

export interface BranchKitSnap {
  transform: PlacementTransform;
  portRole: string;
  targetId: string;
  distanceMm: number;
}

const RAD = Math.PI / 180;

function rotate(p: Point2D, deg: number): Point2D {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

function angleDeg(v: Point2D): number {
  return Math.atan2(v.y, v.x) / RAD;
}

export function applyPlacement(tf: PlacementTransform, p: Point2D): Point2D {
  const r = rotate(p, tf.rotDeg);
  return { x: r.x + tf.tx, y: r.y + tf.ty };
}

/**
 * Solve the ghost placement for a kit whose centre is at `cursor`. Returns the
 * transform to apply and, when a port is within `toleranceMm` of an open end,
 * the snap that translated+rotated the kit so that port connects to the end.
 * `usedTargetIds` are ends already consumed by other kits (excluded).
 */
export function solveBranchKitSnap(
  ports: PlaceablePort[],
  targets: SnapTargetEnd[],
  cursor: Point2D,
  toleranceMm: number,
  usedTargetIds: ReadonlySet<string> = new Set(),
): { transform: PlacementTransform; snap: BranchKitSnap | null } {
  const base: PlacementTransform = { tx: cursor.x, ty: cursor.y, rotDeg: 0 };
  let best: BranchKitSnap | null = null;
  let bestDist = toleranceMm;

  for (const port of ports) {
    // Port world position at the un-snapped (cursor-centred) transform.
    const world = applyPlacement(base, port.point);
    for (const target of targets) {
      if (usedTargetIds.has(target.id)) continue;
      const dist = Math.hypot(world.x - target.point.x, world.y - target.point.y);
      if (dist > bestDist) continue;
      // Rotate so the port's outward direction faces INTO the pipe end
      // (opposite the pipe's outward heading), then translate the port onto it.
      const desired = angleDeg({ x: -target.direction.x, y: -target.direction.y });
      const rotDeg = desired - angleDeg(port.direction);
      const rp = rotate(port.point, rotDeg);
      bestDist = dist;
      best = {
        transform: { tx: target.point.x - rp.x, ty: target.point.y - rp.y, rotDeg },
        portRole: port.role,
        targetId: target.id,
        distanceMm: dist,
      };
    }
  }

  return { transform: best ? best.transform : base, snap: best };
}
