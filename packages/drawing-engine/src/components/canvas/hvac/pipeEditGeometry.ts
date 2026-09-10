import type { PipeRouteNode3D } from './pipeRoute3d';

/** All positions and offsets are model-space millimetres. No camera state belongs here. */
export type PipeEditCoordinateMode = 'world' | 'local' | 'workplane';
export type PipeEditSelection =
  | { kind: 'run' }
  | { kind: 'node'; index: number }
  | { kind: 'segment'; index: number }
  | { kind: 'section'; startIndex: number; endIndex: number };

export interface PipeEditWorkplane {
  origin: PipeRouteNode3D;
  xAxis: PipeRouteNode3D;
  normal: PipeRouteNode3D;
}

export interface PipeEditFrame {
  mode: PipeEditCoordinateMode;
  origin: PipeRouteNode3D;
  xAxis: PipeRouteNode3D;
  yAxis: PipeRouteNode3D;
  zAxis: PipeRouteNode3D;
  labels: readonly [string, string, string];
}

export type PipeRouteEditOperation =
  | { kind: 'translate'; offset: PipeRouteNode3D }
  | { kind: 'set-node'; position: PipeRouteNode3D }
  | { kind: 'rotate'; axis: 'x' | 'y' | 'z'; angleDegrees: number; pivot: 'start' | 'end' | PipeRouteNode3D }
  | { kind: 'insert'; position?: PipeRouteNode3D }
  | { kind: 'remove' };

export interface PipeEditPortConstraint {
  endpoint: 'start' | 'end';
  position: PipeRouteNode3D;
  /** Direction from the component's port into the pipe (at either endpoint). */
  direction: PipeRouteNode3D;
  positionToleranceMm?: number;
  angularToleranceDegrees?: number;
}

export interface PipeEditConstraints {
  locked?: boolean;
  /** Indices in the original route, unaffected by insertion or removal. */
  lockedNodeIndices?: readonly number[];
  /** Preserve both the original terminal position and its direction into the route. */
  protectStart?: boolean;
  protectEnd?: boolean;
  ports?: readonly PipeEditPortConstraint[];
  /** Slide a segment by extending its adjacent straight legs to meet it. */
  preserveAdjacentDirections?: boolean;
  minimumSegmentLengthMm?: number;
}

export type PipeRouteEditResult =
  | { ok: true; nodes: PipeRouteNode3D[]; changedNodeIndices: number[] }
  | { ok: false; error: { code: 'invalid-input' | 'invalid-selection' | 'locked' | 'degenerate-segment' | 'connection-position' | 'connection-orientation'; message: string } };

const EPSILON = 1e-9;
const POSITION_TOLERANCE_MM = 0.01;
const ANGULAR_TOLERANCE_DEGREES = 0.1;
const WORLD_X: PipeRouteNode3D = { x: 1, y: 0, z: 0 };
const WORLD_Y: PipeRouteNode3D = { x: 0, y: 1, z: 0 };
const WORLD_Z: PipeRouteNode3D = { x: 0, y: 0, z: 1 };
const ZERO: PipeRouteNode3D = { x: 0, y: 0, z: 0 };

