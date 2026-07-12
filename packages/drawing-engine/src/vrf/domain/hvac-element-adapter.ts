import { normalizePipeRouteNodes3d } from '../../components/canvas/hvac/pipeRoute3d';
import {
  isRefrigerantBranchKitElement,
  resolveRefrigerantBranchKitLineSelection,
  type RefrigerantBranchTerminalRole,
} from '../../components/canvas/hvac/refrigerantBranchKitModel';
import {
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
} from '../../components/canvas/hvac/refrigerantPipeDimensions';
import {
  getBranchKitPortConnections,
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipePairSpec,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from '../../components/canvas/hvac/refrigerantPipePairModel';
import type { HvacElement, Point2D } from '../../types';

import {
  createEmptyVrfPipingDocument,
  type BranchKitComponent,
  type EquipmentNode,
  type EquipmentPort,
  type EquipmentPortSystemType,
  type JsonObject,
  type JsonValue,
  type PipeRun,
  type Quaternion,
  type RefrigerantLineKind,
  type RouteNode,
  type Vec3,
  type VrfDiagnostic,
  type VrfPipingDocument,
} from './types';

export type AdaptedRefrigerantLineKind = 'gas' | 'liquid';

export interface HvacElementVrfAdapterOptions {
  documentId?: string;
  activeRuleProfileId?: string;
  defaultRuleProfileId?: string;
  defaultManufacturer?: string;
  defaultFamily?: string;
  defaultRefrigerant?: string;
}

/** Deterministic ids keep semantic entities stable across repeated projections. */
export const hvacVrfSemanticIds = {
  equipment: (elementId: string) => elementId,
  equipmentPort: (elementId: string, lineKind: AdaptedRefrigerantLineKind) =>
    `${elementId}:port:${lineKind}`,
  pipeRun: (
    elementId: string,
    lineKind: AdaptedRefrigerantLineKind,
    coordinatedPair = false,
  ) => coordinatedPair ? `${elementId}:${lineKind}` : elementId,
  routeNode: (runId: string, key: string | number) => `vrf:route-node:${runId}:${key}`,
  segmentEdge: (runId: string, index: number) => `vrf:segment-edge:${runId}:${index}`,
  branchKit: (
    elementId: string,
    lineKind: AdaptedRefrigerantLineKind,
    coordinatedPair = false,
  ) => coordinatedPair ? `${elementId}:${lineKind}` : elementId,
  branchPortNode: (
    componentId: string,
    role: RefrigerantBranchTerminalRole,
  ) => `vrf:branch-port:${componentId}:${role}`,
  pipePairAssembly: (sourceId: string) => `vrf:pipe-pair:${sourceId}`,
} as const;

const DEFAULT_RULE_PROFILE_ID = 'project-fallback/unverified';
const PIPE_EQUIPMENT_TYPES = new Set<HvacElement['type']>([
  'outdoor-unit',
  'ducted-ac',
  'split-ac',
  'wall-mounted-ac',
  'ceiling-cassette-ac',
  'ceiling-suspended-ac',
]);

interface EndpointConnection {
  connectionKind: 'unit-port' | 'field-pipe';
  point: Vec3;
  sourceElementId?: string;
  terminalRole?: RefrigerantBranchTerminalRole;
  portId?: string;
  nodeId?: string;
}

interface PipeDescriptor {
  element: HvacElement;
  lineKind: AdaptedRefrigerantLineKind;
  runId: string;
  routePoints: Point2D[];
  explicitRoute3d: Vec3[];
  diameterMm: number;
  insulationThicknessMm: number | undefined;
  pipeKind: string;
  startConnection: EndpointConnection | null;
  endConnection: EndpointConnection | null;
  bundleId?: string;
  pairSourceId?: string;
  pairSeparationMm?: number;
  defaultStartNodeId: string;
  defaultEndNodeId: string;
}

interface BranchDescriptor {
  element: HvacElement;
  lineKind: AdaptedRefrigerantLineKind;
  component: BranchKitComponent;
  terminalNodeIds: Record<RefrigerantBranchTerminalRole, string>;
  pairKey: string | null;
}

interface EndpointBinding {
  nodeId?: string;
  equipmentPortId?: string;
  componentId?: string;
  point?: Vec3;
  terminalRole?: RefrigerantBranchTerminalRole;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readNumber(properties: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (finiteNumber(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readString(properties: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (finiteNumber(value)) return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const converted = jsonValue(item, seen);
      return converted === undefined ? [] : [converted];
    });
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  const converted: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const child = jsonValue(item, seen);
    if (child !== undefined) converted[key] = child;
  }
  seen.delete(value);
  return converted;
}

function metadata(values: Record<string, unknown>): JsonObject {
  return (jsonValue(values) as JsonObject | undefined) ?? {};
}

function lineSystemType(lineKind: AdaptedRefrigerantLineKind): EquipmentPortSystemType {
  return lineKind === 'gas' ? 'refrigerant-gas' : 'refrigerant-liquid';
}

function lineKindFor(value: unknown): AdaptedRefrigerantLineKind {
  return value === 'liquid' ? 'liquid' : 'gas';
}

function rotationQuaternion(rotationDeg: number): Quaternion {
  const half = rotationDeg * Math.PI / 360;
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) };
}

