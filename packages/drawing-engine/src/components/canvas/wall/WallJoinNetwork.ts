import type { JoinData, JoinType, Point2D, Wall, WallMaterial } from '../../../types';
import { DEFAULT_BEVEL_CONTROL, DEFAULT_WALL_3D } from '../../../types/wall';

import { computeOffsetLines, lineIntersection } from './WallGeometry';

type Endpoint = 'start' | 'end';
type FaceKind = 'interior' | 'exterior';
type NodeJoinType = Extract<JoinType, 'miter' | 'bevel'>;

interface EndpointFace {
  kind: FaceKind;
  anchor: Point2D;
}

interface WallEndpointRef {
  key: string;
  wall: Wall;
  endpoint: Endpoint;
  point: Point2D;
  direction: Point2D;
  length: number;
  angleDeg: number;
  left: EndpointFace;
  right: EndpointFace;
}

interface EndpointNode {
  point: Point2D;
  endpoints: WallEndpointRef[];
}

interface SegmentAttachment {
  endpoint: WallEndpointRef;
  hostWall: Wall;
  point: Point2D;
  angle: number;
}

interface SectorSolution {
  prev: WallEndpointRef;
  next: WallEndpointRef;
  angleDeg: number;
  joinType: NodeJoinType;
  prevVertex: Point2D;
  nextVertex: Point2D;
}

interface EndpointNodeResolution {
  endpointRef: WallEndpointRef;
  cwNeighbor: WallEndpointRef;
  ccwNeighbor: WallEndpointRef;
  leftVertex: Point2D;
  rightVertex: Point2D;
  leftSectorAngleDeg: number;
  rightSectorAngleDeg: number;
  leftSectorJoinType: NodeJoinType;
  rightSectorJoinType: NodeJoinType;
  denseFallback?: boolean;
}

const NODE_TOLERANCE_MM = 2;
const SEGMENT_TOLERANCE_MM = 2;
const MIN_ENDPOINT_JOIN_ANGLE_DEG = 0.5;
const MAX_ENDPOINT_JOIN_ANGLE_DEG = 359.5;
const MIN_SEGMENT_JOIN_ANGLE_DEG = 3;
const ACUTE_BEVEL_THRESHOLD_DEG = 30;
// Keep endpoint-node miters aligned with the safer per-wall update pipeline:
// very small endpoint angles should not create long render-time spikes.
const MIN_ENDPOINT_MITER_ANGLE_DEG = 15;
const NODE_MITER_LIMIT = 2.5;
const MAX_NODE_MITER_LENGTH_FRACTION = 0.35;
const MAX_SAFE_MITER_REACH_LENGTH_FRACTION = 0.3;
const MAX_FULL_JOIN_ENDPOINTS = 6;
const DENSE_NODE_HUB_DEPTH_MULTIPLIER = 1.25;
const MAX_DENSE_NODE_HUB_LENGTH_FRACTION = 0.25;

function pointDistance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function copyPoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

function normalize(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.000001) {
    return { x: 0, y: 0 };
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function lineFromAnchor(anchor: Point2D, direction: Point2D): Point2D {
  return {
    x: anchor.x + direction.x,
    y: anchor.y + direction.y,
  };
}

function normalizeAngleDeg(angleDeg: number): number {
  let normalized = angleDeg % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return normalized;
}

function ccwAngleDeg(fromDeg: number, toDeg: number): number {
  return normalizeAngleDeg(toDeg - fromDeg);
}

function computeBisector(a: Point2D, b: Point2D): Point2D {
  const bisector = normalize({
    x: a.x + b.x,
    y: a.y + b.y,
  });

  if (Math.hypot(bisector.x, bisector.y) < 0.000001) {
    return a;
  }

  return bisector;
}

function computeMaxBevelOffset(lengths: number[]): number {
  if (lengths.length === 0) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(...lengths.map((length) => Math.max(0, length / 2)))
  );
}

function clampPointToDistance(
  point: Point2D,
  origin: Point2D,
  maxDistance: number
): Point2D {
  const distance = pointDistance(point, origin);
  if (distance <= maxDistance || distance < 0.000001) {
    return copyPoint(point);
  }

  const ratio = maxDistance / distance;
  return {
    x: origin.x + (point.x - origin.x) * ratio,
    y: origin.y + (point.y - origin.y) * ratio,
  };
}

