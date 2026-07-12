import type {
  BranchKitComponent,
  EquipmentPort,
  JsonObject,
  PipeRun,
  Quaternion,
  Vec3,
  VrfPipingDocument,
} from '../domain/types';

import { selectPipeSize } from './pipe-sizing';
import type { ManufacturerRuleProfile } from './rule-profile';
import type {
  ValidationBranchInput,
  ValidationPairInput,
  ValidationPortInput,
  ValidationRunInput,
  VrfValidationSnapshot,
} from './validation-engine';

interface TopologyCapacityProjection {
  byRunId: Map<string, number>;
  byBranchId: Map<string, number>;
}

function linkTopologyNodes(
  adjacency: Map<string, Set<string>>,
  left: string | undefined,
  right: string | undefined,
): void {
  if (!left || !right || left === right) return;
  const leftLinks = adjacency.get(left) ?? new Set<string>();
  const rightLinks = adjacency.get(right) ?? new Set<string>();
  leftLinks.add(right);
  rightLinks.add(left);
  adjacency.set(left, leftLinks);
  adjacency.set(right, rightLinks);
}

/**
 * Derives downstream manufacturer capacity indices from the connected graph,
 * independent of route authoring direction. The outdoor unit is the root and
 * each line kind is traversed separately so gas/liquid networks never cross.
 */
function projectTopologyCapacities(
  document: VrfPipingDocument,
): TopologyCapacityProjection {
  const byRunId = new Map<string, number>();
  const byBranchId = new Map<string, number>();
  const lineKinds = new Set(Object.values(document.pipeRuns).map((run) => run.lineKind));

  for (const lineKind of lineKinds) {
    const adjacency = new Map<string, Set<string>>();
    const equipmentNodeId = (equipmentId: string) => `capacity:${lineKind}:${equipmentId}`;

    for (const edge of Object.values(document.segmentEdges)) {
      if (edge.lineKind !== lineKind) continue;
      linkTopologyNodes(adjacency, edge.startNodeId, edge.endNodeId);
    }
    const lineBranches = Object.values(document.branchKits).filter(
      (branch) => branch.lineKind === lineKind,
    );
    for (const branch of lineBranches) {
      for (const inlet of branch.inletNodeIds) {
        for (const outlet of branch.outletNodeIds) {
          linkTopologyNodes(adjacency, inlet, outlet);
        }
      }
    }
    const lineRuns = Object.values(document.pipeRuns).filter(
      (run) => run.lineKind === lineKind,
    );
    for (const run of lineRuns) {
      const firstNodeId = run.nodeIds[0];
      const lastNodeId = run.nodeIds[run.nodeIds.length - 1];
      const sourceEquipmentId = run.sourcePortId
        ? document.equipmentPorts[run.sourcePortId]?.equipmentId
        : undefined;
      const targetEquipmentId = run.targetPortId
        ? document.equipmentPorts[run.targetPortId]?.equipmentId
        : undefined;
      if (sourceEquipmentId) {
        linkTopologyNodes(adjacency, equipmentNodeId(sourceEquipmentId), firstNodeId);
      }
      if (targetEquipmentId) {
        linkTopologyNodes(adjacency, equipmentNodeId(targetEquipmentId), lastNodeId);
      }
    }

    const roots = Object.values(document.equipmentNodes)
      .filter((equipment) => equipment.equipmentType === 'outdoor-unit')
      .map((equipment) => equipmentNodeId(equipment.id))
      .filter((id) => adjacency.has(id));
    if (roots.length === 0) continue;

    const parent = new Map<string, string | null>();
    const distanceFromRoot = new Map<string, number>();
    const queue: string[] = [];
    for (const root of roots) {
      if (distanceFromRoot.has(root)) continue;
      parent.set(root, null);
      distanceFromRoot.set(root, 0);
      queue.push(root);
    }
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      const currentDistance = distanceFromRoot.get(current)!;
      for (const next of adjacency.get(current) ?? []) {
        if (distanceFromRoot.has(next)) continue;
        parent.set(next, current);
        distanceFromRoot.set(next, currentDistance + 1);
        queue.push(next);
      }
    }

    const downstreamTotals = new Map<string, number>();
    const downstreamKnownCapacityCounts = new Map<string, number>();
    for (const equipment of Object.values(document.equipmentNodes)) {
      if (equipment.equipmentType !== 'indoor-unit') continue;
      const id = equipmentNodeId(equipment.id);
      if (!distanceFromRoot.has(id) || !Number.isFinite(equipment.capacityIndex)) continue;
      downstreamTotals.set(id, Math.max(0, equipment.capacityIndex!));
      downstreamKnownCapacityCounts.set(id, 1);
    }
    const farthestFirst = [...distanceFromRoot.keys()].sort(
      (left, right) => distanceFromRoot.get(right)! - distanceFromRoot.get(left)!,
    );
    for (const nodeId of farthestFirst) {
      const parentId = parent.get(nodeId);
      if (!parentId) continue;
      downstreamTotals.set(
        parentId,
        (downstreamTotals.get(parentId) ?? 0) + (downstreamTotals.get(nodeId) ?? 0),
      );
      downstreamKnownCapacityCounts.set(
        parentId,
        (downstreamKnownCapacityCounts.get(parentId) ?? 0)
          + (downstreamKnownCapacityCounts.get(nodeId) ?? 0),
      );
    }

    for (const run of lineRuns) {
      const first = run.nodeIds[0];
      const last = run.nodeIds[run.nodeIds.length - 1];
      const firstDistance = first ? distanceFromRoot.get(first) : undefined;
      const lastDistance = last ? distanceFromRoot.get(last) : undefined;
      if (firstDistance === undefined && lastDistance === undefined) continue;
      const downstreamNode = (lastDistance ?? -1) >= (firstDistance ?? -1) ? last : first;
      if (
        downstreamNode
        && (downstreamKnownCapacityCounts.get(downstreamNode) ?? 0) > 0
      ) {
        byRunId.set(run.id, downstreamTotals.get(downstreamNode) ?? 0);
      }
    }
    for (const branch of lineBranches) {
      const inlet = branch.inletNodeIds
        .filter((id) => distanceFromRoot.has(id))
        .sort((left, right) => distanceFromRoot.get(left)! - distanceFromRoot.get(right)!)[0];
      if (!inlet) continue;
      const downstreamOutlets = branch.outletNodeIds.filter(
        (outlet) => parent.get(outlet) === inlet,
      );
      const knownCapacityCount = downstreamOutlets.reduce(
        (sum, outlet) => sum + (downstreamKnownCapacityCounts.get(outlet) ?? 0),
        0,
      );
      const total = downstreamOutlets.reduce(
        (sum, outlet) => sum + (downstreamTotals.get(outlet) ?? 0),
        0,
      );
      if (knownCapacityCount > 0) byBranchId.set(branch.id, total);
    }
  }

  return { byRunId, byBranchId };
}

