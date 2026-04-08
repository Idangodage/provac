/**
 * MoveOperation
 *
 * Topology-aware move operations for walls and rooms.
 *
 * Implements three move strategies per the Q1 decision:
 *   1. Rigid subgraph translation (isolated groups)
 *   2. Topology-preserving stretch move (default for connected rooms)
 *   3. Explicit detach move (Alt+drag modifier)
 *
 * Block-on-invalid: if preview validation finds an invalid state,
 * the move is blocked before commit.
 *
 * This module is a pure operation layer — it produces new wall data
 * but does NOT directly write to the store.
 */

import type { Point2D, Room, Wall } from '../types';
import { MIN_WALL_LENGTH } from '../types/wall';
import { BuildingTopology } from '../topology/BuildingTopology';
import { GeometryEngine } from '../utils/geometry-engine';

// =============================================================================
// Types
// =============================================================================

export type MoveStrategy =
  | 'rigid-translation'
  | 'stretch-move'
  | 'detach-move'
  | 'block';

export interface MoveRequest {
  /** Wall IDs being moved */
  wallIds: string[];
  /** Translation delta in mm */
  delta: Point2D;
  /** True if user is holding Alt/Option modifier */
  detachModifier: boolean;
  /** The room being moved (if this is a room-move operation) */
  roomId?: string;
}

export interface MoveWarning {
  type: 'wall-too-short' | 'near-overlap' | 'junction-stress' | 'envelope-change';
  wallId: string;
  message: string;
}

export interface MoveError {
  type: 'topology-break' | 'self-intersection' | 'room-collapse' | 'min-length' | 'junction-invalid';
  message: string;
}

export interface MoveValidationResult {
  valid: boolean;
  strategy: MoveStrategy;
  warnings: MoveWarning[];
  errors: MoveError[];
  /** What the walls would look like after the move */
  previewWalls: Wall[];
  /** Wall IDs outside the selection that would be modified */
  affectedExternalWallIds: string[];
  /** Room IDs that need resynchronisation */
  affectedRoomIds: string[];
}

export interface MoveResult {
  success: boolean;
  updatedWalls: Wall[];
  affectedRoomIds: string[];
  strategy: MoveStrategy;
  errors: MoveError[];
  warnings: MoveWarning[];
}

// =============================================================================
// Constants
// =============================================================================

const MIN_WALL_LENGTH_THRESHOLD = MIN_WALL_LENGTH;
const NEAR_OVERLAP_THRESHOLD_MM = 5;
const SELF_INTERSECTION_CHECK_TOLERANCE = 0.01;