function clampSectorMiterPoint(
  prev: WallEndpointRef,
  next: WallEndpointRef,
  miterPoint: Point2D,
  angleDeg: number
): Point2D {
  const joinPoint = {
    x: (prev.point.x + next.point.x) / 2,
    y: (prev.point.y + next.point.y) / 2,
  };
  const halfThickness = Math.max(prev.wall.thickness, next.wall.thickness) / 2;
  const shortestLen = Math.min(prev.length, next.length);
  const halfAngleRad = Math.max(0.05, (angleDeg / 2) * (Math.PI / 180));
  const geometricReach = halfThickness / Math.sin(halfAngleRad);
  const maxReach = Math.min(
    halfThickness * NODE_MITER_LIMIT,
    geometricReach * 1.05,
    shortestLen * MAX_NODE_MITER_LENGTH_FRACTION
  );

  return clampPointToDistance(miterPoint, joinPoint, maxReach);
}

function sectorMiterReach(
  prev: WallEndpointRef,
  next: WallEndpointRef,
  angleDeg: number
): number {
  const maxHalfThickness = Math.max(prev.wall.thickness, next.wall.thickness) / 2;
  const halfAngleRad = Math.max(0.05, (angleDeg / 2) * (Math.PI / 180));
  return maxHalfThickness / Math.sin(halfAngleRad);
}

function projectPointToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D
): { point: Point2D; distance: number; t: number } {
  const segment = {
    x: end.x - start.x,
    y: end.y - start.y,
  };
  const lengthSq = segment.x * segment.x + segment.y * segment.y;

  if (lengthSq < 0.000001) {
    return {
      point: copyPoint(start),
      distance: pointDistance(point, start),
      t: 0,
    };
  }

  const tRaw =
    ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSq;
  const t = Math.max(0, Math.min(1, tRaw));

  return {
    point: {
      x: start.x + segment.x * t,
      y: start.y + segment.y * t,
    },
    distance: pointDistance(point, {
      x: start.x + segment.x * t,
      y: start.y + segment.y * t,
    }),
    t,
  };
}

function endpointKey(wallId: string, endpoint: Endpoint): string {
  return `${wallId}:${endpoint}`;
}

function directionAwayFromEndpoint(wall: Wall, endpoint: Endpoint): Point2D {
  return endpoint === 'start'
    ? normalize({
      x: wall.endPoint.x - wall.startPoint.x,
      y: wall.endPoint.y - wall.startPoint.y,
    })
    : normalize({
      x: wall.startPoint.x - wall.endPoint.x,
      y: wall.startPoint.y - wall.endPoint.y,
    });
}

function wallLength(wall: Wall): number {
  return pointDistance(wall.startPoint, wall.endPoint);
}

function buildEndpointRef(wall: Wall, endpoint: Endpoint): WallEndpointRef {
  const direction = directionAwayFromEndpoint(wall, endpoint);
  const point = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  const angleDeg = normalizeAngleDeg(Math.atan2(direction.y, direction.x) * (180 / Math.PI));

  if (endpoint === 'start') {
    return {
      key: endpointKey(wall.id, endpoint),
      wall,
      endpoint,
      point,
      direction,
      length: wallLength(wall),
      angleDeg,
      left: { kind: 'interior', anchor: wall.interiorLine.start },
      right: { kind: 'exterior', anchor: wall.exteriorLine.start },
    };
  }

  return {
    key: endpointKey(wall.id, endpoint),
    wall,
    endpoint,
    point,
    direction,
    length: wallLength(wall),
    angleDeg,
    left: { kind: 'exterior', anchor: wall.exteriorLine.end },
    right: { kind: 'interior', anchor: wall.interiorLine.end },
  };
}

function buildEndpointNodes(walls: Wall[]): {
  nodes: EndpointNode[];
  nodeByEndpointKey: Map<string, EndpointNode>;
} {
  const refs = walls.flatMap((wall) => [
    buildEndpointRef(wall, 'start'),
    buildEndpointRef(wall, 'end'),
  ]);
  const nodes: EndpointNode[] = [];
  const nodeByEndpointKey = new Map<string, EndpointNode>();

  for (const ref of refs) {
    let node = nodes.find((candidate) => pointDistance(candidate.point, ref.point) <= NODE_TOLERANCE_MM);
    if (!node) {
      node = {
        point: copyPoint(ref.point),
        endpoints: [],
      };
      nodes.push(node);
    } else if (node.endpoints.length > 0) {
      const count = node.endpoints.length + 1;
      node.point = {
        x: (node.point.x * node.endpoints.length + ref.point.x) / count,
        y: (node.point.y * node.endpoints.length + ref.point.y) / count,
      };
    }

    node.endpoints.push(ref);
    nodeByEndpointKey.set(ref.key, node);
  }

  return { nodes, nodeByEndpointKey };
}

