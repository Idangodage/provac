/**
 * RoomBoundaryResolver
 *
 * Computes room corner positions, boundary polygons, and resynchronises
 * room vertices from the wall network. Handles all polygon shapes:
 * rectangles, L-shapes, triangles, irregular polygons.
 */

import type { Point2D, Room, Wall } from '../types';
import { GeometryEngine } from '../utils/geometry-engine';

import { BuildingTopology } from './BuildingTopology';
import type { TopologyNode } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomCorner {
  nodeId: string;
  position: Point2D;
  /** The two wall IDs meeting at this corner */
  wallIds: [string, string];
  /** Interior angle in degrees */
  interiorAngle: number;
  /** true if interiorAngle < 180° */
  isConvex: boolean;
  /** true if interiorAngle > 180° (reflex, e.g. L-shapes) */
  isReflex: boolean;
}

export interface RoomBoundaryResult {
  corners: RoomCorner[];
  /** Interior-face polygon vertices (computed from wall offsets) */
  interiorPolygon: Point2D[];
  area: number;
  perimeter: number;
  centroid: Point2D;
  valid: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function normalize(v: Point2D): Point2D {
  const len = Math.hypot(v.x, v.y);
  if (len < 0.000001) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function cross2D(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Compute the signed area of a polygon.
 * Positive = counter-clockwise, negative = clockwise.
 */
function signedArea(vertices: Point2D[]): number {
  let area = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vertices[i].x * vertices[j].y;
    area -= vertices[j].x * vertices[i].y;
  }
  return area / 2;
}

/**
 * Compute interior angle at vertex B in the sequence A-B-C.
 * Returns angle in degrees [0, 360).
 */
function interiorAngle(a: Point2D, b: Point2D, c: Point2D): number {
  const ba = subtract(a, b);
  const bc = subtract(c, b);
  const angle = Math.atan2(cross2D(ba, bc), dot(ba, bc));
  // Convert to degrees, ensure positive
  let degrees = (angle * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  return degrees;
}

/**
 * Compute the intersection of two lines, each defined by a point and direction.
 */
function lineIntersection(
  p1: Point2D,
  d1: Point2D,
  p2: Point2D,
  d2: Point2D,
): Point2D | null {
  const denom = cross2D(d1, d2);
  if (Math.abs(denom) < 0.000001) return null; // parallel
  const t = cross2D(subtract(p2, p1), d2) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered corners of a room from the topology.
 *
 * This walks the room's boundary edges in order, identifying the
 * topology nodes that form the room's corners.
 */
export function resolveRoomCorners(
  roomId: string,
  topology: BuildingTopology,
  walls: Wall[],
): RoomCorner[] {
  const face = topology.getFace(roomId);
  if (!face || face.edgeIds.length < 3) return [];

  const wallMap = new Map(walls.map((w) => [w.id, w]));

  // Build ordered node loop from edge loop
  const orderedNodeIds = buildOrderedNodeLoop(face.edgeIds, topology);
  if (orderedNodeIds.length < 3) return [];

  const corners: RoomCorner[] = [];
  const n = orderedNodeIds.length;

  for (let i = 0; i < n; i++) {
    const prevIdx = (i - 1 + n) % n;
    const nextIdx = (i + 1) % n;

    const prevNodeId = orderedNodeIds[prevIdx];
    const currNodeId = orderedNodeIds[i];
    const nextNodeId = orderedNodeIds[nextIdx];

    const prevNode = topology.getNode(prevNodeId);
    const currNode = topology.getNode(currNodeId);
    const nextNode = topology.getNode(nextNodeId);

    if (!prevNode || !currNode || !nextNode) continue;

    const angle = interiorAngle(prevNode.position, currNode.position, nextNode.position);

    // Find the two walls meeting at this corner
    const incomingEdge = findEdgeBetweenNodes(prevNodeId, currNodeId, face.edgeIds, topology);
    const outgoingEdge = findEdgeBetweenNodes(currNodeId, nextNodeId, face.edgeIds, topology);

    corners.push({
      nodeId: currNodeId,
      position: { ...currNode.position },
      wallIds: [incomingEdge ?? '', outgoingEdge ?? ''],
      interiorAngle: angle,
      isConvex: angle < 180,
      isReflex: angle > 180,
    });
  }

  return corners;
}

/**
 * Recompute room boundary polygon from the wall network.
 *
 * For each corner, compute the interior-face point by offsetting
 * the two meeting walls inward by thickness/2 and intersecting.
 */
export function computeRoomBoundary(
  roomId: string,
  topology: BuildingTopology,
  walls: Wall[],
): RoomBoundaryResult {
  const corners = resolveRoomCorners(roomId, topology, walls);

  if (corners.length < 3) {
    return {
      corners: [],
      interiorPolygon: [],
      area: 0,
      perimeter: 0,
      centroid: { x: 0, y: 0 },
      valid: false,
      reason: 'Room has fewer than 3 corners',
    };
  }

  const wallMap = new Map(walls.map((w) => [w.id, w]));
  const interiorPolygon: Point2D[] = [];

  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i];
    const wall1 = wallMap.get(corner.wallIds[0]);
    const wall2 = wallMap.get(corner.wallIds[1]);

    if (!wall1 || !wall2) {
      // Fall back to the corner node position
      interiorPolygon.push({ ...corner.position });
      continue;
    }

    // Compute interior offset lines for both walls
    const offset1 = computeInteriorOffsetAtNode(wall1, corner.nodeId, topology);
    const offset2 = computeInteriorOffsetAtNode(wall2, corner.nodeId, topology);

    if (!offset1 || !offset2) {
      interiorPolygon.push({ ...corner.position });
      continue;
    }

    // Intersect the two offset lines to get the interior corner point
    const intersection = lineIntersection(
      offset1.point,
      offset1.direction,
      offset2.point,
      offset2.direction,
    );

    if (intersection) {
      // Clamp to reasonable distance from node to prevent infinite miter
      const maxMiter = Math.max(wall1.thickness, wall2.thickness) * 3;
      if (dist(intersection, corner.position) < maxMiter) {
        interiorPolygon.push(intersection);
      } else {
        interiorPolygon.push({ ...corner.position });
      }
    } else {
      interiorPolygon.push({ ...corner.position });
    }
  }

  // Ensure consistent winding (CCW)
  if (signedArea(interiorPolygon) < 0) {
    interiorPolygon.reverse();
  }

  // Calculate metrics
  const area = Math.abs(signedArea(interiorPolygon)) ; // Already in mm²
  let perimeter = 0;
  for (let i = 0; i < interiorPolygon.length; i++) {
    const j = (i + 1) % interiorPolygon.length;
    perimeter += dist(interiorPolygon[i], interiorPolygon[j]);
  }

  // Centroid
  const centroid = GeometryEngine.findRoomCentroid({ vertices: interiorPolygon });

  // Validate
  const selfIntersects = GeometryEngine.polygonSelfIntersects(interiorPolygon);

  return {
    corners,
    interiorPolygon,
    area,
    perimeter,
    centroid,
    valid: !selfIntersects && area > 0,
    reason: selfIntersects ? 'Room polygon self-intersects' : undefined,
  };
}

/**
 * Resynchronise a Room object's vertices, area, perimeter, and centroid
 * from the wall network. Returns the updated room (does NOT mutate in place).
 */
export function resyncRoomVertices(
  room: Room,
  topology: BuildingTopology,
  walls: Wall[],
): Room {
  const boundary = computeRoomBoundary(room.id, topology, walls);

  if (!boundary.valid || boundary.interiorPolygon.length < 3) {
    // Return unchanged if boundary couldn't be computed
    return room;
  }

  return {
    ...room,
    vertices: boundary.interiorPolygon,
    area: boundary.area,
    perimeter: boundary.perimeter,
    centroid: boundary.centroid,
    validationWarnings: boundary.valid
      ? room.validationWarnings.filter((w) => w !== 'Room polygon self-intersects')
      : [...room.validationWarnings, boundary.reason ?? 'Invalid boundary'],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build an ordered loop of node IDs from an edge set.
 */
function buildOrderedNodeLoop(
  edgeIds: string[],
  topology: BuildingTopology,
): string[] {
  if (edgeIds.length === 0) return [];

  // Build adjacency: nodeId → set of connected nodeIds via these edges
  const adj = new Map<string, Set<string>>();
  const edgeMap = new Map<string, [string, string]>();

  for (const eid of edgeIds) {
    const edge = topology.getEdge(eid);
    if (!edge) continue;
    edgeMap.set(eid, [edge.startNodeId, edge.endNodeId]);

    if (!adj.has(edge.startNodeId)) adj.set(edge.startNodeId, new Set());
    if (!adj.has(edge.endNodeId)) adj.set(edge.endNodeId, new Set());
    adj.get(edge.startNodeId)!.add(edge.endNodeId);
    adj.get(edge.endNodeId)!.add(edge.startNodeId);
  }

  if (adj.size === 0) return [];

  // Walk the loop starting from an arbitrary node
  const startNode = adj.keys().next().value;
  if (!startNode) return [];

  const visited = new Set<string>();
  const result: string[] = [];
  let current = startNode;

  while (!visited.has(current)) {
    visited.add(current);
    result.push(current);

    const neighbors = adj.get(current);
    if (!neighbors) break;

    let next: string | null = null;
    for (const candidate of neighbors) {
      if (!visited.has(candidate)) {
        next = candidate;
        break;
      }
    }

    if (next === null) break;
    current = next;
  }

  return result;
}

/**
 * Find the edge (wall) ID connecting two nodes within a specific edge set.
 */
function findEdgeBetweenNodes(
  nodeA: string,
  nodeB: string,
  edgeIds: string[],
  topology: BuildingTopology,
): string | null {
  for (const eid of edgeIds) {
    const edge = topology.getEdge(eid);
    if (!edge) continue;
    if (
      (edge.startNodeId === nodeA && edge.endNodeId === nodeB) ||
      (edge.startNodeId === nodeB && edge.endNodeId === nodeA)
    ) {
      return eid;
    }
  }
  return null;
}

/**
 * Compute the interior offset line of a wall at a given node.
 * Returns a point on the offset line and a direction along it.
 */
function computeInteriorOffsetAtNode(
  wall: Wall,
  nodeId: string,
  topology: BuildingTopology,
): { point: Point2D; direction: Point2D } | null {
  const nodes = topology.getNodesForWall(wall.id);
  if (!nodes) return null;

  const [startNode, endNode] = nodes;
  const isStart = startNode.id === nodeId;

  // Wall direction
  const wallDir = normalize(subtract(wall.endPoint, wall.startPoint));
  // Interior normal (left-hand perpendicular)
  const interiorNormal: Point2D = { x: -wallDir.y, y: wallDir.x };
  const halfT = wall.thickness / 2;

  // The interior offset line is parallel to the wall, shifted by halfT in the interior direction
  const nodePos = isStart ? wall.startPoint : wall.endPoint;
  const offsetPoint: Point2D = {
    x: nodePos.x + interiorNormal.x * halfT,
    y: nodePos.y + interiorNormal.y * halfT,
  };

  // Direction along the wall (pointing away from the node into the wall)
  const direction = isStart
    ? wallDir
    : { x: -wallDir.x, y: -wallDir.y };

  return { point: offsetPoint, direction };
}
