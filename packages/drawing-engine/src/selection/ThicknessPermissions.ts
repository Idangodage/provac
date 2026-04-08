/**
 * ThicknessPermissions
 *
 * Determines what thickness edits are allowed for a wall based on
 * its topology context (connections, rooms, envelope status).
 *
 * This module is a pure query layer — it does NOT modify state.
 */

import type { Room, Wall } from '../types';
import { MIN_WALL_THICKNESS, MAX_WALL_THICKNESS } from '../types/wall';
import type { BuildingTopology } from '../topology/BuildingTopology';
import type { ThicknessMode } from '../topology/types';

// =============================================================================
// Types
// =============================================================================

export interface ThicknessPermission {
  canChangeThickness: boolean;
  allowedModes: ThicknessMode[];
  minThickness: number;
  maxThickness: number;
  reason: string | null;
  sideRestrictions: {
    interiorIncrease: boolean;
    interiorDecrease: boolean;
    exteriorIncrease: boolean;
    exteriorDecrease: boolean;
  };
  requiresEnvelopeWarning: boolean;
  /** Impact level for outer envelope changes */
  envelopeImpact: 'none' | 'low' | 'high';
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum room area in mm² below which thickness change is blocked */
const MIN_ROOM_AREA_MM2 = 2_000_000; // 2 m²

/** Overlap tolerance when checking wall body collisions */
const OVERLAP_TOLERANCE_MM = 1;

// =============================================================================
// Main Query
// =============================================================================

/**
 * Compute the full thickness permission for a wall.
 */
export function getThicknessPermission(
  wallId: string,
  topology: BuildingTopology,
  walls: Wall[],
  rooms: Room[],
): ThicknessPermission {
  const edge = topology.getEdge(wallId);
  if (!edge) {
    return blockedPermission('Wall not found in topology');
  }

  const wall = walls.find((w) => w.id === wallId);
  if (!wall) {
    return blockedPermission('Wall data not found');
  }

  const adjacentFaces = topology.getFacesContainingEdge(wallId);
  const startNode = topology.getNode(edge.startNodeId);
  const endNode = topology.getNode(edge.endNodeId);
  const startDegree = startNode?.degree ?? 0;
  const endDegree = endNode?.degree ?? 0;

  const isFreestanding = startDegree <= 1 && endDegree <= 1;
  const isEnvelope = adjacentFaces.length <= 1 || adjacentFaces.some((f) => f.isExterior);
  const isShared = adjacentFaces.length >= 2;
  const isAtTJunction = startDegree >= 3 || endDegree >= 3;
  const isAtCrossJunction = startDegree >= 4 || endDegree >= 4;

  // --- Determine allowed modes ---
  const allowedModes: ThicknessMode[] = ['symmetric'];

  if (!isFreestanding) {
    allowedModes.push('interior-only', 'exterior-only');
  }

  // Side-A/B modes for fine-grained control
  if (isShared || isAtTJunction) {
    allowedModes.push('side-a', 'side-b');
  }

  // --- Determine side restrictions ---
  const sideRestrictions = {
    interiorIncrease: true,
    interiorDecrease: true,
    exteriorIncrease: true,
    exteriorDecrease: true,
  };

  // Check if interior increase would collapse any adjacent room
  if (adjacentFaces.length > 0) {
    for (const face of adjacentFaces) {
      const room = rooms.find((r) => r.id === face.roomId);
      if (room && room.area !== undefined) {
        // Convert room area to mm² if it's in m²
        const areaInMm2 = room.area < 1000
          ? room.area * 1_000_000  // m² to mm²
          : room.area;

        if (areaInMm2 < MIN_ROOM_AREA_MM2 * 1.5) {
          // Room is small — restrict interior increase
          sideRestrictions.interiorIncrease = false;
        }
      }
    }
  }

  // --- Determine min/max thickness ---
  let maxThickness = MAX_WALL_THICKNESS;

  // At T-junctions, cap thickness to avoid extending past the cross-wall
  if (isAtTJunction) {
    const adjacentWallIds = topology.getAdjacentWallIds(wallId);
    for (const adjId of adjacentWallIds) {
      const adjWall = walls.find((w) => w.id === adjId);
      if (adjWall) {
        // Max thickness should not cause body overlap with perpendicular walls
        const potentialMax = adjWall.thickness * 2 + OVERLAP_TOLERANCE_MM;
        maxThickness = Math.min(maxThickness, potentialMax);
      }
    }
  }

  // --- Determine envelope impact ---
  let envelopeImpact: 'none' | 'low' | 'high' = 'none';
  if (isEnvelope) {
    // Count how many rooms/walls would be affected
    const affectedRoomCount = adjacentFaces.length;
    const adjacentWallCount = topology.getAdjacentWallIds(wallId).length;

    if (adjacentWallCount > 4 || affectedRoomCount > 2) {
      envelopeImpact = 'high';
    } else {
      envelopeImpact = 'low';
    }
  }

  return {
    canChangeThickness: true,
    allowedModes,
    minThickness: MIN_WALL_THICKNESS,
    maxThickness,
    reason: null,
    sideRestrictions,
    requiresEnvelopeWarning: isEnvelope,
    envelopeImpact,
  };
}

/**
 * Quick check: should a thickness change show a confirmation dialog?
 * Only for "high-impact" envelope changes (per Q3 answer).
 */
export function requiresThicknessConfirmation(
  wallId: string,
  newThickness: number,
  topology: BuildingTopology,
  walls: Wall[],
  rooms: Room[],
): boolean {
  const permission = getThicknessPermission(wallId, topology, walls, rooms);

  // Only require confirmation for high-impact envelope changes
  if (permission.envelopeImpact !== 'high') return false;

  const wall = walls.find((w) => w.id === wallId);
  if (!wall) return false;

  // Check if the change is significant (more than 50mm delta)
  const delta = Math.abs(newThickness - wall.thickness);
  return delta > 50;
}

// =============================================================================
// Helpers
// =============================================================================

function blockedPermission(reason: string): ThicknessPermission {
  return {
    canChangeThickness: false,
    allowedModes: [],
    minThickness: MIN_WALL_THICKNESS,
    maxThickness: MAX_WALL_THICKNESS,
    reason,
    sideRestrictions: {
      interiorIncrease: false,
      interiorDecrease: false,
      exteriorIncrease: false,
      exteriorDecrease: false,
    },
    requiresEnvelopeWarning: false,
    envelopeImpact: 'none',
  };
}
