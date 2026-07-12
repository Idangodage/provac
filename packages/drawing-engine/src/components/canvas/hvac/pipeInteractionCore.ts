/**
 * Renderer-agnostic pipe interaction core (T1 / smart drawing architecture).
 *
 * Today the drawing/editing logic is welded to the render engine: pure geometry
 * (`classifyHardDirection`, `intersectLines`, `snapToGrid`, the parallel-offset
 * segment solver) lives inside `PipeKonvaInteractionLayer.tsx` next to Konva
 * node mutations and store writes, and the rich snap logic lives inside the
 * Fabric draw tool. That makes both untestable and lets draw-time and edit-time
 * behaviour drift.
 *
 * This module is the single, PURE, engine-free core: a tool state machine, the
 * geometric edit operations (move/insert/delete vertex, move hard segment), the
 * snap resolver, and the `PipeCommand`/undo boundary. No fabric / konva / three
 * / React / store imports — so it is unit-tested in isolation and consumed
 * identically by the Konva interaction layer (edit) and the draw tool (draw).
 *
 * Geometry here is BEHAVIOUR-PRESERVING: the hard-segment direction tolerances
 * and the parallel-offset solver are ported verbatim from the current
 * `PipeKonvaInteractionLayer` so wiring it in is a no-op refactor.
 */

import type { Point2D } from '../../../types';

// ---------------------------------------------------------------------------
// Vector helpers (pure)
// ---------------------------------------------------------------------------

export function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}
export function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function scale(v: Point2D, factor: number): Point2D {
  return { x: v.x * factor, y: v.y * factor };
}
export function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}
export function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
export function areParallel(a: Point2D, b: Point2D): boolean {
  return Math.abs(a.x * b.y - a.y * b.x) <= 0.0001;
}

// ---------------------------------------------------------------------------
// Hard (axis/diagonal-locked) direction classification — ported verbatim.
// ---------------------------------------------------------------------------

export type HardDirection8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

const SQRT_HALF = Math.SQRT1_2;
export const DIRECTION_UNIT: Record<HardDirection8, Point2D> = {
  E: { x: 1, y: 0 },
  NE: { x: SQRT_HALF, y: -SQRT_HALF },
  N: { x: 0, y: -1 },
  NW: { x: -SQRT_HALF, y: -SQRT_HALF },
  W: { x: -1, y: 0 },
  SW: { x: -SQRT_HALF, y: SQRT_HALF },
  S: { x: 0, y: 1 },
  SE: { x: SQRT_HALF, y: SQRT_HALF },
};

export const HARD_ZERO_LENGTH_TOLERANCE_MM = 0.5;
export const HARD_DIAGONAL_TOLERANCE_MM = 1.5;
export const HARD_AXIS_TOLERANCE_MM = 0.5;

/**
 * Classifies a segment as one of 8 hard directions, or null if it is too short
 * or not close enough to an axis/diagonal. Tolerances match the live editor.
 */
export function classifyHardDirection(start: Point2D, end: Point2D): HardDirection8 | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) <= HARD_ZERO_LENGTH_TOLERANCE_MM && Math.abs(dy) <= HARD_ZERO_LENGTH_TOLERANCE_MM) {
    return null;
  }
  if (Math.abs(dx) <= HARD_AXIS_TOLERANCE_MM) {
    return dy > 0 ? 'S' : 'N';
  }
  if (Math.abs(dy) <= HARD_AXIS_TOLERANCE_MM) {
    return dx > 0 ? 'E' : 'W';
  }
  if (Math.abs(Math.abs(dx) - Math.abs(dy)) <= HARD_DIAGONAL_TOLERANCE_MM) {
    if (dx > 0 && dy < 0) return 'NE';
    if (dx > 0 && dy > 0) return 'SE';
    if (dx < 0 && dy < 0) return 'NW';
    return 'SW';
  }
  return null;
}

