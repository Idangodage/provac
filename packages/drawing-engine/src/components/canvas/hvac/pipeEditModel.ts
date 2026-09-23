import type { HvacElement } from '../../../types';

import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import { solveAdaptivePipeEdit, type AdaptiveTerminal } from './pipeAdaptiveSolver';
import { designRouteNodes, designWithNodePositions, insertDesignJoint, readPipeDesign, readPipeRouteNodes,
  readPipeSegmentMaterials, removeDesignJoint, writePipeDesign,
  type PipeDesign, type PipeTopologyResult } from './pipeDesignModel';
import {
  applyPipeRouteEdit,
  getPipeEditSelectionIndices,
  pipeEditVectorToWorld,
  type PipeEditFrame,
  type PipeEditPortConstraint,
  type PipeRouteEditOperation,
  type PipeEditSelection,
} from './pipeEditGeometry';
import { analysePipeCornerFittings, analysePipeEnvironment, type PipeEnvironment } from './pipeEnvironment';
import { solvePipeOrientation } from './pipeOrientationSolver';
import { readPipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import { resolvePipeRuleContext, type PipeAdaptation, type PipeRuleContext } from './pipeRuleModel';
import { buildPipeSkeleton, normalizeVector, refreshPipeSkeleton, type PipeSkeleton } from './pipeSkeleton';
import {
  buildRefrigerantPipePairVisual, buildRefrigerantPipePhysicalPath,
  resolveRefrigerantPipePairSpec, resolveRefrigerantPipeSpec,
  type RefrigerantPipeMaterial,
} from './refrigerantPipePairModel';

export const isEditablePipe = (element: HvacElement) =>
  element.type === 'refrigerant-pipe' || element.type === 'refrigerant-pipe-pair';

/**
 * The pipe's 3D route.
 *
 * Delegates to the canonical design model so there is exactly one definition of
 * "element to geometry". Behaviour is unchanged: a stored 3D route wins, and a
 * plan-only route is still flattened onto the connection elevation here — the
 * repair for that lives in {@link readPipeDesign}, which is what the adaptive
 * paths read.
 */
export function editablePipeNodes(element: HvacElement): PipeRouteNode3D[] {
  return readPipeRouteNodes(element);
}

/** Canonical segment ownership, including risers missing from a legacy XY route. */
export function editablePipeMaterials(element: HvacElement,
  nodes = editablePipeNodes(element)): RefrigerantPipeMaterial[] {
  return readPipeSegmentMaterials(element, nodes);
}

function connections(element: HvacElement) {
  const properties = element.properties;
  return element.type === 'refrigerant-pipe-pair'
    ? [properties.startBundleConnection, properties.endBundleConnection]
    : [properties.startConnection, properties.endConnection];
}

function sourceId(connection: unknown): string | undefined {
  if (!connection || typeof connection !== 'object') return undefined;
  const id = (connection as Record<string, unknown>).sourceElementId;
  return typeof id === 'string' ? id : undefined;
}

const distance = (a: PipeRouteNode3D, b: PipeRouteNode3D) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function turnAngle(nodes: readonly PipeRouteNode3D[], index: number): number {
  const a = nodes[index - 1]; const b = nodes[index]; const c = nodes[index + 1];
  if (!a || !b || !c) return 0;
  const lengths = distance(a, b) * distance(b, c);
  if (lengths <= 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1,
    ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) + (b.z - a.z) * (c.z - b.z)) / lengths)));
}

/** Generated physical bends contain short arc chords, not separate fittings. */
function isSampledBendNode(nodes: readonly PipeRouteNode3D[], index: number): boolean {
  if (index <= 0 || index >= nodes.length - 1) return false;
  const angle = turnAngle(nodes, index);
  if (angle < 1e-5 || angle > Math.PI / 8) return false;
  if (Math.min(distance(nodes[index - 1]!, nodes[index]!), distance(nodes[index]!, nodes[index + 1]!)) > 12) return false;
  return [index - 1, index + 1].some(neighbor => {
    const neighborAngle = turnAngle(nodes, neighbor);
    return neighborAngle > 1e-5 && neighborAngle < Math.PI / 8;
  });
}

interface EditBendCircle { center: PipeRouteNode3D; normal: PipeRouteNode3D; radius: number }