function solveSector(prev: WallEndpointRef, next: WallEndpointRef): SectorSolution {
  const angleDeg = ccwAngleDeg(prev.angleDeg, next.angleDeg);
  const effectiveCornerAngleDeg = Math.min(angleDeg, 360 - angleDeg);
  const isExteriorReflexSector = angleDeg > 180;
  const shortestLen = Math.min(prev.length, next.length);
  const geometricMiterReach = sectorMiterReach(prev, next, effectiveCornerAngleDeg);
  const miterConsumesTooMuchWall =
    Number.isFinite(geometricMiterReach) &&
    geometricMiterReach > shortestLen * MAX_SAFE_MITER_REACH_LENGTH_FRACTION;
  const shouldFlatBevel =
    Number.isFinite(effectiveCornerAngleDeg) &&
    (
      (
        isExteriorReflexSector &&
        effectiveCornerAngleDeg >= MIN_ENDPOINT_JOIN_ANGLE_DEG &&
        effectiveCornerAngleDeg < ACUTE_BEVEL_THRESHOLD_DEG
      ) ||
      miterConsumesTooMuchWall
    );

  const miterPoint =
    lineIntersection(
      prev.left.anchor,
      lineFromAnchor(prev.left.anchor, prev.direction),
      next.right.anchor,
      lineFromAnchor(next.right.anchor, next.direction)
    ) ?? null;

  if (
    shouldFlatBevel ||
    !miterPoint ||
    !Number.isFinite(angleDeg) ||
    angleDeg <= MIN_ENDPOINT_MITER_ANGLE_DEG ||
    angleDeg >= MAX_ENDPOINT_JOIN_ANGLE_DEG
  ) {
    return {
      prev,
      next,
      angleDeg: effectiveCornerAngleDeg,
      joinType: shouldFlatBevel ? 'bevel' : 'miter',
      prevVertex: copyPoint(prev.left.anchor),
      nextVertex: copyPoint(next.right.anchor),
    };
  }

  const clampedMiterPoint = clampSectorMiterPoint(
    prev,
    next,
    miterPoint,
    effectiveCornerAngleDeg
  );

  return {
    prev,
    next,
    angleDeg: effectiveCornerAngleDeg,
    joinType: 'miter',
    prevVertex: copyPoint(clampedMiterPoint),
    nextVertex: copyPoint(clampedMiterPoint),
  };
}

function sectorKey(prev: WallEndpointRef, next: WallEndpointRef): string {
  return `${prev.key}->${next.key}`;
}

function solveEndpointNode(node: EndpointNode): EndpointNodeResolution[] {
  const sorted = [...node.endpoints].sort((a, b) => a.angleDeg - b.angleDeg);
  if (sorted.length > MAX_FULL_JOIN_ENDPOINTS) {
    return solveDenseEndpointNode(node, sorted);
  }

  const sectors = new Map<string, SectorSolution>();

  for (let index = 0; index < sorted.length; index += 1) {
    const prev = sorted[index];
    const next = sorted[(index + 1) % sorted.length];
    sectors.set(sectorKey(prev, next), solveSector(prev, next));
  }

  return sorted.map((endpointRef, index) => {
    const cwNeighbor = sorted[(index - 1 + sorted.length) % sorted.length];
    const ccwNeighbor = sorted[(index + 1) % sorted.length];
    const rightSector = sectors.get(sectorKey(cwNeighbor, endpointRef));
    const leftSector = sectors.get(sectorKey(endpointRef, ccwNeighbor));

    if (!rightSector || !leftSector) {
      throw new Error('Wall join sector resolution failed');
    }

    return {
      endpointRef,
      cwNeighbor,
      ccwNeighbor,
      leftVertex: copyPoint(leftSector.prevVertex),
      rightVertex: copyPoint(rightSector.nextVertex),
      leftSectorAngleDeg: leftSector.angleDeg,
      rightSectorAngleDeg: rightSector.angleDeg,
      leftSectorJoinType: leftSector.joinType,
      rightSectorJoinType: rightSector.joinType,
    };
  });
}