/** Intersection of two infinite lines, or null when (near) parallel. */
export function intersectLines(
  lineAPoint: Point2D,
  lineADirection: Point2D,
  lineBPoint: Point2D,
  lineBDirection: Point2D,
): Point2D | null {
  const determinant = lineADirection.x * lineBDirection.y - lineADirection.y * lineBDirection.x;
  if (Math.abs(determinant) <= 0.0001) {
    return null;
  }
  const delta = subtract(lineBPoint, lineAPoint);
  const t = (delta.x * lineBDirection.y - delta.y * lineBDirection.x) / determinant;
  return add(lineAPoint, scale(lineADirection, t));
}

/** Snaps a point to the nearest grid intersection. */
export function snapToGrid(point: Point2D, gridSizeMm: number): Point2D {
  const safeGrid = Math.max(gridSizeMm, 1);
  return {
    x: Math.round(point.x / safeGrid) * safeGrid,
    y: Math.round(point.y / safeGrid) * safeGrid,
  };
}

/**
 * Ortho/45 lock: projects `cursor` onto the nearest of the 8 hard-direction rays
 * emanating from `anchor` (Shift-drag behaviour). Returns the locked point.
 */
export function lockToHardAngle(anchor: Point2D, cursor: Point2D): { point: Point2D; direction: HardDirection8 } {
  const raw = subtract(cursor, anchor);
  const len = Math.hypot(raw.x, raw.y);
  if (len < 1e-6) {
    return { point: { ...anchor }, direction: 'E' };
  }
  let best: HardDirection8 = 'E';
  let bestDot = -Infinity;
  (Object.keys(DIRECTION_UNIT) as HardDirection8[]).forEach((dir) => {
    const d = dot(raw, DIRECTION_UNIT[dir]);
    if (d > bestDot) {
      bestDot = d;
      best = dir;
    }
  });
  const unit = DIRECTION_UNIT[best];
  const projected = Math.max(0, dot(raw, unit));
  return { point: add(anchor, scale(unit, projected)), direction: best };
}

/** Perpendicular distance from p to the infinite line a→b (|p−a| if a≈b). */
function perpendicularDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(l2);
}

/**
 * Ramer–Douglas–Peucker simplification. Reduces a raw freehand trail to the
 * minimal vertex set that stays within `epsilon` of the original shape, so the
 * arc-elbow builder rounds a handful of real corners instead of hundreds of
 * jitter points. Iterative (explicit stack) — safe for very long strokes.
 */