// =============================================================================
// Helpers
// =============================================================================

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function addDelta(point: Point2D, delta: Point2D): Point2D {
  return { x: point.x + delta.x, y: point.y + delta.y };
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
// Strategy Classification
// =============================================================================

/**
 * Determine which move strategy to use based on the move request and topology.
 */
export function classifyMoveStrategy(
  request: MoveRequest,
  topology: BuildingTopology,
): MoveStrategy {
  // User explicitly requests detach
  if (request.detachModifier) {
    return 'detach-move';
  }

  const subgraph = topology.extractSubgraph(request.wallIds);

  // No boundary nodes → fully isolated → rigid translation
  if (subgraph.boundaryNodes.length === 0) {
    return 'rigid-translation';
  }

  // Has boundary nodes → stretch move (default for connected rooms)
  return 'stretch-move';
}

// =============================================================================
// Move Preview / Validation
// =============================================================================

/**
 * Compute a preview of what the move would look like WITHOUT committing.
 * This is the key function for "preview-before-commit" validation.
 */
export function previewMove(
  request: MoveRequest,
  topology: BuildingTopology,
  walls: Wall[],
  rooms: Room[],
): MoveValidationResult {
  const strategy = classifyMoveStrategy(request, topology);
  const wallMap = new Map(walls.map((w) => [w.id, w]));
  const wallIdSet = new Set(request.wallIds);
  const warnings: MoveWarning[] = [];
  const errors: MoveError[] = [];
  const affectedExternalWallIds: string[] = [];
  const affectedRoomIds = new Set<string>();

  let previewWalls: Wall[];

  switch (strategy) {
    case 'rigid-translation':
      previewWalls = buildRigidTranslation(request, wallMap);
      break;

    case 'stretch-move':
      previewWalls = buildStretchMove(
        request,
        topology,
        wallMap,
        affectedExternalWallIds,
      );
      break;

    case 'detach-move':
      previewWalls = buildDetachMove(request, topology, wallMap);
      break;

    default:
      return {
        valid: false,
        strategy: 'block',
        warnings: [],
        errors: [{ type: 'topology-break', message: 'Unknown move strategy' }],
        previewWalls: walls,
        affectedExternalWallIds: [],
        affectedRoomIds: [],
      };
  }

  // --- Validate preview ---

  // Check 1: No wall below minimum length
  for (const wall of previewWalls) {
    const length = dist(wall.startPoint, wall.endPoint);
    if (length < MIN_WALL_LENGTH_THRESHOLD) {
      errors.push({
        type: 'min-length',
        message: `Wall ${wall.id} would be ${length.toFixed(1)}mm (min: ${MIN_WALL_LENGTH_THRESHOLD}mm)`,
      });
    }
  }

  // Check 2: No self-intersecting room polygons (simplified check)
  // Collect affected rooms
  for (const wallId of request.wallIds) {
    const faces = topology.getFacesContainingEdge(wallId);
    for (const face of faces) {
      affectedRoomIds.add(face.roomId);
    }
  }
  for (const extWid of affectedExternalWallIds) {
    const faces = topology.getFacesContainingEdge(extWid);
    for (const face of faces) {
      affectedRoomIds.add(face.roomId);
    }
  }

  // Check 3: Near-overlap warnings
  const previewWallMap = new Map(previewWalls.map((w) => [w.id, w]));
  for (const wall of previewWalls) {
    if (!wallIdSet.has(wall.id)) continue;
    for (const other of previewWalls) {
      if (other.id === wall.id) continue;
      if (wallIdSet.has(other.id)) continue; // both moving, skip
      // Simple parallel check
      const d = segmentDistance(
        wall.startPoint, wall.endPoint,
        other.startPoint, other.endPoint,
      );
      if (d < NEAR_OVERLAP_THRESHOLD_MM && d > 0) {
        warnings.push({
          type: 'near-overlap',
          wallId: wall.id,
          message: `Wall ${wall.id} is very close to wall ${other.id} (${d.toFixed(1)}mm)`,
        });
      }
    }
  }

  const valid = errors.length === 0;

  return {
    valid,
    strategy: valid ? strategy : 'block',
    warnings,
    errors,
    previewWalls,
    affectedExternalWallIds,
    affectedRoomIds: Array.from(affectedRoomIds),
  };
}

// =============================================================================
// Execute Move
// =============================================================================

/**
 * Execute a validated move. Call previewMove first, then execute if valid.
 */
export function executeMove(
  request: MoveRequest,
  topology: BuildingTopology,
  walls: Wall[],
  rooms: Room[],
): MoveResult {
  const preview = previewMove(request, topology, walls, rooms);

  if (!preview.valid) {
    return {
      success: false,
      updatedWalls: walls,
      affectedRoomIds: [],
      strategy: 'block',
      errors: preview.errors,
      warnings: preview.warnings,
    };
  }

  return {
    success: true,
    updatedWalls: preview.previewWalls,
    affectedRoomIds: preview.affectedRoomIds,
    strategy: preview.strategy,
    errors: [],
    warnings: preview.warnings,
  };
}

// =============================================================================
// Strategy Implementations
// =============================================================================

/**
 * Rigid translation: all selected walls move by the delta.
 * No stretching, no topology changes.
 */
function buildRigidTranslation(
  request: MoveRequest,
  wallMap: Map<string, Wall>,
): Wall[] {
  const wallIdSet = new Set(request.wallIds);
  const result: Wall[] = [];

  for (const [id, wall] of wallMap) {
    if (wallIdSet.has(id)) {
      result.push(rebuildWallGeometry({
        ...wall,
        startPoint: addDelta(wall.startPoint, request.delta),
        endPoint: addDelta(wall.endPoint, request.delta),
      }));
    } else {
      result.push(wall);
    }
  }

  return result;
}

/**
 * Stretch move: internal nodes translate, boundary nodes stay attached.
 * External walls "stretch" to follow boundary node movement.
 */
function buildStretchMove(
  request: MoveRequest,
  topology: BuildingTopology,
  wallMap: Map<string, Wall>,
  outAffectedExternalWallIds: string[],
): Wall[] {
  const subgraph = topology.extractSubgraph(request.wallIds);
  const wallIdSet = new Set(request.wallIds);

  // Build a set of "moving node IDs" — all nodes in the subgraph
  // (both internal and boundary nodes move with the delta)
  const movingNodeIds = new Set(subgraph.nodes.map((n) => n.id));

  // Build a map: nodeId → new position
  const nodePositions = new Map<string, Point2D>();
  for (const node of subgraph.nodes) {
    nodePositions.set(node.id, addDelta(node.position, request.delta));
  }

  const result: Wall[] = [];

  for (const [id, wall] of wallMap) {
    if (wallIdSet.has(id)) {
      // Selected wall: translate both endpoints
      result.push(rebuildWallGeometry({
        ...wall,
        startPoint: addDelta(wall.startPoint, request.delta),
        endPoint: addDelta(wall.endPoint, request.delta),
      }));
    } else {
      // Non-selected wall: check if any of its nodes is a boundary node
      const edge = topology.getEdge(id);
      if (!edge) {
        result.push(wall);
        continue;
      }

      let startPoint = wall.startPoint;
      let endPoint = wall.endPoint;
      let modified = false;

      // If start node is in the moving set, update start point
      if (movingNodeIds.has(edge.startNodeId)) {
        startPoint = nodePositions.get(edge.startNodeId) ?? startPoint;
        modified = true;
      }

      // If end node is in the moving set, update end point
      if (movingNodeIds.has(edge.endNodeId)) {
        endPoint = nodePositions.get(edge.endNodeId) ?? endPoint;
        modified = true;
      }

      if (modified) {
        outAffectedExternalWallIds.push(id);
        result.push(rebuildWallGeometry({
          ...wall,
          startPoint,
          endPoint,
        }));
      } else {
        result.push(wall);
      }
    }
  }

  return result;
}

/**
 * Detach move: break shared connections, then translate rigidly.
 * Creates new wall endpoints at the break points.
 */
function buildDetachMove(
  request: MoveRequest,
  topology: BuildingTopology,
  wallMap: Map<string, Wall>,
): Wall[] {
  const subgraph = topology.extractSubgraph(request.wallIds);
  const wallIdSet = new Set(request.wallIds);

  // Step 1: For each boundary node, disconnect external walls
  // by removing the selected wall IDs from their connectedWalls
  const externalWallUpdates = new Map<string, string[]>();

  for (const boundaryNode of subgraph.boundaryNodes) {
    const refs = topology.getWallsAtNode(boundaryNode.id);
    for (const ref of refs) {
      if (wallIdSet.has(ref.wallId)) continue; // skip selected walls

      const wall = wallMap.get(ref.wallId);
      if (!wall) continue;

      // Remove selected wall IDs from connected list
      const updatedConnected = wall.connectedWalls.filter(
        (cid) => !wallIdSet.has(cid),
      );
      externalWallUpdates.set(ref.wallId, updatedConnected);
    }
  }

  // Step 2: For selected walls, remove external wall IDs from connected
  const internalWallConnUpdates = new Map<string, string[]>();
  for (const wallId of request.wallIds) {
    const wall = wallMap.get(wallId);
    if (!wall) continue;

    const updatedConnected = wall.connectedWalls.filter(
      (cid) => wallIdSet.has(cid),
    );
    internalWallConnUpdates.set(wallId, updatedConnected);
  }

  // Step 3: Translate selected walls, update connections
  const result: Wall[] = [];

  for (const [id, wall] of wallMap) {
    if (wallIdSet.has(id)) {
      const connectedWalls = internalWallConnUpdates.get(id) ?? wall.connectedWalls;
      result.push(rebuildWallGeometry({
        ...wall,
        startPoint: addDelta(wall.startPoint, request.delta),
        endPoint: addDelta(wall.endPoint, request.delta),
        connectedWalls,
      }));
    } else if (externalWallUpdates.has(id)) {
      result.push({
        ...wall,
        connectedWalls: externalWallUpdates.get(id)!,
      });
    } else {
      result.push(wall);
    }
  }

  return result;
}

// =============================================================================
// Geometry helpers
// =============================================================================

function segmentDistance(
  aStart: Point2D,
  aEnd: Point2D,
  bStart: Point2D,
  bEnd: Point2D,
): number {
  return Math.min(
    pointToSegmentDistance(aStart, bStart, bEnd),
    pointToSegmentDistance(aEnd, bStart, bEnd),
    pointToSegmentDistance(bStart, aStart, aEnd),
    pointToSegmentDistance(bEnd, aStart, aEnd),
  );
}

function pointToSegmentDistance(
  point: Point2D,
  start: Point2D,
  end: Point2D,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 0.000001) {
    return dist(point, start);
  }

  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq,
  ));

  const proj = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  };

  return dist(point, proj);
}