function denseNodeHubDepth(node: EndpointNode, endpointRef: WallEndpointRef): number {
  const nodeMaxThickness = node.endpoints.reduce(
    (max, candidate) => Math.max(max, candidate.wall.thickness),
    endpointRef.wall.thickness
  );

  return Math.min(
    endpointRef.length * MAX_DENSE_NODE_HUB_LENGTH_FRACTION,
    Math.max(
      endpointRef.wall.thickness * DENSE_NODE_HUB_DEPTH_MULTIPLIER,
      nodeMaxThickness
    )
  );
}

function solveDenseEndpointNode(
  node: EndpointNode,
  sorted: WallEndpointRef[]
): EndpointNodeResolution[] {
  return sorted.map((endpointRef, index) => {
    const cwNeighbor = sorted[(index - 1 + sorted.length) % sorted.length];
    const ccwNeighbor = sorted[(index + 1) % sorted.length];
    const hubDepth = denseNodeHubDepth(node, endpointRef);
    const leftVertex = {
      x: endpointRef.left.anchor.x + endpointRef.direction.x * hubDepth,
      y: endpointRef.left.anchor.y + endpointRef.direction.y * hubDepth,
    };
    const rightVertex = {
      x: endpointRef.right.anchor.x + endpointRef.direction.x * hubDepth,
      y: endpointRef.right.anchor.y + endpointRef.direction.y * hubDepth,
    };

    return {
      endpointRef,
      cwNeighbor,
      ccwNeighbor,
      leftVertex,
      rightVertex,
      leftSectorAngleDeg: 180,
      rightSectorAngleDeg: 180,
      leftSectorJoinType: 'bevel',
      rightSectorJoinType: 'bevel',
      denseFallback: true,
    };
  });
}

function endpointVertices(
  endpointRef: WallEndpointRef,
  leftVertex: Point2D,
  rightVertex: Point2D
): { interiorVertex: Point2D; exteriorVertex: Point2D } {
  return endpointRef.left.kind === 'interior'
    ? {
      interiorVertex: leftVertex,
      exteriorVertex: rightVertex,
    }
    : {
      interiorVertex: rightVertex,
      exteriorVertex: leftVertex,
    };
}

function selectPrimaryNeighbor(resolution: EndpointNodeResolution): WallEndpointRef {
  const leftPriority = resolution.leftSectorAngleDeg <= resolution.rightSectorAngleDeg;
  return leftPriority ? resolution.ccwNeighbor : resolution.cwNeighbor;
}

function computeNodeBevelDirection(resolution: EndpointNodeResolution): Point2D {
  const { endpointRef, cwNeighbor, ccwNeighbor } = resolution;
  const hasLeftBevel = resolution.leftSectorJoinType === 'bevel';
  const hasRightBevel = resolution.rightSectorJoinType === 'bevel';

  if (hasLeftBevel && !hasRightBevel) {
    return computeBisector(endpointRef.direction, ccwNeighbor.direction);
  }

  if (hasRightBevel && !hasLeftBevel) {
    return computeBisector(cwNeighbor.direction, endpointRef.direction);
  }

  if (cwNeighbor.key === ccwNeighbor.key) {
    return computeBisector(endpointRef.direction, cwNeighbor.direction);
  }

  return computeBisector(cwNeighbor.direction, ccwNeighbor.direction);
}

function buildNodeJoinData(
  node: EndpointNode,
  resolution: EndpointNodeResolution
): JoinData {
  const { endpointRef, cwNeighbor, ccwNeighbor } = resolution;
  const vertices = endpointVertices(endpointRef, resolution.leftVertex, resolution.rightVertex);
  const joinType: NodeJoinType =
    resolution.leftSectorJoinType === 'bevel' || resolution.rightSectorJoinType === 'bevel'
      ? 'bevel'
      : 'miter';
  const other = selectPrimaryNeighbor(resolution);

  return {
    wallId: endpointRef.wall.id,
    otherWallId: other.wall.id,
    endpoint: endpointRef.endpoint,
    joinPoint: copyPoint(node.point),
    joinType,
    angle: Math.min(resolution.leftSectorAngleDeg, resolution.rightSectorAngleDeg),
    interiorVertex: vertices.interiorVertex,
    exteriorVertex: vertices.exteriorVertex,
    bevelDirection: resolution.denseFallback ? undefined : computeNodeBevelDirection(resolution),
    maxBevelOffset: computeMaxBevelOffset([
      endpointRef.length,
      cwNeighbor.length,
      ccwNeighbor.length,
    ]),
  };
}