function finite(point: PipeRouteNode3D | undefined): point is PipeRouteNode3D {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function add(a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: PipeRouteNode3D, amount: number): PipeRouteNode3D {
  return { x: a.x * amount, y: a.y * amount, z: a.z * amount };
}

function dot(a: PipeRouteNode3D, b: PipeRouteNode3D): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function length(a: PipeRouteNode3D): number {
  return Math.hypot(a.x, a.y, a.z);
}

function normalize(a: PipeRouteNode3D): PipeRouteNode3D | null {
  const magnitude = length(a);
  return finite(a) && Number.isFinite(magnitude) && magnitude > EPSILON ? scale(a, 1 / magnitude) : null;
}

function fail(code: Extract<PipeRouteEditResult, { ok: false }>['error']['code'], message: string): PipeRouteEditResult {
  return { ok: false, error: { code, message } };
}

/** An invalid/out-of-range selection is never clamped onto unrelated geometry. */
export function getPipeEditSelectionIndices(nodes: readonly PipeRouteNode3D[], selection: PipeEditSelection): number[] {
  let start: number;
  let end: number;
  switch (selection.kind) {
    case 'run': start = 0; end = nodes.length - 1; break;
    case 'node': start = selection.index; end = start; break;
    case 'segment': start = selection.index; end = start + 1; break;
    case 'section': start = selection.startIndex; end = selection.endIndex; break;
    default: return [];
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= nodes.length || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/**
 * Local X follows the first selected segment (the preceding segment at the last
 * node); local Z follows the supplied workplane normal or world Z as closely as
 * orthogonality permits. A vertical segment uses a deterministic world Y fallback.
 * Workplane U/V/N are independent of camera projection and workplane translation.
 */
export function resolvePipeEditFrame(input: {
  mode: PipeEditCoordinateMode;
  nodes: readonly PipeRouteNode3D[];
  selection: PipeEditSelection;
  workplane?: PipeEditWorkplane | null;
}): PipeEditFrame | null {
  const { mode, nodes, selection, workplane } = input;
  if (mode === 'world') {
    return { mode, origin: { ...ZERO }, xAxis: { ...WORLD_X }, yAxis: { ...WORLD_Y }, zAxis: { ...WORLD_Z }, labels: ['X', 'Y', 'Z'] };
  }
  if (mode === 'workplane') {
    if (!workplane || !finite(workplane.origin) || !finite(workplane.xAxis) || !finite(workplane.normal)) return null;
    const zAxis = normalize(workplane.normal);
    if (!zAxis) return null;
    const xAxis = [workplane.xAxis, WORLD_X, WORLD_Y, WORLD_Z]
      .map((axis) => normalize(subtract(axis, scale(zAxis, dot(axis, zAxis)))))
      .find((axis): axis is PipeRouteNode3D => !!axis);
    if (!xAxis) return null;
    const yAxis = normalize(cross(zAxis, xAxis));
    return yAxis ? { mode, origin: { ...workplane.origin }, xAxis, yAxis, zAxis, labels: ['U', 'V', 'N'] } : null;
  }
  if (mode !== 'local') return null;
  const indices = getPipeEditSelectionIndices(nodes, selection);
  if (!indices.length || nodes.length < 2) return null;
  const start = indices[0]!;
  const segment = Math.min(start, nodes.length - 2);
  if (!finite(nodes[segment]) || !finite(nodes[segment + 1]) || !finite(nodes[start])) return null;
  const xAxis = normalize(subtract(nodes[segment + 1]!, nodes[segment]!));
  if (!xAxis) return null;
  const normalHint = workplane?.normal ?? WORLD_Z;
  if (!finite(normalHint)) return null;
  const zAxis = [normalHint, WORLD_Z, WORLD_Y, WORLD_X]
    .map((normal) => normalize(subtract(normal, scale(xAxis, dot(normal, xAxis)))))
    .find((axis): axis is PipeRouteNode3D => !!axis);
  if (!zAxis) return null;
  const yAxis = normalize(cross(zAxis, xAxis));
  return yAxis ? { mode, origin: { ...nodes[start]! }, xAxis, yAxis, zAxis, labels: ['Local X', 'Local Y', 'Local Z'] } : null;
}

function validFrame(frame: PipeEditFrame): boolean {
  const axes = [frame.xAxis, frame.yAxis, frame.zAxis];
  return finite(frame.origin)
    && axes.every((axis) => finite(axis) && Math.abs(length(axis) - 1) < 1e-7)
    && Math.abs(dot(frame.xAxis, frame.yAxis)) < 1e-7
    && Math.abs(dot(frame.xAxis, frame.zAxis)) < 1e-7
    && Math.abs(dot(frame.yAxis, frame.zAxis)) < 1e-7
    && dot(cross(frame.xAxis, frame.yAxis), frame.zAxis) > 1 - 1e-7;
}

export function pipeEditVectorToWorld(vector: PipeRouteNode3D, frame: PipeEditFrame): PipeRouteNode3D {
  return add(add(scale(frame.xAxis, vector.x), scale(frame.yAxis, vector.y)), scale(frame.zAxis, vector.z));
}

export function pipeEditPointToWorld(point: PipeRouteNode3D, frame: PipeEditFrame): PipeRouteNode3D {
  return add(frame.origin, pipeEditVectorToWorld(point, frame));
}

export function pipeEditPointFromWorld(point: PipeRouteNode3D, frame: PipeEditFrame): PipeRouteNode3D {
  const relative = subtract(point, frame.origin);
  return { x: dot(relative, frame.xAxis), y: dot(relative, frame.yAxis), z: dot(relative, frame.zAxis) };
}

function rotateVector(vector: PipeRouteNode3D, axis: PipeRouteNode3D, angle: number): PipeRouteNode3D {
  const cosine = Math.cos(angle);
  return add(add(scale(vector, cosine), scale(cross(axis, vector), Math.sin(angle))), scale(axis, dot(axis, vector) * (1 - cosine)));
}

function directionsAgree(a: PipeRouteNode3D, b: PipeRouteNode3D, tolerance: number): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return !!left && !!right && dot(left, right) >= Math.cos(tolerance * Math.PI / 180) - 1e-12;
}

function endpointDirection(nodes: readonly PipeRouteNode3D[], endpoint: 'start' | 'end'): PipeRouteNode3D {
  return endpoint === 'start' ? subtract(nodes[1]!, nodes[0]!) : subtract(nodes[nodes.length - 2]!, nodes[nodes.length - 1]!);
}

function intersectStraightLeg(origin: PipeRouteNode3D, direction: PipeRouteNode3D,
  neighbor: PipeRouteNode3D, neighborDirection: PipeRouteNode3D): PipeRouteNode3D | null {
  const normal = cross(direction, neighborDirection);
  const denominator = dot(normal, normal);
  const separation = subtract(neighbor, origin);
  if (denominator < 1e-12) return length(cross(separation, direction)) < 0.001 ? origin : null;
  if (Math.abs(dot(separation, normal)) > 0.001 * Math.sqrt(denominator)) return null;
  return add(origin, scale(direction, dot(cross(separation, neighborDirection), normal) / denominator));
}

/**
 * Carry a slid segment's coordinates through adjoining perpendicular legs.
 * This lets a plan leg carry its risers to the next horizontal straights. A
 * sampled curve or diagonal leg moves rigidly; its chord directions and lengths
 * are never stretched into invented fittings. Fixed ports constrain the affected
 * coordinate instead of blocking an otherwise usable pointer drag.
 */
function slidePipeSegment(nodes: readonly PipeRouteNode3D[], start: number,
  delta: PipeRouteNode3D, constraints: PipeEditConstraints): PipeRouteNode3D[] {
  const candidate = nodes.map(node => ({ ...node }));
  const selectedDirection = normalize(subtract(nodes[start + 1]!, nodes[start]!));
  if (!selectedDirection) return candidate;
  const transverseDelta = subtract(delta, scale(selectedDirection, dot(delta, selectedDirection)));
  const fixed = new Set(constraints.lockedNodeIndices);
  if (constraints.protectStart || constraints.ports?.some(port => port.endpoint === 'start')) fixed.add(0);
  if (constraints.protectEnd || constraints.ports?.some(port => port.endpoint === 'end')) fixed.add(nodes.length - 1);
  const immediate = nodes.map(node => ({ ...node }));
  immediate[start] = add(nodes[start]!, transverseDelta);
  immediate[start + 1] = add(nodes[start + 1]!, transverseDelta);
  let intersects = true;
  for (const [index, neighbor] of [[start, start - 1], [start + 1, start + 2]] as const) {
    if (neighbor < 0 || neighbor >= nodes.length) continue;
    const neighborDirection = normalize(subtract(nodes[index]!, nodes[neighbor]!));
    const meeting = neighborDirection && intersectStraightLeg(immediate[index]!, selectedDirection, nodes[neighbor]!, neighborDirection);
    if (!meeting) { intersects = false; break; }
    immediate[index] = meeting;
  }
  if (intersects && [...fixed].every(index => length(subtract(immediate[index]!, nodes[index]!)) < EPSILON)) return immediate;

  // Express orthogonal propagation in the route's own frame, so a plan rotated
  // relative to world XY edits identically to an axis-aligned installation.
  const yAxis = nodes.slice(1).map((node, index) => subtract(node, nodes[index]!))
    .map(edge => normalize(subtract(edge, scale(selectedDirection, dot(edge, selectedDirection)))))
    .find((axis): axis is PipeRouteNode3D => axis !== null)
    ?? normalize(cross(selectedDirection, Math.abs(selectedDirection.z) < 0.9 ? WORLD_Z : WORLD_Y))!;
  const axes = { x: selectedDirection, y: yAxis, z: cross(selectedDirection, yAxis) };
  const localDelta = { x: 0, y: dot(transverseDelta, axes.y), z: dot(transverseDelta, axes.z) };
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(localDelta[axis]) < EPSILON) continue;
    const affected = new Set([start, start + 1]);
    const pending = [...affected];
    while (pending.length) {
      const index = pending.pop()!;
      for (const neighbor of [index - 1, index + 1]) {
        if (neighbor < 0 || neighbor >= nodes.length || affected.has(neighbor)) continue;
        const edge = subtract(nodes[neighbor]!, nodes[index]!);
        const alongAxis = Math.abs(dot(edge, axes[axis])) > EPSILON
          && (['x', 'y', 'z'] as const).every(otherAxis => otherAxis === axis || Math.abs(dot(edge, axes[otherAxis])) < 1e-6);
        if (alongAxis) continue;
        affected.add(neighbor); pending.push(neighbor);
      }
    }
    if ([...affected].some(index => fixed.has(index))) continue;
    for (const index of affected) candidate[index] = add(candidate[index]!, scale(axes[axis], localDelta[axis]));
  }
  return candidate;
}

