/**
 * JSON-serializable semantic model for a VRF refrigerant-piping network.
 *
 * World coordinates are millimetres.  The records below are engineering data;
 * render meshes, hit areas and view-specific projections are derived from them.
 */

export const VRF_PIPING_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Transform3D {
  position: Vec3;
  orientation: Quaternion;
  scale: Vec3;
}

export type EquipmentPortSystemType =
  | 'refrigerant-gas'
  | 'refrigerant-liquid'
  | 'refrigerant-suction'
  | 'refrigerant-discharge'
  | 'refrigerant-equalizer'
  | 'drain';

export type RefrigerantLineKind =
  | 'gas'
  | 'liquid'
  | 'suction'
  | 'discharge'
  | 'equalizer'
  | 'drain';

export interface EquipmentPort {
  id: string;
  equipmentId: string;
  systemType: EquipmentPortSystemType;
  positionLocal: Vec3;
  directionLocal: Vec3;
  upLocal?: Vec3;
  connectionDiameterMm: number;
  connectionType: 'brazed' | 'flare' | 'socket' | 'manufacturer-kit';
  preferredExitDirection?: Vec3;
  allowedExitConeDeg?: number;
  minimumStraightStubMm?: number;
  minimumBendRadiusMm?: number;
  serviceClearanceMm?: number;
  compatiblePipeKinds: string[];
  compatibleFittingIds?: string[];
  allowMultipleConnections?: boolean;
  isConnected: boolean;
  connectedEdgeId?: string;
  metadata?: JsonObject;
}

export interface EquipmentNode {
  id: string;
  kind: 'equipment';
  equipmentType: 'indoor-unit' | 'outdoor-unit' | 'other';
  definitionId?: string;
  manufacturer?: string;
  family?: string;
  model?: string;
  capacityIndex?: number;
  transform: Transform3D;
  /** Optional transform parent for imported/nested equipment assemblies. */
  parentEquipmentId?: string;
  portIds: string[];
  metadata?: JsonObject;
}

export type RouteNodeKind =
  | 'equipment-port'
  | 'endpoint'
  | 'route'
  | 'bend'
  | 'riser'
  | 'junction'
  | 'component-port';

export interface RouteNode {
  id: string;
  kind: RouteNodeKind;
  /** Absolute model-space centreline position, in millimetres. */
  position: Vec3;
  connectedEdgeIds: string[];
  equipmentPortId?: string;
  componentId?: string;
  metadata?: JsonObject;
}

export interface PipeSegmentEdge {
  id: string;
  kind: 'pipe-segment';
  runId: string;
  startNodeId: string;
  endNodeId: string;
  systemType: EquipmentPortSystemType;
  lineKind: RefrigerantLineKind;
  pipeKind: string;
  nominalDiameterMm: number;
  outsideDiameterMm: number;
  insulationThicknessMm?: number;
  material?: string;
  ruleProfileId?: string;
  metadata?: JsonObject;
}

/** An ordered, non-branching path. Branches connect multiple runs through components. */
export interface PipeRun {
  id: string;
  kind: 'pipe-run';
  systemType: EquipmentPortSystemType;
  lineKind: RefrigerantLineKind;
  pipeKind: string;
  nodeIds: string[];
  segmentEdgeIds: string[];
  sourcePortId?: string;
  targetPortId?: string;
  sourceComponentId?: string;
  targetComponentId?: string;
  pairAssemblyId?: string;
  ruleProfileId?: string;
  metadata?: JsonObject;
}

export interface ReducerComponent {
  id: string;
  kind: 'reducer';
  systemType: EquipmentPortSystemType;
  lineKind: RefrigerantLineKind;
  inletNodeId: string;
  outletNodeId: string;
  inletDiameterMm: number;
  outletDiameterMm: number;
  position: Vec3;
  orientation: Quaternion;
  ruleProfileId?: string;
  metadata?: JsonObject;
}

export interface BranchKitComponent {
  id: string;
  kind: 'branch-kit';
  manufacturer: string;
  family: string;
  model: string;
  branchType: 'y-joint' | 'header' | 'outdoor-multi-kit';
  systemRole: 'first-branch' | 'intermediate-branch' | 'terminal-header';
  lineKind: RefrigerantLineKind;
  inletNodeIds: string[];
  outletNodeIds: string[];
  position: Vec3;
  orientation: Quaternion;
  localForward: Vec3;
  localUp: Vec3;
  splitPlaneNormal: Vec3;
  downstreamCapacityIndex: number;
  upstreamOutdoorCapacity?: number;
  pairedGasComponentId?: string;
  pairedLiquidComponentId?: string;
  hostRunIds?: string[];
  branchRunIds?: string[];
  ruleProfileId: string;
  metadata?: JsonObject;
}

/** Coordinates corresponding gas and liquid runs without merging their engineering data. */
export interface PipePairAssembly {
  id: string;
  kind: 'pipe-pair-assembly';
  gasRunIds: string[];
  liquidRunIds: string[];
  separationMm: number;
  allowIndependentAdjustment: boolean;
  flowDirection: 'forward' | 'reverse';
  gasBranchComponentIds?: string[];
  liquidBranchComponentIds?: string[];
  metadata?: JsonObject;
}

export type VrfDiagnosticSeverity = 'error' | 'warning' | 'advisory' | 'information';

export interface VrfDiagnostic {
  id: string;
  severity: VrfDiagnosticSeverity;
  code: string;
  message: string;
  entityIds: string[];
  source: 'topology' | 'migration' | 'rules' | 'routing' | 'interaction';
  details?: JsonObject;
}

export interface VrfPipingDocument {
  id: string;
  schemaVersion: number;
  equipmentNodes: Record<string, EquipmentNode>;
  equipmentPorts: Record<string, EquipmentPort>;
  routeNodes: Record<string, RouteNode>;
  segmentEdges: Record<string, PipeSegmentEdge>;
  pipeRuns: Record<string, PipeRun>;
  reducers: Record<string, ReducerComponent>;
  branchKits: Record<string, BranchKitComponent>;
  pipePairAssemblies: Record<string, PipePairAssembly>;
  diagnostics: VrfDiagnostic[];
  activeRuleProfileId?: string;
  metadata?: JsonObject;
}

export function createEmptyVrfPipingDocument(id = 'vrf-piping-network'): VrfPipingDocument {
  return {
    id,
    schemaVersion: VRF_PIPING_SCHEMA_VERSION,
    equipmentNodes: {},
    equipmentPorts: {},
    routeNodes: {},
    segmentEdges: {},
    pipeRuns: {},
    reducers: {},
    branchKits: {},
    pipePairAssemblies: {},
    diagnostics: [],
  };
}

export const IDENTITY_QUATERNION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
export const UNIT_SCALE_3D: Vec3 = { x: 1, y: 1, z: 1 };

export class VrfTopologyError extends Error {
  readonly code: string;
  readonly entityIds: string[];

  constructor(code: string, message: string, entityIds: string[] = []) {
    super(message);
    this.name = 'VrfTopologyError';
    this.code = code;
    this.entityIds = entityIds;
  }
}