function computeButtJoinVertices(
  endpointRef: WallEndpointRef,
  hostWall: Wall
): { interiorVertex: Point2D; exteriorVertex: Point2D } {
  const endpointPoint = endpointRef.point;
  const oppositePoint =
    endpointRef.endpoint === 'start' ? endpointRef.wall.endPoint : endpointRef.wall.startPoint;
  const interiorFallback =
    endpointRef.endpoint === 'start'
      ? endpointRef.wall.interiorLine.start
      : endpointRef.wall.interiorLine.end;
  const exteriorFallback =
    endpointRef.endpoint === 'start'
      ? endpointRef.wall.exteriorLine.start
      : endpointRef.wall.exteriorLine.end;

  const approachVector = {
    x: endpointPoint.x - oppositePoint.x,
    y: endpointPoint.y - oppositePoint.y,
  };
  const approachLength = Math.hypot(approachVector.x, approachVector.y);
  const hostVector = {
    x: hostWall.endPoint.x - hostWall.startPoint.x,
    y: hostWall.endPoint.y - hostWall.startPoint.y,
  };
  const hostLength = Math.hypot(hostVector.x, hostVector.y);

  if (approachLength < 0.0001 || hostLength < 0.0001) {
    return {
      interiorVertex: interiorFallback,
      exteriorVertex: exteriorFallback,
    };
  }

  const approachDir = {
    x: approachVector.x / approachLength,
    y: approachVector.y / approachLength,
  };
  const hostNormal = {
    x: -hostVector.y / hostLength,
    y: hostVector.x / hostLength,
  };

  // For a T-junction, the incoming wall's interior and exterior edges should
  // each extend to the host wall face they naturally intersect, so that the
  // incoming wall cuts through the full width of the host wall.  Previously
  // both edges were projected to the same face, leaving a visible seam on
  // one side.
  //
  // Determine which host face each edge of the incoming wall is closer to
  // by checking which side of the host each offset line falls on.
  const wallInteriorAnchor =
    endpointRef.endpoint === 'start'
      ? endpointRef.wall.interiorLine.start
      : endpointRef.wall.interiorLine.end;
  const wallExteriorAnchor =
    endpointRef.endpoint === 'start'
      ? endpointRef.wall.exteriorLine.start
      : endpointRef.wall.exteriorLine.end;

  const interiorSide =
    (wallInteriorAnchor.x - hostWall.startPoint.x) * hostNormal.x +
    (wallInteriorAnchor.y - hostWall.startPoint.y) * hostNormal.y;
  const exteriorSide =
    (wallExteriorAnchor.x - hostWall.startPoint.x) * hostNormal.x +
    (wallExteriorAnchor.y - hostWall.startPoint.y) * hostNormal.y;

  // Pick the host face that is on the same side as the incoming edge.
  // Interior face is on the +normal side, exterior face on the –normal side.
  const interiorHostFace = interiorSide >= 0 ? hostWall.interiorLine : hostWall.exteriorLine;
  const exteriorHostFace = exteriorSide >= 0 ? hostWall.interiorLine : hostWall.exteriorLine;

  return {
    interiorVertex:
      lineIntersection(
        endpointRef.wall.interiorLine.start,
        endpointRef.wall.interiorLine.end,
        interiorHostFace.start,
        interiorHostFace.end
      ) ?? interiorFallback,
    exteriorVertex:
      lineIntersection(
        endpointRef.wall.exteriorLine.start,
        endpointRef.wall.exteriorLine.end,
        exteriorHostFace.start,
        exteriorHostFace.end
      ) ?? exteriorFallback,
  };
}

function segmentJoinAngleDeg(endpointRef: WallEndpointRef, hostWall: Wall): number {
  const hostDirection = normalize({
    x: hostWall.endPoint.x - hostWall.startPoint.x,
    y: hostWall.endPoint.y - hostWall.startPoint.y,
  });
  const alignment = Math.abs(
    endpointRef.direction.x * hostDirection.x + endpointRef.direction.y * hostDirection.y
  );
  return Math.acos(Math.max(-1, Math.min(1, alignment))) * (180 / Math.PI);
}