function jsonNumber(value: JsonObject | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function jsonString(value: JsonObject | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

function jsonBoolean(value: JsonObject | undefined, key: string): boolean | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

function jsonNumberArray(value: JsonObject | undefined, key: string): number[] | undefined {
  const candidate = value?.[key];
  if (!Array.isArray(candidate)) return undefined;
  const numbers = candidate.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  );
  return numbers.length ? numbers : undefined;
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function normalize(value: Vec3): Vec3 {
  const magnitude = Math.hypot(value.x, value.y, value.z);
  return magnitude > 1e-9
    ? { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude }
    : { x: 1, y: 0, z: 0 };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function rotateByQuaternion(vector: Vec3, quaternion: Quaternion): Vec3 {
  const { x, y, z, w } = quaternion;
  const tx = 2 * (y * vector.z - z * vector.y);
  const ty = 2 * (z * vector.x - x * vector.z);
  const tz = 2 * (x * vector.y - y * vector.x);
  return {
    x: vector.x + w * tx + (y * tz - z * ty),
    y: vector.y + w * ty + (z * tx - x * tz),
    z: vector.z + w * tz + (x * ty - y * tx),
  };
}

function portWorldDirection(document: VrfPipingDocument, port: EquipmentPort): Vec3 {
  const equipment = document.equipmentNodes[port.equipmentId];
  return normalize(
    equipment
      ? rotateByQuaternion(port.directionLocal, equipment.transform.orientation)
      : port.directionLocal,
  );
}

function straightStubLength(
  points: readonly Vec3[],
  side: 'start' | 'end',
  portDirection: Vec3,
  exitConeDeg: number,
): number | undefined {
  if (points.length < 2) return undefined;
  const ordered = side === 'start' ? [...points] : [...points].reverse();
  const direction = normalize(portDirection);
  const minimumDot = Math.cos(Math.max(0, Math.min(180, exitConeDeg)) * Math.PI / 180);
  let length = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const start = ordered[index - 1]!;
    const end = ordered[index]!;
    const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
    const segmentLength = Math.hypot(delta.x, delta.y, delta.z);
    if (segmentLength <= 1e-9) continue;
    if (dot(normalize(delta), direction) + 1e-9 < minimumDot) break;
    length += segmentLength;
  }
  return length;
}

function hasSagPocket(points: readonly Vec3[]): boolean {
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const next = points[index + 1]!;
    if (point.z < previous.z - 0.1 && point.z < next.z - 0.1) return true;
  }
  return false;
}

function horizontalRouteLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index]!.x - points[index - 1]!.x,
      points[index]!.y - points[index - 1]!.y,
    );
  }
  return total;
}

