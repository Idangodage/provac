/**
 * Topology Types
 *
 * Core type definitions for the building topology graph.
 * The topology graph is a half-edge-like structure derived from
 * the existing Wall[] and Room[] arrays. It provides fast queries
 * for adjacency, containment, and connectivity without replacing
 * the source-of-truth arrays.
 *
 * All coordinates are in millimeters, matching the Wall/Room data model.
 */

import type { Point2D, WallMaterial } from '../types';

// =============================================================================
// Node (Junction)
// =============================================================================

/**
 * Reference to a specific wall endpoint.
 */
export interface WallEndRef {
  wallId: string;
  endpoint: 'start' | 'end';
}

/**
 * A junction node where 2+ wall endpoints meet (or a dead-end with 1).
 * Nodes are identified by a deterministic position hash.
 */
export interface TopologyNode {
  id: string;
  position: Point2D;
  wallEndpoints: WallEndRef[];
  /** Number of wall edges meeting at this node */
  degree: number;
}

// =============================================================================
// Edge (Wall)
// =============================================================================

/**
 * A wall edge in the topology graph.
 * Each edge connects exactly two TopologyNodes.
 */
export interface TopologyEdge {
  wallId: string;
  startNodeId: string;
  endNodeId: string;
  thickness: number;
  material: WallMaterial;
  /** Center-line length in mm */
  length: number;
  /** Unit vector from startNode to endNode */
  direction: Point2D;
  /** Perpendicular unit vector (left-hand normal of direction) */
  normal: Point2D;
}

// =============================================================================
// Face (Room)
// =============================================================================

/**
 * A room face in the topology graph.
 * Faces are bounded by an ordered loop of edges/nodes.
 */
export interface TopologyFace {
  roomId: string;
  /** Ordered boundary edge (wall) IDs forming the loop */
  edgeIds: string[];
  /** Ordered boundary node IDs (corners of the room) */
  nodeIds: string[];
  /** Polygon vertices derived from room data */
  vertices: Point2D[];
  isExterior: boolean;
}

// =============================================================================
// Subgraph
// =============================================================================

/**
 * Result of extracting a subgraph from the topology.
 * Used for move operations to classify which nodes are
 * boundary (shared with outside) vs internal (fully inside selection).
 */
export interface TopologySubgraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  faces: TopologyFace[];
  /** Nodes that also connect to walls outside the selection */
  boundaryNodes: TopologyNode[];
  /** Nodes fully inside the selection (all connected walls are selected) */
  internalNodes: TopologyNode[];
  /** Wall IDs outside the subgraph that connect to boundary nodes */
  externalWallIds: string[];
}

// =============================================================================
// Validation
// =============================================================================

export type TopologyIssueKind =
  | 'orphaned-endpoint'
  | 'duplicate-node'
  | 'broken-room-loop'
  | 'self-intersecting-room'
  | 'degenerate-wall'
  | 'missing-wall-reference';

export interface TopologyIssue {
  kind: TopologyIssueKind;
  message: string;
  /** Affected element IDs */
  elementIds: string[];
  severity: 'warning' | 'error';
}

export interface TopologyValidationResult {
  valid: boolean;
  issues: TopologyIssue[];
}

// =============================================================================
// Capabilities (Permission layer uses these)
// =============================================================================

/**
 * Capabilities exposed by the topology for a specific wall or room.
 * This is the bridge between topology analysis and the permission/UI system.
 */
export interface ElementCapabilities {
  canMoveRigid: boolean;
  canMoveWithStretch: boolean;
  canDetach: boolean;
  canEditThickness: boolean;
  allowedThicknessModes: ThicknessMode[];
  requiresEnvelopeWarning: boolean;
  requiresJoinRebuild: boolean;
  blockedReason: string | null;
}

export type ThicknessMode =
  | 'symmetric'
  | 'interior-only'
  | 'exterior-only'
  | 'side-a'
  | 'side-b';