function readQuaternion(
  properties: Record<string, unknown>,
  fallbackRotationDeg: number,
): Quaternion {
  const value = properties.orientationQuaternion ?? properties.orientation3d;
  const candidate = Array.isArray(value)
    ? { x: value[0], y: value[1], z: value[2], w: value[3] }
    : value;
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    const components = [record.x, record.y, record.z, record.w];
    if (components.every((component) => typeof component === 'number' && Number.isFinite(component))) {
      const [x, y, z, w] = components as number[];
      const length = Math.hypot(x!, y!, z!, w!);
      if (length > 1e-9) {
        return { x: x! / length, y: y! / length, z: z! / length, w: w! / length };
      }
    }
  }
  return rotationQuaternion(fallbackRotationDeg);
}

function rotate2d(point: Point2D, rotationDeg: number): Point2D {
  const angle = rotationDeg * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function inverseRotate2d(point: Point2D, rotationDeg: number): Point2D {
  return rotate2d(point, -rotationDeg);
}

function elementCenter(element: HvacElement): Vec3 {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
    z: element.elevation,
  };
}

function pointsEqual(left: Vec3, right: Vec3, tolerance = 0.01): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <= tolerance;
}

function dedupePoints(points: Vec3[]): Vec3[] {
  const result: Vec3[] = [];
  for (const point of points) {
    if (!result.length || !pointsEqual(result[result.length - 1]!, point)) result.push(point);
  }
  return result;
}

function interpolateRouteZ(
  points: Point2D[],
  fallbackZ: number,
  startZ?: number,
  endZ?: number,
): Vec3[] {
  if (points.length === 0) return [];
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    lengths.push(lengths[index - 1]! + Math.hypot(point.x - previous.x, point.y - previous.y));
  }
  const total = lengths[lengths.length - 1] ?? 0;
  const from = startZ ?? endZ ?? fallbackZ;
  const to = endZ ?? startZ ?? fallbackZ;
  return points.map((point, index) => ({
    x: point.x,
    y: point.y,
    z: total > 1e-9 ? from + (to - from) * (lengths[index]! / total) : from,
  }));
}

function connectionFromPipe(
  connection: RefrigerantPipeConnection | null,
): EndpointConnection | null {
  if (!connection) return null;
  return {
    connectionKind: connection.connectionKind,
    point: { x: connection.portPoint.x, y: connection.portPoint.y, z: connection.elevationMm },
    sourceElementId: connection.sourceElementId,
    terminalRole: connection.terminalRole,
    portId: connection.portId,
    nodeId: connection.nodeId,
  };
}

function connectionFromBundle(
  connection: RefrigerantPipeBundleConnection | null,
  lineKind: AdaptedRefrigerantLineKind,
): EndpointConnection | null {
  if (!connection) return null;
  const gas = lineKind === 'gas';
  const point = gas ? connection.gasPoint : connection.liquidPoint;
  return {
    connectionKind: connection.connectionKind,
    point: {
      x: point.x,
      y: point.y,
      z: gas ? connection.gasElevationMm : connection.liquidElevationMm,
    },
    sourceElementId:
      (gas ? connection.gasSourceElementId : connection.liquidSourceElementId)
      ?? connection.sourceElementId,
    terminalRole: connection.terminalRole,
    portId: (gas ? connection.gasPortId : connection.liquidPortId) ?? connection.portId,
    nodeId: (gas ? connection.gasNodeId : connection.liquidNodeId) ?? connection.nodeId,
  };
}