function inferredSlopeTowardOutdoor(
  document: VrfPipingDocument,
  run: PipeRun,
  points: readonly Vec3[],
): number | undefined {
  if (points.length < 2) return undefined;
  const startEquipment = run.sourcePortId
    ? document.equipmentNodes[document.equipmentPorts[run.sourcePortId]?.equipmentId ?? '']
    : undefined;
  const endEquipment = run.targetPortId
    ? document.equipmentNodes[document.equipmentPorts[run.targetPortId]?.equipmentId ?? '']
    : undefined;
  const horizontal = horizontalRouteLength(points);
  if (horizontal <= 1e-9) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (startEquipment?.equipmentType === 'outdoor-unit') {
    return ((last.z - first.z) / horizontal) * 100;
  }
  if (endEquipment?.equipmentType === 'outdoor-unit') {
    return ((first.z - last.z) / horizontal) * 100;
  }
  return undefined;
}

function connectedEdgeIdsForPort(document: VrfPipingDocument, port: EquipmentPort): string[] {
  const ids = new Set<string>();
  if (port.connectedEdgeId) ids.add(port.connectedEdgeId);
  for (const node of Object.values(document.routeNodes)) {
    if (node.equipmentPortId !== port.id) continue;
    for (const edgeId of node.connectedEdgeIds) ids.add(edgeId);
  }
  return [...ids].sort();
}

function toValidationPort(
  document: VrfPipingDocument,
  port: EquipmentPort,
): ValidationPortInput {
  return {
    id: port.id,
    equipmentId: port.equipmentId,
    systemType: port.systemType,
    connectionDiameterMm: port.connectionDiameterMm,
    compatiblePipeKinds: port.compatiblePipeKinds,
    connectedEdgeIds: connectedEdgeIdsForPort(document, port),
    allowsMultipleConnections: port.allowMultipleConnections,
  };
}