export function simplifyPath(points: Point2D[], epsilon: number): Point2D[] {
  const n = points.length;
  if (n <= 2 || epsilon <= 0) return points.slice();
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let idx = -1;
    let maxDist = epsilon;
    for (let i = lo + 1; i < hi; i += 1) {
      const d = perpendicularDistance(points[i]!, points[lo]!, points[hi]!);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out: Point2D[] = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(points[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

export type SnapKind = 'none' | 'grid' | 'port' | 'centerline' | 'endpoint' | 'angle45';

export interface SnapResult {
  point: Point2D;
  kind: SnapKind;
  targetId?: string;
}

export interface SnapCandidate {
  point: Point2D;
  kind: Extract<SnapKind, 'port' | 'centerline' | 'endpoint'>;
  targetId?: string;
  /** Lower = stronger; ties break by distance. Port < endpoint < centerline. */
  priority?: number;
}

/**
 * Read-only view of the scene the snap resolver queries for magnetic targets.
 * Implemented by the live layer / `pipeConnections`; injected here so the core
 * stays engine-free and unit-testable with fakes.
 */
export interface SceneQuery {
  snapCandidates(world: Point2D, toleranceMm: number): SnapCandidate[];
}

export interface SnapOptions {
  toleranceMm: number;
  gridSizeMm: number;
  snapToGrid: boolean;
}

const DEFAULT_PRIORITY: Record<SnapCandidate['kind'], number> = {
  port: 0,
  endpoint: 1,
  centerline: 2,
};

/**
 * Resolves the strongest snap for a world point: the highest-priority scene
 * candidate within tolerance, else a grid snap (if enabled), else the raw point.
 * Pure — magnetic candidates come from the injected {@link SceneQuery}.
 */
export function resolveSnap(world: Point2D, scene: SceneQuery | null, opts: SnapOptions): SnapResult {
  const candidates = scene ? scene.snapCandidates(world, opts.toleranceMm) : [];
  let best: SnapCandidate | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const dist = Math.hypot(candidate.point.x - world.x, candidate.point.y - world.y);
    if (dist > opts.toleranceMm) {
      continue;
    }
    const priority = candidate.priority ?? DEFAULT_PRIORITY[candidate.kind];
    const score = priority * 1e6 + dist; // priority dominates; distance breaks ties
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best) {
    return { point: { ...best.point }, kind: best.kind, targetId: best.targetId };
  }
  if (opts.snapToGrid) {
    return { point: snapToGrid(world, opts.gridSizeMm), kind: 'grid' };
  }
  return { point: { ...world }, kind: 'none' };
}

// ---------------------------------------------------------------------------
// Route edit operations (pure; preserve segment-material identity)
// ---------------------------------------------------------------------------

export type PipeSegmentMaterial = 'hard' | 'flexible';

function cloneRoute(route: Point2D[]): Point2D[] {
  return route.map((p) => ({ x: p.x, y: p.y }));
}

function normalizeMaterials(materials: PipeSegmentMaterial[], segmentCount: number): PipeSegmentMaterial[] {
  return Array.from({ length: Math.max(0, segmentCount) }, (_, i) =>
    materials[i] === 'hard' ? 'hard' : 'flexible',
  );
}

/** Moves a single vertex to `to`. */
export function moveVertex(route: Point2D[], index: number, to: Point2D): Point2D[] {
  if (index < 0 || index >= route.length) {
    return cloneRoute(route);
  }
  return route.map((p, i) => (i === index ? { x: to.x, y: to.y } : { x: p.x, y: p.y }));
}

export interface EditablePipeVertexInput {
  routeLength: number;
  vertexIndex: number;
  startConnected: boolean;
  endConnected: boolean;
  /** Number of fixed nodes at the start (port only = 1, port + rigid stub = 2). */
  startProtectedVertexCount?: number;
  /** Number of fixed nodes at the end (port only = 1, rigid stub + port = 2). */
  endProtectedVertexCount?: number;
}

/**
 * Resolves the route node a visible vertex grip is allowed to move. Connected
 * endpoints stay pinned to their port/fitting; dragging that endpoint grip
 * redirects the gesture to the first adjacent free node. A two-node run whose
 * opposite endpoint is also connected has no free node and is not draggable.
 */
export function resolveEditablePipeVertexIndex({
  routeLength,
  vertexIndex,
  startConnected,
  endConnected,
  startProtectedVertexCount = 1,
  endProtectedVertexCount = 1,
}: EditablePipeVertexInput): number | null {
  if (routeLength < 2 || vertexIndex < 0 || vertexIndex >= routeLength) return null;
  const lastIndex = routeLength - 1;
  if (vertexIndex === 0 && startConnected) {
    const protectedAtEnd = Math.max(1, Math.floor(endProtectedVertexCount));
    const target = Math.min(
      lastIndex,
      Math.max(1, Math.floor(startProtectedVertexCount)),
    );
    if (endConnected && target > lastIndex - protectedAtEnd) return null;
    return target;
  }
  if (vertexIndex === lastIndex && endConnected) {
    const protectedAtStart = Math.max(1, Math.floor(startProtectedVertexCount));
    const target = Math.max(
      0,
      lastIndex - Math.max(1, Math.floor(endProtectedVertexCount)),
    );
    if (startConnected && target < protectedAtStart) return null;
    return target;
  }
  return vertexIndex;
}

/**
 * Inserts a vertex `at`, splitting segment `afterIndex` (between vertices
 * `afterIndex` and `afterIndex+1`). Both halves inherit the split segment's
 * material, so material identity is preserved.
 */
export function insertVertex(
  route: Point2D[],
  materials: PipeSegmentMaterial[],
  afterIndex: number,
  at: Point2D,
): { route: Point2D[]; materials: PipeSegmentMaterial[] } {
  if (afterIndex < 0 || afterIndex > route.length - 2) {
    return { route: cloneRoute(route), materials: [...materials] };
  }
  const nextRoute = [
    ...cloneRoute(route.slice(0, afterIndex + 1)),
    { x: at.x, y: at.y },
    ...cloneRoute(route.slice(afterIndex + 1)),
  ];
  const splitMaterial: PipeSegmentMaterial = materials[afterIndex] === 'hard' ? 'hard' : 'flexible';
  const nextMaterials: PipeSegmentMaterial[] = [
    ...materials.slice(0, afterIndex),
    splitMaterial,
    splitMaterial,
    ...materials.slice(afterIndex + 1),
  ];
  return {
    route: nextRoute,
    materials: normalizeMaterials(nextMaterials, nextRoute.length - 1),
  };
}

/**
 * Deletes vertex `index`. Interior vertices merge their two adjacent segments
 * (the merged segment keeps the incoming material). Refuses to drop below 2
 * points.
 */
export function deleteVertex(
  route: Point2D[],
  materials: PipeSegmentMaterial[],
  index: number,
): { route: Point2D[]; materials: PipeSegmentMaterial[] } {
  if (route.length <= 2 || index < 0 || index >= route.length) {
    return { route: cloneRoute(route), materials: [...materials] };
  }
  const nextRoute = [...cloneRoute(route.slice(0, index)), ...cloneRoute(route.slice(index + 1))];
  // Remove one segment: the deleted vertex's *outgoing* segment, except at the
  // tail where it is the incoming one.
  const segmentToRemove = index === route.length - 1 ? index - 1 : index;
  const nextMaterials = [...materials.slice(0, segmentToRemove), ...materials.slice(segmentToRemove + 1)];
  return {
    route: nextRoute,
    materials: normalizeMaterials(nextMaterials, nextRoute.length - 1),
  };
}

// ---------------------------------------------------------------------------
// Parallel-offset hard-segment solver (ported verbatim from the Konva layer)
// ---------------------------------------------------------------------------

export interface MoveSegmentInput {
  routePoints: Point2D[];
  segmentMaterials: PipeSegmentMaterial[];
  startIndex: number;
  endIndex: number;
  /** Signed offset along the segment normal (mm). Caller applies grid snap. */
  offsetDistanceMm: number;
  lockStart: boolean;
  lockEnd: boolean;
}

export interface MoveSegmentResult {
  routePoints: Point2D[];
  mainDirection: HardDirection8;
}

/**
 * Offsets a hard segment perpendicular to itself, dragging along any parallel
 * hard neighbours and re-intersecting the bounding non-parallel hard segments so
 * the route stays orthogonally consistent. Returns null when the move is invalid
 * (locked endpoint reached, boundary parallel, no intersection, or the segment's
 * hard direction would flip) — exactly the cases the live editor rejects.
 */
export function moveHardSegment(input: MoveSegmentInput): MoveSegmentResult | null {
  const { routePoints, segmentMaterials, startIndex, endIndex, offsetDistanceMm, lockStart, lockEnd } = input;
  const startPoint = routePoints[startIndex];
  const endPoint = routePoints[endIndex];
  if (!startPoint || !endPoint) {
    return null;
  }
  const mainDirection = classifyHardDirection(startPoint, endPoint);
  if (!mainDirection) {
    return null;
  }
  const direction = DIRECTION_UNIT[mainDirection];
  const segmentNormal = { x: -direction.y, y: direction.x };
  const appliedDelta = scale(segmentNormal, offsetDistanceMm);

  const pointCount = routePoints.length;
  const terminalIndex = pointCount - 1;
  const isHardSegment = (segmentIndex: number): boolean =>
    (segmentMaterials[segmentIndex] ?? 'flexible') === 'hard';
  const hardSegmentDirection = (segmentIndex: number): HardDirection8 | null => {
    if (segmentIndex < 0 || segmentIndex >= pointCount - 1) {
      return null;
    }
    return classifyHardDirection(routePoints[segmentIndex]!, routePoints[segmentIndex + 1]!);
  };

  let moveStartIndex = startIndex;
  let moveEndIndex = endIndex;

  while (moveStartIndex > 0) {
    const leftSegmentIndex = moveStartIndex - 1;
    if (!isHardSegment(leftSegmentIndex)) break;
    const leftDirection = hardSegmentDirection(leftSegmentIndex);
    if (!leftDirection || !areParallel(DIRECTION_UNIT[leftDirection], direction)) break;
    if (lockStart && leftSegmentIndex === 0) return null;
    moveStartIndex -= 1;
  }

  while (moveEndIndex < terminalIndex) {
    const rightSegmentIndex = moveEndIndex;
    if (!isHardSegment(rightSegmentIndex)) break;
    const rightDirection = hardSegmentDirection(rightSegmentIndex);
    if (!rightDirection || !areParallel(DIRECTION_UNIT[rightDirection], direction)) break;
    if (lockEnd && rightSegmentIndex === terminalIndex - 1) return null;
    moveEndIndex += 1;
  }

  const movedPointOverrides = new Map<number, Point2D>();
  for (let index = moveStartIndex; index <= moveEndIndex; index += 1) {
    movedPointOverrides.set(index, add(routePoints[index]!, appliedDelta));
  }

  const leftBoundarySegmentIndex = moveStartIndex - 1;
  if (leftBoundarySegmentIndex >= 0 && isHardSegment(leftBoundarySegmentIndex)) {
    const fixedPoint = routePoints[leftBoundarySegmentIndex]!;
    const leftDirection = hardSegmentDirection(leftBoundarySegmentIndex);
    const movedBoundaryPoint = movedPointOverrides.get(moveStartIndex)!;
    if (!leftDirection || areParallel(DIRECTION_UNIT[leftDirection], direction)) {
      return null;
    }
    const intersection = intersectLines(movedBoundaryPoint, direction, fixedPoint, DIRECTION_UNIT[leftDirection]);
    if (!intersection) return null;
    movedPointOverrides.set(moveStartIndex, intersection);
  }

  const rightBoundarySegmentIndex = moveEndIndex;
  if (rightBoundarySegmentIndex < terminalIndex && isHardSegment(rightBoundarySegmentIndex)) {
    const fixedPoint = routePoints[rightBoundarySegmentIndex + 1]!;
    const rightDirection = hardSegmentDirection(rightBoundarySegmentIndex);
    const movedBoundaryPoint = movedPointOverrides.get(moveEndIndex)!;
    if (!rightDirection || areParallel(DIRECTION_UNIT[rightDirection], direction)) {
      return null;
    }
    const intersection = intersectLines(movedBoundaryPoint, direction, fixedPoint, DIRECTION_UNIT[rightDirection]);
    if (!intersection) return null;
    movedPointOverrides.set(moveEndIndex, intersection);
  }

  const nextRoutePoints = routePoints.map(
    (routePoint, index): Point2D => movedPointOverrides.get(index) ?? { x: routePoint.x, y: routePoint.y },
  );
  const movedStart = nextRoutePoints[startIndex]!;
  const movedEnd = nextRoutePoints[endIndex]!;
  const movedMainDirection = classifyHardDirection(movedStart, movedEnd);
  if (!movedMainDirection || movedMainDirection !== mainDirection) {
    return null;
  }
  return { routePoints: nextRoutePoints, mainDirection };
}

// ---------------------------------------------------------------------------
// Tool state machine
// ---------------------------------------------------------------------------

export type PipeToolState =
  | { kind: 'idle' }
  | { kind: 'drawing'; points: Point2D[]; cursor: Point2D | null }
  | { kind: 'selected'; elementId: string }
  | { kind: 'draggingVertex'; elementId: string; index: number }
  | { kind: 'draggingSegment'; elementId: string; index: number }
  | { kind: 'draggingEndpoint'; elementId: string; end: 'start' | 'end' };

export type PipeToolEvent =
  | { type: 'startDraw' }
  | { type: 'addPoint'; point: Point2D }
  | { type: 'moveCursor'; point: Point2D }
  | { type: 'commitDraw' }
  | { type: 'cancel' }
  | { type: 'select'; elementId: string }
  | { type: 'deselect' }
  | { type: 'grabVertex'; elementId: string; index: number }
  | { type: 'grabSegment'; elementId: string; index: number }
  | { type: 'grabEndpoint'; elementId: string; end: 'start' | 'end' }
  | { type: 'release' };

const IDLE: PipeToolState = { kind: 'idle' };

/** Pure tool transition. Unknown (state,event) pairs are no-ops. */
export function reducePipeTool(state: PipeToolState, event: PipeToolEvent): PipeToolState {
  switch (event.type) {
    case 'startDraw':
      return { kind: 'drawing', points: [], cursor: null };
    case 'addPoint':
      if (state.kind === 'drawing') {
        return { kind: 'drawing', points: [...state.points, { ...event.point }], cursor: state.cursor };
      }
      return state;
    case 'moveCursor':
      if (state.kind === 'drawing') {
        return { kind: 'drawing', points: state.points, cursor: { ...event.point } };
      }
      return state;
    case 'commitDraw':
    case 'cancel':
      return IDLE;
    case 'select':
      return { kind: 'selected', elementId: event.elementId };
    case 'deselect':
      return IDLE;
    case 'grabVertex':
      return { kind: 'draggingVertex', elementId: event.elementId, index: event.index };
    case 'grabSegment':
      return { kind: 'draggingSegment', elementId: event.elementId, index: event.index };
    case 'grabEndpoint':
      return { kind: 'draggingEndpoint', elementId: event.elementId, end: event.end };
    case 'release':
      if (
        state.kind === 'draggingVertex' ||
        state.kind === 'draggingSegment' ||
        state.kind === 'draggingEndpoint'
      ) {
        return { kind: 'selected', elementId: state.elementId };
      }
      return state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Command / undo boundary
// ---------------------------------------------------------------------------

export type PipeCommand =
  | { type: 'AddPipe'; route: Point2D[]; materials: PipeSegmentMaterial[] }
  | { type: 'MoveVertex'; elementId: string; index: number; to: Point2D }
  | { type: 'InsertVertex'; elementId: string; afterIndex: number; at: Point2D }
  | { type: 'DeleteVertex'; elementId: string; index: number }
  | { type: 'MoveSegment'; elementId: string; startIndex: number; endIndex: number; deltaNormalMm: number; lockStart?: boolean; lockEnd?: boolean }
  | { type: 'ReconnectEndpoint'; elementId: string; end: 'start' | 'end'; target: SnapResult };

export interface RouteGeometry {
  route: Point2D[];
  materials: PipeSegmentMaterial[];
}

/**
 * Applies the GEOMETRY of a command to a route. Returns the next geometry, or
 * null when the command does not change geometry by itself (`AddPipe`,
 * `ReconnectEndpoint` — those are resolved by the commit layer against the
 * scene/spec). Used for undo-able commits and round-trip tests.
 */
export function applyPipeCommand(current: RouteGeometry, command: PipeCommand): RouteGeometry | null {
  switch (command.type) {
    case 'MoveVertex':
      return { route: moveVertex(current.route, command.index, command.to), materials: [...current.materials] };
    case 'InsertVertex':
      return insertVertex(current.route, current.materials, command.afterIndex, command.at);
    case 'DeleteVertex':
      return deleteVertex(current.route, current.materials, command.index);
    case 'MoveSegment': {
      const moved = moveHardSegment({
        routePoints: current.route,
        segmentMaterials: current.materials,
        startIndex: command.startIndex,
        endIndex: command.endIndex,
        offsetDistanceMm: command.deltaNormalMm,
        lockStart: command.lockStart ?? false,
        lockEnd: command.lockEnd ?? false,
      });
      return moved ? { route: moved.routePoints, materials: [...current.materials] } : null;
    }
    case 'AddPipe':
    case 'ReconnectEndpoint':
    default:
      return null;
  }
}