const editSubtract = (a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D =>
  ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const editCross = (a: PipeRouteNode3D, b: PipeRouteNode3D): PipeRouteNode3D =>
  ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const editDot = (a: PipeRouteNode3D, b: PipeRouteNode3D) => a.x * b.x + a.y * b.y + a.z * b.z;

/** A local circle is evidence of tessellation only when several neighbours agree. */
function editBendCircle(nodes: readonly PipeRouteNode3D[], index: number): EditBendCircle | null {
  if (index <= 0 || index >= nodes.length - 1) return null;
  const angle = turnAngle(nodes, index);
  if (angle < 1e-5 || angle > Math.PI / 8 + 1e-6) return null;
  const a = nodes[index - 1]!;
  const u = editSubtract(nodes[index]!, a); const v = editSubtract(nodes[index + 1]!, a);
  const cross = editCross(u, v); const normal = normalizeVector(cross);
  if (!normal) return null;
  const denominator = 2 * editDot(cross, cross);
  const first = editCross(v, cross); const second = editCross(cross, u);
  const uu = editDot(u, u); const vv = editDot(v, v);
  const center = {
    x: a.x + (first.x * uu + second.x * vv) / denominator,
    y: a.y + (first.y * uu + second.y * vv) / denominator,
    z: a.z + (first.z * uu + second.z * vv) / denominator,
  };
  return { center, normal, radius: distance(center, a) };
}

/** Match curvature in model space, independently of diameter, zoom or bend plane. */
function sameEditBendCircle(a: EditBendCircle, b: EditBendCircle): boolean {
  const toleranceMm = Math.max(0.002, Math.min(a.radius, b.radius) * 1e-5);
  return distance(a.center, b.center) <= toleranceMm
    && Math.abs(a.radius - b.radius) <= toleranceMm && editDot(a.normal, b.normal) > 1 - 1e-6;
}

/**
 * Recognize complete circular sample runs, including their tangent boundaries.
 * A fixed chord-length limit leaks handles on larger pipes and the inflection
 * between two socket-gather bends. Fitting validation deliberately retains its
 * separate, conservative preservation check; this only chooses UI controls.
 */
function editBendSegments(nodes: readonly PipeRouteNode3D[]): Array<EditBendCircle | null> {
  const circles = nodes.map((_, index) => editBendCircle(nodes, index));
  const segments: Array<EditBendCircle | null> = nodes.slice(1).map(() => null);
  for (let start = 1; start < nodes.length - 1;) {
    const circle = circles[start];
    if (!circle) { start++; continue; }
    let end = start;
    while (end + 1 < nodes.length - 1 && circles[end + 1]
      && sameEditBendCircle(circle, circles[end + 1]!)) end++;
    // Four chords / five points distinguish a sampled bend from isolated
    // authored changes of direction or a short dogleg.
    if (end - start >= 2) {
      for (let index = start - 1; index <= end; index++) segments[index] = circle;
    }
    start = end + 1;
  }
  return segments;
}

/** Keep fabrication tessellation out of controls without changing route indices or geometry. */
export function pipeEditControlIndices(element: HvacElement): { nodes: number[]; segments: number[] } {
  const nodes = editablePipeNodes(element);
  const all = { nodes: nodes.map((_, index) => index), segments: nodes.slice(1).map((_, index) => index) };
  // A matching persisted design explicitly identifies these as authored joints.
  // Stale metadata must not override the current fabrication geometry.
  if (element.properties.pipeDesign) {
    const design = readPipeDesign(element);
    if (design.provenance === 'authored' && design.nodes.length === nodes.length
      && design.nodes.every((node, index) => distance(node, nodes[index]!) < 0.001)) return all;
  }
  const bendSegments = editBendSegments(nodes);
  const materials = editablePipeMaterials(element, nodes);
  const tangent = (segment: number, node: PipeRouteNode3D) => {
    const circle = bendSegments[segment];
    return normalizeVector(circle
      ? editCross(circle.normal, editSubtract(node, circle.center))
      : editSubtract(nodes[segment + 1]!, nodes[segment]!));
  };
  return {
    nodes: all.nodes.filter(index => {
      if (index === 0 || index === nodes.length - 1
        || materials[index - 1] !== materials[index]
        || (!bendSegments[index - 1] && !bendSegments[index])) return true;
      const incoming = tangent(index - 1, nodes[index]!); const outgoing = tangent(index, nodes[index]!);
      // Retain an actual corner where an arc meets a non-tangent leg or bend.
      return !incoming || !outgoing || editDot(incoming, outgoing) < 1 - 1e-8;
    }),
    segments: all.segments.filter(index => !bendSegments[index]),
  };
}

function preservesSampledBend(nodes: readonly PipeRouteNode3D[], index: number,
  original: readonly PipeRouteNode3D[]): boolean {
  const originalIndex = original.length === nodes.length ? index
    : original.findIndex(point => distance(point, nodes[index]!) < 0.001);
  if (!isSampledBendNode(original, originalIndex)
    || Math.abs(turnAngle(nodes, index) - turnAngle(original, originalIndex)) > 1e-5) return false;
  for (const neighbor of [-1, 1]) {
    const before = distance(original[originalIndex]!, original[originalIndex + neighbor]!);
    const after = distance(nodes[index]!, nodes[index + neighbor]!);
    // Long adjoining straight sections may extend; the physical arc chords keep
    // their dimensions. New turns still take the ordinary fitting checks below.
    if (before <= 12 && Math.abs(before - after) > 0.001) return false;
  }
  return true;
}

/** Traverse explicit pipe relationships only. Equipment and kits are fixed boundaries. */
export function connectedPipeIds(elementId: string, elements: readonly HvacElement[]): string[] {
  const pipes = elements.filter(isEditablePipe);
  const pipeIds = new Set(pipes.map(pipe => pipe.id));
  const adjacency = new Map<string, string[]>();
  for (const pipe of pipes) {
    for (const connection of connections(pipe)) {
      const target = sourceId(connection);
      if (!target || !pipeIds.has(target)) continue;
      const sourceNeighbors = adjacency.get(pipe.id) ?? [];
      sourceNeighbors.push(target); adjacency.set(pipe.id, sourceNeighbors);
      const targetNeighbors = adjacency.get(target) ?? [];
      targetNeighbors.push(pipe.id); adjacency.set(target, targetNeighbors);
    }
  }
  const ids = new Set([elementId]);
  const pending = [elementId];
  for (let index = 0; index < pending.length; index++) {
    for (const neighbor of adjacency.get(pending[index]!) ?? []) {
      if (ids.has(neighbor)) continue;
      ids.add(neighbor); pending.push(neighbor);
    }
  }
  return [...ids];
}

/** Preserve attachment even for legacy one-sided connection records. */
function protectedTerminals(element: HvacElement, elements: readonly HvacElement[], movingIds: Set<string>,
  nodes = editablePipeNodes(element)) {
  const result = connections(element).map(connection => Boolean(connection) && !movingIds.has(sourceId(connection) ?? ''));
  const ports: PipeEditPortConstraint[] = [];
  // A fixed endpoint also has a physical direction. Do not bless an already
  // misaligned connection merely because its existing route tangent is unchanged.
  if (element.type === 'refrigerant-pipe') connections(element).forEach((raw, index) => {
    if (!result[index] || !raw || typeof raw !== 'object') return;
    const connection = raw as Record<string, unknown>;
    const point = connection.portPoint as { x: number; y: number } | undefined;
    const direction = connection.direction as { x: number; y: number } | undefined;
    if (point && direction && typeof connection.elevationMm === 'number') {
      ports.push({ endpoint: index === 0 ? 'start' : 'end',
        position: { ...point, z: connection.elevationMm }, direction: { ...direction, z: 0 } });
    }
  });
  for (const other of elements) {
    if (movingIds.has(other.id) || !isEditablePipe(other)) continue;
    connections(other).forEach((connection, index) => {
      if (sourceId(connection) !== element.id) return;
      const otherNodes = editablePipeNodes(other);
      const point = index === 0 ? otherNodes[0] : otherNodes.at(-1);
      if (!point) return;
      if (nodes[0] && distance(point, nodes[0]) < 1) result[0] = true;
      if (nodes.at(-1) && distance(point, nodes.at(-1)!) < 1) result[1] = true;
    });
  }
  return { protectStart: result[0] ?? false, protectEnd: result[1] ?? false, ports };
}

/** Check intrinsic 3D turn angles and fitting takeoffs, independently of camera/plan projection. */
export function validatePipeBendSpace(element: HvacElement, nodes: readonly PipeRouteNode3D[],
  originalNodes: readonly PipeRouteNode3D[] = []): string | null {
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const materials = editablePipeMaterials(element, [...nodes]);
  const takeoffs = nodes.map(() => 0);
  const turnBoundaries = nodes.map(() => false);
  const socketElbows = usesCopperSocketElbows(element.properties);
  const requiredRadius = resolveCopperSocketElbowMinimumRadius(element.properties);
  const fieldRadius = resolveFieldPipeBendRadiusMm(spec.outerDiameterMm, element.properties.bendRadiusFactor);
  const minimumPortStub = getActivePipeRoutingSettings().minimumPortStubMm;
  for (let index = 1; index < nodes.length - 1; index++) {
    const a = nodes[index - 1]!; const b = nodes[index]!; const c = nodes[index + 1]!;
    const before = distance(a, b); const after = distance(b, c);
    if (before <= 0.001 || after <= 0.001) return 'A route segment is too short.';
    const cosine = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) + (b.z - a.z) * (c.z - b.z)) / before / after;
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    if (angle < 1e-5) continue;
    if (angle > Math.PI - 1e-5) return `Point ${index + 1} reverses the pipe direction without a valid return bend.`;
    turnBoundaries[index] = true;
    if (preservesSampledBend(nodes, index, originalNodes)) continue;
    const degrees = angle * 180 / Math.PI;
    const standard = Math.abs(degrees - 90) < 0.01 ? 90 : Math.abs(degrees - 45) < 0.01 ? 45 : null;
    if (!standard && (materials[index - 1] === 'hard' || materials[index] === 'hard')) {
      return `Point ${index + 1} requires a ${degrees.toFixed(1)}° fitting. Hard pipe supports 45° or 90° turns.`;
    }
    const elbow = standard && socketElbows
      ? resolveCopperSocketElbow(spec.pipeDiameterMm, standard) : null;
    takeoffs[index] = Math.max(requiredRadius * Math.tan(angle / 2), elbow?.centerToFaceMm
      ?? fieldRadius * Math.tan(angle / 2));
  }
  let spanStart = 0;
  let spanLength = 0;
  for (let index = 1; index < nodes.length; index++) {
    spanLength += distance(nodes[index - 1]!, nodes[index]!);
    if (!turnBoundaries[index] && index < nodes.length - 1) continue;
    const startStraight = spanStart === 0 && spec.startConnection?.connectionKind === 'unit-port' ? minimumPortStub : 0;
    const endStraight = index === nodes.length - 1 && spec.endConnection?.connectionKind === 'unit-port' ? minimumPortStub : 0;
    if (takeoffs[spanStart]! + takeoffs[index]! + startStraight + endStraight > spanLength + 0.001) {
      return `Segment ${spanStart + 1} is too short for the specified bend radius, fitting sockets or equipment approach. Extend the adjoining straight sections.`;
    }
    spanStart = index;
    spanLength = 0;
  }
  return null;
}