function toValidationRun(
  document: VrfPipingDocument,
  run: PipeRun,
  ports: Map<string, ValidationPortInput>,
  profile?: ManufacturerRuleProfile,
  topologyCapacityIndex?: number,
): ValidationRunInput {
  const edges = run.segmentEdgeIds.flatMap((id) => {
    const edge = document.segmentEdges[id];
    return edge ? [edge] : [];
  });
  const firstEdge = edges[0];
  const minimumBendRadiusMm = jsonNumber(run.metadata, 'minimumBendRadiusMm')
    ?? (run.sourcePortId ? document.equipmentPorts[run.sourcePortId]?.minimumBendRadiusMm : undefined)
    ?? (run.targetPortId ? document.equipmentPorts[run.targetPortId]?.minimumBendRadiusMm : undefined);
  const nodePositions = run.nodeIds.flatMap((id) => {
    const node = document.routeNodes[id];
    return node ? [node.position] : [];
  });
  const startPortRecord = run.sourcePortId
    ? document.equipmentPorts[run.sourcePortId]
    : undefined;
  const endPortRecord = run.targetPortId
    ? document.equipmentPorts[run.targetPortId]
    : undefined;
  const fallbackExitCone = profile?.portDefaults.allowedExitConeDeg?.value ?? 2;
  const explicitExpectedDiameter = jsonNumber(run.metadata, 'expectedDiameterMm');
  const downstreamCapacityIndex = topologyCapacityIndex
    ?? jsonNumber(run.metadata, 'downstreamCapacityIndex');
  const sizing = profile && downstreamCapacityIndex !== undefined
    ? selectPipeSize(profile, {
        systemType: run.systemType,
        downstreamCapacityIndex,
        currentOutsideDiameterMm: firstEdge?.nominalDiameterMm,
      })
    : null;
  return {
    id: run.id,
    systemType: run.systemType,
    lineKind: run.lineKind,
    pipeKind: run.pipeKind,
    diameterMm: firstEdge?.nominalDiameterMm ?? 0,
    expectedDiameterMm: explicitExpectedDiameter
      ?? sizing?.preferred?.rule.outsideDiameterMm.value,
    nodePositions,
    startPort: run.sourcePortId ? ports.get(run.sourcePortId) : undefined,
    endPort: run.targetPortId ? ports.get(run.targetPortId) : undefined,
    startPortStubMm: startPortRecord
      ? straightStubLength(
          nodePositions,
          'start',
          portWorldDirection(document, startPortRecord),
          startPortRecord.allowedExitConeDeg ?? fallbackExitCone,
        )
      : undefined,
    endPortStubMm: endPortRecord
      ? straightStubLength(
          nodePositions,
          'end',
          portWorldDirection(document, endPortRecord),
          endPortRecord.allowedExitConeDeg ?? fallbackExitCone,
        )
      : undefined,
    bendRadiiMm: jsonNumberArray(run.metadata, 'bendRadiiMm'),
    minimumBendRadiusMm,
    equivalentLengthMm: jsonNumber(run.metadata, 'equivalentLengthMm'),
    insulationSpecified: edges.length > 0
      && edges.every((edge) => edge.insulationThicknessMm !== undefined),
    slopeTowardOutdoorPercent: jsonNumber(run.metadata, 'slopeTowardOutdoorPercent')
      ?? inferredSlopeTowardOutdoor(document, run, nodePositions),
    hasSagPocket: jsonBoolean(run.metadata, 'hasSagPocket') ?? hasSagPocket(nodePositions),
    flowDirectionValid: jsonBoolean(run.metadata, 'flowDirectionValid'),
  };
}

function incidentDiameters(document: VrfPipingDocument, nodeIds: string[]): number[] {
  const values = new Set<number>();
  for (const nodeId of nodeIds) {
    const node = document.routeNodes[nodeId];
    if (!node) continue;
    for (const edgeId of node.connectedEdgeIds) {
      const edge = document.segmentEdges[edgeId];
      if (edge) values.add(edge.nominalDiameterMm);
    }
  }
  return [...values].sort((left, right) => left - right);
}

function straightLengthAtNode(document: VrfPipingDocument, nodeId: string): number | undefined {
  const lengths: number[] = [];
  for (const run of Object.values(document.pipeRuns)) {
    const endpointIndex = run.nodeIds.indexOf(nodeId);
    if (endpointIndex !== 0 && endpointIndex !== run.nodeIds.length - 1) continue;
    const orderedIds = endpointIndex === 0 ? run.nodeIds : [...run.nodeIds].reverse();
    const origin = document.routeNodes[orderedIds[0]!]?.position;
    const first = document.routeNodes[orderedIds[1]!]?.position;
    if (!origin || !first) continue;
    const initial = normalize({
      x: first.x - origin.x,
      y: first.y - origin.y,
      z: first.z - origin.z,
    });
    let total = 0;
    for (let index = 1; index < orderedIds.length; index += 1) {
      const start = document.routeNodes[orderedIds[index - 1]!]?.position;
      const end = document.routeNodes[orderedIds[index]!]?.position;
      if (!start || !end) break;
      const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
      const segmentLength = Math.hypot(delta.x, delta.y, delta.z);
      if (segmentLength <= 1e-9) continue;
      if (dot(normalize(delta), initial) < 0.999) break;
      total += segmentLength;
    }
    lengths.push(total);
  }
  return lengths.length ? Math.min(...lengths) : undefined;
}

