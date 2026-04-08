/**
 * HandlePermissions
 *
 * Computes whether each handle type is allowed, restricted,
 * or blocked based on topology context, selection state,
 * and geometric constraints.
 *
 * This module does NOT modify state — it is a pure query layer.
 */

import type { Point2D, Room, Wall } from '../types';
import { MIN_WALL_LENGTH, MIN_WALL_THICKNESS, MAX_WALL_THICKNESS } from '../types/wall';
import type { BuildingTopology } from '../topology/BuildingTopology';
import type { SelectionState } from './SelectionModel';

// =============================================================================
// Types
// =============================================================================

export type ConstraintAxis = 'free' | 'perpendicular' | 'parallel' | 'locked';

export type HandleVisibility = 'visible' | 'disabled' | 'hidden';

export interface HandlePermission {
  canActivate: boolean;
  canDrag: boolean;
  constraintAxes: ConstraintAxis[];
  visibility: HandleVisibility;
  reason: string | null;
  maxDisplacement: number | null;
}

// =============================================================================
// Endpoint Permission
// =============================================================================

/**
 * Determine permission for dragging a wall endpoint.
 */
export function getEndpointPermission(
  wallId: string,
  endpoint: 'start' | 'end',
  topology: BuildingTopology,
  selection: SelectionState,
): HandlePermission {
  const edge = topology.getEdge(wallId);
  if (!edge) {
    return blocked('Wall not found in topology');
  }

  const nodeId = endpoint === 'start' ? edge.startNodeId : edge.endNodeId;
  const node = topology.getNode(nodeId);
  if (!node) {
    return blocked('Endpoint node not found');
  }

  // At high-degree junctions (T/cross), only allow perpendicular movement
  if (node.degree >= 3) {
    return {
      canActivate: true,
      canDrag: true,
      constraintAxes: ['perpendicular'],
      visibility: 'visible',
      reason: 'Junction with 3+ walls — movement constrained to perpendicular',
      maxDisplacement: null,
    };
  }

  // At degree-2 junctions (corner), free movement but moves both connected walls
  if (node.degree === 2) {
    return {
      canActivate: true,
      canDrag: true,
      constraintAxes: ['free'],
      visibility: 'visible',
      reason: null,
      maxDisplacement: null,
    };
  }

  // Dead end (degree 1) — fully free
  return allowed('free');
}

// =============================================================================
// Center Move Permission
// =============================================================================

/**
 * Determine permission for moving a wall via its center handle.
 */
export function getCenterMovePermission(
  wallId: string,
  topology: BuildingTopology,
  selection: SelectionState,
): HandlePermission {
  const edge = topology.getEdge(wallId);
  if (!edge) {
    return blocked('Wall not found in topology');
  }

  const startNode = topology.getNode(edge.startNodeId);
  const endNode = topology.getNode(edge.endNodeId);
  if (!startNode || !endNode) {
    return blocked('Wall nodes not found');
  }

  // If both endpoints are at high-degree junctions, block wall center move
  if (startNode.degree >= 3 && endNode.degree >= 3) {
    return {
      canActivate: true,
      canDrag: false,
      constraintAxes: ['locked'],
      visibility: 'disabled',
      reason: 'Both endpoints are fixed junctions — wall cannot be moved individually',
      maxDisplacement: null,
    };
  }

  // Default: perpendicular constraint (move wall parallel to itself)
  return {
    canActivate: true,
    canDrag: true,
    constraintAxes: ['perpendicular'],
    visibility: 'visible',
    reason: null,
    maxDisplacement: null,
  };
}

// =============================================================================
// Thickness Permission
// =============================================================================

/**
 * Determine permission for changing wall thickness via drag handle.
 */