function findSegmentHostsAtPoint(
  endpointRef: WallEndpointRef,
  walls: Wall[],
  excludedWallIds: Set<string>
): Wall[] {
  const hosts: Wall[] = [];

  for (const otherWall of walls) {
    if (excludedWallIds.has(otherWall.id) || otherWall.id === endpointRef.wall.id) {
      continue;
    }

    const projection = projectPointToSegment(
      endpointRef.point,
      otherWall.startPoint,
      otherWall.endPoint
    );
    if (projection.distance > SEGMENT_TOLERANCE_MM) {
      continue;
    }
    if (
      pointDistance(projection.point, otherWall.startPoint) <= NODE_TOLERANCE_MM ||
      pointDistance(projection.point, otherWall.endPoint) <= NODE_TOLERANCE_MM
    ) {
      continue;
    }

    if (segmentJoinAngleDeg(endpointRef, otherWall) < MIN_SEGMENT_JOIN_ANGLE_DEG) {
      continue;
    }

    hosts.push(otherWall);
  }

  return hosts;
}

function projectionAlongDirection(origin: Point2D, point: Point2D, direction: Point2D): number {
  return (
    (point.x - origin.x) * direction.x +
    (point.y - origin.y) * direction.y
  );
}

function chooseMoreInteriorVertex(
  endpointRef: WallEndpointRef,
  current: Point2D,
  candidate: Point2D
): Point2D {
  const currentProjection = projectionAlongDirection(endpointRef.point, current, endpointRef.direction);
  const candidateProjection = projectionAlongDirection(endpointRef.point, candidate, endpointRef.direction);
  return candidateProjection > currentProjection + 0.001 ? copyPoint(candidate) : current;
}

function clipNodeJoinAgainstSegmentHosts(
  endpointRef: WallEndpointRef,
  join: JoinData,
  walls: Wall[],
  excludedWallIds: Set<string>
): JoinData {
  const segmentHosts = findSegmentHostsAtPoint(endpointRef, walls, excludedWallIds);
  if (segmentHosts.length === 0) {
    return join;
  }

  let interiorVertex = copyPoint(join.interiorVertex);
  let exteriorVertex = copyPoint(join.exteriorVertex);

  for (const hostWall of segmentHosts) {
    const trimmed = computeButtJoinVertices(endpointRef, hostWall);
    interiorVertex = chooseMoreInteriorVertex(endpointRef, interiorVertex, trimmed.interiorVertex);
    exteriorVertex = chooseMoreInteriorVertex(endpointRef, exteriorVertex, trimmed.exteriorVertex);
  }

  return {
    ...join,
    interiorVertex,
    exteriorVertex,
  };
}

function findSegmentAttachment(
  endpointRef: WallEndpointRef,
  walls: Wall[],
  nodeByEndpointKey: Map<string, EndpointNode>
): SegmentAttachment | null {
  const endpointNode = nodeByEndpointKey.get(endpointRef.key);
  if (endpointNode && endpointNode.endpoints.length > 1) {
    return null;
  }

  let best: SegmentAttachment | null = null;

  for (const otherWall of walls) {
    if (otherWall.id === endpointRef.wall.id) continue;

    const projection = projectPointToSegment(
      endpointRef.point,
      otherWall.startPoint,
      otherWall.endPoint
    );
    if (projection.distance > SEGMENT_TOLERANCE_MM) {
      continue;
    }
    if (
      pointDistance(projection.point, otherWall.startPoint) <= NODE_TOLERANCE_MM ||
      pointDistance(projection.point, otherWall.endPoint) <= NODE_TOLERANCE_MM
    ) {
      continue;
    }

    const hostDirection = normalize({
      x: otherWall.endPoint.x - otherWall.startPoint.x,
      y: otherWall.endPoint.y - otherWall.startPoint.y,
    });
    const alignment = Math.abs(
      endpointRef.direction.x * hostDirection.x + endpointRef.direction.y * hostDirection.y
    );
    const angle = Math.acos(Math.max(-1, Math.min(1, alignment))) * (180 / Math.PI);
    if (angle < MIN_SEGMENT_JOIN_ANGLE_DEG) {
      continue;
    }

    if (!best || projection.distance < pointDistance(endpointRef.point, best.point)) {
      best = {
        endpoint: endpointRef,
        hostWall: otherWall,
        point: projection.point,
        angle,
      };
    }
  }

  return best;
}

function mergeJoin(joinsMap: Map<string, JoinData[]>, join: JoinData): void {
  const joins = joinsMap.get(join.wallId) ?? [];
  const filtered = joins.filter((existing) => existing.endpoint !== join.endpoint);
  filtered.push(join);
  joinsMap.set(join.wallId, filtered);
}

/**
 * Detect walls that share the same centerline (within tolerance) and return
 * a set of wall IDs that should be excluded from join computation.
 * When two rooms from the room tool share an edge, both create a wall at
 * that position.  Keeping both walls causes degenerate 0° sectors in
 * endpoint nodes and confuses T-junction host selection.
 *
 * For each group of coincident walls we keep the longest wall first so
 * partially-overlapping room spans do not hide the wall segment that
 * extends beyond the overlap. Connection count and thickness only break ties.
 */