function directionAwayFromNode(document: VrfPipingDocument, nodeId: string): Vec3 | null {
  const node = document.routeNodes[nodeId];
  const edgeId = node?.connectedEdgeIds[0];
  const edge = edgeId ? document.segmentEdges[edgeId] : undefined;
  if (!node || !edge) return null;
  const otherId = edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId;
  const other = document.routeNodes[otherId];
  return other
    ? normalize({
        x: other.position.x - node.position.x,
        y: other.position.y - node.position.y,
        z: other.position.z - node.position.z,
      })
    : null;
}

function downstreamBranchCount(document: VrfPipingDocument, branch: BranchKitComponent): number {
  const explicit = jsonNumber(branch.metadata, 'downstreamBranchCount');
  if (explicit !== undefined) return Math.max(0, Math.round(explicit));
  const connectedOutlets = branch.outletNodeIds.filter(
    (nodeId) => (document.routeNodes[nodeId]?.connectedEdgeIds.length ?? 0) > 0,
  ).length;
  return Math.max(connectedOutlets, branch.branchRunIds?.length ?? 0);
}

/**
 * Measures spacing only between fittings joined by actual pipe topology. A
 * plan-distance comparison incorrectly flags unrelated systems and the paired
 * gas/liquid halves of one kit merely because they occupy the same location.
 */