function pipeDescriptors(elements: HvacElement[]): PipeDescriptor[] {
  return elements.flatMap((element): PipeDescriptor[] => {
    if (element.type === 'refrigerant-pipe') {
      const spec = resolveRefrigerantPipeSpec(element.properties, elements);
      const lineKind = lineKindFor(spec.lineKind);
      const runId = hvacVrfSemanticIds.pipeRun(element.id, lineKind);
      return [{
        element,
        lineKind,
        runId,
        routePoints: spec.routePoints,
        explicitRoute3d: normalizePipeRouteNodes3d(element.properties.routeNodes3d),
        diameterMm: spec.pipeDiameterMm,
        insulationThicknessMm: element.properties.insulated === false
          ? undefined
          : spec.insulationThicknessMm,
        pipeKind: readString(element.properties, ['pipeKind', 'material']) ?? 'copper',
        startConnection: connectionFromPipe(spec.startConnection),
        endConnection: connectionFromPipe(spec.endConnection),
        bundleId: spec.bundleId,
        pairSourceId: spec.bundleId,
        pairSeparationMm: readNumber(element.properties, ['pipeGapMm']),
        defaultStartNodeId: hvacVrfSemanticIds.routeNode(runId, 'start'),
        defaultEndNodeId: hvacVrfSemanticIds.routeNode(runId, 'end'),
      }];
    }
    if (element.type !== 'refrigerant-pipe-pair') return [];
    const spec = resolveRefrigerantPipePairSpec(element.properties, elements);
    return (['gas', 'liquid'] as const).map((lineKind) => {
      const runId = hvacVrfSemanticIds.pipeRun(element.id, lineKind, true);
      return {
        element,
        lineKind,
        runId,
        routePoints: spec.routePoints,
        explicitRoute3d: normalizePipeRouteNodes3d(element.properties.routeNodes3d),
        diameterMm: lineKind === 'gas' ? spec.gasPipeDiameterMm : spec.liquidPipeDiameterMm,
        insulationThicknessMm: element.properties.insulated === false
          ? undefined
          : spec.insulationThicknessMm,
        pipeKind: readString(element.properties, ['pipeKind', 'material']) ?? 'copper',
        startConnection: connectionFromBundle(spec.startBundleConnection, lineKind),
        endConnection: connectionFromBundle(spec.endBundleConnection, lineKind),
        bundleId: readString(element.properties, ['bundleId']) ?? element.id,
        pairSourceId: readString(element.properties, ['bundleId']) ?? element.id,
        pairSeparationMm: spec.pipeGapMm,
        defaultStartNodeId: hvacVrfSemanticIds.routeNode(runId, 'start'),
        defaultEndNodeId: hvacVrfSemanticIds.routeNode(runId, 'end'),
      };
    });
  });
}

function equipmentKind(element: HvacElement): EquipmentNode['equipmentType'] {
  if (element.type === 'outdoor-unit' || element.category === 'outdoor-unit') return 'outdoor-unit';
  return 'indoor-unit';
}

function branchPairKey(element: HvacElement): string | null {
  const explicit = readString(element.properties, ['branchKitPairId', 'teeId']);
  if (explicit) return `explicit:${explicit}`;
  const source = readString(element.properties, ['branchKitSnapSourceElementId']);
  const station = readNumber(element.properties, ['branchKitSnapProjectedDistanceMm']);
  if (source && station !== undefined) return `inline:${source}:${Math.round(station)}`;
  return null;
}

function branchLineKinds(element: HvacElement): AdaptedRefrigerantLineKind[] {
  const selection = resolveRefrigerantBranchKitLineSelection(element);
  return selection === 'both' ? ['gas', 'liquid'] : [selection];
}

function normalizeBranchType(value: unknown): BranchKitComponent['branchType'] {
  return value === 'header' || value === 'outdoor-multi-kit' ? value : 'y-joint';
}

function normalizeSystemRole(value: unknown): BranchKitComponent['systemRole'] {
  return value === 'first-branch' || value === 'terminal-header'
    ? value
    : 'intermediate-branch';
}