/**
 * Transactional, immutable edit: failures return no candidate geometry. The caller
 * can preview successful results and commit once through the existing store.
 * A rotated section may extend/shorten neighboring straight segments only while
 * preserving the rotated interface direction. More complex neighboring rerouting
 * requires an explicit separate operation and is rejected here.
 * This kernel does not check equipment compatibility, clearances or bend radii;
 * callers must also run the application's HVAC/fitting validation before commit.
 */
export function applyPipeRouteEdit(input: {
  nodes: readonly PipeRouteNode3D[];
  selection: PipeEditSelection;
  operation: PipeRouteEditOperation;
  frame?: PipeEditFrame | null;
  constraints?: PipeEditConstraints;
}): PipeRouteEditResult {
  const { nodes, selection, operation, constraints = {} } = input;
  if (nodes.length < 2 || !Array.from(nodes).every(finite)) return fail('invalid-input', 'The route must contain at least two finite 3D points.');
  if (constraints.locked) return fail('locked', 'This pipe is locked. Unlock it before editing.');
  const indices = getPipeEditSelectionIndices(nodes, selection);
  if (!indices.length) return fail('invalid-selection', 'Select valid route points or a segment.');
  const frame = input.frame === undefined
    ? resolvePipeEditFrame({ mode: 'world', nodes, selection })
    : input.frame;
  if (!frame || !validFrame(frame)) return fail('invalid-input', 'Choose a valid coordinate frame or define a workplane.');
  const minimumLength = constraints.minimumSegmentLengthMm ?? 0.0001;
  if (!Number.isFinite(minimumLength) || minimumLength <= 0) return fail('invalid-input', 'The minimum segment length must be positive and finite.');
  const lockedIndices = constraints.lockedNodeIndices ?? [];
  if (lockedIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= nodes.length)) return fail('invalid-input', 'A locked route point no longer exists.');

  let candidate = nodes.map((node) => ({ ...node }));
  const originalIndices: Array<number | null> = nodes.map((_, index) => index);
  let rotation: { axis: PipeRouteNode3D; angle: number } | null = null;
  switch (operation.kind) {
    case 'translate': {
      if (!finite(operation.offset)) return fail('invalid-input', 'Enter finite translation offsets.');
      const delta = pipeEditVectorToWorld(operation.offset, frame);
      for (const index of indices) candidate[index] = add(nodes[index]!, delta);
      if (selection.kind === 'segment' && constraints.preserveAdjacentDirections) {
        candidate = slidePipeSegment(nodes, selection.index, delta, constraints);
        if (length(delta) > EPSILON && candidate.every((node, index) => length(subtract(node, nodes[index]!)) < EPSILON)) {
          const direction = normalize(subtract(nodes[selection.index + 1]!, nodes[selection.index]!))!;
          return length(subtract(delta, scale(direction, dot(delta, direction)))) < EPSILON
            ? fail('invalid-selection', 'Move an endpoint to change this segment’s length.')
            : fail('connection-position', 'The connected ends constrain this direction. Move an adjoining segment.');
        }
      }
      break;
    }
    case 'set-node': {
      if (selection.kind !== 'node') return fail('invalid-selection', 'Select one route point to enter its coordinates.');
      if (!finite(operation.position)) return fail('invalid-input', 'Enter finite point coordinates.');
      candidate[selection.index] = pipeEditPointToWorld(operation.position, frame);
      break;
    }
    case 'rotate': {
      if (indices.length < 2) return fail('invalid-selection', 'Select a segment, bend section or complete run to rotate.');
      if (!Number.isFinite(operation.angleDegrees) || !['x', 'y', 'z'].includes(operation.axis)
        || (typeof operation.pivot === 'string' ? !['start', 'end'].includes(operation.pivot) : !finite(operation.pivot))) return fail('invalid-input', 'Enter a finite angle and choose a rotation axis and endpoint pivot.');
      const axis = operation.axis === 'x' ? frame.xAxis : operation.axis === 'y' ? frame.yAxis : frame.zAxis;
      const angle = (operation.angleDegrees % 360) * Math.PI / 180;
      rotation = { axis, angle };
      const pivotIndex = typeof operation.pivot === 'string' ? operation.pivot === 'start' ? indices[0]! : indices[indices.length - 1]! : -1;
      // Explicit pivots are world/model coordinates, so connected runs can share
      // one pivot even when their own endpoint order or local origins differ.
      const pivot = typeof operation.pivot === 'string' ? nodes[pivotIndex]! : operation.pivot;
      for (const index of indices) {
        // Copy the pivot exactly; do not subject it to subtract/add roundoff.
        candidate[index] = index === pivotIndex ? { ...pivot } : add(pivot, rotateVector(subtract(nodes[index]!, pivot), axis, angle));
      }
      break;
    }
    case 'insert': {
      if (selection.kind !== 'segment') return fail('invalid-selection', 'Select a segment to insert a route point.');
      if (operation.position && !finite(operation.position)) return fail('invalid-input', 'Enter finite insertion coordinates.');
      const index = selection.index;
      const inserted = operation.position
        ? pipeEditPointToWorld(operation.position, frame)
        : add(scale(nodes[index]!, 0.5), scale(nodes[index + 1]!, 0.5));
      candidate.splice(index + 1, 0, inserted);
      originalIndices.splice(index + 1, 0, null);
      break;
    }
    case 'remove': {
      if (selection.kind !== 'node' || selection.index === 0 || selection.index === nodes.length - 1) return fail('invalid-selection', 'Only intermediate route points can be removed.');
      candidate.splice(selection.index, 1);
      originalIndices.splice(selection.index, 1);
      break;
    }
    default: return fail('invalid-input', 'Choose a supported pipe editing operation.');
  }

  if (!candidate.every(finite)) return fail('invalid-input', 'The requested edit exceeds the supported coordinate range.');
  for (const index of lockedIndices) {
    const nextIndex = originalIndices.indexOf(index);
    if (nextIndex < 0 || length(subtract(candidate[nextIndex]!, nodes[index]!)) > 1e-6) return fail('locked', `Route point ${index + 1} is locked. Adjust the selection or unlock that point.`);
  }
  for (let index = 1; index < candidate.length; index += 1) {
    const distance = length(subtract(candidate[index]!, candidate[index - 1]!));
    if (!Number.isFinite(distance) || distance < minimumLength) return fail('degenerate-segment', `The edit would create a zero-length or too-short segment at route point ${index + 1}.`);
    if (index < candidate.length - 1 && directionsAgree(subtract(candidate[index - 1]!, candidate[index]!), subtract(candidate[index + 1]!, candidate[index]!), 0.001)) {
      return fail('degenerate-segment', `The edit would make the pipe double back at route point ${index + 1}.`);
    }
  }

  const ports: PipeEditPortConstraint[] = [...(constraints.ports ?? [])];
  if (constraints.protectStart) ports.push({ endpoint: 'start', position: nodes[0]!, direction: endpointDirection(nodes, 'start') });
  if (constraints.protectEnd) ports.push({ endpoint: 'end', position: nodes[nodes.length - 1]!, direction: endpointDirection(nodes, 'end') });
  for (const port of ports) {
    const positionTolerance = port.positionToleranceMm ?? POSITION_TOLERANCE_MM;
    const angularTolerance = port.angularToleranceDegrees ?? ANGULAR_TOLERANCE_DEGREES;
    if (!['start', 'end'].includes(port.endpoint) || !finite(port.position) || !finite(port.direction) || !normalize(port.direction)
      || !Number.isFinite(positionTolerance) || positionTolerance < 0 || !Number.isFinite(angularTolerance) || angularTolerance < 0 || angularTolerance > 180) {
      return fail('invalid-input', 'A connected port has invalid position, direction or tolerance data.');
    }
    const point = port.endpoint === 'start' ? candidate[0]! : candidate[candidate.length - 1]!;
    if (length(subtract(point, port.position)) > positionTolerance) return fail('connection-position', `The ${port.endpoint} connection must remain fixed. Adjust the adjoining route or explicitly disconnect it first.`);
    if (!directionsAgree(endpointDirection(candidate, port.endpoint), port.direction, angularTolerance)) return fail('connection-orientation', `The ${port.endpoint} connection would point in the wrong direction. Keep its straight approach aligned or explicitly adjust the connection first.`);
  }

  if (rotation) {
    const start = indices[0]!;
    const end = indices[indices.length - 1]!;
    const boundaries = [
      ...(start > 0 ? [{ selected: start, outside: start - 1 }] : []),
      ...(end < nodes.length - 1 ? [{ selected: end, outside: end + 1 }] : []),
    ];
    for (const boundary of boundaries) {
      const expected = rotateVector(subtract(nodes[boundary.outside]!, nodes[boundary.selected]!), rotation.axis, rotation.angle);
      const actual = subtract(candidate[boundary.outside]!, candidate[boundary.selected]!);
      if (!directionsAgree(actual, expected, ANGULAR_TOLERANCE_DEGREES)) return fail('connection-orientation', `The neighboring segment at route point ${boundary.selected + 1} cannot maintain the rotated connection direction. Adjust that section before rotating.`);
    }
  }

  const changedNodeIndices = candidate.flatMap((node, index) => {
    const originalIndex = originalIndices[index];
    return originalIndex == null || originalIndex !== index || length(subtract(node, nodes[originalIndex]!)) > 1e-9 ? [index] : [];
  });
  return { ok: true, nodes: candidate, changedNodeIndices };
}