export function pipeWithEditedNodes(element: HvacElement, nodes: readonly PipeRouteNode3D[]): HvacElement {
  const routePoints = nodes.map(({ x, y }) => ({ x, y }));
  const outerDiameter = element.type === 'refrigerant-pipe-pair'
    ? Math.max(resolveRefrigerantPipePairSpec(element.properties).gasOuterDiameterMm, resolveRefrigerantPipePairSpec(element.properties).liquidOuterDiameterMm)
    : resolveRefrigerantPipeSpec(element.properties).outerDiameterMm;
  const minZ = Math.min(...nodes.map(node => node.z));
  const maxZ = Math.max(...nodes.map(node => node.z));
  const next: HvacElement = { ...element, elevation: minZ - outerDiameter / 2,
    height: Math.max(outerDiameter, maxZ - minZ + outerDiameter), properties: {
    ...element.properties, routePoints, routeNodes3d: nodes.map(node => ({ ...node })),
    centerline_start: routePoints[0], centerline_end: routePoints.at(-1),
    networkLevelPlan: undefined,
  } };
  const visual = element.type === 'refrigerant-pipe-pair'
    ? buildRefrigerantPipePairVisual(next) : buildRefrigerantPipePhysicalPath(next);
  return { ...next, position: { x: visual.bounds.minX, y: visual.bounds.minY }, width: visual.bounds.width, depth: visual.bounds.height };
}

export interface PipeModelEditRequest {
  elementId: string;
  elements: readonly HvacElement[];
  selection: PipeEditSelection;
  operation: PipeRouteEditOperation;
  frame: PipeEditFrame;
  connected?: boolean;
  selectedIds?: readonly string[];
  /**
   * 'adaptive' lets a whole-run translation RE-MAKE what the pipe is tied to —
   * generating the offset or riser a fixed port needs and swivelling a branch
   * kit to keep facing the run — instead of rigidly translating and failing the
   * port check. Defaults to the historic rigid behaviour.
   */
  mode?: 'rigid' | 'adaptive';
}
export type PipeModelEditResult =
  | { ok: true; elements: HvacElement[]; adaptations?: PipeAdaptation[]; clampedTo?: string }
  | { ok: false; message: string };

/** Final guard for legacy plan editors which already construct an entire route. */
export function validatePipeModelReplacement(before: HvacElement, after: HvacElement,
  elements: readonly HvacElement[], movingIds: readonly string[] = []): string | null {
  const original = editablePipeNodes(before); const nodes = editablePipeNodes(after);
  const protection = protectedTerminals(before, elements, new Set(movingIds), original);
  const ports = [...protection.ports];
  const direction = (index: number, neighbor: number) => ({ x: original[neighbor]!.x - original[index]!.x,
    y: original[neighbor]!.y - original[index]!.y, z: original[neighbor]!.z - original[index]!.z });
  if (original.length < 2) return 'The original pipe has no valid route.';
  if (protection.protectStart) ports.push({ endpoint: 'start', position: original[0]!, direction: direction(0, 1) });
  if (protection.protectEnd) ports.push({ endpoint: 'end', position: original.at(-1)!, direction: direction(original.length - 1, original.length - 2) });
  const result = applyPipeRouteEdit({ nodes, selection: { kind: 'run' }, operation: { kind: 'translate', offset: { x: 0, y: 0, z: 0 } },
    constraints: { ports, locked: ['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed'].some(key => before.properties[key] === true) } });
  return result.ok ? validatePipeBendSpace(after, nodes, original) : result.error.message;
}