function addBranchKits(
  document: VrfPipingDocument,
  elements: HvacElement[],
  options: HvacElementVrfAdapterOptions,
): BranchDescriptor[] {
  const ruleProfileId = options.defaultRuleProfileId
    ?? options.activeRuleProfileId
    ?? DEFAULT_RULE_PROFILE_ID;
  const descriptors: BranchDescriptor[] = [];
  for (const element of elements) {
    if (!isRefrigerantBranchKitElement(element)) continue;
    const terminals = getBranchKitPortConnections(element);
    const lineKinds = branchLineKinds(element);
    for (const lineKind of lineKinds) {
      const componentId = hvacVrfSemanticIds.branchKit(element.id, lineKind, lineKinds.length > 1);
      const terminalNodeIds = {
        inlet: hvacVrfSemanticIds.branchPortNode(componentId, 'inlet'),
        'run-outlet': hvacVrfSemanticIds.branchPortNode(componentId, 'run-outlet'),
        'branch-outlet': hvacVrfSemanticIds.branchPortNode(componentId, 'branch-outlet'),
      } satisfies Record<RefrigerantBranchTerminalRole, string>;
      const terminalPositions: Vec3[] = [];
      for (const role of ['inlet', 'run-outlet', 'branch-outlet'] as const) {
        const terminal = terminals.find((candidate) => candidate.terminalRole === role);
        const point = lineKind === 'gas' ? terminal?.gasPoint : terminal?.liquidPoint;
        const z = lineKind === 'gas' ? terminal?.gasElevationMm : terminal?.liquidElevationMm;
        const fallback = elementCenter(element);
        const position = {
          x: point?.x ?? fallback.x,
          y: point?.y ?? fallback.y,
          z: z ?? (element.elevation + element.height / 2),
        };
        terminalPositions.push(position);
        document.routeNodes[terminalNodeIds[role]] = {
          id: terminalNodeIds[role],
          kind: 'component-port',
          position,
          connectedEdgeIds: [],
          componentId,
          metadata: metadata({ sourceElementId: element.id, terminalRole: role, lineKind }),
        };
      }
      const origin = terminalPositions.reduce(
        (sum, point) => ({ x: sum.x + point.x / 3, y: sum.y + point.y / 3, z: sum.z + point.z / 3 }),
        { x: 0, y: 0, z: 0 },
      );
      const manufacturer = readString(element.properties, ['manufacturer'])
        ?? options.defaultManufacturer
        ?? 'Unspecified';
      const family = readString(element.properties, ['family', 'productFamily', 'branchKitType'])
        ?? options.defaultFamily
        ?? element.subtype
        ?? 'Unspecified branch family';
      const model = readString(element.properties, ['model', 'modelCode', 'modelNumber'])
        ?? element.modelLabel
        ?? element.subtype
        ?? element.id;
      const component: BranchKitComponent = {
        id: componentId,
        kind: 'branch-kit',
        manufacturer,
        family,
        model,
        branchType: normalizeBranchType(element.properties.branchType),
        systemRole: normalizeSystemRole(element.properties.branchSystemRole),
        lineKind,
        inletNodeIds: [terminalNodeIds.inlet],
        outletNodeIds: [terminalNodeIds['run-outlet'], terminalNodeIds['branch-outlet']],
        position: origin,
        orientation: readQuaternion(element.properties, element.rotation),
        localForward: { x: 1, y: 0, z: 0 },
        localUp: { x: 0, y: 0, z: 1 },
        splitPlaneNormal: { x: 0, y: 0, z: 1 },
        downstreamCapacityIndex: readNumber(element.properties, ['downstreamCapacityIndex']) ?? 0,
        upstreamOutdoorCapacity: readNumber(element.properties, ['upstreamOutdoorCapacity', 'outdoorCapacity']),
        hostRunIds: [],
        branchRunIds: [],
        ruleProfileId: readString(element.properties, ['ruleProfileId']) ?? ruleProfileId,
        metadata: metadata({
          sourceElementId: element.id,
          sourceElementType: element.type,
          sourceLineSelection: resolveRefrigerantBranchKitLineSelection(element),
          refrigerant: readString(element.properties, ['refrigerant']) ?? options.defaultRefrigerant ?? 'unspecified',
          arrangement: readString(element.properties, ['arrangement']) ?? 'heat-pump',
          downstreamBranchCount: readNumber(element.properties, ['downstreamBranchCount']),
          equivalentLengthMm: readNumber(element.properties, ['equivalentLengthMm']),
          insulationThicknessMm: readNumber(element.properties, ['insulationThicknessMm']),
          insulated: element.properties.insulated,
          connectedToSelectorBox: element.properties.connectedToSelectorBox,
        }),
      };
      document.branchKits[componentId] = component;
      descriptors.push({ element, lineKind, component, terminalNodeIds, pairKey: branchPairKey(element) });
    }
  }

  const groups = new Map<string, BranchDescriptor[]>();
  for (const descriptor of descriptors) {
    const key = descriptor.pairKey ?? `element:${descriptor.element.id}`;
    const group = groups.get(key) ?? [];
    group.push(descriptor);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const gas = group.find((candidate) => candidate.lineKind === 'gas');
    const liquid = group.find((candidate) => candidate.lineKind === 'liquid');
    if (!gas || !liquid) continue;
    gas.component.pairedGasComponentId = gas.component.id;
    gas.component.pairedLiquidComponentId = liquid.component.id;
    liquid.component.pairedGasComponentId = gas.component.id;
    liquid.component.pairedLiquidComponentId = liquid.component.id;
  }
  return descriptors;
}

