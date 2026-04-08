/**
 * ThicknessOperation
 *
 * Topology-aware wall thickness editing.
 *
 * Supports three modes per Q2 decision:
 *   - Symmetric (default): grows equally on both sides
 *   - Interior-only: exterior face stays fixed, centerline shifts outward
 *   - Exterior-only: interior face stays fixed, centerline shifts inward
 *
 * All three input methods (drag handles, properties panel, context presets)
 * funnel through the same validation pipeline:
 *   request → permission check → preview solve → topology validation → commit/reject
 *
 * This module is a pure operation layer — it produces new wall data
 * but does NOT directly write to the store.
 */

import type { Point2D, Room, Wall } from '../types';
import { MIN_WALL_THICKNESS, MAX_WALL_THICKNESS } from '../types/wall';
import { BuildingTopology } from '../topology/BuildingTopology';
import type { ThicknessMode } from '../topology/types';
import { getThicknessPermission, requiresThicknessConfirmation } from '../selection/ThicknessPermissions';

// =============================================================================
// Types
// =============================================================================

export interface ThicknessChangeRequest {
  wallId: string;
  newThickness: number;
  mode: ThicknessMode;
  /** For asymmetric mode: offset from old centerline in mm */
  centerlineShift?: number;
}

export interface CornerUpdate {
  nodeId: string;
  affectedWallIds: string[];
}

export interface ThicknessChangeResult {
  valid: boolean;
  updatedWall: Wall;
  affectedCorners: CornerUpdate[];
  affectedRoomIds: string[];
  warnings: string[];
  errors: string[];
  /** Whether the user should be shown a confirmation dialog */
  requiresConfirmation: boolean;
  /** Envelope impact level for UI badge */
  envelopeImpact: 'none' | 'low' | 'high';
}

// =============================================================================
// Constants
// =============================================================================

/** Standard wall thickness presets in mm */
export const THICKNESS_PRESETS_MM = [100, 150, 200, 250, 300] as const;

/** Named construction types (for context menu presets per Q2) */
export const THICKNESS_PRESETS = [
  { label: '100mm Partition', thickness: 100 },
  { label: '150mm Brick', thickness: 150 },
  { label: '200mm Concrete', thickness: 200 },
  { label: '250mm Insulated', thickness: 250 },
  { label: '300mm External', thickness: 300 },
  { label: 'Reset to Default', thickness: 0 }, // means use wallSettings.defaultThickness
] as const;

// =============================================================================
// Helpers
// =============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function rebuildWallGeometry(wall: Wall): Wall {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const perpX = -dy / length;
  const perpY = dx / length;
  const halfThickness = wall.thickness / 2;

  return {
    ...wall,
    interiorLine: {
      start: { x: wall.startPoint.x + perpX * halfThickness, y: wall.startPoint.y + perpY * halfThickness },
      end: { x: wall.endPoint.x + perpX * halfThickness, y: wall.endPoint.y + perpY * halfThickness },
    },
    exteriorLine: {
      start: { x: wall.startPoint.x - perpX * halfThickness, y: wall.startPoint.y - perpY * halfThickness },
      end: { x: wall.endPoint.x - perpX * halfThickness, y: wall.endPoint.y - perpY * halfThickness },
    },
  };
}

// =============================================================================
// Main API
// =============================================================================

/**
 * Compute a thickness change operation.
 *
 * This is the single pipeline entry point for all input methods
 * (drag, panel, context menu). Returns the result with validation.
 */