export function buildPipeModelEdit(request: PipeModelEditRequest): PipeModelEditResult {
  const primary = request.elements.find(element => element.id === request.elementId);
  if (!primary || !isEditablePipe(primary)) return { ok: false, message: 'Select an editable refrigerant pipe.' };
  // A whole-run translation is the one operation whose whole point is that the
  // surroundings must give way. Route it through the solver so the fittings the
  // move needs are generated rather than the move being refused.
  // Rotation is an ORIENTATION edit, not a rigid transform to be vetoed. Route
  // it through the orientation solver so a fitting can be re-aimed while its
  // included angle and radius stay exactly what was purchased.
  if (request.mode === 'adaptive' && request.operation.kind === 'rotate'
    && !request.connected && (request.selectedIds?.length ?? 0) <= 1) {
    return buildAdaptivePipeRotation(request, primary);
  }
  if (request.mode === 'adaptive' && request.operation.kind === 'translate'
    && request.selection.kind === 'run' && !request.connected
    && (request.selectedIds?.length ?? 0) <= 1) {
    const outcome = buildAdaptivePipeEdit({
      elementId: request.elementId, elements: request.elements,
      goal: { kind: 'move-run', offset: pipeEditVectorToWorld(request.operation.offset, request.frame) },
    });
    return outcome.ok
      ? { ok: true, elements: [outcome.element, ...outcome.elementUpdates],
          adaptations: outcome.adaptations, ...(outcome.clampedTo ? { clampedTo: outcome.clampedTo } : {}) }
      : { ok: false, message: `${primary.label || 'Pipe'}: ${outcome.message}` };
  }
  const ids = new Set(request.connected ? connectedPipeIds(primary.id, request.elements) : request.selectedIds?.length ? request.selectedIds : [primary.id]);
  if (!ids.has(primary.id) || [...ids].some(id => !request.elements.some(element => element.id === id && isEditablePipe(element)))) {
    return { ok: false, message: 'The selected pipe group has changed. Select the runs again.' };
  }
  const rigidGroup = request.connected || ids.size > 1;
  if (rigidGroup && !['translate', 'rotate'].includes(request.operation.kind)) {
    return { ok: false, message: 'Connected sections support rigid movement and rotation. Select a point to reshape one route.' };
  }
  let operation = request.operation;
  if (operation.kind === 'rotate' && typeof operation.pivot === 'string') {
    const nodes = editablePipeNodes(primary);
    const indices = getPipeEditSelectionIndices(nodes, rigidGroup ? { kind: 'run' } : request.selection);
    const pivot = nodes[operation.pivot === 'start' ? indices[0]! : indices.at(-1)!];
    if (!pivot) return { ok: false, message: 'The selected pivot is unavailable.' };
    operation = { ...operation, pivot };
  }
  const edited: HvacElement[] = [];
  for (const element of request.elements) {
    if (!ids.has(element.id)) continue;
    const locked = ['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed']
      .some(key => element.properties[key] === true);
    const nodes = editablePipeNodes(element);
    const result = applyPipeRouteEdit({ nodes, selection: rigidGroup ? { kind: 'run' } : request.selection,
      operation, frame: request.frame, constraints: { locked, preserveAdjacentDirections: true,
        ...protectedTerminals(element, request.elements, ids, nodes) } });
    if (!result.ok) return { ok: false, message: `${element.label || 'Pipe'}: ${result.error.message}` };
    const materials = editablePipeMaterials(element, nodes);
    if (operation.kind === 'insert' && request.selection.kind === 'segment') materials.splice(request.selection.index, 0, materials[request.selection.index] ?? 'flexible');
    if (operation.kind === 'remove' && request.selection.kind === 'node') {
      const index = request.selection.index;
      if (materials[index - 1] !== materials[index]) return { ok: false, message: 'This point separates different pipe materials. Match the materials before removing it.' };
      materials.splice(index, 1);
    }
    const materialElement = { ...element, properties: { ...element.properties,
      routePoints: result.nodes.map(({ x, y }) => ({ x, y })), segmentMaterials: materials } };
    const conflict = validatePipeBendSpace(materialElement, result.nodes, nodes);
    if (conflict) return { ok: false, message: conflict };
    // Rebuild visual bounds only after moved connection records are transformed.
    const next: HvacElement = { ...materialElement, properties: { ...materialElement.properties,
      routeNodes3d: result.nodes.map(node => ({ ...node })) } };
    edited.push(next);
  }
  // Connection records follow rigidly moved neighbours. Never flatten a rotated port direction.
  for (const next of edited) {
    const original = request.elements.find(element => element.id === next.id)!;
    const keys = next.type === 'refrigerant-pipe-pair' ? ['startBundleConnection', 'endBundleConnection'] : ['startConnection', 'endConnection'];
    for (const key of keys) {
      const record = original.properties[key];
      if (!record || typeof record !== 'object' || !ids.has(sourceId(record) ?? '')) continue;
      const connection = { ...(record as Record<string, unknown>) };
      const transformPoint = (point: PipeRouteNode3D) => {
        const result = applyPipeRouteEdit({ nodes: [point, { x: point.x + 100, y: point.y, z: point.z }],
          selection: { kind: 'run' }, operation, frame: request.frame });
        return result.ok ? result.nodes[0]! : point;
      };
      const endpoint = key.startsWith('start') ? editablePipeNodes(original)[0]! : editablePipeNodes(original).at(-1)!;
      const elevation = typeof connection.elevationMm === 'number' ? connection.elevationMm : endpoint.z;
      const elevations = new Map<string, number>();
      for (const pointKey of ['portPoint', 'point', 'gasPoint', 'liquidPoint', 'gasFieldPoint', 'liquidFieldPoint']) {
        const point = connection[pointKey] as { x: number; y: number } | undefined;
        if (!point) continue;
        const elevationKey = pointKey.startsWith('gas') ? 'gasElevationMm' : pointKey.startsWith('liquid') ? 'liquidElevationMm' : 'elevationMm';
        const pointElevation = typeof connection[elevationKey] === 'number' ? connection[elevationKey] as number : elevation;
        const transformed = transformPoint({ ...point, z: pointElevation });
        const previousElevation = elevations.get(elevationKey);
        if (previousElevation !== undefined && Math.abs(previousElevation - transformed.z) > 0.01) {
          return { ok: false, message: 'This connection cannot represent different elevations along one port approach. Preserve its axis or adjust the adjoining route first.' };
        }
        connection[pointKey] = { x: transformed.x, y: transformed.y };
        elevations.set(elevationKey, transformed.z);
      }
      for (const [key, value] of elevations) connection[key] = value;
      for (const directionKey of ['direction', 'gasDirection', 'liquidDirection']) {
        const direction = connection[directionKey] as { x: number; y: number } | undefined;
        if (!direction) continue;
        const origin = transformPoint({ x: 0, y: 0, z: 0 });
        const tip = transformPoint({ ...direction, z: 0 });
        if (Math.abs(tip.z - origin.z) > 1e-6) return { ok: false, message: 'This connected port cannot represent a tilted direction. Keep its axis horizontal or edit the adjoining route while preserving the connection.' };
        connection[directionKey] = { x: tip.x - origin.x, y: tip.y - origin.y };
      }
      next.properties[key] = connection;
    }
  }
  return { ok: true, elements: edited.map(element => pipeWithEditedNodes(element, editablePipeNodes(element))) };
}