function addEquipment(
  document: VrfPipingDocument,
  elements: HvacElement[],
): Map<string, Vec3> {
  const equipment = elements.filter((element) => PIPE_EQUIPMENT_TYPES.has(element.type));
  const bundleTargets = getRefrigerantPipeBundleSnapTargets(equipment);
  const targetByElementId = new Map(
    bundleTargets
      .filter((target) => target.connectionKind === 'unit-port' && target.sourceElementId)
      .map((target) => [target.sourceElementId!, target]),
  );
  const portWorldPositions = new Map<string, Vec3>();
  for (const element of equipment) {
    const equipmentId = hvacVrfSemanticIds.equipment(element.id);
    const center = elementCenter(element);
    const properties = element.properties;
    const target = targetByElementId.get(element.id);
    const portIds = (['gas', 'liquid'] as const).map((lineKind) => {
      const id = hvacVrfSemanticIds.equipmentPort(element.id, lineKind);
      const targetPoint = lineKind === 'gas' ? target?.gasPoint : target?.liquidPoint;
      const targetDirection = (lineKind === 'gas' ? target?.gasDirection : target?.liquidDirection)
        ?? target?.direction
        ?? rotate2d({ x: 1, y: 0 }, element.rotation);
      const z = lineKind === 'gas' ? target?.gasElevationMm : target?.liquidElevationMm;
      const world = {
        x: targetPoint?.x ?? center.x,
        y: targetPoint?.y ?? center.y,
        z: z ?? (element.elevation + element.height / 2),
      };
      const localPlan = inverseRotate2d({ x: world.x - center.x, y: world.y - center.y }, element.rotation);
      const localDirection = inverseRotate2d(targetDirection, element.rotation);
      const diameter = readNumber(properties, [
        lineKind === 'gas' ? 'refrigerantGasPipeDiameterMm' : 'refrigerantLiquidPipeDiameterMm',
        lineKind === 'gas' ? 'gasPipeDiameterMm' : 'liquidPipeDiameterMm',
      ]) ?? (lineKind === 'gas'
        ? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM
        : DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM);
      const port: EquipmentPort = {
        id,
        equipmentId,
        systemType: lineSystemType(lineKind),
        positionLocal: { x: localPlan.x, y: localPlan.y, z: world.z - element.elevation },
        directionLocal: { x: localDirection.x, y: localDirection.y, z: 0 },
        upLocal: { x: 0, y: 0, z: 1 },
        connectionDiameterMm: diameter,
        connectionType: 'brazed',
        preferredExitDirection: { x: localDirection.x, y: localDirection.y, z: 0 },
        allowedExitConeDeg: readNumber(properties, [
          'refrigerantAllowedExitConeDeg',
          'allowedExitConeDeg',
        ]),
        minimumStraightStubMm: readNumber(properties, ['refrigerantMinimumStraightStubMm', 'minimumStraightStubMm']),
        minimumBendRadiusMm: readNumber(properties, ['refrigerantMinimumBendRadiusMm', 'minimumBendRadiusMm']),
        serviceClearanceMm: readNumber(properties, ['refrigerantServiceClearanceMm', 'serviceClearanceMm']),
        compatiblePipeKinds: ['copper'],
        isConnected: false,
        metadata: metadata({ sourceElementId: element.id, lineKind }),
      };
      document.equipmentPorts[id] = port;
      portWorldPositions.set(id, world);
      return id;
    });
    document.equipmentNodes[equipmentId] = {
      id: equipmentId,
      kind: 'equipment',
      equipmentType: equipmentKind(element),
      definitionId: readString(properties, ['definitionId']),
      manufacturer: readString(properties, ['manufacturer']),
      family: readString(properties, ['family', 'productFamily']),
      model: readString(properties, ['model', 'modelCode']) ?? element.modelLabel,
      // Manufacturer capacity index is not interchangeable with kW/BTU. Only
      // consume an explicitly mapped index here; raw capacity remains metadata.
      capacityIndex: readNumber(properties, ['capacityIndex', 'capacityIndexValue']),
      transform: {
        position: center,
        orientation: rotationQuaternion(element.rotation),
        scale: { x: 1, y: 1, z: 1 },
      },
      portIds,
      metadata: metadata({
        sourceElementId: element.id,
        sourceElementType: element.type,
        capacityKw: readNumber(properties, ['capacityKw']),
      }),
    };
  }
  return portWorldPositions;
}

