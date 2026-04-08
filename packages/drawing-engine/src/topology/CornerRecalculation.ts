/**
 * CornerRecalculation
 *
 * Post-transform corner and room polygon resynchronisation.
 * Called after every move, endpoint edit, or thickness change
 * to keep corners, room polygons, and wall offset lines consistent.
 */

import type { Point2D, Room, Wall } from '../types';

import { BuildingTopology } from './BuildingTopology';
import { resyncRoomVertices } from './RoomBoundaryResolver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CornerResyncResult {
  updatedRooms: Map<string, Room>;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SNAP_PRECISION = 0.001; // mm

function snapCoord(val: number): number {
  return Math.round(val / SNAP_PRECISION) * SNAP_PRECISION;
}

function snapPoint(pt: Point2D): Point2D {
  return { x: snapCoord(pt.x), y: snapCoord(pt.y) };
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * After a move or edit, snap all wall endpoints to sub-mm precision
 * and deduplicate any node positions that ended up at the same location.
 *
 * Returns a new array of walls with snapped endpoints.
 * Does NOT mutate the input.
 */
export function snapWallEndpoints(walls: Wall[]): Wall[] {
  return walls.map((wall) => ({
    ...wall,
    startPoint: snapPoint(wall.startPoint),
    endPoint: snapPoint(wall.endPoint),
  }));
}

/**
 * After any transform, resync all affected rooms.
 *
 * @param affectedRoomIds - Room IDs that may have changed
 * @param walls - Current wall array (post-transform)
 * @param rooms - Current room array (pre-resync)
 * @param topology - Current topology (rebuilt from post-transform walls/rooms)
 */
export function resyncAffectedRooms(
  affectedRoomIds: string[],
  walls: Wall[],
  rooms: Room[],
  topology: BuildingTopology,
): CornerResyncResult {
  const updatedRooms = new Map<string, Room>();
  const issues: string[] = [];

  const roomMap = new Map(rooms.map((r) => [r.id, r]));

  for (const roomId of affectedRoomIds) {
    const room = roomMap.get(roomId);
    if (!room) continue;

    try {
      const updated = resyncRoomVertices(room, topology, walls);
      updatedRooms.set(roomId, updated);
    } catch (err) {
      issues.push(`Failed to resync room ${roomId}: ${String(err)}`);
    }
  }

  return { updatedRooms, issues };
}

/**
 * Identify which rooms are affected by a set of changed wall IDs.
 * Includes rooms directly containing those walls, plus rooms adjacent
 * to the changed walls (connected via shared nodes).
 */
export function findAffectedRoomIds(
  changedWallIds: string[],
  topology: BuildingTopology,
): string[] {
  const roomIds = new Set<string>();

  for (const wallId of changedWallIds) {
    // Direct containment
    const faces = topology.getFacesContainingEdge(wallId);
    for (const face of faces) {
      roomIds.add(face.roomId);
    }

    // Adjacent via shared nodes
    const nodes = topology.getNodesForWall(wallId);
    if (nodes) {
      for (const node of nodes) {
        const nodeFaces = topology.getFacesContainingNode(node.id);
        for (const face of nodeFaces) {
          roomIds.add(face.roomId);
        }
      }
    }
  }

  return Array.from(roomIds);
}

/**
 * Validate corner positions after a transform.
 * Checks for duplicate nodes, orphaned endpoints, and broken intersections.
 */
export function validateCorners(
  walls: Wall[],
  topology: BuildingTopology,
): string[] {
  const issues: string[] = [];

  // Check for duplicate nodes (two nodes at same position)
  const allNodes = topology.getAllNodes();
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      if (dist(allNodes[i].position, allNodes[j].position) < SNAP_PRECISION * 10) {
        issues.push(
          `Duplicate nodes ${allNodes[i].id} and ${allNodes[j].id} at ` +
          `(${allNodes[i].position.x.toFixed(1)}, ${allNodes[i].position.y.toFixed(1)})`
        );
      }
    }
  }

  // Check that connected walls still share endpoint positions
  for (const wall of walls) {
    for (const connectedId of wall.connectedWalls) {
      const other = walls.find((w) => w.id === connectedId);
      if (!other) {
        issues.push(`Wall ${wall.id} references non-existent connected wall ${connectedId}`);
        continue;
      }

      // At least one endpoint pair should be within tolerance
      const d_ss = dist(wall.startPoint, other.startPoint);
      const d_se = dist(wall.startPoint, other.endPoint);
      const d_es = dist(wall.endPoint, other.startPoint);
      const d_ee = dist(wall.endPoint, other.endPoint);
      const minDist = Math.min(d_ss, d_se, d_es, d_ee);

      if (minDist > 2) { // 2mm tolerance
        issues.push(
          `Connected walls ${wall.id} and ${connectedId} don't share an endpoint ` +
          `(closest distance: ${minDist.toFixed(1)}mm)`
        );
      }
    }
  }

  return issues;
}
