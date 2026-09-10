import type { HvacElement } from '../../../types';

import { resolveCopperSocketElbow, resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import {
  applyPipeRouteEdit,
  getPipeEditSelectionIndices,
  type PipeEditFrame,
  type PipeEditPortConstraint,
  type PipeRouteEditOperation,
  type PipeEditSelection,
} from './pipeEditGeometry';
import { readPipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipePairVisual, buildRefrigerantPipePhysicalPath,
  resolveRefrigerantPipePairSpec, resolveRefrigerantPipeSpec,
  type RefrigerantPipeMaterial,
} from './refrigerantPipePairModel';

export const isEditablePipe = (element: HvacElement) =>
  element.type === 'refrigerant-pipe' || element.type === 'refrigerant-pipe-pair';

export function editablePipeNodes(element: HvacElement): PipeRouteNode3D[] {
  const authored = readPipeRouteNodes3d(element);
  if (authored.length >= 2) return authored;
  if (element.type === 'refrigerant-pipe-pair') {
    const spec = resolveRefrigerantPipePairSpec(element.properties);
    const z = spec.startBundleConnection
      ? (spec.startBundleConnection.gasElevationMm + spec.startBundleConnection.liquidElevationMm) / 2
      : element.elevation + (spec.gasOuterDiameterMm + spec.liquidOuterDiameterMm) / 4;
    return spec.routePoints.map(point => ({ ...point, z }));
  }
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const z = spec.startConnection?.elevationMm ?? spec.endConnection?.elevationMm
    ?? element.elevation + spec.outerDiameterMm / 2;
  return spec.routePoints.map(point => ({ ...point, z }));
}

/** Canonical segment ownership, including risers missing from a legacy XY route. */
export function editablePipeMaterials(element: HvacElement, nodes = editablePipeNodes(element)): RefrigerantPipeMaterial[] {
  const raw = element.properties.segmentMaterials;
  if (Array.isArray(raw) && raw.length === nodes.length - 1) {
    return raw.map(material => material === 'hard' ? 'hard' : 'flexible');
  }
  const spec = resolveRefrigerantPipeSpec(element.properties);
  return nodes.slice(1).map((end, index) => {
    const start = nodes[index]!;
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    let closest = Infinity;
    let material: RefrigerantPipeMaterial = 'flexible';
    for (let planIndex = 0; planIndex < spec.routePoints.length - 1; planIndex++) {
      const a = spec.routePoints[planIndex]!; const b = spec.routePoints[planIndex + 1]!;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const squared = dx * dx + dy * dy;
      const fraction = squared > 1e-9 ? Math.max(0, Math.min(1, ((midpoint.x - a.x) * dx + (midpoint.y - a.y) * dy) / squared)) : 0;
      const separation = Math.hypot(midpoint.x - a.x - fraction * dx, midpoint.y - a.y - fraction * dy);
      const nextMaterial = spec.segmentMaterials[planIndex] ?? 'flexible';
      if (separation < closest - 1e-6) { closest = separation; material = nextMaterial; }
      // A newly lifted riser at a material boundary inherits the stricter hard
      // constraint until the user deliberately assigns its material.
      else if (Math.abs(separation - closest) <= 1e-6 && nextMaterial === 'hard') material = 'hard';
    }
    return material;
  });
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

/** Keep sampled arc tessellation out of the direct-edit control handles. */
export function pipeEditControlIndices(element: HvacElement): { nodes: number[]; segments: number[] } {
  const nodes = editablePipeNodes(element);
  const sampled = nodes.map((_, index) => isSampledBendNode(nodes, index));
  return {
    nodes: nodes.flatMap((_, index) => sampled[index] ? [] : [index]),
    segments: nodes.slice(1).flatMap((end, index) => sampled[index] && sampled[index + 1]
      && distance(nodes[index]!, end) <= 12 ? [] : [index]),
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
}
export type PipeModelEditResult = { ok: true; elements: HvacElement[] } | { ok: false; message: string };

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
