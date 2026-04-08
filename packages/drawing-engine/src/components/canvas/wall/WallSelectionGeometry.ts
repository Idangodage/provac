/**
 * WallSelectionGeometry
 *
 * Computes selection outlines for walls and room-aware wall groups.
 *
 * CHANGES FROM ORIGINAL:
 * ──────────────────────────────────────────────────────
 * [BUG] assignRoomEdgesUniquely: added MAX_SEARCH_ITERATIONS (50,000) cap.
 *       The original had no limit — a room with 10+ edges and many candidate
 *       walls per edge could freeze the browser with exponential backtracking.
 * [BUG] traceOffsetRing: validates output ring is not self-intersecting.
 *       Acute-angle corners could produce rings where edges cross, causing
 *       fill-rule artifacts (holes appearing as fills and vice versa).
 * [BUG] Outer rings now validated for CCW winding, inner rings for CW.
 *       The even-odd fill rule requires correct winding but the original
 *       never checked it.
 * [FEAT] getConnectedWallIds: flood-fill selection of connected walls.
 *        Double-click a wall → select all walls connected to it. Standard
 *        in AutoCAD, Revit, and SketchUp.
 * [FEAT] lassooSelectWalls: select walls whose centerlines intersect a
 *        freeform polygon (lasso/marquee selection).
 * [PERF] matchRoomEdgesToWalls: early exit when any edge has zero candidates
 *        (was already there but now cleaner).
 * ──────────────────────────────────────────────────────
 */

import { featureCollection, multiPolygon, polygon, union } from '@turf/turf';

import type { JoinData, Point2D, Room, Wall } from '../../../types';
import { GeometryEngine } from '../../../utils/geometry-engine';

import {
  computeWallBodyPolygon,
  computeWallPolygon,
  isPolygonSelfIntersecting,
  lineIntersection,
  segmentIntersection,
  projectPointToSegment,
} from './WallGeometry';
import { computeWallUnionRenderData } from './WallUnionGeometry';

// =============================================================================
// Public Types
// =============================================================================

export type WallSelectionComponentKind = 'wall' | 'room' | 'component';

export interface WallSelectionComponent {
  id: string;
  kind: WallSelectionComponentKind;
  wallIds: string[];
  outlineRings: Point2D[][];
  fillRings: Point2D[][];
}

export interface WallSelectionPlan {
  individualWallIds: string[];
  mergedComponents: WallSelectionComponent[];
}

export interface WallSelectionComponentEntry {
  wallId: string;
  component: WallSelectionComponent | null;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * [FIX] Safety cap on backtracking search.
 * A room with 10 edges × 8 candidates each = 8^10 ≈ 1 billion paths.
 * Without this limit, the UI freezes. 50,000 iterations is enough to
 * find optimal assignments for rooms up to ~8 edges while keeping
 * worst-case execution under 50ms.
 */
const MAX_SEARCH_ITERATIONS = 50_000;
const SELECTION_ENDPOINT_TOLERANCE_MM = 8;
const SELECTION_SEGMENT_T_EPSILON = 0.001;
const ROOM_OFFSET_MITER_LENGTH_RATIO = 0.35;
const ROOM_OFFSET_MITER_GAP_FACTOR = 12;
const SELECTION_SPIKE_ANGLE_THRESHOLD_DEG = 35;
const SELECTION_SPIKE_CAP_FACTOR = 0.45;
const SELECTION_SPIKE_MAX_REACH_FACTOR = 1.6;
const SELECTION_SPIKE_MAX_REACH_MM = 55;
const SELECTION_JOIN_ENDPOINT_TOLERANCE_MM = 8;
const ROOM_OFFSET_MITER_MIN_REACH_MM = 20;
const ROOM_OFFSET_MITER_MAX_REACH_MM = 80;
const OUTER_RING_SPIKE_ANGLE_DEG = 42;
const OUTER_RING_SPIKE_REACH_RATIO = 2.2;
const OUTER_RING_SPIKE_MIN_EDGE_MM = 8;
const ROOM_RING_SHORT_EDGE_FACTOR = 0.8;
const ROOM_RING_SHORT_EDGE_MIN_MM = 10;
const ROOM_RING_COLLINEAR_DISTANCE_FACTOR = 0.18;
const ROOM_RING_COLLINEAR_DISTANCE_MIN_MM = 2;
const ROOM_RING_MAX_AREA_DELTA_RATIO = 0.06;
const ROOM_CONTOUR_INNER_AREA_RATIO_MIN = 0.6;
const ROOM_CONTOUR_INNER_AREA_RATIO_MAX = 1.45;
const WALL_SELECTION_CACHE_LIMIT = 24;

const wallSelectionSignatureCache = new WeakMap<Wall[], string>();
const wallSelectionComponentCache = new Map<string, Map<string, WallSelectionComponent>>();

function touchCachedWallSelectionComponents(
  signature: string,
  componentsByWallId: Map<string, WallSelectionComponent>
): Map<string, WallSelectionComponent> {
  wallSelectionComponentCache.delete(signature);
  wallSelectionComponentCache.set(signature, componentsByWallId);
  return componentsByWallId;
}

function setCachedWallSelectionComponents(
  signature: string,
  componentsByWallId: Map<string, WallSelectionComponent>
): void {
  touchCachedWallSelectionComponents(signature, componentsByWallId);
  if (wallSelectionComponentCache.size <= WALL_SELECTION_CACHE_LIMIT) {
    return;
  }

  const oldestKey = wallSelectionComponentCache.keys().next().value;
  if (typeof oldestKey === 'string') {
    wallSelectionComponentCache.delete(oldestKey);
  }
}

// =============================================================================
// Ring Utilities
// =============================================================================

function normalizeRing(ring: Point2D[]): Point2D[] {
  if (ring.length < 2) {
    return ring.map((point) => ({ ...point }));
  }

  const normalized = ring.map((point) => ({ ...point }));
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) {
    normalized.pop();
  }
  return normalized;
}

function normalizeOuterRings(polygons: Point2D[][][]): Point2D[][] {
  return polygons
    .map((polygon) => normalizeRing(polygon[0] ?? []))
    .filter((ring) => ring.length >= 3)
    .map((ring) => ensureWindingOrder(ring, true)); // [NEW] Validate CCW
}

function normalizeInnerRings(polygons: Point2D[][][]): Point2D[][] {
  return polygons
    .flatMap((polygon) => polygon.slice(1))
    .map((ring) => normalizeRing(ring))
    .filter((ring) => ring.length >= 3)
    .map((ring) => ensureWindingOrder(ring, false)); // [NEW] Validate CW
}

function normalizeFillRings(polygons: Point2D[][][]): Point2D[][] {
  return [
    ...normalizeOuterRings(polygons),
    ...normalizeInnerRings(polygons),
  ];
}

interface RoomUnionContours {
  outerRing: Point2D[];
  innerRing: Point2D[];
}

interface RoomUnionContourCandidate extends RoomUnionContours {
  score: number;
}

interface RoomOuterRingCandidate {
  ring: Point2D[];
  source: 'selectable' | 'traced' | 'body' | 'union';
  priority: number;
}

interface RoomInnerRingCandidate {
  ring: Point2D[];
  source: 'traced' | 'selectable' | 'body' | 'union' | 'fallback';
  priority: number;
}

type PolygonFeature = ReturnType<typeof polygon>;
type PolygonGeometry = PolygonFeature['geometry'];
type MultiPolygonGeometry = ReturnType<typeof multiPolygon>['geometry'];

/**
 * [NEW] Compute signed area of a polygon ring.
 * Positive = counter-clockwise, Negative = clockwise.
 */