// ---------------------------------------------------------------------------
// Adaptive editing
//
// Everything above treats a drag as a rigid transform to be validated, so an
// edit that needs a bend to change angle, a bend to change plane, or a straight
// to change length is refused. The functions below treat the drag as a GOAL:
// the design skeleton is recovered from the fabrication polyline, the move is
// re-solved against it, and every rule that had to be relaxed is reported.
// ---------------------------------------------------------------------------

/** Centreline elevation each end is welded at, when the record carries one. */
function terminalElevations(element: HvacElement): { startZ: number | null; endZ: number | null } {
  const read = (raw: unknown): number | null => {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.elevationMm === 'number') return record.elevationMm;
    // A bundle lands its two lanes at different heights; the pair centreline
    // sits between them, exactly as editablePipeNodes derives it.
    const gas = record.gasElevationMm;
    const liquid = record.liquidElevationMm;
    return typeof gas === 'number' && typeof liquid === 'number' ? (gas + liquid) / 2 : null;
  };
  const pair = element.type === 'refrigerant-pipe-pair';
  return {
    startZ: read(pair ? element.properties.startBundleConnection : element.properties.startConnection),
    endZ: read(pair ? element.properties.endBundleConnection : element.properties.endConnection),
  };
}

/**
 * Give a legacy plan-only route its missing riser.
 *
 * A pipe stored without `routeNodes3d` has no elevation information beyond its
 * two connection records, so `editablePipeNodes` flattens every node onto the
 * START elevation. When the two ends are welded at different heights that route
 * cannot reach its own end port, and EVERY edit is refused with "the end
 * connection must remain fixed" — by a whole elevation delta, before the user
 * has changed anything.
 *
 * The fix is a real riser, not an interpolation: a linear ramp along the run
 * would turn every corner into a compound angle and break the hard-pipe fitting
 * checks. The run stays at the start elevation and drops vertically at the
 * corner feeding the terminal stub, so the port approach stays straight and
 * horizontal, which is what the connection record actually requires.
 */
function withTerminalRiser(element: HvacElement, nodes: readonly PipeRouteNode3D[],
  materials: readonly RefrigerantPipeMaterial[]): { nodes: PipeRouteNode3D[]; materials: RefrigerantPipeMaterial[] } {
  const plain = { nodes: nodes.map(node => ({ ...node })), materials: [...materials] };
  if (readPipeRouteNodes3d(element).length >= 2 || nodes.length < 3) return plain;
  const { startZ, endZ } = terminalElevations(element);
  if (startZ === null || endZ === null || Math.abs(startZ - endZ) < 0.5) return plain;
  const corner = nodes[nodes.length - 2]!;
  return {
    nodes: [
      ...plain.nodes.slice(0, -1),
      { x: corner.x, y: corner.y, z: endZ },
      { ...plain.nodes[plain.nodes.length - 1]!, z: endZ },
    ],
    // The riser inherits the terminal stub's material: it is the same physical
    // drop into the unit, and the stricter constraint is the safe default.
    materials: [...plain.materials.slice(0, -1), plain.materials.at(-1) ?? 'flexible', plain.materials.at(-1) ?? 'flexible'],
  };
}

/** The design skeleton (sharp corners, joints, legs) behind a stored route. */
export function pipeDesignSkeleton(element: HvacElement): PipeSkeleton {
  const nodes = editablePipeNodes(element);
  const defaultBendRadiusMm = resolveFieldPipeBendRadiusMm(
    resolveRefrigerantPipeSpec(element.properties).outerDiameterMm,
    element.properties.bendRadiusFactor,
  );
  const flat = buildPipeSkeleton(nodes, {
    materials: editablePipeMaterials(element, nodes),
    defaultBendRadiusMm,
  });
  // Lift AFTER decimation so the riser lands on a design corner rather than
  // inside sampled arc tessellation.
  const lifted = withTerminalRiser(element, flat.nodes, flat.legs.map(leg => leg.material));
  if (lifted.nodes.length === flat.nodes.length) return flat;
  // Keep the flag describing the STORED route, which is what callers ask about;
  // the second build runs on corners that are already sharp.
  return { ...buildPipeSkeleton(lifted.nodes, { materials: lifted.materials, defaultBendRadiusMm }),
    decimated: flat.decimated };
}

const planDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Design corner nearest a plan point — handles are placed against the render. */
export function nearestSkeletonNodeIndex(skeleton: PipeSkeleton, point: { x: number; y: number }): number {
  let best = 0;
  let bestDistance = Infinity;
  skeleton.nodes.forEach((node, index) => {
    const separation = planDistance(node, point);
    if (separation < bestDistance) { best = index; bestDistance = separation; }
  });
  return best;
}