function routeNodeKind(points: Vec3[], index: number): RouteNode['kind'] {
  if (index === 0 || index === points.length - 1) return 'endpoint';
  const before = points[index - 1]!;
  const point = points[index]!;
  const after = points[index + 1]!;
  const verticalBefore = Math.hypot(point.x - before.x, point.y - before.y) <= 1e-6;
  const verticalAfter = Math.hypot(after.x - point.x, after.y - point.y) <= 1e-6;
  if (verticalBefore || verticalAfter) return 'riser';
  const ax = point.x - before.x;
  const ay = point.y - before.y;
  const az = point.z - before.z;
  const bx = after.x - point.x;
  const by = after.y - point.y;
  const bz = after.z - point.z;
  const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  return cross > 1e-6 ? 'bend' : 'route';
}

function addDiagnostic(
  document: VrfPipingDocument,
  code: string,
  message: string,
  entityIds: string[],
): void {
  const diagnostic: VrfDiagnostic = {
    id: `vrf-adapter:${code}:${entityIds.join(':')}`,
    severity: 'advisory',
    code,
    message,
    entityIds,
    source: 'migration',
  };
  document.diagnostics.push(diagnostic);
}

function buildBranchLookup(descriptors: BranchDescriptor[]) {
  const bySourceAndLine = new Map<string, BranchDescriptor>();
  const byComponentId = new Map(descriptors.map((descriptor) => [descriptor.component.id, descriptor]));
  for (const descriptor of descriptors) {
    bySourceAndLine.set(`${descriptor.element.id}|${descriptor.lineKind}`, descriptor);
  }
  return {
    find(sourceElementId: string, lineKind: AdaptedRefrigerantLineKind): BranchDescriptor | null {
      const direct = bySourceAndLine.get(`${sourceElementId}|${lineKind}`);
      if (direct) return direct;
      const source = descriptors.find((candidate) => candidate.element.id === sourceElementId);
      if (!source) {
        if (sourceElementId.startsWith('branch-pair:')) {
          const ids = sourceElementId.slice('branch-pair:'.length).split(':');
          return ids
            .map((id) => bySourceAndLine.get(`${id}|${lineKind}`))
            .find(Boolean) ?? null;
        }
        return null;
      }
      const pairedId = lineKind === 'gas'
        ? source.component.pairedGasComponentId
        : source.component.pairedLiquidComponentId;
      return (pairedId ? byComponentId.get(pairedId) : undefined) ?? null;
    },
  };
}

function endpointBinding(
  connection: EndpointConnection | null,
  lineKind: AdaptedRefrigerantLineKind,
  descriptorsByPipeSource: Map<string, PipeDescriptor>,
  branchLookup: ReturnType<typeof buildBranchLookup>,
  portWorldPositions: Map<string, Vec3>,
): EndpointBinding {
  if (!connection?.sourceElementId) return connection ? { point: connection.point } : {};
  if (connection.connectionKind === 'unit-port') {
    const portId = hvacVrfSemanticIds.equipmentPort(connection.sourceElementId, lineKind);
    return {
      equipmentPortId: portId,
      point: portWorldPositions.get(portId) ?? connection.point,
    };
  }
  if (connection.terminalRole) {
    const branch = branchLookup.find(connection.sourceElementId, lineKind);
    if (branch) {
      return {
        nodeId: branch.terminalNodeIds[connection.terminalRole],
        componentId: branch.component.id,
        terminalRole: connection.terminalRole,
        point: branch.component.id
          ? undefined
          : connection.point,
      };
    }
  }
  if (connection.nodeId) {
    return { nodeId: connection.nodeId, point: connection.point };
  }
  const sourcePipe = descriptorsByPipeSource.get(`${connection.sourceElementId}|${lineKind}`);
  if (sourcePipe) return { nodeId: sourcePipe.defaultEndNodeId, point: connection.point };
  return { point: connection.point };
}

function addEndpointPoint(points: Vec3[], binding: EndpointBinding, end: 'start' | 'end'): Vec3[] {
  if (!binding.point) return points;
  if (points.length === 0) return [binding.point];
  const index = end === 'start' ? 0 : points.length - 1;
  if (pointsEqual(points[index]!, binding.point)) {
    const next = points.slice();
    next[index] = binding.point;
    return next;
  }
  return end === 'start' ? [binding.point, ...points] : [...points, binding.point];
}

function connectedBranchNodePosition(
  document: VrfPipingDocument,
  binding: EndpointBinding,
): EndpointBinding {
  const node = binding.nodeId ? document.routeNodes[binding.nodeId] : undefined;
  return node ? { ...binding, point: node.position } : binding;
}