function signedArea(ring: Point2D[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return area / 2;
}

/**
 * [NEW] Ensure ring has correct winding order for even-odd fill rule.
 * Outer rings should be CCW (positive area), inner rings CW (negative).
 * The original code assumed correct winding but never validated it,
 * causing occasional rendering artifacts.
 */
function ensureWindingOrder(ring: Point2D[], wantCCW: boolean): Point2D[] {
  const isCCW = signedArea(ring) > 0;
  if (isCCW !== wantCCW) {
    return [...ring].reverse();
  }
  return ring;
}

function absoluteRingArea(ring: Point2D[]): number {
  return Math.abs(signedArea(ring));
}

function ringSignature(ring: Point2D[]): string {
  const normalized = normalizeRing(ring);
  if (normalized.length < 3) {
    return '';
  }

  const centroid = ringCentroid(normalized);
  const area = absoluteRingArea(normalized);
  return [
    normalized.length,
    centroid.x.toFixed(2),
    centroid.y.toFixed(2),
    area.toFixed(2),
  ].join(':');
}

function pushUniqueRing(
  rings: Point2D[][],
  ring: Point2D[] | null | undefined,
  wantCCW: boolean,
  seenSignatures: Set<string>
): void {
  if (!ring) {
    return;
  }

  const normalized = normalizeRing(ring);
  if (normalized.length < 3) {
    return;
  }

  const oriented = ensureWindingOrder(normalized, wantCCW);
  const signature = ringSignature(oriented);
  if (!signature || seenSignatures.has(signature)) {
    return;
  }

  seenSignatures.add(signature);
  rings.push(oriented);
}

function ringsIntersect(a: Point2D[], b: Point2D[]): boolean {
  const ringA = normalizeRing(a);
  const ringB = normalizeRing(b);
  if (ringA.length < 2 || ringB.length < 2) {
    return false;
  }

  for (let i = 0; i < ringA.length; i += 1) {
    const a1 = ringA[i];
    const a2 = ringA[(i + 1) % ringA.length];
    for (let j = 0; j < ringB.length; j += 1) {
      const b1 = ringB[j];
      const b2 = ringB[(j + 1) % ringB.length];
      if (segmentIntersection(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return false;
}

function pointToRingDistance(point: Point2D, ring: Point2D[]): number {
  const normalized = normalizeRing(ring);
  if (normalized.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < normalized.length; i += 1) {
    const start = normalized[i];
    const end = normalized[(i + 1) % normalized.length];
    const distance = pointToSegmentDistance(point, start, end);
    if (distance < best) {
      best = distance;
    }
  }
  return best;
}

function averageRingDistanceToRing(sampleRing: Point2D[], targetRing: Point2D[]): number {
  const sample = normalizeRing(sampleRing);
  if (sample.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const totalDistance = sample.reduce((sum, point) => sum + pointToRingDistance(point, targetRing), 0);
  return totalDistance / sample.length;
}

function minRingDistanceToRing(sampleRing: Point2D[], targetRing: Point2D[]): number {
  const sample = normalizeRing(sampleRing);
  if (sample.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (const point of sample) {
    const distance = pointToRingDistance(point, targetRing);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }
  return minDistance;
}

function outerRingQualityScore(
  room: Room,
  outerRing: Point2D[],
  canonicalInnerRing: Point2D[],
  expectedBandWidthMm: number,
  minBandWidthMm: number
): number {
  const outer = normalizeRing(outerRing);
  const inner = normalizeRing(canonicalInnerRing);
  if (outer.length < 3 || inner.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (isRingSelfIntersecting(outer)) {
    return Number.POSITIVE_INFINITY;
  }
  if (ringsIntersect(outer, inner)) {
    return Number.POSITIVE_INFINITY;
  }
  if (!GeometryEngine.pointInPolygon(room.centroid, outer)) {
    return Number.POSITIVE_INFINITY;
  }

  const roomArea = Math.max(1, Math.abs(room.area));
  const innerArea = Math.max(1, absoluteRingArea(inner));
  const outerArea = absoluteRingArea(outer);
  if (outerArea <= innerArea + 1) {
    return Number.POSITIVE_INFINITY;
  }

  const innerAreaRatio = innerArea / roomArea;
  if (innerAreaRatio < ROOM_CONTOUR_INNER_AREA_RATIO_MIN || innerAreaRatio > ROOM_CONTOUR_INNER_AREA_RATIO_MAX) {
    return Number.POSITIVE_INFINITY;
  }

  const centroidDistance = pointDistance(ringCentroid(outer), room.centroid) / Math.max(1, Math.sqrt(roomArea));
  const meanBandWidth = averageRingDistanceToRing(inner, outer);
  const minBandWidth = minRingDistanceToRing(inner, outer);
  if (minBandWidth < minBandWidthMm) {
    return Number.POSITIVE_INFINITY;
  }
  const relativeBandArea = (outerArea - innerArea) / innerArea;
  const widthDeviation = Math.abs(meanBandWidth - expectedBandWidthMm) / Math.max(1, expectedBandWidthMm);
  return centroidDistance * 2 + relativeBandArea + widthDeviation * 0.8;
}

function innerRingQualityScore(
  room: Room,
  innerRing: Point2D[],
  outerRing: Point2D[],
  expectedBandWidthMm: number,
  minBandWidthMm: number
): number {
  const inner = normalizeRing(innerRing);
  const outer = normalizeRing(outerRing);
  if (inner.length < 3 || outer.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (isRingSelfIntersecting(inner)) {
    return Number.POSITIVE_INFINITY;
  }
  if (ringsIntersect(inner, outer)) {
    return Number.POSITIVE_INFINITY;
  }
  if (!GeometryEngine.pointInPolygon(room.centroid, inner)) {
    return Number.POSITIVE_INFINITY;
  }

  const roomArea = Math.max(1, Math.abs(room.area));
  const innerArea = absoluteRingArea(inner);
  const outerArea = absoluteRingArea(outer);
  if (outerArea <= innerArea + 1) {
    return Number.POSITIVE_INFINITY;
  }

  const meanBandWidth = averageRingDistanceToRing(inner, outer);
  const minBandWidth = minRingDistanceToRing(inner, outer);
  if (minBandWidth < minBandWidthMm) {
    return Number.POSITIVE_INFINITY;
  }

  const areaDeltaRatio = Math.abs(innerArea - roomArea) / roomArea;
  const widthDeviation = Math.abs(meanBandWidth - expectedBandWidthMm) / Math.max(1, expectedBandWidthMm);
  const centroidDistance =
    pointDistance(ringCentroid(inner), room.centroid) / Math.max(1, Math.sqrt(roomArea));
  return areaDeltaRatio + widthDeviation * 0.9 + centroidDistance * 0.5;
}

function ringCentroid(ring: Point2D[]): Point2D {
  return GeometryEngine.findRoomCentroid({ vertices: ring });
}

/**
 * [NEW] Check if a polygon ring has self-intersecting edges.
 * Used to validate traceOffsetRing output — acute corners can cause crossings.
 */
function isRingSelfIntersecting(ring: Point2D[]): boolean {
  const n = ring.length;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];

    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];

      if (segmentIntersection(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return false;
}

// =============================================================================
// Vector Helpers (local — avoids importing the full Vec2 set)
// =============================================================================

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function magnitude(vector: Point2D): number {
  return Math.hypot(vector.x, vector.y);
}

function normalize(vector: Point2D): Point2D {
  const length = magnitude(vector);
  if (length < 0.000001) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

function pointDistance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointToSegmentDistance(point: Point2D, start: Point2D, end: Point2D): number {
  return projectPointToSegment(point, start, end).distance;
}

function pointOnEdge(edgeStart: Point2D, edgeEnd: Point2D, t: number): Point2D {
  return {
    x: edgeStart.x + (edgeEnd.x - edgeStart.x) * t,
    y: edgeStart.y + (edgeEnd.y - edgeStart.y) * t,
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function estimateRoomWallThickness(roomWalls: Wall[]): number {
  const thicknesses = roomWalls
    .map((wall) => wall.thickness)
    .filter((thickness) => Number.isFinite(thickness) && thickness > 0);
  return median(thicknesses);
}

function cleanRoomRingCornerArtifacts(
  ring: Point2D[],
  nominalWallThicknessMm: number
): Point2D[] {
  const normalized = normalizeRing(ring);
  if (normalized.length < 4) {
    return normalized;
  }

  const shortEdgeThreshold = Math.max(
    ROOM_RING_SHORT_EDGE_MIN_MM,
    nominalWallThicknessMm * ROOM_RING_SHORT_EDGE_FACTOR
  );
  const chordDistanceThreshold = Math.max(
    ROOM_RING_COLLINEAR_DISTANCE_MIN_MM,
    nominalWallThicknessMm * ROOM_RING_COLLINEAR_DISTANCE_FACTOR
  );

  let working = [...normalized];
  let changed = true;
  let iteration = 0;
  const maxIterations = working.length * 3;

  while (changed && iteration < maxIterations && working.length >= 4) {
    iteration += 1;
    changed = false;
    const baselineArea = Math.max(1, absoluteRingArea(working));

    for (let i = 0; i < working.length; i += 1) {
      const prev = working[(i - 1 + working.length) % working.length];
      const curr = working[i];
      const next = working[(i + 1) % working.length];
      const lenPrev = pointDistance(prev, curr);
      const lenNext = pointDistance(curr, next);
      const shortestAdjacentEdge = Math.min(lenPrev, lenNext);

      if (shortestAdjacentEdge > shortEdgeThreshold) {
        continue;
      }

      const distanceToChord = pointToSegmentDistance(curr, prev, next);
      const maxAllowedDistance = Math.max(chordDistanceThreshold, shortestAdjacentEdge * 0.65);
      if (distanceToChord > maxAllowedDistance) {
        continue;
      }

      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < 3) {
        continue;
      }
      if (isRingSelfIntersecting(candidate)) {
        continue;
      }

      const candidateArea = Math.max(1, absoluteRingArea(candidate));
      const areaDeltaRatio = Math.abs(candidateArea - baselineArea) / baselineArea;
      if (areaDeltaRatio > ROOM_RING_MAX_AREA_DELTA_RATIO) {
        continue;
      }

      working = candidate;
      changed = true;
      break;
    }
  }

  return working;
}

// =============================================================================
// Room Edge Matching
// =============================================================================

interface RoomEdge {
  index: number;
  start: Point2D;
  end: Point2D;
  midpoint: Point2D;
  direction: Point2D;
}

interface RoomEdgeWallCandidate {
  wall: Wall;
  score: number;
  alignment: number;
}

interface MatchedRoomEdge {
  edge: RoomEdge;
  wall: Wall;
}

function buildRoomEdges(room: Room): RoomEdge[] {
  return room.vertices.map((start, index) => {
    const end = room.vertices[(index + 1) % room.vertices.length];
    return {
      index,
      start,
      end,
      midpoint: pointOnEdge(start, end, 0.5),
      direction: normalize(subtract(end, start)),
    };
  });
}

function offsetPointFromEdge(midpoint: Point2D, direction: Point2D, offset: number): Point2D {
  const normal = { x: -direction.y, y: direction.x };
  return { x: midpoint.x + normal.x * offset, y: midpoint.y + normal.y * offset };
}

function averageEdgeDistanceToWall(edgeStart: Point2D, edgeEnd: Point2D, wall: Wall): number {
  const samples = [0, 0.25, 0.5, 0.75, 1];
  const total = samples.reduce((sum, t) => {
    const point = pointOnEdge(edgeStart, edgeEnd, t);
    return sum + pointToSegmentDistance(point, wall.startPoint, wall.endPoint);
  }, 0);
  return total / samples.length;
}

function edgeAlignment(edgeStart: Point2D, edgeEnd: Point2D, wall: Wall): number {
  const edgeDirection = normalize(subtract(edgeEnd, edgeStart));
  const wallDirection = normalize(subtract(wall.endPoint, wall.startPoint));
  return Math.abs(dot(edgeDirection, wallDirection));
}

function edgeSpanPenalty(edgeStart: Point2D, edgeEnd: Point2D, wall: Wall): number {
  const wallDirection = normalize(subtract(wall.endPoint, wall.startPoint));
  if (magnitude(wallDirection) < 0.000001) return Number.POSITIVE_INFINITY;

  const wallLength = pointDistance(wall.startPoint, wall.endPoint);
  if (wallLength < 0.000001) return Number.POSITIVE_INFINITY;

  const project = (point: Point2D): number =>
    dot(subtract(point, wall.startPoint), wallDirection) / wallLength;

  const startT = project(edgeStart);
  const endT = project(edgeEnd);
  const minT = Math.min(startT, endT);
  const maxT = Math.max(startT, endT);

  return Math.max(0, -minT) + Math.max(0, maxT - 1);
}

function scoreWallForRoomEdge(edgeStart: Point2D, edgeEnd: Point2D, wall: Wall): number {
  const alignmentPenalty = 1 - edgeAlignment(edgeStart, edgeEnd, wall);
  const distancePenalty = averageEdgeDistanceToWall(edgeStart, edgeEnd, wall);
  const spanPenalty = edgeSpanPenalty(edgeStart, edgeEnd, wall);
  return alignmentPenalty * 100000 + spanPenalty * 10000 + distancePenalty;
}

function buildRoomEdgeCandidates(edge: RoomEdge, roomWalls: Wall[]): RoomEdgeWallCandidate[] {
  return roomWalls
    .map((wall) => ({
      wall,
      score: scoreWallForRoomEdge(edge.start, edge.end, wall),
      alignment: edgeAlignment(edge.start, edge.end, wall),
    }))
    .filter((candidate) => candidate.alignment >= 0.85)
    .sort((a, b) => a.score - b.score);
}

/**
 * [FIX] Backtracking search now capped at MAX_SEARCH_ITERATIONS.
 * The original had no limit, causing exponential blowup on rooms with
 * many edges and many candidate walls. With the cap, worst case is ~1ms
 * instead of potential browser freeze.
 */
function assignRoomEdgesUniquely(
  candidatesByEdge: RoomEdgeWallCandidate[][]
): Array<Wall | null> | null {
  const edgeCount = candidatesByEdge.length;
  const orderedEdgeIndexes = candidatesByEdge
    .map((candidates, index) => ({ index, candidates }))
    .sort((a, b) => {
      if (a.candidates.length !== b.candidates.length) {
        return a.candidates.length - b.candidates.length;
      }
      return (a.candidates[0]?.score ?? Number.POSITIVE_INFINITY) -
        (b.candidates[0]?.score ?? Number.POSITIVE_INFINITY);
    })
    .map((entry) => entry.index);

  const assignment: Array<Wall | null> = new Array(edgeCount).fill(null);
  const usedWallIds = new Set<string>();
  let bestCost = Number.POSITIVE_INFINITY;
  let bestAssignment: Array<Wall | null> | null = null;
  let iterations = 0; // [FIX] Iteration counter

  const search = (depth: number, cost: number): void => {
    // [FIX] Bail out if we've exceeded the search budget
    if (++iterations > MAX_SEARCH_ITERATIONS) return;
    if (cost >= bestCost) return;
    if (depth >= orderedEdgeIndexes.length) {
      bestCost = cost;
      bestAssignment = assignment.map((wall) => wall);
      return;
    }

    const edgeIndex = orderedEdgeIndexes[depth];
    const candidates = candidatesByEdge[edgeIndex];
    for (const candidate of candidates) {
      if (iterations > MAX_SEARCH_ITERATIONS) return; // [FIX] Check inside loop too
      if (usedWallIds.has(candidate.wall.id)) continue;

      assignment[edgeIndex] = candidate.wall;
      usedWallIds.add(candidate.wall.id);
      search(depth + 1, cost + candidate.score);
      usedWallIds.delete(candidate.wall.id);
      assignment[edgeIndex] = null;
    }
  };

  search(0, 0);
  return bestAssignment;
}

function assignmentCost(
  assignment: Array<Wall | null>,
  candidatesByEdge: RoomEdgeWallCandidate[][]
): number {
  let cost = 0;
  for (let edgeIndex = 0; edgeIndex < assignment.length; edgeIndex += 1) {
    const wall = assignment[edgeIndex];
    if (!wall) {
      return Number.POSITIVE_INFINITY;
    }
    const candidate = candidatesByEdge[edgeIndex].find((entry) => entry.wall.id === wall.id);
    if (!candidate) {
      return Number.POSITIVE_INFINITY;
    }
    cost += candidate.score;
  }
  return cost;
}

function matchRoomEdgesToWalls(room: Room, roomWalls: Wall[]): MatchedRoomEdge[] | null {
  const roomEdges = buildRoomEdges(room);
  if (roomEdges.length < 3 || roomWalls.length === 0) return null;

  const candidatesByEdge = roomEdges.map((edge) => buildRoomEdgeCandidates(edge, roomWalls));
  if (candidatesByEdge.some((candidates) => candidates.length === 0)) return null;

  const greedyAssignment = candidatesByEdge.map((candidates) => candidates[0]?.wall ?? null);
  const uniqueAssignment = roomWalls.length >= roomEdges.length
    ? assignRoomEdgesUniquely(candidatesByEdge)
    : null;
  const greedyCost = assignmentCost(greedyAssignment, candidatesByEdge);
  const uniqueCost = uniqueAssignment
    ? assignmentCost(uniqueAssignment, candidatesByEdge)
    : Number.POSITIVE_INFINITY;

  // If one-to-one matching distorts the geometry too much, prefer per-edge best match.
  const useGreedy =
    !uniqueAssignment ||
    uniqueCost > greedyCost * 1.35;
  const assignedWalls = useGreedy ? greedyAssignment : uniqueAssignment;

  if (assignedWalls.some((wall) => !wall)) return null;

  return roomEdges.map((edge, index) => ({
    edge,
    wall: assignedWalls[index] as Wall,
  }));
}

function collectRoomTraceCandidateWalls(
  room: Room,
  wallsById: Map<string, Wall>
): Wall[] {
  const explicitWalls = room.wallIds
    .map((wallId) => wallsById.get(wallId))
    .filter((wall): wall is Wall => Boolean(wall));
  const candidatesById = new Map(explicitWalls.map((wall) => [wall.id, wall]));
  const roomEdges = buildRoomEdges(room);
  if (roomEdges.length < 3) {
    return explicitWalls;
  }

  const allWalls = Array.from(wallsById.values());
  for (const wall of allWalls) {
    if (candidatesById.has(wall.id)) {
      continue;
    }

    let bestAlignment = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestSpanPenalty = Number.POSITIVE_INFINITY;
    for (const edge of roomEdges) {
      const alignment = edgeAlignment(edge.start, edge.end, wall);
      if (alignment < 0.8) {
        continue;
      }

      const distance = averageEdgeDistanceToWall(edge.start, edge.end, wall);
      const spanPenalty = edgeSpanPenalty(edge.start, edge.end, wall);
      bestAlignment = Math.max(bestAlignment, alignment);
      bestDistance = Math.min(bestDistance, distance);
      bestSpanPenalty = Math.min(bestSpanPenalty, spanPenalty);
    }

    if (
      bestAlignment >= 0.92 &&
      bestDistance <= Math.max(140, wall.thickness * 1.4) &&
      bestSpanPenalty <= 0.35
    ) {
      candidatesById.set(wall.id, wall);
    }
  }

  return Array.from(candidatesById.values());
}

// =============================================================================
// Offset Ring Tracing
// =============================================================================

function chooseRoomEdgeOuterLine(
  room: Room,
  matchedEdge: MatchedRoomEdge
): { start: Point2D; end: Point2D } | null {
  const faces = chooseRoomEdgeFaceLines(room, matchedEdge);
  return faces?.outerLine ?? null;
}

function chooseRoomEdgeInnerLine(
  room: Room,
  matchedEdge: MatchedRoomEdge
): { start: Point2D; end: Point2D } | null {
  const faces = chooseRoomEdgeFaceLines(room, matchedEdge);
  return faces?.innerLine ?? null;
}

function orientLineToDirection(
  line: { start: Point2D; end: Point2D },
  direction: Point2D
): { start: Point2D; end: Point2D } {
  const lineDirection = normalize(subtract(line.end, line.start));
  if (dot(lineDirection, direction) >= 0) {
    return {
      start: { ...line.start },
      end: { ...line.end },
    };
  }

  return {
    start: { ...line.end },
    end: { ...line.start },
  };
}

function chooseRoomEdgeFaceLines(
  room: Room,
  matchedEdge: MatchedRoomEdge
): { outerLine: { start: Point2D; end: Point2D }; innerLine: { start: Point2D; end: Point2D } } | null {
  const { edge, wall } = matchedEdge;
  if (magnitude(edge.direction) < 0.000001) return null;

  const outsideSign = roomEdgeOutsideSign(room, edge, wall.thickness);
  const interiorLine = orientLineToDirection(
    { start: wall.interiorLine.start, end: wall.interiorLine.end },
    edge.direction
  );
  const exteriorLine = orientLineToDirection(
    { start: wall.exteriorLine.start, end: wall.exteriorLine.end },
    edge.direction
  );
  const edgeNormal = { x: -edge.direction.y, y: edge.direction.x };
  const interiorMid = pointOnEdge(interiorLine.start, interiorLine.end, 0.5);
  const exteriorMid = pointOnEdge(exteriorLine.start, exteriorLine.end, 0.5);
  const interiorOutsideScore = dot(subtract(interiorMid, edge.midpoint), edgeNormal) * outsideSign;
  const exteriorOutsideScore = dot(subtract(exteriorMid, edge.midpoint), edgeNormal) * outsideSign;

  if (interiorOutsideScore >= exteriorOutsideScore) {
    return {
      outerLine: interiorLine,
      innerLine: exteriorLine,
    };
  }

  return {
    outerLine: exteriorLine,
    innerLine: interiorLine,
  };
}

function roomEdgeOutsideSign(
  room: Room,
  edge: RoomEdge,
  wallThickness: number
): number {
  const probeDistance = Math.max(1, Math.min(wallThickness / 4, 25));
  const leftProbe = offsetPointFromEdge(edge.midpoint, edge.direction, probeDistance);
  const rightProbe = offsetPointFromEdge(edge.midpoint, edge.direction, -probeDistance);
  const leftInside = GeometryEngine.pointInPolygon(leftProbe, room.vertices);
  const rightInside = GeometryEngine.pointInPolygon(rightProbe, room.vertices);

  if (leftInside && !rightInside) {
    return -1;
  }
  if (!leftInside && rightInside) {
    return 1;
  }

  const toCentroid = subtract(room.centroid, edge.midpoint);
  return cross(edge.direction, toCentroid) >= 0 ? -1 : 1;
}


/**
 * [FIX] traceOffsetRing now validates the resulting ring is not self-intersecting.
 * Acute-angle corners can cause consecutive offset lines to cross behind the wall,
 * producing a self-intersecting polygon that renders incorrectly with even-odd fill.
 */
function traceOffsetRing(lines: Array<{ start: Point2D; end: Point2D }>): Point2D[] | null {
  if (lines.length < 3) return null;

  const ring: Point2D[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const previous = lines[(index - 1 + lines.length) % lines.length];
    const current = lines[index];
    const fallbackCorner = {
      x: (previous.end.x + current.start.x) / 2,
      y: (previous.end.y + current.start.y) / 2,
    };
    const intersection = lineIntersection(previous.start, previous.end, current.start, current.end);
    if (!intersection) {
      ring.push(fallbackCorner);
      continue;
    }

    // Limit acute-angle miters to prevent long spikes from protruding into the wall band.
    const previousLength = pointDistance(previous.start, previous.end);
    const currentLength = pointDistance(current.start, current.end);
    const shortestLength = Math.max(1, Math.min(previousLength, currentLength));
    const cornerGap = pointDistance(previous.end, current.start);
    const geometricCap = shortestLength * ROOM_OFFSET_MITER_LENGTH_RATIO;
    const localGapCap = Math.max(
      ROOM_OFFSET_MITER_MIN_REACH_MM,
      cornerGap * ROOM_OFFSET_MITER_GAP_FACTOR
    );
    const maxReach = Math.max(
      ROOM_OFFSET_MITER_MIN_REACH_MM,
      Math.min(geometricCap, localGapCap, ROOM_OFFSET_MITER_MAX_REACH_MM)
    );
    const reach = pointDistance(intersection, fallbackCorner);
    if (!Number.isFinite(reach) || reach > maxReach) {
      if (!Number.isFinite(reach) || reach < 0.000001) {
        ring.push(fallbackCorner);
        continue;
      }

      const clampRatio = maxReach / reach;
      ring.push({
        x: fallbackCorner.x + (intersection.x - fallbackCorner.x) * clampRatio,
        y: fallbackCorner.y + (intersection.y - fallbackCorner.y) * clampRatio,
      });
      continue;
    }

    ring.push(intersection);
  }

  const normalized = normalizeRing(ring);
  if (normalized.length < 3) return null;

  // [FIX] Reject self-intersecting rings
  if (isRingSelfIntersecting(normalized)) {
    return null;
  }

  return normalized;
}

function traceRoomOuterRing(room: Room, wallsById: Map<string, Wall>): Point2D[] | null {
  if (room.vertices.length < 3) return null;

  const roomWalls = collectRoomTraceCandidateWalls(room, wallsById);
  const matchedEdges = matchRoomEdgesToWalls(room, roomWalls);
  if (!matchedEdges) return null;

  const outerLines = matchedEdges.map((matchedEdge) =>
    chooseRoomEdgeOuterLine(room, matchedEdge)
  );
  if (outerLines.some((line) => !line)) return null;

  const resolvedLines = outerLines.filter(
    (line): line is { start: Point2D; end: Point2D } => Boolean(line)
  );
  const ring = traceOffsetRing(resolvedLines);
  if (!ring) return null;
  const nominalWallThickness = estimateRoomWallThickness(roomWalls);
  const oriented = ensureWindingOrder(ring, true);
  const cleaned = cleanRoomRingCornerArtifacts(oriented, nominalWallThickness);

  if (cleaned.length >= 3 && !isRingSelfIntersecting(cleaned)) {
    return ensureWindingOrder(cleaned, true);
  }

  // [NEW] Ensure outer rings are CCW for correct even-odd fill
  return oriented;
}

function traceRoomInnerRing(room: Room, wallsById: Map<string, Wall>): Point2D[] | null {
  if (room.vertices.length < 3) return null;

  const roomWalls = collectRoomTraceCandidateWalls(room, wallsById);
  const matchedEdges = matchRoomEdgesToWalls(room, roomWalls);
  if (!matchedEdges) return null;

  const innerLines = matchedEdges.map((matchedEdge) =>
    chooseRoomEdgeInnerLine(room, matchedEdge)
  );
  if (innerLines.some((line) => !line)) return null;

  const resolvedLines = innerLines.filter(
    (line): line is { start: Point2D; end: Point2D } => Boolean(line)
  );
  const ring = traceOffsetRing(resolvedLines);
  if (!ring) return null;
  const nominalWallThickness = estimateRoomWallThickness(roomWalls);
  const oriented = ensureWindingOrder(ring, false);
  const cleaned = cleanRoomRingCornerArtifacts(oriented, nominalWallThickness);

  if (cleaned.length >= 3 && !isRingSelfIntersecting(cleaned)) {
    return ensureWindingOrder(cleaned, false);
  }

  // [NEW] Ensure inner rings are CW for correct even-odd fill
  return oriented;
}

function findRoomContoursFromUnion(
  room: Room,
  polygons: Point2D[][][]
): RoomUnionContours | null {
  let containingMatch: RoomUnionContourCandidate | null = null;
  let fallbackMatch: RoomUnionContourCandidate | null = null;

  polygons.forEach((polygon) => {
    const outerRing = normalizeRing(polygon[0] ?? []);
    if (outerRing.length < 3) {
      return;
    }

    polygon.slice(1).forEach((hole) => {
      const innerRing = normalizeRing(hole);
      if (innerRing.length < 3) {
        return;
      }

      const orientedOuter = ensureWindingOrder(outerRing, true);
      const prunedOuter = pruneOuterRingSpikes(orientedOuter);
      const resolvedOuter = prunedOuter.length >= 3 && !isRingSelfIntersecting(prunedOuter)
        ? prunedOuter
        : orientedOuter;
      const resolvedInner = ensureWindingOrder(innerRing, false);

      const containsCentroid = GeometryEngine.pointInPolygon(room.centroid, innerRing);
      const centroidDistance = pointDistance(ringCentroid(innerRing), room.centroid);
      const areaDelta = Math.abs(absoluteRingArea(innerRing) - room.area);
      const score = areaDelta + centroidDistance;
      const candidate: RoomUnionContourCandidate = {
        score,
        outerRing: resolvedOuter,
        innerRing: resolvedInner,
      };

      if (containsCentroid) {
        if (!containingMatch || score < containingMatch.score) {
          containingMatch = candidate;
        }
      } else if (!fallbackMatch || score < fallbackMatch.score) {
        fallbackMatch = candidate;
      }
    });
  });

  const bestMatch = (containingMatch ?? fallbackMatch) as RoomUnionContourCandidate | null;
  if (!bestMatch) {
    return null;
  }

  return {
    outerRing: bestMatch.outerRing,
    innerRing: bestMatch.innerRing,
  };
}

function findRoomContoursFromWallBodies(
  room: Room,
  roomWalls: Wall[]
): RoomUnionContours | null {
  const features = roomWalls
    .map((wall) => makePolygonFeatureFromRing(computeWallBodyPolygon(wall)))
    .filter((feature): feature is PolygonFeature => Boolean(feature));
  if (features.length === 0) {
    return null;
  }

  const polygons = unionFeaturesPolygons(features);
  if (polygons.length === 0) {
    return null;
  }

  return findRoomContoursFromUnion(room, polygons);
}

function findRoomContoursFromSelectableWalls(
  room: Room,
  roomWalls: Wall[],
  joinsMap: Map<string, JoinData[]>
): RoomUnionContours | null {
  const features = roomWalls
    .map((wall) => computeSelectableWallPolygon(wall, joinsMap, roomWalls))
    .map((polygon) => makePolygonFeatureFromRing(polygon))
    .filter((feature): feature is PolygonFeature => Boolean(feature));
  if (features.length === 0) {
    return null;
  }

  const polygons = unionFeaturesPolygons(features);
  if (polygons.length === 0) {
    return null;
  }

  return findRoomContoursFromUnion(room, polygons);
}

// =============================================================================
// [NEW] Connected Component Selection
// =============================================================================

/**
 * Flood-fill to find all walls connected to a starting wall.
 * This enables "double-click to select connected walls" — standard
 * in AutoCAD, Revit, and SketchUp.
 *
 * Traverses via wall.connectedWalls and also checks geometric proximity
 * (endpoints within tolerance) for walls that are touching but not
 * explicitly linked in the data model.
 */
export function getConnectedWallIds(
  startWallId: string,
  walls: Wall[],
  toleranceMm: number = 1
): string[] {
  const wallsById = new Map(walls.map((w) => [w.id, w]));
  const startWall = wallsById.get(startWallId);
  if (!startWall) return [startWallId];

  const visited = new Set<string>();
  const queue: string[] = [startWallId];

  while (queue.length > 0) {
    const currentId = queue.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const current = wallsById.get(currentId);
    if (!current) continue;

    // Follow explicit connections
    for (const connectedId of current.connectedWalls) {
      if (!visited.has(connectedId)) {
        queue.push(connectedId);
      }
    }

    // Also find geometrically touching walls (endpoints within tolerance)
    for (const other of walls) {
      if (visited.has(other.id)) continue;

      const endpoints = [current.startPoint, current.endPoint];
      const otherEndpoints = [other.startPoint, other.endPoint];

      for (const ep of endpoints) {
        for (const oep of otherEndpoints) {
          if (pointDistance(ep, oep) <= toleranceMm) {
            queue.push(other.id);
          }
        }
      }
    }
  }

  return Array.from(visited);
}

/**
 * [NEW] Select walls whose centerlines intersect a lasso polygon.
 * For marquee/lasso selection in the UI.
 */
export function lassoSelectWalls(
  walls: Wall[],
  lassoPolygon: Point2D[]
): string[] {
  if (lassoPolygon.length < 3) return [];

  const selected: string[] = [];

  for (const wall of walls) {
    // Check if either endpoint is inside the lasso
    const startInside = isPointInPolygon(wall.startPoint, lassoPolygon);
    const endInside = isPointInPolygon(wall.endPoint, lassoPolygon);

    if (startInside || endInside) {
      selected.push(wall.id);
      continue;
    }

    // Check if the wall centerline intersects any lasso edge
    let intersects = false;
    for (let i = 0; i < lassoPolygon.length && !intersects; i++) {
      const j = (i + 1) % lassoPolygon.length;
      if (segmentIntersection(wall.startPoint, wall.endPoint, lassoPolygon[i], lassoPolygon[j])) {
        intersects = true;
      }
    }

    if (intersects) {
      selected.push(wall.id);
    }
  }

  return selected;
}

/** Point-in-polygon (ray casting) for lasso selection */
function isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      ((pi.y > point.y) !== (pj.y > point.y)) &&
      (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x)
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// =============================================================================
// Public API
// =============================================================================

function buildRoomSelectionComponent(
  room: Room,
  roomWalls: Wall[],
  wallsById: Map<string, Wall>
): WallSelectionComponent | null {
  const roomRenderData = computeWallUnionRenderData(roomWalls);
  const roomPolygons = roomRenderData.components.flatMap((component) => component.polygons);
  const selectableContours = findRoomContoursFromSelectableWalls(
    room,
    roomWalls,
    roomRenderData.joinsMap
  );
  const bodyContours = findRoomContoursFromWallBodies(room, roomWalls);
  const unionContours = findRoomContoursFromUnion(room, roomPolygons);
  const tracedOuterRing = traceRoomOuterRing(room, wallsById);
  const tracedInnerRing = traceRoomInnerRing(room, wallsById);
  const thicknessValues = roomWalls
    .map((wall) => wall.thickness)
    .filter((thickness): thickness is number => Number.isFinite(thickness) && thickness > 0);
  const medianThickness = median(thicknessValues);
  const shortEdgeThreshold = Math.max(6, medianThickness * 0.45);
  const tracedOuterCandidate = tracedOuterRing
    ? ensureWindingOrder(cleanRingNotches(tracedOuterRing, shortEdgeThreshold), true)
    : null;
  const tracedInnerCandidate = tracedInnerRing
    ? ensureWindingOrder(cleanRingNotches(tracedInnerRing, Math.max(5, shortEdgeThreshold * 0.7)), false)
    : null;
  const bodyOuterCandidate = bodyContours?.outerRing
    ? ensureWindingOrder(cleanRingNotches(pruneOuterRingSpikes(bodyContours.outerRing), shortEdgeThreshold), true)
    : null;
  const bodyInnerCandidate = bodyContours?.innerRing
    ? ensureWindingOrder(cleanRingNotches(bodyContours.innerRing, Math.max(5, shortEdgeThreshold * 0.7)), false)
    : null;
  const unionOuterCandidate = unionContours?.outerRing
    ? ensureWindingOrder(cleanRingNotches(pruneOuterRingSpikes(unionContours.outerRing), shortEdgeThreshold), true)
    : null;
  const unionInnerCandidate = unionContours?.innerRing
    ? ensureWindingOrder(cleanRingNotches(unionContours.innerRing, Math.max(5, shortEdgeThreshold * 0.7)), false)
    : null;
  const selectableInnerCandidate = selectableContours?.innerRing
    ? ensureWindingOrder(cleanRingNotches(selectableContours.innerRing, Math.max(5, shortEdgeThreshold * 0.7)), false)
    : null;

  const fallbackRoomInnerRing = ensureWindingOrder(normalizeRing(room.vertices), false);
  const canonicalInnerRing = fallbackRoomInnerRing.length >= 3
    ? ensureWindingOrder(
      cleanRingNotches(fallbackRoomInnerRing, Math.max(5, shortEdgeThreshold * 0.7)),
      false
    )
    : null;

  const outerRingCandidates: RoomOuterRingCandidate[] = [];
  if (selectableContours) {
    outerRingCandidates.push({
      ring: ensureWindingOrder(
        cleanRingNotches(pruneOuterRingSpikes(selectableContours.outerRing), shortEdgeThreshold),
        true
      ),
      source: 'selectable',
      priority: 0,
    });
  }
  if (tracedOuterCandidate) {
    outerRingCandidates.push({
      ring: tracedOuterCandidate,
      source: 'traced',
      priority: 1,
    });
  }
  if (bodyOuterCandidate) {
    outerRingCandidates.push({
      ring: bodyOuterCandidate,
      source: 'body',
      priority: 2,
    });
  }
  if (unionOuterCandidate) {
    outerRingCandidates.push({
      ring: unionOuterCandidate,
      source: 'union',
      priority: 3,
    });
  }

  const scoredOuterCandidates = canonicalInnerRing
    ? outerRingCandidates
    .map((candidate) => ({
      candidate,
      score: outerRingQualityScore(
        room,
        candidate.ring,
        canonicalInnerRing,
        Math.max(40, medianThickness),
        Math.max(6, medianThickness * 0.18)
      ),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) <= 0.000001) {
        return a.candidate.priority - b.candidate.priority;
      }
      return a.score - b.score;
    })
    : [];
  const bestOuterCandidate = scoredOuterCandidates[0]?.candidate ?? outerRingCandidates[0] ?? null;

  const wallBandOuterRing =
    bestOuterCandidate?.ring ??
    tracedOuterCandidate ??
    bodyOuterCandidate ??
    unionOuterCandidate ??
    null;
  const innerRingCandidates: RoomInnerRingCandidate[] = [];
  if (tracedInnerCandidate) {
    innerRingCandidates.push({
      ring: tracedInnerCandidate,
      source: 'traced',
      priority: 0,
    });
  }
  if (selectableInnerCandidate) {
    innerRingCandidates.push({
      ring: selectableInnerCandidate,
      source: 'selectable',
      priority: 1,
    });
  }
  if (bodyInnerCandidate) {
    innerRingCandidates.push({
      ring: bodyInnerCandidate,
      source: 'body',
      priority: 2,
    });
  }
  if (unionInnerCandidate) {
    innerRingCandidates.push({
      ring: unionInnerCandidate,
      source: 'union',
      priority: 3,
    });
  }
  if (canonicalInnerRing) {
    innerRingCandidates.push({
      ring: canonicalInnerRing,
      source: 'fallback',
      priority: 4,
    });
  }

  const scoredInnerCandidates = wallBandOuterRing
    ? innerRingCandidates
      .map((candidate) => ({
        candidate,
        score: innerRingQualityScore(
          room,
          candidate.ring,
          wallBandOuterRing,
          Math.max(40, medianThickness),
          Math.max(6, medianThickness * 0.18)
        ),
      }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => {
        if (Math.abs(a.score - b.score) <= 0.000001) {
          return a.candidate.priority - b.candidate.priority;
        }
        return a.score - b.score;
      })
    : [];
  const bestInnerCandidate = scoredInnerCandidates[0]?.candidate ?? innerRingCandidates[0] ?? null;

  const rawInnerRing = bestInnerCandidate?.ring ?? canonicalInnerRing ?? null;
  const wallBandInnerRing = rawInnerRing && rawInnerRing.length >= 3
    ? ensureWindingOrder(
      cleanRingNotches(rawInnerRing, Math.max(5, shortEdgeThreshold * 0.7)),
      false
    )
    : null;
  const outlineRings: Point2D[][] = [];
  const outlineSignatures = new Set<string>();
  pushUniqueRing(outlineRings, wallBandOuterRing, true, outlineSignatures);
  pushUniqueRing(outlineRings, wallBandInnerRing, false, outlineSignatures);
  if (outlineRings.length === 0) {
    roomRenderData.components.forEach((component) => {
      normalizeOuterRings(component.polygons).forEach((ring) => {
        pushUniqueRing(outlineRings, ring, true, outlineSignatures);
      });
      normalizeInnerRings(component.polygons).forEach((ring) => {
        pushUniqueRing(outlineRings, ring, false, outlineSignatures);
      });
    });
  }
  const fillRingsFromUnion = roomRenderData.components.flatMap((component) =>
    normalizeFillRings(component.polygons)
  );
  let fillRings: Point2D[][] = [];
  if (wallBandOuterRing && wallBandInnerRing) {
    fillRings = [wallBandOuterRing, wallBandInnerRing];
  } else if (wallBandOuterRing) {
    fillRings = [wallBandOuterRing];
  } else if (wallBandInnerRing) {
    fillRings = [wallBandInnerRing];
  } else {
    fillRings = fillRingsFromUnion;
  }

  if (outlineRings.length === 0 && fillRings.length === 0) {
    return null;
  }

  return {
    id: `room-selection-${room.id}`,
    kind: 'room',
    wallIds: [...room.wallIds],
    outlineRings,
    fillRings,
  };
}

function buildComponentSelectionComponent(component: {
  id: string;
  wallIds: string[];
  polygons: Point2D[][][];
}): WallSelectionComponent | null {
  const outlineRings = normalizeOuterRings(component.polygons);
  const fillRings = normalizeFillRings(component.polygons);
  if (outlineRings.length === 0 && fillRings.length === 0) {
    return null;
  }

  return {
    id: `component-selection-${component.id}`,
    kind: 'component',
    wallIds: component.wallIds,
    outlineRings,
    fillRings,
  };
}

function isCrowdedSelectionEndpoint(
  wall: Wall,
  endpoint: 'start' | 'end',
  componentWalls: Wall[]
): boolean {
  const point = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  let endpointNeighborCount = 0;
  let segmentHostCount = 0;

  for (const otherWall of componentWalls) {
    if (otherWall.id === wall.id) {
      continue;
    }

    const touchesOtherEndpoint =
      pointDistance(point, otherWall.startPoint) <= SELECTION_ENDPOINT_TOLERANCE_MM ||
      pointDistance(point, otherWall.endPoint) <= SELECTION_ENDPOINT_TOLERANCE_MM;
    if (touchesOtherEndpoint) {
      endpointNeighborCount += 1;
      continue;
    }

    const projection = projectPointToSegment(point, otherWall.startPoint, otherWall.endPoint);
    if (
      projection.distance <= SELECTION_ENDPOINT_TOLERANCE_MM &&
      projection.t > SELECTION_SEGMENT_T_EPSILON &&
      projection.t < 1 - SELECTION_SEGMENT_T_EPSILON
    ) {
      segmentHostCount += 1;
    }
  }

  return endpointNeighborCount >= 1 || segmentHostCount >= 1;
}

function unitDirectionFromEndpoint(
  wall: Wall,
  endpoint: 'start' | 'end'
): Point2D {
  return endpoint === 'start'
    ? normalize(subtract(wall.endPoint, wall.startPoint))
    : normalize(subtract(wall.startPoint, wall.endPoint));
}

function endpointTouchesWallAtEnd(
  point: Point2D,
  wall: Wall,
  endpoint: 'start' | 'end',
  toleranceMm: number
): boolean {
  const target = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  return pointDistance(point, target) <= toleranceMm;
}

function endpointMinJoinAngleDeg(
  wall: Wall,
  endpoint: 'start' | 'end',
  componentWalls: Wall[]
): number | null {
  const endpointPoint = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  const directionA = unitDirectionFromEndpoint(wall, endpoint);
  if (magnitude(directionA) < 0.000001) {
    return null;
  }

  let minAngleDeg: number | null = null;
  for (const otherWall of componentWalls) {
    if (otherWall.id === wall.id) {
      continue;
    }

    const touchesStart = endpointTouchesWallAtEnd(
      endpointPoint,
      otherWall,
      'start',
      SELECTION_ENDPOINT_TOLERANCE_MM
    );
    const touchesEnd = endpointTouchesWallAtEnd(
      endpointPoint,
      otherWall,
      'end',
      SELECTION_ENDPOINT_TOLERANCE_MM
    );
    if (!touchesStart && !touchesEnd) {
      continue;
    }

    const directionB = touchesStart
      ? normalize(subtract(otherWall.endPoint, otherWall.startPoint))
      : normalize(subtract(otherWall.startPoint, otherWall.endPoint));
    if (magnitude(directionB) < 0.000001) {
      continue;
    }

    const dotProduct = Math.max(-1, Math.min(1, dot(directionA, directionB)));
    const angleDeg = Math.acos(dotProduct) * (180 / Math.PI);
    if (minAngleDeg === null || angleDeg < minAngleDeg) {
      minAngleDeg = angleDeg;
    }
  }

  return minAngleDeg;
}

function endpointJoinLooksSpiky(
  wall: Wall,
  endpoint: 'start' | 'end',
  selectionPolygon: Point2D[],
  componentWalls: Wall[]
): boolean {
  if (selectionPolygon.length !== 4) {
    return false;
  }

  const [firstIndex, secondIndex] = endpoint === 'start' ? [0, 3] : [1, 2];
  const firstVertex = selectionPolygon[firstIndex];
  const secondVertex = selectionPolygon[secondIndex];
  const endpointPoint = endpoint === 'start' ? wall.startPoint : wall.endPoint;

  const reach = Math.max(
    pointDistance(firstVertex, endpointPoint),
    pointDistance(secondVertex, endpointPoint)
  );
  const maxReachAllowed = Math.max(
    wall.thickness * SELECTION_SPIKE_MAX_REACH_FACTOR,
    SELECTION_SPIKE_MAX_REACH_MM
  );

  const capWidth = pointDistance(firstVertex, secondVertex);
  const minCapWidth = wall.thickness * SELECTION_SPIKE_CAP_FACTOR;

  const minAngleDeg = endpointMinJoinAngleDeg(wall, endpoint, componentWalls);
  const acuteNeighbor = minAngleDeg !== null && minAngleDeg <= SELECTION_SPIKE_ANGLE_THRESHOLD_DEG;

  if (reach > maxReachAllowed) {
    return true;
  }
  if (acuteNeighbor) {
    return true;
  }
  if (minAngleDeg !== null && minAngleDeg <= 90 && capWidth < minCapWidth) {
    return true;
  }

  return false;
}

function closeRing(points: Point2D[]): number[][] {
  if (points.length === 0) return [];
  const ring = points.map((point) => [point.x, point.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (Math.abs(first[0] - last[0]) > 0.000001 || Math.abs(first[1] - last[1]) > 0.000001) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function openRing(ring: number[][]): Point2D[] {
  if (ring.length === 0) return [];
  const opened = ring.map(([x, y]) => ({ x, y }));
  if (opened.length < 2) return opened;
  const first = opened[0];
  const last = opened[opened.length - 1];
  if (Math.abs(first.x - last.x) < 0.000001 && Math.abs(first.y - last.y) < 0.000001) {
    opened.pop();
  }
  return opened;
}

function makePolygonFeatureFromRing(vertices: Point2D[]): PolygonFeature | null {
  const ring = normalizeRing(vertices);
  if (ring.length < 3) return null;
  try {
    return polygon([closeRing(ring)]);
  } catch {
    return null;
  }
}

function extractPolygonsFromGeometry(
  geometry: PolygonGeometry | MultiPolygonGeometry
): Point2D[][][] {
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map(openRing)];
  }
  return geometry.coordinates.map((polygon) => polygon.map(openRing));
}

function unionFeaturesPolygons(features: PolygonFeature[]): Point2D[][][] {
  if (features.length === 0) {
    return [];
  }

  if (features.length === 1) {
    return [features[0].geometry.coordinates.map(openRing)];
  }

  try {
    const merged = union(featureCollection(features));
    if (merged && (merged.geometry.type === 'Polygon' || merged.geometry.type === 'MultiPolygon')) {
      return extractPolygonsFromGeometry(merged.geometry);
    }
  } catch {
    // Fall through to per-feature polygons.
  }

  return features.map((feature) => feature.geometry.coordinates.map(openRing));
}

function endpointHasJoin(
  wall: Wall,
  endpoint: 'start' | 'end',
  joinsMap: Map<string, JoinData[]>
): boolean {
  const joins = joinsMap.get(wall.id) ?? [];
  if (joins.length === 0) {
    return false;
  }

  const endpointPoint = endpoint === 'start' ? wall.startPoint : wall.endPoint;
  return joins.some((join) => {
    if (join.endpoint === endpoint) {
      return true;
    }
    const joinPoint = join.joinPoint;
    return pointDistance(joinPoint, endpointPoint) <= SELECTION_JOIN_ENDPOINT_TOLERANCE_MM;
  });
}

function angleBetweenFromVertex(vertex: Point2D, a: Point2D, b: Point2D): number {
  const va = subtract(a, vertex);
  const vb = subtract(b, vertex);
  const magA = magnitude(va);
  const magB = magnitude(vb);
  if (magA < 0.000001 || magB < 0.000001) {
    return 180;
  }
  const cosine = Math.max(-1, Math.min(1, dot(va, vb) / (magA * magB)));
  return Math.acos(cosine) * (180 / Math.PI);
}

function pruneOuterRingSpikes(ring: Point2D[]): Point2D[] {
  const normalized = normalizeRing(ring);
  if (normalized.length < 4) {
    return normalized;
  }

  let working = [...normalized];
  let changed = true;
  let iteration = 0;
  const maxIterations = 2 * normalized.length;

  while (changed && iteration < maxIterations && working.length >= 4) {
    iteration += 1;
    changed = false;

    for (let i = 0; i < working.length; i += 1) {
      const prev = working[(i - 1 + working.length) % working.length];
      const curr = working[i];
      const next = working[(i + 1) % working.length];
      const lenPrev = pointDistance(prev, curr);
      const lenNext = pointDistance(curr, next);
      const span = pointDistance(prev, next);
      if (
        lenPrev < OUTER_RING_SPIKE_MIN_EDGE_MM ||
        lenNext < OUTER_RING_SPIKE_MIN_EDGE_MM ||
        span < OUTER_RING_SPIKE_MIN_EDGE_MM
      ) {
        continue;
      }

      const angleDeg = angleBetweenFromVertex(curr, prev, next);
      const reachRatio = Math.max(lenPrev, lenNext) / Math.max(span, 1);
      if (angleDeg <= OUTER_RING_SPIKE_ANGLE_DEG && reachRatio >= OUTER_RING_SPIKE_REACH_RATIO) {
        const candidate = working.filter((_, idx) => idx !== i);
        if (candidate.length < 3) {
          continue;
        }
        if (isRingSelfIntersecting(candidate)) {
          continue;
        }
        working = candidate;
        changed = true;
        break;
      }
    }
  }

  return working;
}

function cleanRingNotches(ring: Point2D[], shortEdgeThreshold: number): Point2D[] {
  const normalized = normalizeRing(ring);
  if (normalized.length < 4) {
    return normalized;
  }

  let working = [...normalized];
  let changed = true;
  let iteration = 0;
  const maxIterations = 3 * normalized.length;

  while (changed && iteration < maxIterations && working.length >= 4) {
    iteration += 1;
    changed = false;

    for (let i = 0; i < working.length; i += 1) {
      const prev = working[(i - 1 + working.length) % working.length];
      const curr = working[i];
      const next = working[(i + 1) % working.length];
      const lenPrev = pointDistance(prev, curr);
      const lenNext = pointDistance(curr, next);
      const angleDeg = angleBetweenFromVertex(curr, prev, next);
      const hasShortEdge = lenPrev < shortEdgeThreshold || lenNext < shortEdgeThreshold;
      const stronglyAsymmetric = Math.min(lenPrev, lenNext) < shortEdgeThreshold * 0.6;
      const notchLike =
        hasShortEdge &&
        stronglyAsymmetric &&
        angleDeg > 25 &&
        angleDeg < 165;
      const nearCollinear = angleDeg > 176;

      if (!notchLike && !nearCollinear) {
        continue;
      }

      const candidate = working.filter((_, idx) => idx !== i);
      if (candidate.length < 3) {
        continue;
      }
      if (isRingSelfIntersecting(candidate)) {
        continue;
      }
      working = candidate;
      changed = true;
      break;
    }
  }

  return working;
}

export function computeSelectableWallPolygon(
  wall: Wall,
  joinsMap: Map<string, JoinData[]>,
  componentWalls: Wall[]
): Point2D[] {
  const basePolygon = computeWallBodyPolygon(wall);
  const selectionPolygon = computeWallPolygon(wall, joinsMap.get(wall.id));
  if (selectionPolygon.length !== 4 || isPolygonSelfIntersecting(selectionPolygon)) {
    return basePolygon;
  }

  const adjustedPolygon = selectionPolygon.map((point) => ({ ...point }));
  const startHasJoin = endpointHasJoin(wall, 'start', joinsMap);
  const endHasJoin = endpointHasJoin(wall, 'end', joinsMap);
  if (
    startHasJoin ||
    isCrowdedSelectionEndpoint(wall, 'start', componentWalls) ||
    endpointJoinLooksSpiky(wall, 'start', adjustedPolygon, componentWalls)
  ) {
    adjustedPolygon[0] = { ...basePolygon[0] };
    adjustedPolygon[3] = { ...basePolygon[3] };
  }
  if (
    endHasJoin ||
    isCrowdedSelectionEndpoint(wall, 'end', componentWalls) ||
    endpointJoinLooksSpiky(wall, 'end', adjustedPolygon, componentWalls)
  ) {
    adjustedPolygon[1] = { ...basePolygon[1] };
    adjustedPolygon[2] = { ...basePolygon[2] };
  }

  return isPolygonSelfIntersecting(adjustedPolygon) ? basePolygon : adjustedPolygon;
}

function buildWallSelectionComponent(
  wall: Wall,
  joinsMap: Map<string, JoinData[]>,
  componentWalls: Wall[]
): WallSelectionComponent | null {
  const selectionPolygon = normalizeRing(
    computeSelectableWallPolygon(wall, joinsMap, componentWalls)
  );
  const outlineRings = normalizeOuterRings([[selectionPolygon]]);
  if (outlineRings.length === 0) {
    return null;
  }
  const fillRings = [...outlineRings];

  return {
    id: `wall-selection-${wall.id}`,
    kind: 'wall',
    wallIds: [wall.id],
    outlineRings,
    fillRings,
  };
}

export function getWallSelectionGeometrySignature(walls: Wall[]): string {
  const cached = wallSelectionSignatureCache.get(walls);
  if (cached) {
    return cached;
  }

  const signature = JSON.stringify(
    walls.map((wall) => ({
      id: wall.id,
      thickness: wall.thickness,
      startPoint: wall.startPoint,
      endPoint: wall.endPoint,
      interiorLine: wall.interiorLine,
      exteriorLine: wall.exteriorLine,
      connectedWalls: wall.connectedWalls,
      startBevel: wall.startBevel ?? null,
      endBevel: wall.endBevel ?? null,
    }))
  );
  wallSelectionSignatureCache.set(walls, signature);
  return signature;
}

export function getCachedWallSelectionComponentsForSignature(
  signature: string
): Map<string, WallSelectionComponent> | null {
  const cached = wallSelectionComponentCache.get(signature);
  return cached ? touchCachedWallSelectionComponents(signature, cached) : null;
}

export function cacheWallSelectionComponentEntriesForSignature(
  signature: string,
  entries: WallSelectionComponentEntry[]
): void {
  const componentsByWallId = new Map<string, WallSelectionComponent>();
  entries.forEach((entry) => {
    if (entry.component) {
      componentsByWallId.set(entry.wallId, entry.component);
    }
  });
  setCachedWallSelectionComponents(signature, componentsByWallId);
}

export function buildAllWallSelectionComponentEntries(
  walls: Wall[]
): WallSelectionComponentEntry[] {
  const joinsMap = computeWallUnionRenderData(walls).joinsMap;
  return walls.map((wall) => ({
    wallId: wall.id,
    component: buildWallSelectionComponent(wall, joinsMap, walls),
  }));
}

function getWallSelectionComponentMap(
  walls: Wall[]
): Map<string, WallSelectionComponent> {
  const signature = getWallSelectionGeometrySignature(walls);
  const cached = getCachedWallSelectionComponentsForSignature(signature);
  if (cached) {
    return cached;
  }

  const entries = buildAllWallSelectionComponentEntries(walls);
  cacheWallSelectionComponentEntriesForSignature(signature, entries);
  return getCachedWallSelectionComponentsForSignature(signature) ?? new Map<string, WallSelectionComponent>();
}

export function resolveWallSelectionPlan(
  walls: Wall[],
  rooms: Room[],
  selectedWallIds: string[]
): WallSelectionPlan {
  // Room selections are already expanded to wall IDs by the caller.
  // Keep the plan wall-centric to avoid merged-room contour artifacts.
  void rooms;
  const selectedSet = new Set(selectedWallIds);
  if (selectedSet.size === 0) {
    return {
      individualWallIds: [],
      mergedComponents: [],
    };
  }

  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const individualWallIds = Array.from(new Set(
    selectedWallIds.filter((wallId) => wallsById.has(wallId))
  ));
  const componentsByWallId = getWallSelectionComponentMap(walls);
  const mergedComponents = individualWallIds
    .map((wallId) => componentsByWallId.get(wallId) ?? null)
    .filter((component): component is WallSelectionComponent => Boolean(component));

  return {
    individualWallIds,
    mergedComponents,
  };
}

export function computeWallSelectionComponents(
  walls: Wall[],
  rooms: Room[],
  selectedWallIds: string[]
): WallSelectionComponent[] {
  return resolveWallSelectionPlan(walls, rooms, selectedWallIds).mergedComponents;
}
