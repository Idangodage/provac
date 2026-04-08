/**
 * BuildingTopology
 *
 * Pure-logic class that builds a half-edge graph from the existing
 * Wall[] and Room[] arrays. Provides fast adjacency, containment, and
 * connectivity queries used by selection, move, and thickness operations.
 *
 * This is a **derived** acceleration structure — it does NOT replace
 * the source-of-truth Wall[]/Room[] arrays in the Zustand store.
 *
 * All coordinates are in millimetres.
 */

import type { Point2D, Room, Wall } from '../types';

import type {
  ElementCapabilities,
  ThicknessMode,
  TopologyEdge,
  TopologyFace,
  TopologyIssue,
  TopologyNode,
  TopologySubgraph,
  TopologyValidationResult,
  WallEndRef,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default tolerance for snapping endpoints into the same node (mm). */
const DEFAULT_NODE_TOLERANCE_MM = 2;

/** Minimum wall length considered valid (mm). */
const MIN_VALID_WALL_LENGTH_MM = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalize(v: Point2D): Point2D {
  const len = Math.hypot(v.x, v.y);
  if (len < 0.000001) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

/**
 * Deterministic hash for a node position.
 * Rounds to 0.1 mm to absorb floating-point jitter.
 */
function positionHash(point: Point2D): string {
  const rx = Math.round(point.x * 10) / 10;
  const ry = Math.round(point.y * 10) / 10;
  return `n:${rx}:${ry}`;
}

// ---------------------------------------------------------------------------
// BuildingTopology
// ---------------------------------------------------------------------------

export class BuildingTopology {
  // Primary stores
  private _nodes: Map<string, TopologyNode> = new Map();
  private _edges: Map<string, TopologyEdge> = new Map();
  private _faces: Map<string, TopologyFace> = new Map();

  // Indexes
  /** wallEndRef[] keyed by nodeId – which wall endpoints touch a node */
  private _nodeWalls: Map<string, WallEndRef[]> = new Map();
  /** nodeId pair keyed by wallId */
  private _wallNodes: Map<string, [string, string]> = new Map();
  /** roomId[] keyed by wallId – which rooms contain this wall */
  private _wallFaces: Map<string, string[]> = new Map();
  /** roomId[] keyed by nodeId – which rooms contain this node */
  private _nodeFaces: Map<string, string[]> = new Map();

  private _tolerance: number;

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  private constructor(tolerance: number) {
    this._tolerance = tolerance;
  }

  /**
   * Build a topology graph from the current walls and rooms.
   */
  static fromWallsAndRooms(
    walls: Wall[],
    rooms: Room[],
    tolerance: number = DEFAULT_NODE_TOLERANCE_MM,
  ): BuildingTopology {
    const topo = new BuildingTopology(tolerance);
    topo._buildNodes(walls);
    topo._buildEdges(walls);
    topo._buildFaces(rooms);
    return topo;
  }

  // ---- internal build steps ------------------------------------------------

  /**
   * Phase 1: Identify unique junction nodes from wall endpoints.
   * Endpoints within `tolerance` of each other collapse into one node.
   */
  private _buildNodes(walls: Wall[]): void {
    const buckets = new Map<string, { position: Point2D; refs: WallEndRef[] }>();

    for (const wall of walls) {
      for (const ep of ['start', 'end'] as const) {
        const point = ep === 'start' ? wall.startPoint : wall.endPoint;
        const hash = positionHash(point);

        // Try to find an existing node within tolerance
        let assigned = false;
        for (const [key, bucket] of buckets) {
          if (dist(bucket.position, point) <= this._tolerance) {
            bucket.refs.push({ wallId: wall.id, endpoint: ep });
            assigned = true;
            break;
          }
        }

        if (!assigned) {
          buckets.set(hash + ':' + wall.id + ':' + ep, {
            position: { x: point.x, y: point.y },
            refs: [{ wallId: wall.id, endpoint: ep }],
          });
        }
      }
    }

    // Merge buckets that ended up close together (second pass)
    const mergedBuckets = this._mergeBuckets(
      Array.from(buckets.values()),
    );

    let nodeIndex = 0;
    for (const bucket of mergedBuckets) {
      // Compute averaged position
      const avgX = bucket.refs.reduce((sum, _r, i) => {
        // Use the first ref's position (they are all within tolerance)
        return sum;
      }, bucket.position.x);
      const avgY = bucket.position.y;

      const nodeId = `tnode-${nodeIndex++}`;
      const node: TopologyNode = {
        id: nodeId,
        position: { x: avgX, y: avgY },
        wallEndpoints: bucket.refs,
        degree: bucket.refs.length,
      };

      this._nodes.set(nodeId, node);
      this._nodeWalls.set(nodeId, bucket.refs);

      // Register each wall endpoint → node mapping
      for (const ref of bucket.refs) {
        const existing = this._wallNodes.get(ref.wallId);
        if (!existing) {
          this._wallNodes.set(
            ref.wallId,
            ref.endpoint === 'start'
              ? [nodeId, '']
              : ['', nodeId],
          );
        } else {
          if (ref.endpoint === 'start') {
            existing[0] = nodeId;
          } else {
            existing[1] = nodeId;
          }
        }
      }
    }
  }

  /**
   * Merge position buckets that are within tolerance of each other.
   */
  private _mergeBuckets(
    buckets: { position: Point2D; refs: WallEndRef[] }[],
  ): { position: Point2D; refs: WallEndRef[] }[] {
    const merged: { position: Point2D; refs: WallEndRef[] }[] = [];

    for (const bucket of buckets) {
      let found = false;
      for (const existing of merged) {
        if (dist(existing.position, bucket.position) <= this._tolerance) {
          existing.refs.push(...bucket.refs);
          found = true;
          break;
        }
      }
      if (!found) {
        merged.push({
          position: { ...bucket.position },
          refs: [...bucket.refs],
        });
      }
    }

    // Update degree after merging
    for (const bucket of merged) {
      // Deduplicate refs (same wallId + endpoint shouldn't appear twice)
      const seen = new Set<string>();
      bucket.refs = bucket.refs.filter((ref) => {
        const key = `${ref.wallId}:${ref.endpoint}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return merged;
  }

  /**
   * Phase 2: Build edge records for each wall.
   */
  private _buildEdges(walls: Wall[]): void {
    for (const wall of walls) {
      const nodePair = this._wallNodes.get(wall.id);
      if (!nodePair || !nodePair[0] || !nodePair[1]) {
        continue; // wall not connected to two nodes — degenerate
      }

      const dir = normalize(subtract(wall.endPoint, wall.startPoint));
      const normal: Point2D = { x: -dir.y, y: dir.x };
      const length = dist(wall.startPoint, wall.endPoint);

      const edge: TopologyEdge = {
        wallId: wall.id,
        startNodeId: nodePair[0],
        endNodeId: nodePair[1],
        thickness: wall.thickness,
        material: wall.material,
        length,
        direction: dir,
        normal,
      };

      this._edges.set(wall.id, edge);
    }
  }

  /**
   * Phase 3: Build face records for each room.
   */
  private _buildFaces(rooms: Room[]): void {
    for (const room of rooms) {
      const edgeIds = room.wallIds.filter((wid) => this._edges.has(wid));

      // Collect unique nodes used by these edges
      const nodeIdSet = new Set<string>();
      for (const wid of edgeIds) {
        const edge = this._edges.get(wid);
        if (edge) {
          nodeIdSet.add(edge.startNodeId);
          nodeIdSet.add(edge.endNodeId);
        }
      }

      const face: TopologyFace = {
        roomId: room.id,
        edgeIds,
        nodeIds: Array.from(nodeIdSet),
        vertices: room.vertices.map((v) => ({ x: v.x, y: v.y })),
        isExterior: room.isExterior ?? false,
      };

      this._faces.set(room.id, face);

      // Build reverse indexes
      for (const wid of edgeIds) {
        const existing = this._wallFaces.get(wid);
        if (existing) {
          if (!existing.includes(room.id)) {
            existing.push(room.id);
          }
        } else {
          this._wallFaces.set(wid, [room.id]);
        }
      }

      for (const nid of nodeIdSet) {
        const existing = this._nodeFaces.get(nid);
        if (existing) {
          if (!existing.includes(room.id)) {
            existing.push(room.id);
          }
        } else {
          this._nodeFaces.set(nid, [room.id]);
        }
      }
    }
  }

  // ===========================================================================
  // Node Queries
  // ===========================================================================

  getNode(nodeId: string): TopologyNode | undefined {
    return this._nodes.get(nodeId);
  }

  getAllNodes(): TopologyNode[] {
    return Array.from(this._nodes.values());
  }

  /**
   * Get the two nodes at the endpoints of a wall.
   */
  getNodesForWall(wallId: string): [TopologyNode, TopologyNode] | null {
    const pair = this._wallNodes.get(wallId);
    if (!pair || !pair[0] || !pair[1]) return null;
    const startNode = this._nodes.get(pair[0]);
    const endNode = this._nodes.get(pair[1]);
    if (!startNode || !endNode) return null;
    return [startNode, endNode];
  }

  /**
   * Get all wall endpoint references that touch a node.
   */
  getWallsAtNode(nodeId: string): WallEndRef[] {
    return this._nodeWalls.get(nodeId) ?? [];
  }

  /**
   * Find a node at a given position within tolerance.
   */
  getNodeAtPosition(point: Point2D, tolerance?: number): TopologyNode | undefined {
    const tol = tolerance ?? this._tolerance;
    for (const node of this._nodes.values()) {
      if (dist(node.position, point) <= tol) {
        return node;
      }
    }
    return undefined;
  }

  // ===========================================================================
  // Edge Queries
  // ===========================================================================

  getEdge(wallId: string): TopologyEdge | undefined {
    return this._edges.get(wallId);
  }

  getAllEdges(): TopologyEdge[] {
    return Array.from(this._edges.values());
  }

  /**
   * Get all edges that touch a given node.
   */
  getEdgesAtNode(nodeId: string): TopologyEdge[] {
    const refs = this._nodeWalls.get(nodeId) ?? [];
    const wallIds = new Set(refs.map((r) => r.wallId));
    const edges: TopologyEdge[] = [];
    for (const wid of wallIds) {
      const edge = this._edges.get(wid);
      if (edge) edges.push(edge);
    }
    return edges;
  }

  /**
   * Get IDs of walls directly connected to a wall (sharing a node).
   */
  getAdjacentWallIds(wallId: string): string[] {
    const pair = this._wallNodes.get(wallId);
    if (!pair) return [];

    const result = new Set<string>();
    for (const nodeId of pair) {
      if (!nodeId) continue;
      const refs = this._nodeWalls.get(nodeId) ?? [];
      for (const ref of refs) {
        if (ref.wallId !== wallId) {
          result.add(ref.wallId);
        }
      }
    }

    return Array.from(result);
  }

  // ===========================================================================
  // Face Queries
  // ===========================================================================

  getFace(roomId: string): TopologyFace | undefined {
    return this._faces.get(roomId);
  }

  getAllFaces(): TopologyFace[] {
    return Array.from(this._faces.values());
  }

  /**
   * Get rooms that contain a given wall.
   */
  getFacesContainingEdge(wallId: string): TopologyFace[] {
    const roomIds = this._wallFaces.get(wallId) ?? [];
    return roomIds
      .map((rid) => this._faces.get(rid))
      .filter((f): f is TopologyFace => f !== undefined);
  }

  /**
   * Get rooms that contain a given node.
   */
  getFacesContainingNode(nodeId: string): TopologyFace[] {
    const roomIds = this._nodeFaces.get(nodeId) ?? [];
    return roomIds
      .map((rid) => this._faces.get(rid))
      .filter((f): f is TopologyFace => f !== undefined);
  }

  /**
   * Get rooms shared between two walls.
   */
  getSharedFaces(wallId1: string, wallId2: string): TopologyFace[] {
    const rooms1 = new Set(this._wallFaces.get(wallId1) ?? []);
    const rooms2 = this._wallFaces.get(wallId2) ?? [];
    const shared = rooms2.filter((rid) => rooms1.has(rid));
    return shared
      .map((rid) => this._faces.get(rid))
      .filter((f): f is TopologyFace => f !== undefined);
  }

  // ===========================================================================
  // Subgraph Extraction
  // ===========================================================================

  /**
   * Extract the subgraph formed by a set of wall IDs.
   * Classifies each node as boundary (shared with outside) or internal.
   */
  extractSubgraph(wallIds: string[]): TopologySubgraph {
    const wallIdSet = new Set(wallIds);

    // Collect all nodes used by selected walls
    const nodeIdSet = new Set<string>();
    const edges: TopologyEdge[] = [];

    for (const wid of wallIds) {
      const edge = this._edges.get(wid);
      if (!edge) continue;
      edges.push(edge);
      nodeIdSet.add(edge.startNodeId);
      nodeIdSet.add(edge.endNodeId);
    }

    const nodes: TopologyNode[] = [];
    const boundaryNodes: TopologyNode[] = [];
    const internalNodes: TopologyNode[] = [];
    const externalWallIds = new Set<string>();

    for (const nodeId of nodeIdSet) {
      const node = this._nodes.get(nodeId);
      if (!node) continue;
      nodes.push(node);

      // Check if any wall at this node is outside the selection
      const refs = this._nodeWalls.get(nodeId) ?? [];
      const hasExternal = refs.some((ref) => !wallIdSet.has(ref.wallId));

      if (hasExternal) {
        boundaryNodes.push(node);
        // Collect external wall IDs
        for (const ref of refs) {
          if (!wallIdSet.has(ref.wallId)) {
            externalWallIds.add(ref.wallId);
          }
        }
      } else {
        internalNodes.push(node);
      }
    }

    // Collect affected faces
    const faceIdSet = new Set<string>();
    for (const wid of wallIds) {
      const roomIds = this._wallFaces.get(wid) ?? [];
      for (const rid of roomIds) faceIdSet.add(rid);
    }
    const faces = Array.from(faceIdSet)
      .map((rid) => this._faces.get(rid))
      .filter((f): f is TopologyFace => f !== undefined);

    return {
      nodes,
      edges,
      faces,
      boundaryNodes,
      internalNodes,
      externalWallIds: Array.from(externalWallIds),
    };
  }

  // ===========================================================================
  // Graph Analysis
  // ===========================================================================

  /**
   * Check if a set of wall IDs forms a closed loop.
   */
  isClosedLoop(wallIds: string[]): boolean {
    if (wallIds.length < 2) return false;

    // Collect all nodes; each node must appear exactly twice
    const nodeCounts = new Map<string, number>();
    for (const wid of wallIds) {
      const pair = this._wallNodes.get(wid);
      if (!pair) return false;
      for (const nid of pair) {
        if (!nid) return false;
        nodeCounts.set(nid, (nodeCounts.get(nid) ?? 0) + 1);
      }
    }

    return Array.from(nodeCounts.values()).every((count) => count === 2);
  }

  /**
   * Check if moving a set of walls by a delta would disconnect the graph.
   * (Simplified heuristic: checks if boundary nodes can survive the stretch.)
   */
  wouldDisconnect(wallIds: string[], delta: Point2D): boolean {
    const subgraph = this.extractSubgraph(wallIds);

    // If no boundary nodes, the subgraph is isolated — never disconnects
    if (subgraph.boundaryNodes.length === 0) return false;

    // For each external wall at a boundary node, check if it would become
    // shorter than MIN_VALID_WALL_LENGTH_MM after the move
    for (const extWallId of subgraph.externalWallIds) {
      const edge = this._edges.get(extWallId);
      if (!edge) continue;

      const startNode = this._nodes.get(edge.startNodeId);
      const endNode = this._nodes.get(edge.endNodeId);
      if (!startNode || !endNode) continue;

      // Determine which endpoint moves
      const startMoves = subgraph.boundaryNodes.some((n) => n.id === edge.startNodeId);
      const endMoves = subgraph.boundaryNodes.some((n) => n.id === edge.endNodeId);

      let newStart = startNode.position;
      let newEnd = endNode.position;

      if (startMoves) {
        newStart = { x: newStart.x + delta.x, y: newStart.y + delta.y };
      }
      if (endMoves) {
        newEnd = { x: newEnd.x + delta.x, y: newEnd.y + delta.y };
      }

      if (dist(newStart, newEnd) < MIN_VALID_WALL_LENGTH_MM) {
        return true;
      }
    }

    return false;
  }

  // ===========================================================================
  // Capabilities
  // ===========================================================================

  /**
   * Compute capabilities for a wall based on its topology context.
   */
  getWallCapabilities(wallId: string): ElementCapabilities {
    const edge = this._edges.get(wallId);
    if (!edge) {
      return {
        canMoveRigid: false,
        canMoveWithStretch: false,
        canDetach: false,
        canEditThickness: false,
        allowedThicknessModes: [],
        requiresEnvelopeWarning: false,
        requiresJoinRebuild: false,
        blockedReason: 'Wall not found in topology',
      };
    }

    const startNode = this._nodes.get(edge.startNodeId);
    const endNode = this._nodes.get(edge.endNodeId);
    const startDegree = startNode?.degree ?? 0;
    const endDegree = endNode?.degree ?? 0;
    const adjacentFaces = this.getFacesContainingEdge(wallId);
    const isEnvelopeWall = adjacentFaces.some((f) => f.isExterior) || adjacentFaces.length <= 1;
    const isSharedWall = adjacentFaces.length >= 2;
    const hasConnections = startDegree > 1 || endDegree > 1;
    const isFreestanding = startDegree <= 1 && endDegree <= 1;

    // Thickness modes
    const thicknessModes: ThicknessMode[] = ['symmetric'];
    if (!isFreestanding) {
      thicknessModes.push('interior-only', 'exterior-only');
    }

    // Rigid move: only if freestanding
    const canMoveRigid = !hasConnections;

    // Stretch: can move if the drag yields valid geometry
    const canMoveWithStretch = hasConnections;

    // Detach: always possible for walls in a network
    const canDetach = hasConnections;

    // Join rebuild needed when connected at junctions
    const requiresJoinRebuild = startDegree >= 2 || endDegree >= 2;

    return {
      canMoveRigid,
      canMoveWithStretch,
      canDetach,
      canEditThickness: true,
      allowedThicknessModes: thicknessModes,
      requiresEnvelopeWarning: isEnvelopeWall,
      requiresJoinRebuild,
      blockedReason: null,
    };
  }

  /**
   * Compute capabilities for a room based on its topology context.
   */
  getRoomCapabilities(roomId: string): ElementCapabilities {
    const face = this._faces.get(roomId);
    if (!face) {
      return {
        canMoveRigid: false,
        canMoveWithStretch: false,
        canDetach: false,
        canEditThickness: false,
        allowedThicknessModes: [],
        requiresEnvelopeWarning: false,
        requiresJoinRebuild: false,
        blockedReason: 'Room not found in topology',
      };
    }

    const subgraph = this.extractSubgraph(face.edgeIds);
    const isIsolated = subgraph.boundaryNodes.length === 0;

    return {
      canMoveRigid: isIsolated,
      canMoveWithStretch: !isIsolated,
      canDetach: !isIsolated,
      canEditThickness: false, // rooms don't have thickness
      allowedThicknessModes: [],
      requiresEnvelopeWarning: face.isExterior,
      requiresJoinRebuild: subgraph.boundaryNodes.length > 0,
      blockedReason: null,
    };
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Validate the entire topology for structural correctness.
   */
  validateTopology(): TopologyValidationResult {
    const issues: TopologyIssue[] = [];

    // Check 1: Every wall should be connected to exactly 2 nodes
    for (const [wallId, pair] of this._wallNodes) {
      if (!pair[0] || !pair[1]) {
        issues.push({
          kind: 'orphaned-endpoint',
          message: `Wall ${wallId} is not connected to two valid nodes`,
          elementIds: [wallId],
          severity: 'error',
        });
      }
    }

    // Check 2: Every edge should have non-zero length
    for (const edge of this._edges.values()) {
      if (edge.length < MIN_VALID_WALL_LENGTH_MM) {
        issues.push({
          kind: 'degenerate-wall',
          message: `Wall ${edge.wallId} is shorter than ${MIN_VALID_WALL_LENGTH_MM}mm (${edge.length.toFixed(1)}mm)`,
          elementIds: [edge.wallId],
          severity: 'warning',
        });
      }
    }

    // Check 3: Room boundary edges should form a connected loop
    for (const face of this._faces.values()) {
      if (face.edgeIds.length >= 3 && !this.isClosedLoop(face.edgeIds)) {
        issues.push({
          kind: 'broken-room-loop',
          message: `Room ${face.roomId} boundary edges do not form a closed loop`,
          elementIds: [face.roomId, ...face.edgeIds],
          severity: 'error',
        });
      }
    }

    // Check 4: Room boundary edges should reference existing walls
    for (const face of this._faces.values()) {
      for (const eid of face.edgeIds) {
        if (!this._edges.has(eid)) {
          issues.push({
            kind: 'missing-wall-reference',
            message: `Room ${face.roomId} references non-existent wall ${eid}`,
            elementIds: [face.roomId, eid],
            severity: 'error',
          });
        }
      }
    }

    return {
      valid: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /** Total number of nodes */
  get nodeCount(): number {
    return this._nodes.size;
  }

  /** Total number of edges */
  get edgeCount(): number {
    return this._edges.size;
  }

  /** Total number of faces */
  get faceCount(): number {
    return this._faces.size;
  }

  /**
   * Debug string representation of the topology.
   */
  toString(): string {
    return (
      `BuildingTopology(` +
      `${this._nodes.size} nodes, ` +
      `${this._edges.size} edges, ` +
      `${this._faces.size} faces)`
    );
  }
}