/** Design leg whose plan midpoint is nearest a plan point. */
export function nearestSkeletonLegIndex(skeleton: PipeSkeleton, point: { x: number; y: number }): number {
  let best = 0;
  let bestDistance = Infinity;
  skeleton.legs.forEach((leg, index) => {
    const start = skeleton.nodes[index]!;
    const end = skeleton.nodes[index + 1]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const squared = dx * dx + dy * dy;
    const fraction = squared > 1e-9
      ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squared)) : 0;
    const separation = Math.hypot(point.x - start.x - fraction * dx, point.y - start.y - fraction * dy);
    if (separation < bestDistance) { best = leg.index; bestDistance = separation; }
  });
  return best;
}

export type AdaptivePipeGoal =
  | { kind: 'move-node'; nodeIndex: number; target: PipeRouteNode3D }
  | { kind: 'move-leg'; legIndex: number; offset: PipeRouteNode3D }
  /** Translate the whole run; whatever it stays tied to is re-made around it. */
  | { kind: 'move-run'; offset: PipeRouteNode3D };

export type AdaptivePipeEditOutcome =
  | {
      ok: true;
      element: HvacElement;
      nodes: PipeRouteNode3D[];
      adaptations: PipeAdaptation[];
      clampedTo?: string;
      /** What the pipe is attached to and what its corners are made of. */
      environment: PipeEnvironment;
      /** Other elements the edit had to change — a rolled branch kit, say. */
      elementUpdates: HvacElement[];
    }
  | { ok: false; message: string };

/**
 * Terminal constraints for the solver.
 *
 * A protected end keeps BOTH its position and the direction the route leaves it
 * along; where a real port record exists its published direction wins over the
 * route's current tangent, so an already-misaligned route is not blessed.
 */
function adaptiveTerminals(element: HvacElement, elements: readonly HvacElement[],
  skeleton: PipeSkeleton): { start: AdaptiveTerminal; end: AdaptiveTerminal } {
  const nodes = editablePipeNodes(element);
  const protection = protectedTerminals(element, elements, new Set(), nodes);
  const terminalFor = (endpoint: 'start' | 'end'): AdaptiveTerminal => {
    const protectedEnd = endpoint === 'start' ? protection.protectStart : protection.protectEnd;
    const port = protection.ports.find(candidate => candidate.endpoint === endpoint);
    if (!protectedEnd && !port) return { position: null, direction: null };
    const anchor = endpoint === 'start' ? skeleton.nodes[0]! : skeleton.nodes[skeleton.nodes.length - 1]!;
    const neighbour = endpoint === 'start' ? skeleton.nodes[1] : skeleton.nodes[skeleton.nodes.length - 2];
    return {
      // The position that must hold is where the route actually lands today; a
      // port record's own point can differ by the socket insertion depth.
      position: anchor,
      direction: port?.direction ?? (neighbour
        ? { x: neighbour.x - anchor.x, y: neighbour.y - anchor.y, z: neighbour.z - anchor.z }
        : null),
    };
  };
  return { start: terminalFor('start'), end: terminalFor('end') };
}

/**
 * Re-solve one pipe around a dragged corner or leg.
 *
 * Returns the updated element together with the concessions the move spent, or
 * the single hard constraint that refused it. The result is re-checked through
 * {@link validatePipeBendSpace} before it is returned, so an adaptive edit can
 * never commit geometry the rest of the application would reject.
 */
export function buildAdaptivePipeEdit(input: {
  elementId: string;
  elements: readonly HvacElement[];
  goal: AdaptivePipeGoal;
  pinnedJoints?: readonly number[];
}): AdaptivePipeEditOutcome {
  const element = input.elements.find(candidate => candidate.id === input.elementId);
  if (!element || !isEditablePipe(element)) return { ok: false, message: 'Select an editable refrigerant pipe.' };
  if (['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed']
    .some(key => element.properties[key] === true)) {
    return { ok: false, message: 'This pipe is locked. Unlock it before editing.' };
  }

  const skeleton = pipeDesignSkeleton(element);
  if (skeleton.nodes.length < 2) return { ok: false, message: 'The original pipe has no valid route.' };

  const context = resolvePipeRuleContext(element);
  const environment = analysePipeEnvironment(element, input.elements, skeleton, context);
  const solved = solveAdaptivePipeEdit({
    skeleton,
    context,
    goal: input.goal.kind === 'move-node'
      ? { kind: 'move-node', index: input.goal.nodeIndex, target: input.goal.target }
      : input.goal.kind === 'move-leg'
        ? { kind: 'move-leg', index: input.goal.legIndex, offset: input.goal.offset }
        : { kind: 'move-run', offset: input.goal.offset },
    terminals: adaptiveTerminals(element, input.elements, skeleton),
    ...(input.pinnedJoints ? { pinnedJoints: input.pinnedJoints } : {}),
  });
  if (!solved.ok) return { ok: false, message: solved.message };

  const materials = skeleton.legs.map((leg, index) => solved.materials.get(index) ?? leg.material);
  const materialElement: HvacElement = {
    ...element,
    properties: {
      ...element.properties,
      routePoints: solved.nodes.map(({ x, y }) => ({ x, y })),
      segmentMaterials: materials,
    },
  };
  // The route is now design corners, not fabrication chords, so the sampled-bend
  // exemption has nothing to protect: validate against the rules directly.
  //
  // Held to the standard the route ARRIVED with. A generated route's own design
  // corners often already fail this check (a port stub that is exactly the
  // reserve, with the first fitting's takeoff inside it), and refusing an edit
  // for a fault it did not introduce is what makes generated pipes uneditable.
  // The guarantee kept here is the one that matters: a compliant route can
  // never be edited into a non-compliant one.
  const baselineElement: HvacElement = {
    ...element,
    properties: {
      ...element.properties,
      routePoints: skeleton.nodes.map(({ x, y }) => ({ x, y })),
      segmentMaterials: skeleton.legs.map(leg => leg.material),
    },
  };
  const conflict = validatePipeBendSpace(materialElement, solved.nodes, []);
  if (conflict && !validatePipeBendSpace(baselineElement, skeleton.nodes, [])) {
    return { ok: false, message: conflict };
  }

  // The corners are now different shapes; say which catalogue parts changed.
  const refits = describeElbowRefits(skeleton, solved.nodes, environment, context);
  // A branch kit at either end swivels about its joint to face the new approach.
  const kits = rotateAttachedBranchKits(environment, solved.nodes, input.elements);

  return {
    ok: true,
    element: pipeWithEditedNodes(materialElement, solved.nodes),
    nodes: solved.nodes,
    adaptations: [...solved.adaptations, ...refits, ...kits.adaptations],
    ...(solved.clampedTo ? { clampedTo: solved.clampedTo } : {}),
    environment,
    elementUpdates: kits.elements,
  };
}