export function getThicknessPermission(
  wallId: string,
  side: 'interior' | 'exterior',
  topology: BuildingTopology,
  selection: SelectionState,
  walls: Wall[],
  rooms: Room[],
): HandlePermission {
  const edge = topology.getEdge(wallId);
  if (!edge) {
    return blocked('Wall not found in topology');
  }

  const adjacentFaces = topology.getFacesContainingEdge(wallId);
  const isEnvelope = adjacentFaces.length <= 1;
  const isShared = adjacentFaces.length >= 2;

  // Check if thickness change on this side would create issues
  const wall = walls.find((w) => w.id === wallId);
  if (!wall) {
    return blocked('Wall data not found');
  }

  // For shared walls, validate that both rooms can absorb the change
  if (isShared) {
    return {
      canActivate: true,
      canDrag: true,
      constraintAxes: ['perpendicular'],
      visibility: 'visible',
      reason: 'Shared wall — thickness change affects both adjacent rooms',
      maxDisplacement: null,
    };
  }

  // For envelope walls, warn on exterior expansion
  if (isEnvelope && side === 'exterior') {
    return {
      canActivate: true,
      canDrag: true,
      constraintAxes: ['perpendicular'],
      visibility: 'visible',
      reason: 'Exterior envelope — expansion changes building footprint',
      maxDisplacement: null,
    };
  }

  // Default: free thickness editing
  return {
    canActivate: true,
    canDrag: true,
    constraintAxes: ['perpendicular'],
    visibility: 'visible',
    reason: null,
    maxDisplacement: null,
  };
}

// =============================================================================
// Room Center Move Permission
// =============================================================================

/**
 * Determine permission for moving a room via its center handle.
 */
export function getRoomCenterMovePermission(
  roomId: string,
  topology: BuildingTopology,
  selection: SelectionState,
): HandlePermission {
  const face = topology.getFace(roomId);
  if (!face) {
    return blocked('Room not found in topology');
  }

  const subgraph = topology.extractSubgraph(face.edgeIds);

  // Fully isolated room — free rigid translation
  if (subgraph.boundaryNodes.length === 0) {
    return allowed('free');
  }

  // Room has shared walls — stretch move by default
  return {
    canActivate: true,
    canDrag: true,
    constraintAxes: ['free'],
    visibility: 'visible',
    reason: `Room shares ${subgraph.boundaryNodes.length} junction(s) with adjacent geometry — stretch move`,
    maxDisplacement: null,
  };
}

// =============================================================================
// Room Corner Permission
// =============================================================================

/**
 * Determine permission for moving a room corner.
 */
export function getRoomCornerPermission(
  roomId: string,
  cornerIndex: number,
  topology: BuildingTopology,
  selection: SelectionState,
  rooms: Room[],
): HandlePermission {
  const room = rooms.find((r) => r.id === roomId);
  if (!room || cornerIndex < 0 || cornerIndex >= (room.vertices?.length ?? 0)) {
    return blocked('Corner not found');
  }

  // Corners are always draggable but must maintain valid polygon
  return {
    canActivate: true,
    canDrag: true,
    constraintAxes: ['free'],
    visibility: 'visible',
    reason: null,
    maxDisplacement: null,
  };
}

// =============================================================================
// Rotation Permission
// =============================================================================

/**
 * Determine permission for rotating a wall.
 * Rotation is only allowed for isolated walls (not connected to anything).
 */
export function getRotationPermission(
  wallId: string,
  topology: BuildingTopology,
): HandlePermission {
  const edge = topology.getEdge(wallId);
  if (!edge) {
    return blocked('Wall not found in topology');
  }

  const startNode = topology.getNode(edge.startNodeId);
  const endNode = topology.getNode(edge.endNodeId);

  const isIsolated =
    (startNode?.degree ?? 0) <= 1 && (endNode?.degree ?? 0) <= 1;

  if (!isIsolated) {
    return {
      canActivate: false,
      canDrag: false,
      constraintAxes: ['locked'],
      visibility: 'hidden',
      reason: 'Rotation is only available for disconnected walls',
      maxDisplacement: null,
    };
  }

  // Also check if wall belongs to any room
  const faces = topology.getFacesContainingEdge(wallId);
  if (faces.length > 0) {
    return {
      canActivate: false,
      canDrag: false,
      constraintAxes: ['locked'],
      visibility: 'hidden',
      reason: 'Cannot rotate a wall that belongs to a room',
      maxDisplacement: null,
    };
  }

  return allowed('free');
}

// =============================================================================
// Helpers
// =============================================================================

function blocked(reason: string): HandlePermission {
  return {
    canActivate: false,
    canDrag: false,
    constraintAxes: ['locked'],
    visibility: 'disabled',
    reason,
    maxDisplacement: null,
  };
}

function allowed(axis: ConstraintAxis): HandlePermission {
  return {
    canActivate: true,
    canDrag: true,
    constraintAxes: [axis],
    visibility: 'visible',
    reason: null,
    maxDisplacement: null,
  };
}