function distanceToAdjacentBranchAlongTopology(
  document: VrfPipingDocument,
  branch: BranchKitComponent,
  allBranches: readonly BranchKitComponent[],
): number | undefined {
  const ownNodes = new Set([...branch.inletNodeIds, ...branch.outletNodeIds]);
  const targetNodes = new Set(
    allBranches
      .filter((candidate) => candidate.id !== branch.id && candidate.lineKind === branch.lineKind)
      .flatMap((candidate) => [...candidate.inletNodeIds, ...candidate.outletNodeIds]),
  );
  if (ownNodes.size === 0 || targetNodes.size === 0) return undefined;

  const adjacency = new Map<string, Array<{ nodeId: string; distanceMm: number }>>();
  for (const edge of Object.values(document.segmentEdges)) {
    if (edge.lineKind !== branch.lineKind) continue;
    const start = document.routeNodes[edge.startNodeId]?.position;
    const end = document.routeNodes[edge.endNodeId]?.position;
    if (!start || !end) continue;
    const distanceMm = distance(start, end);
    const fromStart = adjacency.get(edge.startNodeId) ?? [];
    const fromEnd = adjacency.get(edge.endNodeId) ?? [];
    fromStart.push({ nodeId: edge.endNodeId, distanceMm });
    fromEnd.push({ nodeId: edge.startNodeId, distanceMm });
    adjacency.set(edge.startNodeId, fromStart);
    adjacency.set(edge.endNodeId, fromEnd);
  }

  const distances = new Map<string, number>();
  const pending: Array<{ nodeId: string; distanceMm: number }> = [];
  for (const nodeId of ownNodes) {
    distances.set(nodeId, 0);
    pending.push({ nodeId, distanceMm: 0 });
  }
  while (pending.length > 0) {
    pending.sort((left, right) => left.distanceMm - right.distanceMm);
    const current = pending.shift()!;
    if (current.distanceMm > (distances.get(current.nodeId) ?? Number.POSITIVE_INFINITY)) continue;
    if (!ownNodes.has(current.nodeId) && targetNodes.has(current.nodeId)) {
      return current.distanceMm;
    }
    for (const next of adjacency.get(current.nodeId) ?? []) {
      const candidateDistance = current.distanceMm + next.distanceMm;
      if (candidateDistance >= (distances.get(next.nodeId) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(next.nodeId, candidateDistance);
      pending.push({ nodeId: next.nodeId, distanceMm: candidateDistance });
    }
  }
  return undefined;
}

function toValidationBranch(
  document: VrfPipingDocument,
  branch: BranchKitComponent,
  allBranches: readonly BranchKitComponent[],
  topologyCapacityIndex?: number,
): ValidationBranchInput {
  const arrangementValue = jsonString(branch.metadata, 'arrangement');
  const arrangement = arrangementValue === 'heat-recovery' ? 'heat-recovery' : 'heat-pump';
  const forward = normalize(rotateByQuaternion(branch.localForward, branch.orientation));
  const inletDirection = branch.inletNodeIds[0]
    ? directionAwayFromNode(document, branch.inletNodeIds[0])
    : null;
  const adjacentBranchDistance = distanceToAdjacentBranchAlongTopology(
    document,
    branch,
    allBranches,
  );
  const outletStraightMm = branch.outletNodeIds.map(
    (id) => straightLengthAtNode(document, id) ?? 0,
  );
  const inletStraightMm = branch.inletNodeIds
    .map((id) => straightLengthAtNode(document, id))
    .find((value): value is number => value !== undefined);
  const insulationThicknessMm = jsonNumber(branch.metadata, 'insulationThicknessMm');
  return {
    id: branch.id,
    model: branch.model,
    branchType: branch.branchType,
    selection: {
      manufacturer: branch.manufacturer,
      family: branch.family,
      refrigerant: jsonString(branch.metadata, 'refrigerant') ?? 'unspecified',
      arrangement,
      systemRole: branch.systemRole,
      branchType: branch.branchType,
      headerOutletCount: branch.branchType === 'header' ? branch.outletNodeIds.length : undefined,
      outdoorCapacity: branch.upstreamOutdoorCapacity,
      downstreamCapacityIndex: topologyCapacityIndex ?? branch.downstreamCapacityIndex,
      downstreamBranchCount: downstreamBranchCount(document, branch),
      upstreamDiametersMm: incidentDiameters(document, branch.inletNodeIds),
      downstreamDiametersMm: incidentDiameters(document, branch.outletNodeIds),
      currentModel: branch.model,
    },
    frame: {
      forward,
      up: normalize(rotateByQuaternion(branch.localUp, branch.orientation)),
      splitPlaneNormal: normalize(
        rotateByQuaternion(branch.splitPlaneNormal, branch.orientation),
      ),
      outletDirections: branch.outletNodeIds.flatMap((nodeId) => {
        const node = document.routeNodes[nodeId];
        if (!node) return [];
        const edgeId = node.connectedEdgeIds[0];
        const edge = edgeId ? document.segmentEdges[edgeId] : undefined;
        if (!edge) return [];
        const otherId = edge.startNodeId === nodeId ? edge.endNodeId : edge.startNodeId;
        const other = document.routeNodes[otherId];
        return other
          ? [normalize({
              x: other.position.x - node.position.x,
              y: other.position.y - node.position.y,
              z: other.position.z - node.position.z,
            })]
          : [];
      }),
    },
    upstreamStraightMm: inletStraightMm,
    downstreamStraightMm: outletStraightMm,
    outletElevationsMm: branch.outletNodeIds.flatMap((id) => {
      const node = document.routeNodes[id];
      return node ? [node.position.z] : [];
    }),
    distanceToAdjacentJointMm: adjacentBranchDistance,
    firstElbowDistancesMm: [
      ...(inletStraightMm === undefined ? [] : [inletStraightMm]),
      ...outletStraightMm,
    ],
    connectedToSelectorBox: jsonBoolean(branch.metadata, 'connectedToSelectorBox'),
    inletFacesUpstream: inletDirection ? dot(inletDirection, forward) < -0.5 : undefined,
    insulationSpecified: jsonBoolean(branch.metadata, 'insulated')
      ?? (insulationThicknessMm !== undefined && insulationThicknessMm > 0),
    equivalentLengthMm: jsonNumber(branch.metadata, 'equivalentLengthMm'),
  };
}

function runDirection(document: VrfPipingDocument, runId: string): Vec3 | null {
  const run = document.pipeRuns[runId];
  if (!run || run.nodeIds.length < 2) return null;
  const first = document.routeNodes[run.nodeIds[0]!];
  const last = document.routeNodes[run.nodeIds[run.nodeIds.length - 1]!];
  if (!first || !last) return null;
  return normalize({
    x: last.position.x - first.position.x,
    y: last.position.y - first.position.y,
    z: last.position.z - first.position.z,
  });
}

function runStart(document: VrfPipingDocument, runId: string): Vec3 | null {
  const run = document.pipeRuns[runId];
  const node = run?.nodeIds[0] ? document.routeNodes[run.nodeIds[0]!] : undefined;
  return node?.position ?? null;
}

function toValidationPair(
  document: VrfPipingDocument,
  pairId: string,
): ValidationPairInput | null {
  const pair = document.pipePairAssemblies[pairId];
  const gasRunId = pair?.gasRunIds[0];
  const liquidRunId = pair?.liquidRunIds[0];
  if (!pair || !gasRunId || !liquidRunId) return null;
  const gasDirection = runDirection(document, gasRunId);
  const liquidDirection = runDirection(document, liquidRunId);
  const gasStart = runStart(document, gasRunId);
  const liquidStart = runStart(document, liquidRunId);
  return {
    id: pair.id,
    gasRunId,
    liquidRunId,
    directionAlignmentDot: gasDirection && liquidDirection
      ? dot(gasDirection, liquidDirection)
      : 1,
    separationMm: gasStart && liquidStart ? distance(gasStart, liquidStart) : pair.separationMm,
    requiredSeparationMm: pair.separationMm,
  };
}

/** Derives the rule engine's immutable input from the semantic network graph. */
export function buildVrfValidationSnapshot(
  document: VrfPipingDocument,
  profile?: ManufacturerRuleProfile,
): VrfValidationSnapshot {
  const ports = Object.values(document.equipmentPorts).map((port) =>
    toValidationPort(document, port));
  const portById = new Map(ports.map((port) => [port.id, port]));
  const branches = Object.values(document.branchKits);
  const topologyCapacities = projectTopologyCapacities(document);
  const connectedEquipment = Object.values(document.equipmentNodes).filter((equipment) =>
    equipment.portIds.some((portId) => document.equipmentPorts[portId]?.isConnected));
  const outdoorEquipment = connectedEquipment.filter(
    (equipment) => equipment.equipmentType === 'outdoor-unit',
  );
  const indoorEquipment = connectedEquipment.filter(
    (equipment) => equipment.equipmentType === 'indoor-unit',
  );
  return {
    ports,
    runs: Object.values(document.pipeRuns).map((run) =>
      toValidationRun(
        document,
        run,
        portById,
        profile,
        topologyCapacities.byRunId.get(run.id),
      )),
    branches: branches.map((branch) =>
      toValidationBranch(
        document,
        branch,
        branches,
        topologyCapacities.byBranchId.get(branch.id),
      )),
    pairs: Object.keys(document.pipePairAssemblies).flatMap((id) => {
      const pair = toValidationPair(document, id);
      return pair ? [pair] : [];
    }),
    cycleEntityIds: document.diagnostics
      .filter((diagnostic) => diagnostic.code.toLowerCase().includes('cycle'))
      .flatMap((diagnostic) => diagnostic.entityIds),
    disconnectedEntityIds: document.diagnostics
      .filter((diagnostic) => diagnostic.code.toLowerCase().includes('disconnected'))
      .flatMap((diagnostic) => diagnostic.entityIds),
    unapprovedTeeEntityIds: Object.values(document.routeNodes)
      .filter((node) => !node.componentId && node.connectedEdgeIds.length === 3)
      .map((node) => jsonString(node.metadata, 'sourceElementId') ?? node.id),
    indoorUnitCount: indoorEquipment.length,
    outdoorIndoorVerticalSeparations: outdoorEquipment.length === 1
      ? indoorEquipment.map((indoor) => ({
          entityId: indoor.id,
          separationMm: Math.abs(
            indoor.transform.position.z - outdoorEquipment[0]!.transform.position.z,
          ),
          outdoorBelowIndoor:
            outdoorEquipment[0]!.transform.position.z < indoor.transform.position.z,
        }))
      : undefined,
  };
}