function addPipes(
  document: VrfPipingDocument,
  descriptors: PipeDescriptor[],
  branchDescriptors: BranchDescriptor[],
  portWorldPositions: Map<string, Vec3>,
): void {
  const branchLookup = buildBranchLookup(branchDescriptors);
  const byPipeSource = new Map<string, PipeDescriptor>();
  for (const descriptor of descriptors) {
    byPipeSource.set(`${descriptor.element.id}|${descriptor.lineKind}`, descriptor);
    if (descriptor.bundleId) byPipeSource.set(`${descriptor.bundleId}|${descriptor.lineKind}`, descriptor);
  }

  for (const descriptor of descriptors) {
    let startBinding = endpointBinding(
      descriptor.startConnection,
      descriptor.lineKind,
      byPipeSource,
      branchLookup,
      portWorldPositions,
    );
    let endBinding = endpointBinding(
      descriptor.endConnection,
      descriptor.lineKind,
      byPipeSource,
      branchLookup,
      portWorldPositions,
    );
    startBinding = connectedBranchNodePosition(document, startBinding);
    endBinding = connectedBranchNodePosition(document, endBinding);
    const fallbackZ = descriptor.element.elevation + descriptor.element.height / 2;
    let points = descriptor.explicitRoute3d.length >= 2
      ? descriptor.explicitRoute3d.map((point) => ({ ...point }))
      : interpolateRouteZ(
          descriptor.routePoints,
          fallbackZ,
          descriptor.startConnection?.point.z,
          descriptor.endConnection?.point.z,
        );
    points = addEndpointPoint(points, startBinding, 'start');
    points = addEndpointPoint(points, endBinding, 'end');
    points = dedupePoints(points);
    if (points.length < 2) {
      addDiagnostic(document, 'ADAPTER_DEGENERATE_PIPE', 'Pipe could not be projected to two route nodes.', [descriptor.runId]);
      continue;
    }

    const nodeIds = points.map((point, index) => {
      const endpoint = index === 0 ? startBinding : index === points.length - 1 ? endBinding : null;
      const id = endpoint?.nodeId
        ?? (index === 0
          ? descriptor.defaultStartNodeId
          : index === points.length - 1
            ? descriptor.defaultEndNodeId
            : hvacVrfSemanticIds.routeNode(descriptor.runId, index));
      const existing = document.routeNodes[id];
      if (!existing) {
        document.routeNodes[id] = {
          id,
          kind: endpoint?.componentId ? 'component-port' : routeNodeKind(points, index),
          position: point,
          connectedEdgeIds: [],
          equipmentPortId: endpoint?.equipmentPortId,
          componentId: endpoint?.componentId,
          metadata: metadata({
            sourceElementId: descriptor.element.id,
            sourceNodeId: endpoint && (index === 0
              ? descriptor.startConnection?.nodeId
              : descriptor.endConnection?.nodeId),
          }),
        };
      }
      return id;
    });

    const segmentEdgeIds: string[] = [];
    for (let index = 0; index < nodeIds.length - 1; index += 1) {
      const edgeId = hvacVrfSemanticIds.segmentEdge(descriptor.runId, index);
      segmentEdgeIds.push(edgeId);
      document.segmentEdges[edgeId] = {
        id: edgeId,
        kind: 'pipe-segment',
        runId: descriptor.runId,
        startNodeId: nodeIds[index]!,
        endNodeId: nodeIds[index + 1]!,
        systemType: lineSystemType(descriptor.lineKind),
        lineKind: descriptor.lineKind as RefrigerantLineKind,
        pipeKind: descriptor.pipeKind,
        nominalDiameterMm: descriptor.diameterMm,
        outsideDiameterMm: descriptor.diameterMm,
        insulationThicknessMm: descriptor.insulationThicknessMm,
        material: 'copper',
        ruleProfileId: document.activeRuleProfileId,
        metadata: metadata({ sourceElementId: descriptor.element.id, sourceSegmentIndex: index }),
      };
      document.routeNodes[nodeIds[index]!]!.connectedEdgeIds.push(edgeId);
      document.routeNodes[nodeIds[index + 1]!]!.connectedEdgeIds.push(edgeId);
    }

    const run: PipeRun = {
      id: descriptor.runId,
      kind: 'pipe-run',
      systemType: lineSystemType(descriptor.lineKind),
      lineKind: descriptor.lineKind,
      pipeKind: descriptor.pipeKind,
      nodeIds,
      segmentEdgeIds,
      sourcePortId: startBinding.equipmentPortId,
      targetPortId: endBinding.equipmentPortId,
      sourceComponentId: startBinding.componentId,
      targetComponentId: endBinding.componentId,
      ruleProfileId: document.activeRuleProfileId,
      metadata: metadata({
        sourceElementId: descriptor.element.id,
        bundleId: descriptor.bundleId,
        routeClass: descriptor.element.properties.routeClass,
        equivalentLengthMm: readNumber(descriptor.element.properties, ['equivalentLengthMm']),
        minimumBendRadiusMm: readNumber(descriptor.element.properties, ['minimumBendRadiusMm']),
        bendRadiiMm: descriptor.element.properties.bendRadiiMm,
        downstreamCapacityIndex: readNumber(descriptor.element.properties, [
          'downstreamCapacityIndex',
          'capacityIndex',
        ]),
        expectedDiameterMm: readNumber(descriptor.element.properties, [
          'expectedDiameterMm',
          'requiredDiameterMm',
        ]),
        slopeTowardOutdoorPercent: readNumber(descriptor.element.properties, [
          'slopeTowardOutdoorPercent',
          'slopePercent',
        ]),
        hasSagPocket: descriptor.element.properties.hasSagPocket,
        flowDirectionValid: descriptor.element.properties.flowDirectionValid,
      }),
    };
    document.pipeRuns[run.id] = run;

    const connectPort = (portId: string | undefined, edgeId: string | undefined) => {
      if (!portId || !edgeId) return;
      const port = document.equipmentPorts[portId];
      if (!port) {
        addDiagnostic(document, 'ADAPTER_UNKNOWN_EQUIPMENT_PORT', 'Pipe connection references an unavailable equipment port.', [run.id, portId]);
        return;
      }
      if (port.connectedEdgeId && port.connectedEdgeId !== edgeId) {
        addDiagnostic(document, 'ADAPTER_DUPLICATE_EQUIPMENT_PORT', 'Multiple pipe edges reference a single-connect equipment port.', [portId]);
      } else {
        port.connectedEdgeId = edgeId;
      }
      port.isConnected = true;
    };
    connectPort(run.sourcePortId, segmentEdgeIds[0]);
    connectPort(run.targetPortId, segmentEdgeIds[segmentEdgeIds.length - 1]);

    const registerBranchRun = (binding: EndpointBinding) => {
      if (!binding.componentId) return;
      const branch = document.branchKits[binding.componentId];
      if (!branch) return;
      const list = binding.terminalRole === 'branch-outlet' ? branch.branchRunIds! : branch.hostRunIds!;
      if (!list.includes(run.id)) list.push(run.id);
    };
    registerBranchRun(startBinding);
    registerBranchRun(endBinding);
  }

  const pairGroups = new Map<string, PipeDescriptor[]>();
  for (const descriptor of descriptors) {
    if (!descriptor.pairSourceId || !document.pipeRuns[descriptor.runId]) continue;
    const group = pairGroups.get(descriptor.pairSourceId) ?? [];
    group.push(descriptor);
    pairGroups.set(descriptor.pairSourceId, group);
  }
  for (const [sourceId, group] of pairGroups) {
    const gasRunIds = group.filter((item) => item.lineKind === 'gas').map((item) => item.runId);
    const liquidRunIds = group.filter((item) => item.lineKind === 'liquid').map((item) => item.runId);
    if (!gasRunIds.length || !liquidRunIds.length) continue;
    const id = hvacVrfSemanticIds.pipePairAssembly(sourceId);
    document.pipePairAssemblies[id] = {
      id,
      kind: 'pipe-pair-assembly',
      gasRunIds,
      liquidRunIds,
      separationMm: group.find((item) => item.pairSeparationMm !== undefined)?.pairSeparationMm ?? 0,
      allowIndependentAdjustment: true,
      flowDirection: 'forward',
      metadata: metadata({ sourceBundleId: sourceId }),
    };
    for (const runId of [...gasRunIds, ...liquidRunIds]) document.pipeRuns[runId]!.pairAssemblyId = id;
  }
}

/**
 * Projects the active editor's legacy HvacElement records into the semantic VRF
 * graph without changing or taking ownership of the persisted editor model.
 */
export function buildVrfDocumentFromHvacElements(
  elements: readonly HvacElement[],
  options: HvacElementVrfAdapterOptions = {},
): VrfPipingDocument {
  const sourceElements = [...elements];
  const document = createEmptyVrfPipingDocument(options.documentId);
  document.activeRuleProfileId = options.activeRuleProfileId
    ?? options.defaultRuleProfileId
    ?? DEFAULT_RULE_PROFILE_ID;
  document.metadata = metadata({ source: 'hvac-elements', sourceElementCount: sourceElements.length });
  const portWorldPositions = addEquipment(document, sourceElements);
  const branches = addBranchKits(document, sourceElements, options);
  addPipes(document, pipeDescriptors(sourceElements), branches, portWorldPositions);
  return document;
}

/** @deprecated Prefer the shorter public name retained by the package subpath. */
export const buildVrfPipingDocumentFromHvacElements = buildVrfDocumentFromHvacElements;