function findCoincidentShadowedWalls(walls: Wall[]): Set<string> {
  const shadowed = new Set<string>();
  const checked = new Set<string>();

  const wallLength = (wall: Wall): number => Math.hypot(
    wall.endPoint.x - wall.startPoint.x,
    wall.endPoint.y - wall.startPoint.y
  );

  for (let i = 0; i < walls.length; i++) {
    if (shadowed.has(walls[i].id) || checked.has(walls[i].id)) continue;

    const group: Wall[] = [walls[i]];
    checked.add(walls[i].id);

    for (let j = i + 1; j < walls.length; j++) {
      if (shadowed.has(walls[j].id) || checked.has(walls[j].id)) continue;

      if (areCenterlinesCoincident(walls[i], walls[j])) {
        group.push(walls[j]);
        checked.add(walls[j].id);
      }
    }

    if (group.length < 2) continue;

    // Keep the wall with the broadest coverage first. This avoids a shorter
    // shared-room edge shadowing a longer wall that continues past the overlap.
    group.sort((a, b) => {
      const lengthDiff = wallLength(b) - wallLength(a);
      if (Math.abs(lengthDiff) > NODE_TOLERANCE_MM) return lengthDiff;

      const connDiff = b.connectedWalls.length - a.connectedWalls.length;
      if (connDiff !== 0) return connDiff;

      // Prefer thicker walls
      return b.thickness - a.thickness;
    });

    for (let k = 1; k < group.length; k++) {
      shadowed.add(group[k].id);
    }
  }

  return shadowed;
}

/**
 * Check whether two walls occupy the same centerline segment (within tolerance).
 * Handles both same-direction and reverse-direction overlaps.
 */
function areCenterlinesCoincident(a: Wall, b: Wall): boolean {
  const tolerance = NODE_TOLERANCE_MM;

  const sameDir =
    pointDistance(a.startPoint, b.startPoint) <= tolerance &&
    pointDistance(a.endPoint, b.endPoint) <= tolerance;
  const reverseDir =
    pointDistance(a.startPoint, b.endPoint) <= tolerance &&
    pointDistance(a.endPoint, b.startPoint) <= tolerance;

  if (sameDir || reverseDir) return true;

  // Also check for overlapping collinear segments.  Two walls are
  // collinear-coincident if they lie on the same line AND substantially
  // overlap (not merely share a single endpoint).
  const dirA = { x: a.endPoint.x - a.startPoint.x, y: a.endPoint.y - a.startPoint.y };
  const dirB = { x: b.endPoint.x - b.startPoint.x, y: b.endPoint.y - b.startPoint.y };
  const lenA = Math.hypot(dirA.x, dirA.y);
  const lenB = Math.hypot(dirB.x, dirB.y);
  if (lenA < 0.001 || lenB < 0.001) return false;

  const crossVal = Math.abs(dirA.x * dirB.y - dirA.y * dirB.x) / (lenA * lenB);
  if (crossVal > 0.02) return false; // Not parallel

  // Check perpendicular distance between centerlines
  const perpA = { x: -dirA.y / lenA, y: dirA.x / lenA };
  const perpDist = Math.abs(
    (b.startPoint.x - a.startPoint.x) * perpA.x +
    (b.startPoint.y - a.startPoint.y) * perpA.y
  );
  if (perpDist > tolerance) return false;

  // Require substantial overlap: BOTH endpoints of the shorter wall must
  // project onto the longer wall's segment (within tolerance).  This
  // prevents collinear walls that merely share a single endpoint (like
  // Room 1's right wall and Room 2's right wall) from being treated as
  // coincident.
  const projB0 = projectPointToSegment(b.startPoint, a.startPoint, a.endPoint);
  const projB1 = projectPointToSegment(b.endPoint, a.startPoint, a.endPoint);
  const bFullyOnA = projB0.distance <= tolerance && projB1.distance <= tolerance;

  const projA0 = projectPointToSegment(a.startPoint, b.startPoint, b.endPoint);
  const projA1 = projectPointToSegment(a.endPoint, b.startPoint, b.endPoint);
  const aFullyOnB = projA0.distance <= tolerance && projA1.distance <= tolerance;

  // At least one wall must be fully contained within the other
  return bFullyOnA || aFullyOnB;
}