export function computeThicknessChange(
  request: ThicknessChangeRequest,
  walls: Wall[],
  rooms: Room[],
  topology: BuildingTopology,
  defaultThickness?: number,
): ThicknessChangeResult {
  const wall = walls.find((w) => w.id === request.wallId);
  if (!wall) {
    return invalidResult('Wall not found');
  }

  // --- Permission check ---
  const permission = getThicknessPermission(
    request.wallId,
    topology,
    walls,
    rooms,
  );

  if (!permission.canChangeThickness) {
    return invalidResult(permission.reason ?? 'Thickness change not allowed');
  }

  // Resolve "reset to default"
  let targetThickness = request.newThickness;
  if (targetThickness === 0 && defaultThickness) {
    targetThickness = defaultThickness;
  }

  // Clamp to allowed range
  targetThickness = clamp(
    targetThickness,
    permission.minThickness,
    permission.maxThickness,
  );

  // --- Check mode is allowed ---
  if (!permission.allowedModes.includes(request.mode)) {
    // Fall back to symmetric if requested mode is not allowed
    if (permission.allowedModes.includes('symmetric')) {
      request = { ...request, mode: 'symmetric' };
    } else {
      return invalidResult(
        `Thickness mode '${request.mode}' not allowed. Available: ${permission.allowedModes.join(', ')}`,
      );
    }
  }

  // --- Check side restrictions ---
  const isIncreasing = targetThickness > wall.thickness;
  const warnings: string[] = [];

  if (request.mode === 'interior-only') {
    if (isIncreasing && !permission.sideRestrictions.interiorIncrease) {
      return invalidResult('Interior increase blocked — adjacent room too small');
    }
    if (!isIncreasing && !permission.sideRestrictions.interiorDecrease) {
      return invalidResult('Interior decrease blocked');
    }
  } else if (request.mode === 'exterior-only') {
    if (isIncreasing && !permission.sideRestrictions.exteriorIncrease) {
      return invalidResult('Exterior increase blocked');
    }
    if (!isIncreasing && !permission.sideRestrictions.exteriorDecrease) {
      return invalidResult('Exterior decrease blocked');
    }
  }

  // --- Compute the new wall geometry ---
  let updatedWall: Wall;

  switch (request.mode) {
    case 'symmetric':
      updatedWall = applySymmetricThickness(wall, targetThickness);
      break;

    case 'interior-only':
      updatedWall = applyInteriorOnlyThickness(wall, targetThickness);
      break;

    case 'exterior-only':
      updatedWall = applyExteriorOnlyThickness(wall, targetThickness);
      break;

    case 'side-a':
    case 'side-b':
      // Asymmetric: use centerlineShift
      updatedWall = applyAsymmetricThickness(
        wall,
        targetThickness,
        request.centerlineShift ?? 0,
      );
      break;

    default:
      updatedWall = applySymmetricThickness(wall, targetThickness);
  }

  // --- Identify affected corners ---
  const affectedCorners: CornerUpdate[] = [];
  const edge = topology.getEdge(request.wallId);

  if (edge) {
    // Start corner
    const startNode = topology.getNode(edge.startNodeId);
    if (startNode && startNode.degree >= 2) {
      const adjacentWalls = topology.getEdgesAtNode(edge.startNodeId)
        .map((e) => e.wallId)
        .filter((wid) => wid !== request.wallId);

      affectedCorners.push({
        nodeId: edge.startNodeId,
        affectedWallIds: adjacentWalls,
      });
    }

    // End corner
    const endNode = topology.getNode(edge.endNodeId);
    if (endNode && endNode.degree >= 2) {
      const adjacentWalls = topology.getEdgesAtNode(edge.endNodeId)
        .map((e) => e.wallId)
        .filter((wid) => wid !== request.wallId);

      affectedCorners.push({
        nodeId: edge.endNodeId,
        affectedWallIds: adjacentWalls,
      });
    }
  }

  // --- Identify affected rooms ---
  const affectedRoomIds: string[] = [];
  const faces = topology.getFacesContainingEdge(request.wallId);
  for (const face of faces) {
    affectedRoomIds.push(face.roomId);
  }
  // Also include rooms at affected corner nodes
  for (const corner of affectedCorners) {
    const nodeFaces = topology.getFacesContainingNode(corner.nodeId);
    for (const face of nodeFaces) {
      if (!affectedRoomIds.includes(face.roomId)) {
        affectedRoomIds.push(face.roomId);
      }
    }
  }

  // --- Envelope warning check ---
  if (permission.requiresEnvelopeWarning) {
    warnings.push('This wall is part of the building envelope — thickness change affects outer footprint');
  }

  // --- Confirmation check ---
  const needsConfirmation = requiresThicknessConfirmation(
    request.wallId,
    targetThickness,
    topology,
    walls,
    rooms,
  );

  return {
    valid: true,
    updatedWall,
    affectedCorners,
    affectedRoomIds,
    warnings,
    errors: [],
    requiresConfirmation: needsConfirmation,
    envelopeImpact: permission.envelopeImpact,
  };
}

// =============================================================================
// Mode Implementations
// =============================================================================

/**
 * Symmetric: thickness changes equally on both sides, centerline stays fixed.
 */
function applySymmetricThickness(wall: Wall, newThickness: number): Wall {
  return rebuildWallGeometry({
    ...wall,
    thickness: newThickness,
  });
}

/**
 * Interior-only: exterior face stays fixed.
 * The centerline shifts outward by half the thickness delta.
 */
function applyInteriorOnlyThickness(wall: Wall, newThickness: number): Wall {
  const thicknessDelta = newThickness - wall.thickness;
  const shift = thicknessDelta / 2;

  // Compute wall direction and normal
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;

  // Shift centerline outward (away from interior)
  return rebuildWallGeometry({
    ...wall,
    thickness: newThickness,
    startPoint: {
      x: wall.startPoint.x - normalX * shift,
      y: wall.startPoint.y - normalY * shift,
    },
    endPoint: {
      x: wall.endPoint.x - normalX * shift,
      y: wall.endPoint.y - normalY * shift,
    },
  });
}

/**
 * Exterior-only: interior face stays fixed.
 * The centerline shifts inward by half the thickness delta.
 */
function applyExteriorOnlyThickness(wall: Wall, newThickness: number): Wall {
  const thicknessDelta = newThickness - wall.thickness;
  const shift = thicknessDelta / 2;

  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;

  // Shift centerline inward
  return rebuildWallGeometry({
    ...wall,
    thickness: newThickness,
    startPoint: {
      x: wall.startPoint.x + normalX * shift,
      y: wall.startPoint.y + normalY * shift,
    },
    endPoint: {
      x: wall.endPoint.x + normalX * shift,
      y: wall.endPoint.y + normalY * shift,
    },
  });
}

/**
 * Asymmetric: arbitrary centerline shift.
 */
function applyAsymmetricThickness(
  wall: Wall,
  newThickness: number,
  centerlineShift: number,
): Wall {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.sqrt(dx * dx + dy * dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;

  return rebuildWallGeometry({
    ...wall,
    thickness: newThickness,
    startPoint: {
      x: wall.startPoint.x + normalX * centerlineShift,
      y: wall.startPoint.y + normalY * centerlineShift,
    },
    endPoint: {
      x: wall.endPoint.x + normalX * centerlineShift,
      y: wall.endPoint.y + normalY * centerlineShift,
    },
  });
}

// =============================================================================
// Helpers
// =============================================================================

function invalidResult(reason: string): ThicknessChangeResult {
  return {
    valid: false,
    updatedWall: null as unknown as Wall,
    affectedCorners: [],
    affectedRoomIds: [],
    warnings: [],
    errors: [reason],
    requiresConfirmation: false,
    envelopeImpact: 'none',
  };
}