/**
 * Report every corner whose purchasable part changed.
 *
 * A turn that moves off a catalogue angle stops being a socket elbow, and a turn
 * that lands on the other catalogue angle becomes a different part number. Both
 * are bill-of-materials changes the drafter must see.
 */
function describeElbowRefits(before: PipeSkeleton, nodes: readonly PipeRouteNode3D[],
  environment: PipeEnvironment, context: PipeRuleContext): PipeAdaptation[] {
  if (nodes.length !== before.nodes.length) return [];
  const after = analysePipeCornerFittings(refreshPipeSkeleton(before, nodes), context);
  const adaptations: PipeAdaptation[] = [];
  for (const fitting of environment.fittings) {
    const next = after.find(candidate => candidate.jointIndex === fitting.jointIndex);
    if (!next) continue;
    const from = fitting.catalogue?.model ?? null;
    const to = next.catalogue?.model ?? null;
    if (from === to) continue;
    adaptations.push({ kind: 'refit-elbow', jointIndex: fitting.jointIndex,
      label: from && to ? `${from} → ${to}`
        : to ? `formed bend → ${to}` : `${from} → formed bend` });
  }
  return adaptations;
}

const planAngleDeg = (v: { x: number; y: number }) => Math.atan2(v.y, v.x) * 180 / Math.PI;

/**
 * Swivel a branch kit so its port keeps facing the pipe.
 *
 * The kit turns about the JOINT, not about its own centre, so the weld stays
 * exactly where it is and only the body swings — which is how a fitter would
 * actually re-orient it. Only a kit with no other pipe on it may be turned;
 * rolling a kit that feeds other runs would silently break those welds.
 */