export function computeWallJoinMap(walls: Wall[]): Map<string, JoinData[]> {
  const joinsMap = new Map<string, JoinData[]>();

  // Deduplicate coincident walls (e.g. shared edges from adjacent rooms)
  const shadowedIds = findCoincidentShadowedWalls(walls);
  const effectiveWalls = shadowedIds.size > 0
    ? walls.filter((w) => !shadowedIds.has(w.id))
    : walls;

  const { nodes, nodeByEndpointKey } = buildEndpointNodes(effectiveWalls);

  for (const node of nodes) {
    if (node.endpoints.length < 2) {
      continue;
    }

    const resolutions = solveEndpointNode(node);
    const nodeWallIds = new Set(node.endpoints.map((endpoint) => endpoint.wall.id));
    for (const resolution of resolutions) {
      const join = clipNodeJoinAgainstSegmentHosts(
        resolution.endpointRef,
        buildNodeJoinData(node, resolution),
        walls,
        nodeWallIds
      );
      mergeJoin(joinsMap, join);
    }
  }

  const endpointRefs = walls.flatMap((wall) => [
    buildEndpointRef(wall, 'start'),
    buildEndpointRef(wall, 'end'),
  ]);

  for (const endpointRef of endpointRefs) {
    const existingJoin = (joinsMap.get(endpointRef.wall.id) ?? []).find(
      (join) => join.endpoint === endpointRef.endpoint
    );
    if (existingJoin) {
      continue;
    }

    const attachment = findSegmentAttachment(endpointRef, effectiveWalls, nodeByEndpointKey);
    if (!attachment) {
      continue;
    }

    const vertices = computeButtJoinVertices(endpointRef, attachment.hostWall);
    mergeJoin(joinsMap, {
      wallId: endpointRef.wall.id,
      otherWallId: attachment.hostWall.id,
      endpoint: endpointRef.endpoint,
      joinPoint: copyPoint(attachment.point),
      joinType: 'butt',
      angle: attachment.angle,
      interiorVertex: vertices.interiorVertex,
      exteriorVertex: vertices.exteriorVertex,
    });
  }

  // Propagate joins from representative walls to their shadowed duplicates.
  // Shadowed walls share the same geometry, so they get the same join data
  // (with wallId updated).
  if (shadowedIds.size > 0) {
    for (const wall of walls) {
      if (!shadowedIds.has(wall.id)) continue;

      // Find the representative (non-shadowed) wall with coincident centerline
      const representative = effectiveWalls.find((ew) => areCenterlinesCoincident(ew, wall));
      if (!representative) continue;

      const repJoins = joinsMap.get(representative.id);
      if (repJoins && repJoins.length > 0) {
        const isReversed =
          pointDistance(wall.startPoint, representative.endPoint) <
          pointDistance(wall.startPoint, representative.startPoint);

        const mappedJoins = repJoins.map((join) => ({
          ...join,
          wallId: wall.id,
          endpoint: isReversed
            ? (join.endpoint === 'start' ? 'end' : 'start') as Endpoint
            : join.endpoint,
        }));
        joinsMap.set(wall.id, mappedJoins);
      }
    }
  }

  return joinsMap;
}

/**
 * Like computeWallJoinMap but also returns the set of shadowed (coincident
 * duplicate) wall IDs so callers can exclude them from polygon rendering.
 */
export function computeWallJoinMapWithShadows(walls: Wall[]): {
  joinsMap: Map<string, JoinData[]>;
  shadowedWallIds: Set<string>;
} {
  const shadowedWallIds = findCoincidentShadowedWalls(walls);
  const joinsMap = computeWallJoinMap(walls);
  return { joinsMap, shadowedWallIds };
}

export function buildTemporaryWall(
  id: string,
  startPoint: Point2D,
  endPoint: Point2D,
  thickness: number,
  material: WallMaterial
): Wall {
  const { interiorLine, exteriorLine } = computeOffsetLines(startPoint, endPoint, thickness);

  return {
    id,
    startPoint: copyPoint(startPoint),
    endPoint: copyPoint(endPoint),
    thickness,
    centerlineOffset: 0,
    material,
    layer: 'partition',
    interiorLine,
    exteriorLine,
    startBevel: { ...DEFAULT_BEVEL_CONTROL },
    endBevel: { ...DEFAULT_BEVEL_CONTROL },
    connectedWalls: [],
    openings: [],
    properties3D: { ...DEFAULT_WALL_3D },
  };
}