function rotateAttachedBranchKits(environment: PipeEnvironment, nodes: readonly PipeRouteNode3D[],
  elements: readonly HvacElement[]): { elements: HvacElement[]; adaptations: PipeAdaptation[] } {
  const updates: HvacElement[] = [];
  const adaptations: PipeAdaptation[] = [];
  for (const endpoint of ['start', 'end'] as const) {
    const edge = environment[endpoint];
    if (edge.kind !== 'branch-kit' || edge.attachedPipeIds.length > 0 || !edge.direction) continue;
    const kit = elements.find(candidate => candidate.id === edge.elementId);
    if (!kit) continue;
    const joint = endpoint === 'start' ? nodes[0] : nodes[nodes.length - 1];
    const inward = endpoint === 'start' ? nodes[1] : nodes[nodes.length - 2];
    if (!joint || !inward) continue;
    const required = { x: inward.x - joint.x, y: inward.y - joint.y };
    if (Math.hypot(required.x, required.y) < 1) continue;
    let deltaDeg = planAngleDeg(required) - planAngleDeg(edge.direction);
    deltaDeg = ((deltaDeg + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(deltaDeg) < 1) continue;

    const radians = deltaDeg * Math.PI / 180;
    const centre = { x: kit.position.x + kit.width / 2, y: kit.position.y + kit.depth / 2 };
    const offset = { x: centre.x - joint.x, y: centre.y - joint.y };
    const turned = {
      x: joint.x + offset.x * Math.cos(radians) - offset.y * Math.sin(radians),
      y: joint.y + offset.x * Math.sin(radians) + offset.y * Math.cos(radians),
    };
    updates.push({ ...kit, rotation: (kit.rotation ?? 0) + deltaDeg,
      position: { x: turned.x - kit.width / 2, y: turned.y - kit.depth / 2 } });
    adaptations.push({ kind: 'rotate-fitting',
      label: `${edge.label} turned ${Math.abs(deltaDeg).toFixed(0)}° to face the run` });
  }
  return { elements: updates, adaptations };
}

/** One-line summary of what a move changed, for a status line or ribbon. */
export function summarizePipeAdaptations(adaptations: readonly PipeAdaptation[], clampedTo?: string): string | null {
  if (!adaptations.length) return clampedTo ? `Clamped to ${clampedTo}.` : null;
  const counts = new Map<PipeAdaptation['kind'], number>();
  for (const adaptation of adaptations) counts.set(adaptation.kind, (counts.get(adaptation.kind) ?? 0) + 1);
  const phrase = (kind: PipeAdaptation['kind'], singular: string, plural = `${singular}s`) => {
    const count = counts.get(kind) ?? 0;
    return count ? `${count} ${count === 1 ? singular : plural}` : null;
  };
  const parts = [
    phrase('insert-offset', 'offset added', 'offsets added'),
    phrase('insert-riser', 'riser added', 'risers added'),
    phrase('rotate-fitting', 'fitting turned', 'fittings turned'),
    phrase('re-angle-bend', 'bend re-angled', 'bends re-angled'),
    phrase('roll-bend-plane', 'bend rolled', 'bends rolled'),
    phrase('refit-elbow', 'elbow refitted', 'elbows refitted'),
    phrase('elbow-to-field-bend', 'elbow → field bend', 'elbows → field bends'),
    phrase('extend-leg', 'segment resized', 'segments resized'),
  ].filter((part): part is string => part !== null);
  return `${parts.join(', ')}${clampedTo ? `; clamped to ${clampedTo}` : ''}.`;
}


/**
 * Write a design back onto an element, including the visual bounds the element
 * model owns. `writePipeDesign` handles the semantic and legacy geometry; the
 * bounds come from the same visual builders every renderer uses.
 */
export function pipeWithEditedDesign(element: HvacElement, design: PipeDesign): HvacElement {
  const routed = writePipeDesign(element, design);
  return pipeWithEditedNodes(routed, designRouteNodes(design));
}

/**
 * Map a command-bar / gizmo rotation onto an orientation goal.
 *
 * The incoming operation is expressed in a coordinate FRAME (world, local to the
 * selected segment, or an explicit workplane). The frame is the caller's choice
 * of vocabulary; the solver works in model space, so the axis is resolved here
 * and the pivot is resolved to a real 3D point.
 *
 * A selection that names a single interior bend is a ROLL about that bend's own
 * incoming leg — the operation a fitter would call re-aiming the elbow. Anything
 * wider is a rigid rotation of that sub-chain about the requested pivot.
 */
function buildAdaptivePipeRotation(request: PipeModelEditRequest,
  primary: HvacElement): PipeModelEditResult {
  if (request.operation.kind !== 'rotate') return { ok: false, message: 'Not a rotation.' };
  const label = primary.label || 'Pipe';
  const design = readPipeDesign(primary, request.elements);
  if (design.nodes.length < 2) return { ok: false, message: `${label}: The original pipe has no valid route.` };

  const nodes = designRouteNodes(design);
  const indices = getPipeEditSelectionIndices(nodes, request.selection);
  if (!indices.length) return { ok: false, message: `${label}: Select valid route points or a segment.` };

  const frame = request.frame;
  const axis = request.operation.axis === 'x' ? frame.xAxis
    : request.operation.axis === 'y' ? frame.yAxis : frame.zAxis;

  const pivotSpec = request.operation.pivot;
  const pivot = typeof pivotSpec === 'string'
    ? nodes[pivotSpec === 'start' ? indices[0]! : indices[indices.length - 1]!]
    : pivotSpec;
  if (!pivot) return { ok: false, message: `${label}: The selected pivot is unavailable.` };

  // A single interior corner selection is a roll of that fitting.
  const selectedNodeIndex = request.selection.kind === 'node' ? request.selection.index : null;
  const rollJoint = selectedNodeIndex === null ? undefined
    : design.joints.find(joint => joint.nodeId === design.nodes[selectedNodeIndex]?.id);

  const solved = solvePipeOrientation({
    design,
    context: resolvePipeRuleContext(primary),
    goal: rollJoint
      ? { kind: 'roll-joint', jointId: rollJoint.id, angleDeg: request.operation.angleDegrees }
      : {
          kind: 'rotate-component',
          nodeIds: indices.map(index => design.nodes[index]!.id),
          pivot, axis, angleDeg: request.operation.angleDegrees,
        },
  });
  if (!solved.ok) return { ok: false, message: `${label}: ${solved.message}` };

  const moved = designWithNodePositions(design, solved.nodes);
  const element = pipeWithEditedDesign(primary, moved);

  // The same final guard a translation gets: a compliant route may never be
  // rotated into a non-compliant one, while a defect the route arrived with is
  // not blamed on this edit.
  const baselineClean = validatePipeBendSpace(
    pipeWithEditedDesign(primary, design), designRouteNodes(design), []) === null;
  const conflict = validatePipeBendSpace(element, solved.nodes, []);
  if (conflict && baselineClean) return { ok: false, message: `${label}: ${conflict}` };

  return {
    ok: true,
    elements: [element],
    adaptations: solved.adaptations,
    ...(solved.status === 'approximate'
      ? { clampedTo: solved.limitedBy ?? `${solved.achievedAngleDeg.toFixed(1)}° of ${solved.requestedAngleDeg.toFixed(1)}°` }
      : {}),
  };
}


/**
 * Insert or remove a bend, addressed by where the user pointed.
 *
 * The canvas handles are drawn against a RECONSTRUCTED view route, whose
 * indices do not match the stored polyline on a generated pipe, so the target
 * is resolved geometrically and then addressed by its stable identity. That is
 * also what makes the operation safe: the design model carries materials and
 * locks with the topology, where an array splice on `routePoints` carries
 * neither.
 */
export function buildPipeTopologyEdit(input: {
  elementId: string;
  elements: readonly HvacElement[];
  action: { kind: 'insert' | 'remove'; nearPoint: { x: number; y: number } };
}): AdaptivePipeEditOutcome {
  const element = input.elements.find(candidate => candidate.id === input.elementId);
  if (!element || !isEditablePipe(element)) return { ok: false, message: 'Select an editable refrigerant pipe.' };
  if (['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed']
    .some(key => element.properties[key] === true)) {
    return { ok: false, message: 'This pipe is locked. Unlock it before editing.' };
  }

  const design = readPipeDesign(element, input.elements);
  const label = element.label || 'Pipe';
  const point = input.action.nearPoint;

  let changed: PipeTopologyResult;
  if (input.action.kind === 'insert') {
    // Nearest leg by perpendicular plan distance, which is what the user aimed at.
    let bestId = design.legs[0]?.id;
    let bestDistance = Infinity;
    design.legs.forEach((leg, index) => {
      const a = design.nodes[index]!;
      const b = design.nodes[index + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const squared = dx * dx + dy * dy;
      const fraction = squared > 1e-9
        ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
      const separation = Math.hypot(point.x - a.x - fraction * dx, point.y - a.y - fraction * dy);
      if (separation < bestDistance) { bestDistance = separation; bestId = leg.id; }
    });
    if (!bestId) return { ok: false, message: `${label}: Select a straight segment.` };
    changed = insertDesignJoint(design, bestId);
  } else {
    let bestId: string | undefined;
    let bestDistance = Infinity;
    for (const joint of design.joints) {
      const node = design.nodes.find(candidate => candidate.id === joint.nodeId);
      if (!node) continue;
      const separation = Math.hypot(point.x - node.x, point.y - node.y);
      if (separation < bestDistance) { bestDistance = separation; bestId = joint.id; }
    }
    if (!bestId) return { ok: false, message: `${label}: This pipe has no removable bend.` };
    changed = removeDesignJoint(design, bestId);
  }
  if (!changed.ok) return { ok: false, message: `${label}: ${changed.message}` };

  const next = pipeWithEditedDesign(element, changed.design);
  // A topology change is held to the same standard as any other edit: it may
  // not introduce a fitting problem the route did not already have.
  const baselineClean = validatePipeBendSpace(
    pipeWithEditedDesign(element, design), designRouteNodes(design), []) === null;
  const conflict = validatePipeBendSpace(next, designRouteNodes(changed.design), []);
  if (conflict && baselineClean) return { ok: false, message: `${label}: ${conflict}` };

  return {
    ok: true,
    element: next,
    nodes: designRouteNodes(changed.design),
    adaptations: [],
    environment: analysePipeEnvironment(element, input.elements, pipeDesignSkeleton(element),
      resolvePipeRuleContext(element)),
    elementUpdates: [],
  };
}
