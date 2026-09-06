/**
 * Real-time branch-kit proposal engine for VRF refrigerant routing.
 *
 * While the user draws a refrigerant pipe pair from a start point (an indoor
 * unit gas/liquid port or an existing field pipe) toward an existing run, this
 * module proposes inserting a *coordinated pair* of copper branch kits — a Gas
 * branch kit on the gas line and a Liquid branch kit on the liquid line — at a
 * technically valid tee point on the target run.
 *
 * The app's catalog models branch kits as separate single-line fittings
 * (`dis-22-1g-gas` / `dis-22-1g-liquid`, see {@link ../../../data/ac-equipment-library}),
 * which matches real DIS/REFNET practice (gas and liquid branch separately but
 * are installed as a coordinated set). So a branch on a paired run is two kits.
 *
 * Preview uses the planned physical service levels. Accepting the proposal replaces
 * both host pipes with inlet/outlet runs connected to actual kit terminals.
 * An incomplete replacement is rejected atomically. The catalog geometry is
 * a layout aid; manufacturer/system capacity selection remains unverified.
 *
 * Two public entry points:
 *  - {@link proposeBranchKit} — geometry used every mouse move to drive the
 *    dashed ghost preview + the "Insert branch kit" card.
 *  - {@link buildBranchKitInsertion} — turns an accepted proposal into the
 *    concrete element additions: the two kit elements + the gas/liquid branch
 *    drop and replacement host runs.
 *
 * All distances are millimetres. This module is framework-free so it can be
 * unit-tested in isolation.
 */

import {
  DEFAULT_AC_EQUIPMENT_LIBRARY,
  type AcEquipmentDefinition,
} from '../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../types';

import { hasNewNetworkPipeClash } from './networkPipeClearance';
import {
  applyNetworkPipeLevels,
  hasNetworkCornerRiser,
  isNetworkLevelPlanCurrent,
  networkFieldConnectionLevel,
  planNetworkPipeLevels,
  replanNetworkPipeRisers,
  type NetworkPipeLevelPlan,
} from './networkPipeLevels';
import { buildOrthogonalConnectionRouteCandidates, type OrthogonalConnectionRouteOptions } from './orthogonalConnectionRoute';
import {
  normalizePipeRouteNodes3d,
  splitPipeRoute3dAtPlanInterval,
  type PipeRouteNode3D,
} from './pipeRoute3d';
import {
  DEFAULT_PIPE_ROUTING_SETTINGS,
  getActivePipeRoutingSettings,
  type PipeRoutingSettings,
} from './pipeRoutingSettings';
import { splitPolylineAtStation } from './pipeTopology';
import {
  buildRefrigerantBranchKitViewModel,
  resolveRefrigerantBranchKitConnectionIdentity,
  resolveRefrigerantBranchKitInlineAnchorLocal,
  type RefrigerantBranchKitModelSpec,
  type RefrigerantBranchLineKind,
} from './refrigerantBranchKitModel';
import {
  buildRefrigerantPipeElement,
  buildRefrigerantPipeElements,
  findNearestRefrigerantPipeBundleSegmentTarget,
  findNearestRefrigerantPipeSegmentTarget,
  getRefrigerantPipeBundleSegmentTargets,
  getUnitPortApproachStraightMm,
  refrigerantBranchKitTerminalIds,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleSegmentConnection,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
  type RefrigerantPipeMaterial,
  type RefrigerantPipeSegmentConnection,
} from './refrigerantPipePairModel';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How the branched route relates to the network it is tapping into. */
export type BranchKitConnectionType =
  | 'indoor-to-branch'
  | 'indoor-to-sub-branch'
  | 'sub-branch-to-main-branch'
  | 'branch-to-main-line'
  | 'generic-tee';

/**
 * `valid`       — the tee sits at a clean station, nothing in the way.
 * `needs-nudge` — geometry forced the kit to slide along the run to fit (the
 *                 cursor was too near a bend / run end); still installable.
 * `invalid`     — no station on this run can host the kit (too short, blocked).
 */
export type BranchKitProposalValidity = 'valid' | 'needs-nudge' | 'invalid';

/** One single-line branch kit (gas or liquid) of the coordinated pair. */
export interface BranchKitGhost {
  lineKind: RefrigerantBranchLineKind;
  /** A renderable element (no id) — spread an id onto it for preview/commit. */
  element: Omit<HvacElement, 'id'>;
  center: Point2D;
  rotationDeg: number;
  /** Inline anchor on the run centerline (== `branchKitSnapPoint`). */
  stationPoint: Point2D;
  inletPoint: Point2D;
  runOutletPoint: Point2D;
  branchOutletPoint: Point2D;
  /** Outward unit direction of the branch outlet (points toward the drop). */
  branchOutletDirection: Point2D;
  outerDiameterMm: number;
  /** True when the kit had to slide to keep clearance from the run ends. */
  nudged: boolean;
}

export interface BranchKitProposalTarget {
  /** bundleId of the tapped run (from the bundle snap target). */
  sourceId: string;
  segmentStart: Point2D;
  segmentEnd: Point2D;
  segmentLengthMm: number;
  direction: Point2D;
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasOuterDiameterMm: number;
  liquidOuterDiameterMm: number;
  elevationMm: number;
  gasElevationMm: number;
  liquidElevationMm: number;
}

export interface BranchKitProposal {
  connectionType: BranchKitConnectionType;
  validity: BranchKitProposalValidity;
  violations: string[];
  /** Lower is better (cursor distance + penalties); used to rank candidates. */
  score: number;
  /** Bundle-centerline tee station (anchor for the card + screen position). */
  teePoint: Point2D;
  runDirection: Point2D;
  gasGhost: BranchKitGhost;
  liquidGhost: BranchKitGhost;
  target: BranchKitProposalTarget;
  /** True when the branch outlets were flipped to face the opposite side. */
  flip: boolean;
  /** Source topology fixes inlet/outlet orientation; a visual flip would reverse it. */
  orientationLocked?: boolean;
  /** Geometry alone cannot establish an approved manufacturer kit selection. */
  selectionStatus?: 'layout-only';
  notes?: string[];
  levelPlan?: NetworkPipeLevelPlan;
  /** Exact selected guide, shared by the ghost preview and atomic insertion. */
  connectionRoute?: Point2D[];
  /** Explicit auto-route radius policy; absent for existing manual workflows. */
  bendRadiusFactor?: number;
  /** Geometric drafting issues may be solved by another level/station. */
  failureReason?: 'approach' | 'interference' | 'levels' | 'station';
}

export interface ProposeBranchKitOptions {
  /** Capture radius (mm) within which a run becomes a proposal candidate. */
  proposalRadiusMm?: number;
  /** Run sourceIds / element ids never tee'd into (e.g. the start's own run). */
  excludeSourceIds?: string[];
  /** Force the branch outlets to the flipped side (user pressed "Flip"). */
  flip?: boolean;
  settings?: PipeRoutingSettings;
  authoredRoute?: readonly Point2D[];
  bendRadiusFactor?: number;
  /** Bounded background network searches already evaluate several stations. */
  maxRecoveryStations?: number;
}

/** The concrete element additions produced when a proposal is accepted. */
export interface BranchKitInsertion {
  /** Kit pair + the gas/liquid branch drop, each with a fresh id. */
  elementsToAdd: HvacElement[];
  /**
   * Original host runs replaced by the fitting and connected inlet/outlet halves.
   */
  removeElementIds: string[];
  /** Ids of the two created kit elements (gas, liquid) for selection. */
  kitElementIds: string[];
  updates?: HvacElement[];
}

// ---------------------------------------------------------------------------
// Vector helpers (local, mirroring the per-file pattern across this folder)
// ---------------------------------------------------------------------------

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(p: Point2D, f: number): Point2D {
  return { x: p.x * f, y: p.y * f };
}
function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}
function lengthOf(p: Point2D): number {
  return Math.hypot(p.x, p.y);
}
function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function normalize(p: Point2D): Point2D {
  const len = lengthOf(p);
  return len < 1e-6 ? { x: 1, y: 0 } : { x: p.x / len, y: p.y / len };
}
function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
/** Drop consecutive duplicate points. */
function dedupeConsecutive(points: Point2D[]): Point2D[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || distance(previous, point) > 1e-3;
  });
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function angleDeg(p: Point2D): number {
  return (Math.atan2(p.y, p.x) * 180) / Math.PI;
}
/** Standard CCW rotation — must match `rotatePoint` in refrigerantBranchKitModel. */
function rotateDeg(p: Point2D, deg: number): Point2D {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Catalog kit definitions (resolved once)
// ---------------------------------------------------------------------------

const GAS_BRANCH_KIT_DEFINITION_ID = 'ac-branch-kit-dis-22-1g';
const LIQUID_BRANCH_KIT_DEFINITION_ID = 'ac-branch-kit-dis-22-1g-liquid';

function findKitDefinition(id: string): AcEquipmentDefinition | null {
  return DEFAULT_AC_EQUIPMENT_LIBRARY.find((definition) => definition.id === id) ?? null;
}

function kitDefinitionFor(lineKind: RefrigerantBranchLineKind): AcEquipmentDefinition | null {
  return findKitDefinition(
    lineKind === 'gas' ? GAS_BRANCH_KIT_DEFINITION_ID : LIQUID_BRANCH_KIT_DEFINITION_ID,
  );
}

let branchKitIdCounter = 0;
function createBranchKitElementId(prefix: string): string {
  branchKitIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${branchKitIdCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Single-line kit footprint (along-run reach) + placement
// ---------------------------------------------------------------------------

interface LineKitFootprint {
  model: RefrigerantBranchKitModelSpec;
  anchorLocal: Point2D;
  anchorDirectionLocal: Point2D;
  requiredBackwardMm: number;
  requiredForwardMm: number;
}

function resolveLineKitFootprint(
  model: RefrigerantBranchKitModelSpec,
  lineKind: RefrigerantBranchLineKind,
): LineKitFootprint {
  const line = lineKind === 'gas' ? model.gas : model.liquid;
  const anchorLocal = resolveRefrigerantBranchKitInlineAnchorLocal(model, lineKind);
  const anchorDirectionLocal = normalize(
    subtract(line.runOutletTerminal.point, line.inletTerminal.point),
  );
  // Project the inlet/run-outlet onto the trunk axis, measured from the anchor.
  const throughPoints = [line.inletTerminal.point, line.runOutletTerminal.point];
  const scalars = throughPoints.map((point) =>
    dot(subtract(point, anchorLocal), anchorDirectionLocal),
  );
  const requiredBackwardMm = Math.max(0, -Math.min(...scalars));
  const requiredForwardMm = Math.max(0, Math.max(...scalars));
  return { model, anchorLocal, anchorDirectionLocal, requiredBackwardMm, requiredForwardMm };
}

interface PlaceKitParams {
  lineKind: RefrigerantBranchLineKind;
  segment: RefrigerantPipeSegmentConnection;
  faceToward: Point2D;
  clearanceMm: number;
  flip: boolean;
  /** Direction from the tee station toward the outdoor-unit side of the run. */
  upstreamDirection?: Point2D | null;
}

/**
 * Places one single-line branch kit on its run line, matching the manual
 * placement tool: clamps the inline station so the kit body + clearance fits,
 * orients the trunk along the run, faces the branch outlet toward `faceToward`,
 * and stores the full `branchKitSnap*` metadata the renderer consumes.
 */
function placeKitOnLineSegment(params: PlaceKitParams): BranchKitGhost | null {
  const { lineKind, segment, faceToward, clearanceMm } = params;
  const definition = kitDefinitionFor(lineKind);
  if (!definition) return null;

  const baseProperties: Record<string, unknown> = {
    definitionId: definition.id,
    ...definition.defaultProperties,
  };
  const buildRolledModel = (rollDeg: 0 | 180) => {
    const properties = { ...baseProperties, branchKitRollDeg: rollDeg };
    const model = buildRefrigerantBranchKitViewModel({
      type: 'refrigerant-branch-kit',
      subtype: definition.subtype,
      modelLabel: definition.modelLabel,
      properties,
    });
    return { model, properties, rollDeg };
  };
  const unrolled = buildRolledModel(0);
  const footprint = resolveLineKitFootprint(unrolled.model, lineKind);
  const runDirection = normalize(segment.direction);

  // A plan rotation chooses the through-flow direction. A 180-degree physical
  // roll about the trunk independently chooses which side receives the branch.
  // Both operations preserve the straight-through station and fitting reach.
  const halfReachMm = Math.max(footprint.requiredBackwardMm, footprint.requiredForwardMm);
  const minStation = halfReachMm + clearanceMm;
  const maxStation = segment.segmentLengthMm - halfReachMm - clearanceMm;
  if (maxStation < minStation) return null;
  const clampedStation = clamp(segment.projectedDistanceMm, minStation, maxStation);
  const nudged = Math.abs(clampedStation - segment.projectedDistanceMm) > 1;
  const stationPoint = add(segment.segmentStart, scale(runDirection, clampedStation));
  const baseRotationDeg = angleDeg(runDirection) - angleDeg(footprint.anchorDirectionLocal);
  const candidateRotations = [baseRotationDeg, baseRotationDeg + 180];
  const rolledModels = [unrolled, buildRolledModel(180)];

  const evaluated = candidateRotations.flatMap((rotationDeg) => rolledModels.map((candidate) => {
    const candidateFootprint = resolveLineKitFootprint(candidate.model, lineKind);
    const center = subtract(stationPoint, rotateDeg(candidateFootprint.anchorLocal, rotationDeg));
    const branchIdentity = resolveRefrigerantBranchKitConnectionIdentity({
      model: candidate.model,
      role: 'branch-outlet',
      lineSelection: lineKind,
      worldCenter: center,
      rotationDeg,
    });
    const inletIdentity = resolveRefrigerantBranchKitConnectionIdentity({
      model: candidate.model,
      role: 'inlet',
      lineSelection: lineKind,
      worldCenter: center,
      rotationDeg,
    });
    if (!branchIdentity || !inletIdentity) return null;
    const branchOutletPoint = lineKind === 'gas'
      ? branchIdentity.gasPoint : branchIdentity.liquidPoint;
    const inletPoint = lineKind === 'gas' ? inletIdentity.gasPoint : inletIdentity.liquidPoint;
    return {
      ...candidate,
      footprint: candidateFootprint,
      rotationDeg,
      center,
      faceScore: distance(branchOutletPoint, faceToward),
      upstreamScore: params.upstreamDirection
        ? dot(normalize(subtract(inletPoint, stationPoint)), params.upstreamDirection) : 0,
    };
  }).filter((value): value is NonNullable<typeof value> => value !== null));
  if (evaluated.length === 0) return null;

  const compareBranchSide = (
    left: (typeof evaluated)[number],
    right: (typeof evaluated)[number],
  ) => left.faceScore - right.faceScore || left.rollDeg - right.rollDeg;
  let chosen: (typeof evaluated)[number];
  if (params.upstreamDirection) {
    evaluated.sort((left, right) => {
      const upstreamDifference = right.upstreamScore - left.upstreamScore;
      return Math.abs(upstreamDifference) > 1e-6
        ? upstreamDifference
        : compareBranchSide(left, right);
    });
    chosen = evaluated[0]!;
  } else {
    // Reverse inlet direction still selects the opposite through-flow choice;
    // the joint roll is optimized inside each choice and does not hijack Flip.
    const flowChoices = candidateRotations.map((rotationDeg) => evaluated
      .filter((candidate) => Math.abs(candidate.rotationDeg - rotationDeg) < 0.01)
      .sort(compareBranchSide)[0]!)
      .sort(compareBranchSide);
    chosen = params.flip && flowChoices.length > 1 ? flowChoices[1]! : flowChoices[0]!;
  }

  const terminalIdentity = (role: 'inlet' | 'run-outlet' | 'branch-outlet') =>
    resolveRefrigerantBranchKitConnectionIdentity({
      model: chosen.model,
      role,
      lineSelection: lineKind,
      worldCenter: chosen.center,
      rotationDeg: chosen.rotationDeg,
    });
  const inletId = terminalIdentity('inlet');
  const runOutletId = terminalIdentity('run-outlet');
  const branchOutletId = terminalIdentity('branch-outlet');
  if (!inletId || !runOutletId || !branchOutletId) return null;
  const pick = (id: NonNullable<ReturnType<typeof resolveRefrigerantBranchKitConnectionIdentity>>) =>
    lineKind === 'gas'
      ? { point: id.gasPoint, direction: id.gasDirection }
      : { point: id.liquidPoint, direction: id.liquidDirection };
  const inlet = pick(inletId);
  const runOutlet = pick(runOutletId);
  const branchOutlet = pick(branchOutletId);
  const line = lineKind === 'gas' ? chosen.model.gas : chosen.model.liquid;
  const position: Point2D = {
    x: chosen.center.x - chosen.model.widthMm / 2,
    y: chosen.center.y - chosen.model.depthMm / 2,
  };
  const element: Omit<HvacElement, 'id'> = {
    type: 'refrigerant-branch-kit',
    category: 'accessory',
    subtype: definition.subtype,
    modelLabel: definition.modelLabel,
    position,
    rotation: chosen.rotationDeg,
    width: chosen.model.widthMm,
    depth: chosen.model.depthMm,
    height: chosen.model.heightMm,
    elevation: segment.elevationMm - line.centerlineZMm,
    mountType: 'ceiling',
    label: definition.name,
    supplyZoneRatio: definition.supplyZoneRatio ?? 0.5,
    properties: {
      ...chosen.properties,
      branchKitPlacementMode: 'fixed',
      branchKitSnapLineKind: lineKind,
      branchKitSnapAnchorLocal: chosen.footprint.anchorLocal,
      branchKitSnapSourceElementId: segment.sourceElementId ?? null,
      branchKitSnapConnectionKind: 'field-pipe',
      branchKitSnapPoint: stationPoint,
      branchKitSnapDirection: runDirection,
      branchKitSnapSegmentStart: segment.segmentStart,
      branchKitSnapSegmentEnd: segment.segmentEnd,
      branchKitSnapProjectedDistanceMm: clampedStation,
      routeClass: 'branch',
      branchKitSelectionStatus: 'layout-only',
    },
  };

  return {
    lineKind,
    element,
    center: chosen.center,
    rotationDeg: chosen.rotationDeg,
    stationPoint,
    inletPoint: inlet.point,
    runOutletPoint: runOutlet.point,
    branchOutletPoint: branchOutlet.point,
    branchOutletDirection: normalize(branchOutlet.direction),
    outerDiameterMm: line.inletTerminal.outerDiameterMm,
    nudged,
  };
}

// ---------------------------------------------------------------------------
// Connection-type classification (heuristic — refined later by the graph)
// ---------------------------------------------------------------------------

function classifyConnectionType(
  startBundle: RefrigerantPipeBundleConnection,
  target: BranchKitProposalTarget,
): BranchKitConnectionType {
  const startGasOd = startBundle.gasOuterDiameterMm ?? 0;
  const targetGasOd = target.gasOuterDiameterMm;
  const targetLarger = targetGasOd >= startGasOd * 1.12;
  if (startBundle.connectionKind === 'unit-port') {
    return targetLarger ? 'indoor-to-branch' : 'indoor-to-sub-branch';
  }
  if (targetGasOd >= startGasOd * 1.25) {
    return 'branch-to-main-line';
  }
  if (targetLarger) {
    return 'sub-branch-to-main-branch';
  }
  return 'generic-tee';
}

// ---------------------------------------------------------------------------
// Clearance / validity checks
// ---------------------------------------------------------------------------

function isIndoorUnitElement(element: HvacElement): boolean {
  return element.category === 'indoor-unit';
}

function elementCenter(element: HvacElement): Point2D {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
}

function kitOverlapsUnitClearance(
  ghost: BranchKitGhost,
  unit: HvacElement,
  marginMm: number,
): boolean {
  // Separating-axis test includes the entire fitting and rotated unit body;
  // testing only the tee station misses sockets intruding into equipment.
  const corners = (center: Point2D, width: number, depth: number, rotation: number) =>
    [
      { x: -width / 2, y: -depth / 2 }, { x: width / 2, y: -depth / 2 },
      { x: width / 2, y: depth / 2 }, { x: -width / 2, y: depth / 2 },
    ].map((point) => add(center, rotateDeg(point, rotation)));
  const kitCorners = corners(ghost.center, ghost.element.width, ghost.element.depth, ghost.rotationDeg);
  const unitCorners = corners(elementCenter(unit), unit.width + marginMm * 2, unit.depth + marginMm * 2, unit.rotation);
  const axes = [ghost.rotationDeg, unit.rotation]
    .flatMap((rotation) => [rotateDeg({ x: 1, y: 0 }, rotation), rotateDeg({ x: 0, y: 1 }, rotation)]);
  return axes.every((axis) => {
    const kitValues = kitCorners.map((point) => dot(point, axis));
    const unitValues = unitCorners.map((point) => dot(point, axis));
    return Math.max(...kitValues) >= Math.min(...unitValues) &&
      Math.max(...unitValues) >= Math.min(...kitValues);
  });
}

function branchStationClearanceViolation(
  gasGhost: BranchKitGhost,
  liquidGhost: BranchKitGhost,
  teePoint: Point2D,
  scene: readonly HvacElement[],
  settings: PipeRoutingSettings,
): string | null {
  const minKitSpacingMm = resolveMinBranchKitSpacingMm(settings);
  const unitClearanceMm = Math.max(0, settings.defaultUnitClearanceMm);
  for (const element of scene) {
    if (element.type === 'refrigerant-branch-kit'
      && distance(elementCenter(element), teePoint) < minKitSpacingMm) {
      return 'Too close to an existing branch kit.';
    }
    if (isIndoorUnitElement(element)
      && (kitOverlapsUnitClearance(gasGhost, element, unitClearanceMm)
        || kitOverlapsUnitClearance(liquidGhost, element, unitClearanceMm))) {
      return 'Inside an indoor unit clearance zone.';
    }
  }
  return null;
}

function resolveMinBranchKitSpacingMm(settings: PipeRoutingSettings): number {
  const candidate = settings.minBranchKitSpacingMm;
  if (isFiniteNumber(candidate) && candidate > 0) {
    return candidate;
  }
  const gasDefinition = kitDefinitionFor('gas');
  return (gasDefinition?.widthMm ?? 442) * 0.75;
}

function estimateMinRunLengthMm(): number {
  const gasDefinition = kitDefinitionFor('gas');
  return (gasDefinition?.widthMm ?? 442) + 1;
}

function resolveBranchFaceToward(
  startBundle: RefrigerantPipeBundleConnection,
  targetLinePoint: Point2D,
  runDirection: Point2D,
  authoredRoute?: readonly Point2D[],
): Point2D {
  const normal = { x: -runDirection.y, y: runDirection.x };
  if (authoredRoute) {
    for (let index = authoredRoute.length - 1; index >= 0; index -= 1) {
      const point = authoredRoute[index];
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      // A point on the trunk carries no takeoff-side intent. Work backwards to
      // the last waypoint that clearly establishes the authored approach side.
      if (Math.abs(dot(subtract(point, targetLinePoint), normal)) > 1) return point;
    }
  }
  return startBundle.point ?? targetLinePoint;
}

// ---------------------------------------------------------------------------
// Upstream flow resolution
// ---------------------------------------------------------------------------

type FlowEndpointSide = 'start' | 'end';

interface FlowEndpoint {
  key: string;
  pipeId: string;
  lineKind: RefrigerantBranchLineKind;
  side: FlowEndpointSide;
  point: Point2D;
  connection: RefrigerantPipeConnection | null;
}

interface FlowEdge {
  key: string;
  weight: number;
}

const MAX_FLOW_GRAPH_ENDPOINTS = 2048;

function addFlowEdge(
  adjacency: Map<string, FlowEdge[]>,
  left: string,
  right: string,
  weight: number,
): void {
  if (left === right) return;
  adjacency.get(left)?.push({ key: right, weight });
  adjacency.get(right)?.push({ key: left, weight });
}

function pointToPolylineDistance(point: Point2D, route: readonly Point2D[]): number {
  if (route.length === 0) return Number.POSITIVE_INFINITY;
  if (route.length === 1) return distance(point, route[0]!);
  let result = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const delta = subtract(route[index + 1]!, start);
    const lengthSquared = dot(delta, delta);
    const t = lengthSquared <= 1e-9
      ? 0
      : clamp(dot(subtract(point, start), delta) / lengthSquared, 0, 1);
    result = Math.min(result, distance(point, add(start, scale(delta, t))));
  }
  return result;
}

function shortestFlowDistances(
  endpoints: ReadonlyMap<string, FlowEndpoint>,
  adjacency: ReadonlyMap<string, FlowEdge[]>,
  roots: readonly string[],
): Map<string, number> {
  const distances = new Map<string, number>();
  roots.forEach((key) => distances.set(key, 0));
  const visited = new Set<string>();
  while (visited.size < endpoints.size) {
    let nextKey: string | null = null;
    let nextDistance = Number.POSITIVE_INFINITY;
    for (const key of endpoints.keys()) {
      if (visited.has(key)) continue;
      const candidate = distances.get(key) ?? Number.POSITIVE_INFINITY;
      if (
        candidate < nextDistance - 1e-6
        || (Math.abs(candidate - nextDistance) <= 1e-6 && key < (nextKey ?? '\uffff'))
      ) {
        nextKey = key;
        nextDistance = candidate;
      }
    }
    if (!nextKey || !Number.isFinite(nextDistance)) break;
    visited.add(nextKey);
    for (const edge of adjacency.get(nextKey) ?? []) {
      const candidate = nextDistance + edge.weight;
      if (candidate < (distances.get(edge.key) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.key, candidate);
      }
    }
  }
  return distances;
}

/**
 * Finds which end of a host pipe is closer through real topology to an outdoor
 * unit. The graph is deliberately bounded and uses only persisted connections:
 * pipe bodies, explicit pipe-to-pipe references, and branch-kit terminal roles.
 * Geometry is used to select the tapped host, never to invent connectivity.
 */
function resolveHostRunUpstreamDirection(
  scene: HvacElement[],
  segment: RefrigerantPipeSegmentConnection,
  lineKind: RefrigerantBranchLineKind,
): Point2D | null {
  const outdoorIds = new Set(
    scene.filter((element) => element.type === 'outdoor-unit').map((element) => element.id),
  );
  if (outdoorIds.size === 0) return null;

  const pipes = scene
    .filter((element) => element.type === 'refrigerant-pipe')
    .map((element) => ({
      element,
      spec: resolveRefrigerantPipeSpec(element.properties, scene),
    }))
    .filter(({ spec }) => spec.lineKind === lineKind && spec.routePoints.length >= 2)
    .sort((left, right) => left.element.id.localeCompare(right.element.id))
    .slice(0, MAX_FLOW_GRAPH_ENDPOINTS / 2);
  const hostCandidates = pipes
    .filter(({ element, spec }) =>
      element.id === segment.sourceElementId || spec.bundleId === segment.sourceElementId)
    .sort((left, right) =>
      pointToPolylineDistance(segment.point, left.spec.routePoints)
        - pointToPolylineDistance(segment.point, right.spec.routePoints)
      || left.element.id.localeCompare(right.element.id));
  const host = hostCandidates[0];
  if (!host) return null;

  // The overwhelmingly common path is a host run attached directly to the
  // outdoor unit. Resolve it before constructing the wider graph so mouse-move
  // proposal updates stay cheap even in a large scene.
  const startIsOutdoor = host.spec.startConnection?.connectionKind === 'unit-port'
    && !!host.spec.startConnection.sourceElementId
    && outdoorIds.has(host.spec.startConnection.sourceElementId);
  const endIsOutdoor = host.spec.endConnection?.connectionKind === 'unit-port'
    && !!host.spec.endConnection.sourceElementId
    && outdoorIds.has(host.spec.endConnection.sourceElementId);
  if (startIsOutdoor !== endIsOutdoor) {
    return startIsOutdoor
      ? scale(normalize(segment.direction), -1)
      : normalize(segment.direction);
  }

  const endpoints = new Map<string, FlowEndpoint>();
  const adjacency = new Map<string, FlowEdge[]>();
  const roots: string[] = [];

  for (const { element, spec } of pipes) {
    const route = spec.routePoints;
    const pair: FlowEndpoint[] = [
      {
        key: `${element.id}:start`,
        pipeId: element.id,
        lineKind,
        side: 'start',
        point: route[0]!,
        connection: spec.startConnection,
      },
      {
        key: `${element.id}:end`,
        pipeId: element.id,
        lineKind,
        side: 'end',
        point: route[route.length - 1]!,
        connection: spec.endConnection,
      },
    ];
    pair.forEach((endpoint) => {
      endpoints.set(endpoint.key, endpoint);
      adjacency.set(endpoint.key, []);
      if (
        endpoint.connection?.connectionKind === 'unit-port'
        && endpoint.connection.sourceElementId
        && outdoorIds.has(endpoint.connection.sourceElementId)
      ) {
        roots.push(endpoint.key);
      }
    });
    addFlowEdge(adjacency, pair[0]!.key, pair[1]!.key, Math.max(1, polylineLength(route)));
  }
  if (roots.length === 0) return null;

  // Explicit node/port identities bind pipe ends without a proximity guess.
  const identityGroups = new Map<string, string[]>();
  for (const endpoint of endpoints.values()) {
    const connection = endpoint.connection;
    const identity = connection?.nodeId ?? connection?.portId;
    if (!identity) continue;
    const group = identityGroups.get(identity) ?? [];
    group.push(endpoint.key);
    identityGroups.set(identity, group);
  }
  for (const group of identityGroups.values()) {
    for (let index = 1; index < group.length; index += 1) {
      addFlowEdge(adjacency, group[0]!, group[index]!, 1);
    }
  }

  // A branch kit connects inlet to each outlet. Keeping outlet-to-outlet out of
  // the graph preserves the fitting's flow semantics while still allowing the
  // resolver to walk through any number of already-inserted tees.
  const branchGroups = new Map<string, FlowEndpoint[]>();
  for (const endpoint of endpoints.values()) {
    const connection = endpoint.connection;
    if (
      connection?.connectionKind !== 'field-pipe'
      || !connection.sourceElementId
      || !connection.terminalRole
    ) continue;
    const key = `${connection.sourceElementId}:${lineKind}`;
    const group = branchGroups.get(key) ?? [];
    group.push(endpoint);
    branchGroups.set(key, group);
  }
  for (const group of branchGroups.values()) {
    const inlets = group.filter((endpoint) => endpoint.connection?.terminalRole === 'inlet');
    const outlets = group.filter((endpoint) => endpoint.connection?.terminalRole !== 'inlet');
    for (const inlet of inlets) {
      for (const outlet of outlets) addFlowEdge(adjacency, inlet.key, outlet.key, 1);
    }
  }

  // Some legacy field-pipe connections point at the owning pipe rather than a
  // shared node id. The explicit source id is authoritative; the port point
  // merely chooses which of that pipe's two ends it names.
  for (const endpoint of endpoints.values()) {
    const connection = endpoint.connection;
    if (connection?.connectionKind !== 'field-pipe' || !connection.sourceElementId) continue;
    const candidates = [...endpoints.values()].filter(
      (candidate) => candidate.pipeId === connection.sourceElementId,
    );
    candidates.sort((left, right) =>
      distance(connection.portPoint, left.point) - distance(connection.portPoint, right.point)
      || left.key.localeCompare(right.key));
    if (candidates[0]) addFlowEdge(adjacency, endpoint.key, candidates[0].key, 1);
  }

  const distances = shortestFlowDistances(endpoints, adjacency, roots);
  const startDistance = distances.get(`${host.element.id}:start`) ?? Number.POSITIVE_INFINITY;
  const endDistance = distances.get(`${host.element.id}:end`) ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(startDistance) && !Number.isFinite(endDistance)) return null;
  if (Math.abs(startDistance - endDistance) <= 1) return null;
  return startDistance < endDistance
    ? scale(normalize(segment.direction), -1)
    : normalize(segment.direction);
}

function combineUpstreamDirections(
  gasDirection: Point2D | null,
  liquidDirection: Point2D | null,
): Point2D | null {
  if (!gasDirection) return liquidDirection;
  if (!liquidDirection) return gasDirection;
  if (dot(gasDirection, liquidDirection) < 0.5) return null;
  return normalize(add(gasDirection, liquidDirection));
}

// ---------------------------------------------------------------------------
// proposeBranchKit
// ---------------------------------------------------------------------------

function findLineSegmentNear(
  scene: HvacElement[],
  lineKind: RefrigerantBranchLineKind,
  point: Point2D,
  radiusMm: number,
  minSegmentLengthMm: number,
  sourceElementId?: string,
): RefrigerantPipeSegmentConnection | null {
  const candidates = sourceElementId
    ? scene.filter((element) => element.id === sourceElementId)
    : scene;
  const target = findNearestRefrigerantPipeSegmentTarget(candidates, point, radiusMm, { lineKind, minSegmentLengthMm });
  return target && sourceElementId ? { ...target, sourceElementId } : target;
}

function kitStationInterval(
  lineKind: RefrigerantBranchLineKind,
  segment: RefrigerantPipeSegmentConnection,
  direction: Point2D,
  clearanceMm: number,
): { minimum: number; maximum: number } {
  const definition = kitDefinitionFor(lineKind)!;
  const model = buildRefrigerantBranchKitViewModel({
    type: 'refrigerant-branch-kit',
    subtype: definition.subtype,
    modelLabel: definition.modelLabel,
    properties: definition.defaultProperties ?? {},
  });
  const footprint = resolveLineKitFootprint(model, lineKind);
  const margin = Math.max(footprint.requiredBackwardMm, footprint.requiredForwardMm) + clearanceMm;
  const start = dot(segment.segmentStart, direction);
  const end = dot(segment.segmentEnd, direction);
  return { minimum: Math.min(start, end) + margin, maximum: Math.max(start, end) - margin };
}

function segmentAtScalar(
  segment: RefrigerantPipeSegmentConnection,
  scalar: number,
  direction: Point2D,
): RefrigerantPipeSegmentConnection {
  const shift = scalar - dot(segment.point, direction);
  const point = add(segment.point, scale(direction, shift));
  return {
    ...segment,
    point,
    projectedDistanceMm: dot(subtract(point, segment.segmentStart), normalize(segment.direction)),
  };
}

function projectBundleTargetAtPoint(
  target: RefrigerantPipeBundleSegmentConnection,
  point: Point2D,
): RefrigerantPipeBundleSegmentConnection {
  const direction = normalize(subtract(target.segmentEnd, target.segmentStart));
  const lengthMm = distance(target.segmentStart, target.segmentEnd);
  const projectedDistanceMm = clamp(
    dot(subtract(point, target.segmentStart), direction),
    0,
    lengthMm,
  );
  const scalar = dot(target.segmentStart, direction) + projectedDistanceMm;
  const moveToScalar = (linePoint: Point2D) =>
    add(linePoint, scale(direction, scalar - dot(linePoint, direction)));
  const bundlePoint = add(target.segmentStart, scale(direction, projectedDistanceMm));
  const gasPoint = moveToScalar(target.gasPoint);
  const liquidPoint = moveToScalar(target.liquidPoint);
  return {
    ...target,
    point: bundlePoint,
    gasPoint,
    liquidPoint,
    gasFieldPoint: gasPoint,
    liquidFieldPoint: liquidPoint,
    direction,
    segmentLengthMm: lengthMm,
    projectedDistanceMm,
  };
}

interface BranchRecoveryStation {
  point: Point2D;
  target: RefrigerantPipeBundleSegmentConnection;
  movementMm: number;
}

/**
 * Build a small, deterministic nearest-first search over every eligible level
 * straight belonging to the originally selected physical gas/liquid hosts.
 * Local increments handle common fitting/clearance conflicts; interval ends and
 * broad span fractions cover long or heavily obstructed mains without a dense
 * scan on every pointer move. Every returned station still receives the full
 * topology, level, straight-length, unit-clearance, and pipe-clash validation.
 */
function branchRecoveryStations(
  scene: HvacElement[],
  first: BranchKitProposal,
  cursorPoint: Point2D,
  settings: PipeRoutingSettings,
): BranchRecoveryStation[] {
  const gasId = first.gasGhost.element.properties.branchKitSnapSourceElementId;
  const liquidId = first.liquidGhost.element.properties.branchKitSnapSourceElementId;
  if (typeof gasId !== 'string' || typeof liquidId !== 'string') return [];
  const hosts = scene.filter((element) => element.id === gasId || element.id === liquidId);
  const targets = getRefrigerantPipeBundleSegmentTargets(hosts, {
    minSegmentLengthMm: estimateMinRunLengthMm(),
  }).filter((target) => target.gasSourceElementId === gasId
    && target.liquidSourceElementId === liquidId);
  const fittingMarginMm = estimateMinRunLengthMm() / 2
    + Math.max(0, settings.defaultBranchKitClearanceMm);
  const incrementMm = Math.max(200, Math.min(300, settings.defaultBranchKitClearanceMm || 250));
  const offsetFactors = [1, 3, 7];
  const candidates: BranchRecoveryStation[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const direction = normalize(subtract(target.segmentEnd, target.segmentStart));
    const lengthMm = distance(target.segmentStart, target.segmentEnd);
    const minimum = fittingMarginMm;
    const maximum = lengthMm - fittingMarginMm;
    if (maximum < minimum) continue;
    const desired = clamp(dot(subtract(cursorPoint, target.segmentStart), direction), minimum, maximum);
    const stations = [
      desired,
      ...offsetFactors.flatMap((factor) => [
        desired - incrementMm * factor,
        desired + incrementMm * factor,
      ]),
      minimum,
      maximum,
      minimum + (maximum - minimum) * 0.25,
      minimum + (maximum - minimum) * 0.5,
      minimum + (maximum - minimum) * 0.75,
    ];
    for (const rawStation of stations) {
      const station = clamp(rawStation, minimum, maximum);
      const point = add(target.segmentStart, scale(direction, station));
      const key = `${gasId}\u0000${liquidId}\u0000${point.x.toFixed(3)}\u0000${point.y.toFixed(3)}`;
      if (seen.has(key) || distance(point, first.teePoint) <= 0.5) continue;
      seen.add(key);
      candidates.push({ point, target, movementMm: distance(cursorPoint, point) });
    }
  }
  return candidates
    .sort((left, right) => left.movementMm - right.movementMm
      || left.point.x - right.point.x || left.point.y - right.point.y)
    .slice(0, 16);
}

export function proposeBranchKit(
  scene: HvacElement[],
  startBundle: RefrigerantPipeBundleConnection | null,
  cursorPoint: Point2D,
  options?: ProposeBranchKitOptions,
): BranchKitProposal | null {
  if (!startBundle) return null;
  const settings = options?.settings ?? getActivePipeRoutingSettings();
  // Recovery stations reuse the same immutable level plan. Its three service
  // fallback variants need rebuilding only once during this proposal search.
  const riserPlanVariants = new Map<NetworkPipeLevelPlan, NetworkPipeLevelPlan[]>();
  const recoveryLevelPlans = new Map<string, {
    plans: NetworkPipeLevelPlan[];
    excludedLevels: Array<{ gas: number; liquid: number }>;
    complete: boolean;
  }>();
  const levelPlanForTarget = (
    target: RefrigerantPipeBundleSegmentConnection,
    requestedIndex: number,
  ): NetworkPipeLevelPlan | undefined => {
    const key = [
      target.gasSourceElementId,
      target.liquidSourceElementId,
      target.gasElevationMm,
      target.liquidElevationMm,
    ].join('\u0000');
    const state = recoveryLevelPlans.get(key) ?? {
      plans: [],
      excludedLevels: [],
      complete: false,
    };
    recoveryLevelPlans.set(key, state);
    while (state.plans.length <= requestedIndex && !state.complete && state.plans.length < 4) {
      const plan = planNetworkPipeLevels(scene, {
        gasHostId: target.gasSourceElementId ?? '',
        liquidHostId: target.liquidSourceElementId ?? '',
        startBundle,
        gasHostElevationMm: target.gasElevationMm,
        liquidHostElevationMm: target.liquidElevationMm,
        settings,
        excludedLevels: state.excludedLevels,
      });
      state.plans.push(plan);
      state.complete = !plan.feasible || state.plans.length >= 4;
      if (plan.feasible) {
        state.excludedLevels.push({ gas: plan.gasElevationMm, liquid: plan.liquidElevationMm });
      }
    }
    return state.plans[requestedIndex];
  };
  const evaluateStation = (
    point: Point2D,
  ): BranchKitProposal | null => {
    const failedLevels: Array<{ gas: number; liquid: number }> = [];
    let candidate = proposeBranchKitAtStation(
      scene,
      startBundle,
      point,
      options,
      failedLevels,
      undefined,
      undefined,
      riserPlanVariants,
    );
    // A failed takeoff is feedback to the level planner. Try the bounded set of
    // alternative corridors at this exact station before moving the fitting.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!candidate || candidate.validity !== 'invalid'
        || candidate.failureReason === 'station' || !candidate.failureReason
        || !candidate.levelPlan?.feasible) break;
      failedLevels.push({
        gas: candidate.levelPlan.gasElevationMm,
        liquid: candidate.levelPlan.liquidElevationMm,
      });
      candidate = proposeBranchKitAtStation(
        scene,
        startBundle,
        point,
        options,
        failedLevels,
        undefined,
        undefined,
        riserPlanVariants,
      );
    }
    return candidate;
  };

  const first = evaluateStation(cursorPoint);
  if (!first || first.validity !== 'invalid' || !first.failureReason) return first;
  const sameHost = (candidate: BranchKitProposal) =>
    candidate.gasGhost.element.properties.branchKitSnapSourceElementId === first.gasGhost.element.properties.branchKitSnapSourceElementId
    && candidate.liquidGhost.element.properties.branchKitSnapSourceElementId === first.liquidGhost.element.properties.branchKitSnapSourceElementId;

  // Search all eligible level straights on the selected physical pair and rank
  // complete, clash-checked insertions by movement from the user's cursor. This
  // covers long mains and bends without silently switching to a nearby network.
  const recoveries = branchRecoveryStations(scene, first, cursorPoint, settings)
    .slice(0, Math.max(0, Math.min(16, options?.maxRecoveryStations ?? 16)));
  // Prefer the level planner's lowest-cost corridor across the searched main
  // before considering its next corridor. This minimizes network transitions
  // and vertical travel while station order minimizes movement within a level.
  for (let levelIndex = 0; levelIndex < 4; levelIndex += 1) {
    for (const recovery of recoveries) {
      const levelPlan = levelPlanForTarget(recovery.target, levelIndex);
      if (!levelPlan) continue;
      const candidate = proposeBranchKitAtStation(
        scene,
        startBundle,
        recovery.point,
        options,
        undefined,
        recovery.target,
        levelPlan,
        riserPlanVariants,
      );
      if (!candidate || !sameHost(candidate) || candidate.validity === 'invalid') continue;
      candidate.validity = 'needs-nudge';
      candidate.gasGhost.nudged = true;
      candidate.liquidGhost.nudged = true;
      const movementMm = distance(cursorPoint, candidate.teePoint);
      candidate.score += movementMm;
      candidate.violations = [
        `Branch position adjusted for clearance (${Math.round(movementMm)} mm from pointer).`,
        ...candidate.violations,
      ];
      return candidate;
    }
  }
  return first;
}

function proposeBranchKitAtStation(
  scene: HvacElement[],
  startBundle: RefrigerantPipeBundleConnection | null,
  cursorPoint: Point2D,
  options?: ProposeBranchKitOptions,
  excludedLevels?: Array<{ gas: number; liquid: number }>,
  preferredTarget?: RefrigerantPipeBundleSegmentConnection,
  preferredLevelPlan?: NetworkPipeLevelPlan,
  riserPlanVariants = new Map<NetworkPipeLevelPlan, NetworkPipeLevelPlan[]>(),
): BranchKitProposal | null {
  if (!startBundle) {
    return null;
  }
  const settings = options?.settings ?? getActivePipeRoutingSettings();
  const proposalRadiusMm = options?.proposalRadiusMm ?? Math.max(140, settings.snapRadiusPx * 8);
  const excludeSourceIds = new Set(options?.excludeSourceIds ?? []);
  [startBundle.sourceElementId, startBundle.gasSourceElementId, startBundle.liquidSourceElementId]
    .forEach((id) => { if (id) excludeSourceIds.add(id); });
  // Exclude before ranking: hovering the source must not hide an eligible
  // nearby run or accidentally join a line back into its own bundle.
  const candidateScene = scene.filter((element) =>
    !excludeSourceIds.has(element.id) &&
    !(typeof element.properties.bundleId === 'string' && excludeSourceIds.has(element.properties.bundleId)));
  const minSegmentLengthMm = estimateMinRunLengthMm();

  // The bundle target gives a consistent gas+liquid station + run direction.
  const modelBundleTarget = preferredTarget
    ? projectBundleTargetAtPoint(preferredTarget, cursorPoint)
    : findNearestRefrigerantPipeBundleSegmentTarget(
        candidateScene,
        cursorPoint,
        proposalRadiusMm,
        { minSegmentLengthMm },
      ) ?? findNearestRefrigerantPipeBundleSegmentTarget(
        candidateScene,
        cursorPoint,
        proposalRadiusMm,
        { minSegmentLengthMm: 1 },
      );
  const bundleTarget = modelBundleTarget;
  if (!bundleTarget) {
    return null;
  }
  const sourceId = bundleTarget.sourceElementId ?? '';
  if (sourceId && excludeSourceIds.has(sourceId)) {
    return null;
  }

  const runDirection = normalize(bundleTarget.direction);
  const target: BranchKitProposalTarget = {
    sourceId,
    segmentStart: bundleTarget.segmentStart,
    segmentEnd: bundleTarget.segmentEnd,
    segmentLengthMm: bundleTarget.segmentLengthMm,
    direction: runDirection,
    gasPoint: bundleTarget.gasPoint,
    liquidPoint: bundleTarget.liquidPoint,
    gasOuterDiameterMm: bundleTarget.gasOuterDiameterMm ?? 28,
    liquidOuterDiameterMm: bundleTarget.liquidOuterDiameterMm ?? 22,
    elevationMm: bundleTarget.elevationMm,
    gasElevationMm: bundleTarget.gasElevationMm,
    liquidElevationMm: bundleTarget.liquidElevationMm,
  };

  // Per-line stations from the bundle station, projected onto each line.
  const stationAlong = clamp(
    dot(subtract(cursorPoint, target.segmentStart), runDirection),
    0,
    target.segmentLengthMm,
  );
  const gasStationDelta =
    stationAlong - dot(subtract(target.gasPoint, target.segmentStart), runDirection);
  const gasStationPoint = add(target.gasPoint, scale(runDirection, gasStationDelta));
  const liquidStationDelta =
    stationAlong - dot(subtract(target.liquidPoint, target.segmentStart), runDirection);
  const liquidStationPoint = add(target.liquidPoint, scale(runDirection, liquidStationDelta));

  const targetSegmentMinimumMm = Math.min(minSegmentLengthMm, bundleTarget.segmentLengthMm);
  let gasSegment = findLineSegmentNear(candidateScene, 'gas', gasStationPoint, proposalRadiusMm, targetSegmentMinimumMm, bundleTarget.gasSourceElementId);
  let liquidSegment = findLineSegmentNear(
    candidateScene,
    'liquid',
    liquidStationPoint,
    proposalRadiusMm,
    targetSegmentMinimumMm,
    bundleTarget.liquidSourceElementId,
  );
  if (!gasSegment || !liquidSegment) {
    return null;
  }

  const clearanceMm = Math.max(0, settings.defaultBranchKitClearanceMm);
  const faceToward = resolveBranchFaceToward(
    startBundle,
    midpoint(gasStationPoint, liquidStationPoint),
    runDirection,
    options?.authoredRoute,
  );
  const gasUpstream = resolveHostRunUpstreamDirection(scene, gasSegment, 'gas');
  const liquidUpstream = resolveHostRunUpstreamDirection(scene, liquidSegment, 'liquid');
  const conflictingUpstream = Boolean(gasUpstream && liquidUpstream && dot(gasUpstream, liquidUpstream) < 0.5);
  const upstreamDirection = combineUpstreamDirections(gasUpstream, liquidUpstream);
  // A 180-degree proposal flip swaps inlet/run-outlet. Once the outdoor side is
  // known it is therefore intentionally a no-op; only unconstrained legacy
  // routes keep the old visual flip fallback.
  const flip = upstreamDirection ? false : (options?.flip ?? false);
  const plannedLevels = preferredLevelPlan ?? planNetworkPipeLevels(scene, {
    gasHostId: gasSegment.sourceElementId ?? '', liquidHostId: liquidSegment.sourceElementId ?? '',
    startBundle, gasHostElevationMm: gasSegment.elevationMm, liquidHostElevationMm: liquidSegment.elevationMm, settings,
    excludedLevels,
  });
  // Station-specific checks may mark a corridor unsuitable; never mutate a
  // cached plan shared by the remaining nearest-station candidates.
  let levelPlan: NetworkPipeLevelPlan = {
    ...plannedLevels,
    issues: [...plannedLevels.issues],
    notes: [...plannedLevels.notes],
  };
  const stationRiserFallbacks: Partial<Record<'gas' | 'liquid', boolean>> = {};
  if (levelPlan.feasible) {
    const gasHostSegment = gasSegment; const liquidHostSegment = liquidSegment;
    const segmentsAtPlannedLevels = (plan: NetworkPipeLevelPlan) => {
      const overrides = new Map(plan.updates.map(element => [element.id, element]));
      const plannedScene = scene.map(element => overrides.get(element.id) ?? element);
      return {
        gas: findLineSegmentNear(plannedScene, 'gas', gasStationPoint, Math.max(proposalRadiusMm, gasHostSegment.segmentLengthMm), targetSegmentMinimumMm, gasHostSegment.sourceElementId),
        liquid: findLineSegmentNear(plannedScene, 'liquid', liquidStationPoint, Math.max(proposalRadiusMm, liquidHostSegment.segmentLengthMm), targetSegmentMinimumMm, liquidHostSegment.sourceElementId),
      };
    };
    let { gas: plannedGas, liquid: plannedLiquid } = segmentsAtPlannedLevels(levelPlan);
    const gasAtCorridor = plannedGas && Math.abs(plannedGas.elevationMm - levelPlan.gasElevationMm) < 0.5;
    const liquidAtCorridor = plannedLiquid && Math.abs(plannedLiquid.elevationMm - levelPlan.liquidElevationMm) < 0.5;
    if (!gasAtCorridor || !liquidAtCorridor) {
      // Moving an outdoor riser to a distant corner must not consume a main
      // station needed by this branch. Reserve that station by shortening only
      // the affected service's equipment-level approach, at the same levels.
      if (!gasAtCorridor) stationRiserFallbacks.gas = false;
      if (!liquidAtCorridor) stationRiserFallbacks.liquid = false;
      const restored = replanNetworkPipeRisers(scene, levelPlan, levelPlan.preferCornerRisers ?? true,
        { ...levelPlan.cornerRisersByService, ...stationRiserFallbacks });
      if (restored.feasible) {
        const segments = segmentsAtPlannedLevels(restored);
        if (segments.gas && segments.liquid
          && Math.abs(segments.gas.elevationMm - restored.gasElevationMm) < 0.5
          && Math.abs(segments.liquid.elevationMm - restored.liquidElevationMm) < 0.5) {
          levelPlan = restored;
          plannedGas = segments.gas; plannedLiquid = segments.liquid;
        }
      }
    }
    if (plannedGas && plannedLiquid && Math.abs(plannedGas.elevationMm - levelPlan.gasElevationMm) < 0.5 && Math.abs(plannedLiquid.elevationMm - levelPlan.liquidElevationMm) < 0.5) {
      gasSegment = plannedGas; liquidSegment = plannedLiquid;
      target.gasElevationMm = levelPlan.gasElevationMm;
      target.liquidElevationMm = levelPlan.liquidElevationMm;
      target.elevationMm = (levelPlan.gasElevationMm + levelPlan.liquidElevationMm) / 2;
    }
    else {
      levelPlan.feasible = false;
      levelPlan.issues.push('Move the branch along the main, beyond the equipment level transition and fitting straight zones.');
    }
  }
  const gasInterval = kitStationInterval('gas', gasSegment, runDirection, clearanceMm);
  const liquidInterval = kitStationInterval('liquid', liquidSegment, runDirection, clearanceMm);
  const minimum = Math.max(gasInterval.minimum, liquidInterval.minimum);
  const maximum = Math.min(gasInterval.maximum, liquidInterval.maximum);
  if (maximum < minimum) {
    const invalid = buildInvalidProposal(target, gasStationPoint, liquidStationPoint, startBundle, flip, upstreamDirection,
      { gas: gasSegment.sourceElementId, liquid: liquidSegment.sourceElementId });
    return invalid ? { ...invalid, levelPlan, failureReason: 'station' } : null;
  }
  const desiredScalar = dot(gasStationPoint, runDirection);
  const coordinatedScalar = clamp(desiredScalar, minimum, maximum);
  const coordinatedNudge = Math.abs(coordinatedScalar - desiredScalar) > 1;
  gasSegment = segmentAtScalar(gasSegment, coordinatedScalar, runDirection);
  liquidSegment = segmentAtScalar(liquidSegment, coordinatedScalar, runDirection);
  const gasGhost = placeKitOnLineSegment({
    lineKind: 'gas',
    segment: gasSegment,
    faceToward,
    clearanceMm,
    flip,
    upstreamDirection,
  });
  const liquidGhost = placeKitOnLineSegment({
    lineKind: 'liquid',
    segment: liquidSegment,
    faceToward,
    clearanceMm,
    flip,
    upstreamDirection,
  });

  const violations: string[] = [];
  let validity: BranchKitProposalValidity = 'valid';
  if (!gasGhost || !liquidGhost) {
    // Run too short for the kit body + clearance — report a best-effort invalid
    // proposal anchored at the cursor station so the user gets feedback.
    return buildInvalidProposal(
      target,
      gasStationPoint,
      liquidStationPoint,
      startBundle,
      flip,
      upstreamDirection,
      { gas: gasSegment.sourceElementId, liquid: liquidSegment.sourceElementId },
    );
  }
  if (coordinatedNudge || gasGhost.nudged || liquidGhost.nudged) {
    gasGhost.nudged = true;
    liquidGhost.nudged = true;
    validity = 'needs-nudge';
    violations.push('Kit slid along the run to keep clearance from the run ends.');
  }
  if (conflictingUpstream) {
    validity = 'invalid';
    violations.unshift('Gas and liquid identify opposite outdoor sides. Check the host connections.');
  }
  if (!levelPlan.feasible) { validity = 'invalid'; violations.unshift(...levelPlan.issues); }

  const teePoint = midpoint(gasGhost.stationPoint, liquidGhost.stationPoint);
  let stationBlocked = false;

  // Clearance from existing branch kits and complete indoor-unit bodies.
  if (validity !== 'invalid') {
    const clearanceViolation = branchStationClearanceViolation(
      gasGhost,
      liquidGhost,
      teePoint,
      scene,
      settings,
    );
    if (clearanceViolation) {
      validity = 'invalid';
      stationBlocked = true;
      violations.unshift(clearanceViolation);
    }
  }

  const connectionType = classifyConnectionType(startBundle, target);
  const cursorPenalty = distance(cursorPoint, teePoint);
  const nudgePenalty = validity === 'needs-nudge' ? 120 : 0;
  const invalidPenalty = validity === 'invalid' ? 10000 : 0;
  const score = cursorPenalty + nudgePenalty + invalidPenalty;

  const proposal: BranchKitProposal = {
    connectionType,
    ...(typeof options?.bendRadiusFactor === 'number' && Number.isFinite(options.bendRadiusFactor) && options.bendRadiusFactor > 0
      ? { bendRadiusFactor: options.bendRadiusFactor } : {}),
    validity,
    violations,
    score,
    teePoint,
    runDirection,
    gasGhost,
    liquidGhost,
    target,
    flip,
    orientationLocked: Boolean(upstreamDirection),
    selectionStatus: 'layout-only',
    levelPlan,
    ...(!conflictingUpstream && stationBlocked ? { failureReason: 'station' as const }
      : !levelPlan.feasible && !conflictingUpstream ? { failureReason: 'levels' as const } : {}),
    notes: [
      'Kit sizing and system compatibility need manufacturer verification.',
      ...(!upstreamDirection ? ['Outdoor-side direction is unresolved; check the inlet orientation.'] : []),
    ],
  };
  if (proposal.validity !== 'invalid') {
    const route = options?.authoredRoute ? [...options.authoredRoute, proposal.teePoint] : undefined;
    const hostIds = new Set([
      proposal.gasGhost.element.properties.branchKitSnapSourceElementId,
      proposal.liquidGhost.element.properties.branchKitSnapSourceElementId,
    ].filter((id): id is string => typeof id === 'string'));
    // Rank complete orthogonal guides by bends and length before constructing
    // the pipes. A simple guide must also fit both services at their real levels;
    // a blocked short route does not suppress the next buildable alternative.
    let hadInterference = false;
    const routes = buildBranchConnectionRouteCandidates(proposal, startBundle, route);
    // Keep recovery bounded for a completely obstructed main. At the pointer,
    // check the full small candidate family before moving the user's station;
    // recovery stations try their two simplest routes before the next station.
    for (const connectionRoute of preferredTarget ? routes.slice(0, 2) : routes) {
      proposal.connectionRoute = connectionRoute;
      const attempts = [proposal];
      let bestFallback: { proposal: BranchKitProposal; turns: number; length: number } | undefined;
      let queuedRiserFallbacks = false;
      const retryStraightRisers = (attempt: BranchKitProposal, elements: HvacElement[]) => {
        hadInterference = true;
        if (queuedRiserFallbacks || !attempt.levelPlan || !hasNetworkCornerRiser(elements)) return;
        queuedRiserFallbacks = true;
        const variantSource = Object.keys(stationRiserFallbacks).length ? levelPlan : plannedLevels;
        let variants = riserPlanVariants.get(variantSource);
        if (!variants) {
          variants = [
            { gas: false, liquid: true },
            { gas: true, liquid: false },
            { gas: false, liquid: false },
          ].map(preferences => ({ ...preferences, ...stationRiserFallbacks }))
            .filter((preferences, index, choices) => choices.findIndex(choice =>
              choice.gas === preferences.gas && choice.liquid === preferences.liquid) === index)
            .map(preferences => replanNetworkPipeRisers(scene, attempt.levelPlan!, true, preferences))
            .filter(candidate => candidate.feasible);
          riserPlanVariants.set(variantSource, variants);
        }
        // Keep the other service's two-elbow turn where possible. All three
        // bounded variants pass the same complete physical insertion checks;
        // stable service preferences survive new IDs at preview and commit.
        attempts.push(...variants.map(candidate => ({ ...proposal, levelPlan: candidate })));
      };
      for (const attempt of attempts) {
        // A safe mixed-service solution always retains at least as many corner
        // turns as the all-straight fallback. Compare the two mixed solutions
        // first, then avoid rebuilding an inferior all-straight installation.
        if (bestFallback && attempt.levelPlan?.cornerRisersByService?.gas === false
          && attempt.levelPlan.cornerRisersByService.liquid === false) return bestFallback.proposal;
        const levelOverrides = new Map(attempt.levelPlan?.updates.map(element => [element.id, element]) ?? []);
        const quickScene = scene.filter(element => !hostIds.has(element.id))
          .map(element => levelOverrides.get(element.id) ?? element);
        const quickConnections = buildBranchKitConnectionElements(
          attempt, startBundle, 'preview-branch-kit-gas', 'preview-branch-kit-liquid',
          route, (prefix) => `preview-clearance-${prefix}`,
        );
        if (quickConnections.length !== 2) continue;
        if (hasNewNetworkPipeClash(quickScene, quickConnections)) {
          retryStraightRisers(attempt, [...quickConnections, ...(attempt.levelPlan?.updates ?? [])]);
          continue;
        }
        let previewId = 0;
        const staged = prepareBranchKitInsertion(attempt, startBundle, scene, route,
          prefix => `preview-level-${prefix}-${++previewId}`);
        if (!staged) continue;
        if (hasNewNetworkPipeClash(scene, [...(staged.updates ?? []), ...staged.elementsToAdd], staged.removeElementIds)) {
          retryStraightRisers(attempt, [...(staged.updates ?? []), ...staged.elementsToAdd]);
          continue;
        }
        if (attempt === proposal) return attempt;
        // Accumulated turn angle is independent of arc sampling density, and
        // keeps a cheaper mixed choice when either service can clear the clash.
        let turns = 0; let length = 0;
        for (const element of [...(staged.updates ?? []), ...staged.elementsToAdd]) {
          if (element.type !== 'refrigerant-pipe') continue;
          const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
          let previousDirection: { x: number; y: number; z: number } | undefined;
          for (let index = 1; index < nodes.length; index += 1) {
            const a = nodes[index - 1]!; const b = nodes[index]!;
            const span = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            if (span <= 1e-6) continue;
            const direction = { x: (b.x - a.x) / span, y: (b.y - a.y) / span, z: (b.z - a.z) / span };
            length += span;
            if (previousDirection) turns += Math.acos(clamp(previousDirection.x * direction.x
              + previousDirection.y * direction.y + previousDirection.z * direction.z, -1, 1));
            previousDirection = direction;
          }
        }
        if (!bestFallback || turns < bestFallback.turns - 1e-6
          || (Math.abs(turns - bestFallback.turns) <= 1e-6 && length < bestFallback.length - 1e-6)) {
          bestFallback = { proposal: attempt, turns, length };
        }
      }
      if (bestFallback) return bestFallback.proposal;
    }
    delete proposal.connectionRoute;
    proposal.validity = 'invalid';
    proposal.failureReason = hadInterference ? 'interference' : 'approach';
    proposal.violations.unshift(hadInterference
      ? 'This connection would introduce an insulated pipe clash. Move the branch or adjust the approach route.'
      : 'The approach needs more straight length for the equipment and branch levels. Move the branch or extend the route.');
  }
  return proposal;
}

/** Best-effort invalid proposal (run too short) so the card can warn the user. */
function buildInvalidProposal(
  target: BranchKitProposalTarget,
  gasStationPoint: Point2D,
  liquidStationPoint: Point2D,
  startBundle: RefrigerantPipeBundleConnection,
  flip: boolean,
  upstreamDirection: Point2D | null,
  sourceElementIds: { gas?: string; liquid?: string },
): BranchKitProposal | null {
  const faceToward = startBundle.point ?? gasStationPoint;
  // Place on a synthetic display span when the physical straight is shorter
  // than the fitting. The invalid ghost preserves the selected host identity,
  // allowing recovery to search later eligible straights on the same pair.
  const makeSegment = (
    lineKind: RefrigerantBranchLineKind,
    stationPoint: Point2D,
  ): RefrigerantPipeSegmentConnection => {
    const displayLengthMm = Math.max(target.segmentLengthMm, estimateMinRunLengthMm());
    const displayStart = add(stationPoint, scale(target.direction, -displayLengthMm / 2));
    return {
      point: stationPoint,
      direction: target.direction,
      segmentStart: displayStart,
      segmentEnd: add(displayStart, scale(target.direction, displayLengthMm)),
      segmentLengthMm: displayLengthMm,
      projectedDistanceMm: displayLengthMm / 2,
      lineKind,
      elevationMm: lineKind === 'gas' ? target.gasElevationMm : target.liquidElevationMm,
      outerDiameterMm: lineKind === 'gas' ? target.gasOuterDiameterMm : target.liquidOuterDiameterMm,
      // A nearby station retry must stay on these same physical hosts even
      // when the current interval cannot accommodate the fitting clearances.
      sourceElementId: sourceElementIds[lineKind],
    };
  };
  const gasGhost = placeKitOnLineSegment({
    lineKind: 'gas',
    segment: makeSegment('gas', gasStationPoint),
    faceToward,
    clearanceMm: 0,
    flip,
    upstreamDirection,
  });
  const liquidGhost = placeKitOnLineSegment({
    lineKind: 'liquid',
    segment: makeSegment('liquid', liquidStationPoint),
    faceToward,
    clearanceMm: 0,
    flip,
    upstreamDirection,
  });
  if (!gasGhost || !liquidGhost) {
    return null;
  }
  return {
    connectionType: 'generic-tee',
    validity: 'invalid',
    violations: ['Run is too short to host a branch kit with clearance.'],
    score: 10000,
    teePoint: midpoint(gasGhost.stationPoint, liquidGhost.stationPoint),
    runDirection: target.direction,
    gasGhost,
    liquidGhost,
    target,
    flip,
    orientationLocked: Boolean(upstreamDirection),
    selectionStatus: 'layout-only',
  };
}

// ---------------------------------------------------------------------------
// buildBranchKitInsertion
// ---------------------------------------------------------------------------

function readRoutePoints(element: HvacElement): Point2D[] {
  const raw = (element.properties as { routePoints?: unknown }).routePoints;
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: Point2D[] = [];
  raw.forEach((value) => {
    if (value && typeof value === 'object') {
      const record = value as { x?: unknown; y?: unknown };
      if (isFiniteNumber(record.x) && isFiniteNumber(record.y)) {
        result.push({ x: record.x, y: record.y });
      }
    }
  });
  return result;
}

/**
 * Turns an accepted proposal into the concrete element additions: the two branch
 * joints (gas + liquid) placed on the intact run, plus the connecting pipes from
 * the start unit/branch to each joint's branch outlet.
 *
 * The connection is routed as a gas/liquid PAIR along a single ORTHOGONAL
 * (right-angle) centerline — the pair builder offsets the two lines
 * concentrically around the bends so they stay parallel (the gap never
 * collapses). Shared service levels resolve crossovers across the network;
 * individual crossings do not silently add rise-and-return offsets.
 */
function readSnapSourceElementId(element: Omit<HvacElement, 'id'>): string | null {
  const value = (element.properties as { branchKitSnapSourceElementId?: unknown })
    .branchKitSnapSourceElementId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function findSnapSourceRun(
  elements: HvacElement[],
  sourceId: string | null,
  lineKind: RefrigerantBranchLineKind,
): HvacElement | null {
  if (!sourceId) return null;
  return elements.find((element) => {
    if (element.type !== 'refrigerant-pipe') return false;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    return spec.lineKind === lineKind
      && (element.id === sourceId || spec.bundleId === sourceId);
  }) ?? null;
}

/**
 * Splits a single-line run element at the tee station into connected run-in /
 * run-out halves. Each half keeps the original line's properties, clears the
 * connection at the cut (tee) end, takes a side-specific bundleId so the
 * gas/liquid halves of the same sub-run pair up, and carries the `teeId`
 * linkage. Returns null if the polyline can't be cleanly split (e.g. the
 * station resolves to an endpoint), preventing an incomplete connection.
 */
export interface TeeRunSplitOptions {
  inletPoint?: Point2D;
  runOutletPoint?: Point2D;
  inletConnection?: RefrigerantPipeConnection | null;
  runOutletConnection?: RefrigerantPipeConnection | null;
}

function polylineLength(points: readonly Point2D[]): number {
  let result = 0;
  for (let index = 1; index < points.length; index += 1) {
    result += distance(points[index - 1]!, points[index]!);
  }
  return result;
}

function nearestRouteSegmentIndex(route: readonly Point2D[], point: Point2D): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const end = route[index + 1]!;
    const delta = subtract(end, start);
    const lengthSquared = delta.x * delta.x + delta.y * delta.y;
    const t = lengthSquared <= 1e-9
      ? 0
      : clamp(dot(subtract(point, start), delta) / lengthSquared, 0, 1);
    const projected = add(start, scale(delta, t));
    const candidateDistance = distance(point, projected);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function materialsForSubroute(
  originalRoute: readonly Point2D[],
  materials: readonly RefrigerantPipeMaterial[],
  subroute: readonly Point2D[],
): RefrigerantPipeMaterial[] {
  // A uniform host has the same material at every possible nearest segment.
  // Avoid projecting every sampled elbow point onto that entire host again.
  // Include the same missing-entry fallback as the general projection path.
  const firstMaterial = materials[0] ?? 'hard';
  let uniform = true;
  for (let index = 1; index < originalRoute.length - 1; index += 1) {
    if ((materials[index] ?? 'hard') !== firstMaterial) { uniform = false; break; }
  }
  if (uniform) return subroute.slice(1).map(() => firstMaterial);
  return subroute.slice(1).map((point, index) => {
    const start = subroute[index]!;
    const midpoint = { x: (start.x + point.x) / 2, y: (start.y + point.y) / 2 };
    return materials[nearestRouteSegmentIndex(originalRoute, midpoint)] ?? 'hard';
  });
}

function routeStationMm(route: Point2D[], point: Point2D): number | null {
  const split = splitPolylineAtStation(route, point, -1);
  return split ? polylineLength(split.before) : null;
}

function bypassesForStationRange(
  value: unknown,
  route: Point2D[],
  minimumMm: number,
  maximumMm: number,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const record = candidate as Record<string, unknown>;
    const points = [record.enterPoint, record.obstaclePoint, record.exitPoint];
    return points.every((raw) => {
      if (!raw || typeof raw !== 'object') return false;
      const point = raw as { x?: unknown; y?: unknown };
      if (typeof point.x !== 'number' || typeof point.y !== 'number') return false;
      const station = routeStationMm(route, { x: point.x, y: point.y });
      return station !== null && station >= minimumMm - 1e-6 && station <= maximumMm + 1e-6;
    });
  });
}

/** A split service lane owns only its matching logical guide interval. The
 * fitting faces lie on the offset physical lane, so project them onto the
 * original guide without moving the remaining orthogonal guide vertices. */
function authoredGuideForHalf(value: unknown, physicalHalf: Point2D[], keepStart: boolean, keepEnd: boolean): Point2D[] {
  const fallback = () => physicalHalf.map(point => ({ ...point }));
  if (!Array.isArray(value) || value.length < 2 || !value.every(point => point && typeof point === 'object'
    && isFiniteNumber(point.x) && isFiniteNumber(point.y))) return fallback();
  let guide = dedupeConsecutive(value.map(point => ({ x: point.x as number, y: point.y as number })));
  if (guide.length < 2) return fallback();
  if (!keepStart) {
    const split = splitPolylineAtStation(guide, physicalHalf[0]!);
    if (!split) return fallback();
    guide = split.after;
  }
  if (!keepEnd) {
    const split = splitPolylineAtStation(guide, physicalHalf.at(-1)!);
    if (!split) return fallback();
    guide = split.before;
  }
  return guide.length >= 2 ? guide : fallback();
}

export function buildTeeRunHalves(
  run: HvacElement,
  station: Point2D,
  teeId: string,
  options: TeeRunSplitOptions = {},
  makeId = createBranchKitElementId,
): [HvacElement, HvacElement] | null {
  const route = readRoutePoints(run);
  const inletPoint = options.inletPoint ?? station;
  const runOutletPoint = options.runOutletPoint ?? station;
  // Polyline splitting projects arbitrary points onto the nearest segment.
  // A stale preview must not use that behavior to bend a moved host back to
  // the old fitting position or silently bridge a physical connection gap.
  if (pointToPolylineDistance(inletPoint, route) > 0.5 ||
    pointToPolylineDistance(runOutletPoint, route) > 0.5) return null;
  const inletSplit = splitPolylineAtStation(route, inletPoint);
  const outletSplit = splitPolylineAtStation(route, runOutletPoint);
  if (!inletSplit || !outletSplit) return null;

  const inletStationMm = polylineLength(inletSplit.before);
  const outletStationMm = polylineLength(outletSplit.before);
  const inletBeforeOutlet = inletStationMm <= outletStationMm;
  const totalLengthMm = polylineLength(route);
  const spec = resolveRefrigerantPipeSpec(run.properties);
  const baseProps = (run.properties ?? {}) as Record<string, unknown>;
  const split3d = splitPipeRoute3dAtPlanInterval(
    route,
    normalizePipeRouteNodes3d(baseProps.routeNodes3d),
    inletPoint,
    runOutletPoint,
    {
      first: options.inletConnection?.elevationMm,
      second: options.runOutletConnection?.elevationMm,
    },
  );

  const makeHalf = (params: {
    routePoints: Point2D[];
    startConnection: RefrigerantPipeConnection | null;
    endConnection: RefrigerantPipeConnection | null;
    bundleId: string;
    teeRole: 'run-in' | 'run-out';
    routeNodes3d: PipeRouteNode3D[];
    minimumStationMm: number;
    maximumStationMm: number;
  }): HvacElement => {
    const built = buildRefrigerantPipeElement(params.routePoints, {
      lineKind: spec.lineKind,
      label: run.label,
      segmentMaterials: materialsForSubroute(
        route,
        spec.segmentMaterials,
        params.routePoints,
      ),
      pipeDiameterMm: spec.pipeDiameterMm,
      outerDiameterMm: spec.outerDiameterMm,
      insulationThicknessMm: spec.insulationThicknessMm,
      bundleId: params.bundleId,
      startConnection: params.startConnection,
      endConnection: params.endConnection,
      elevationMm: run.elevation,
    });
    const properties: Record<string, unknown> = {
      ...baseProps,
      ...(built.properties ?? {}),
      bundleId: params.bundleId,
      teeId,
      teeRole: params.teeRole,
      bypasses: bypassesForStationRange(
        baseProps.bypasses,
        route,
        params.minimumStationMm,
        params.maximumStationMm,
      ),
    };
    if (Object.prototype.hasOwnProperty.call(baseProps, 'authoredCenterlineRoute')) {
      // Preserve the derived-lane marker used by rendering, including imports
      // whose logical guide is malformed. Physical route geometry is unchanged.
      properties.authoredCenterlineRoute = authoredGuideForHalf(baseProps.authoredCenterlineRoute,
        params.routePoints, params.minimumStationMm <= 1e-6, params.maximumStationMm >= totalLengthMm - 1e-6);
    }
    if (params.routeNodes3d.length >= 2) properties.routeNodes3d = params.routeNodes3d;
    else delete properties.routeNodes3d;
    return {
      ...run,
      ...built,
      id: makeId(
        params.teeRole === 'run-in' ? 'refrigerant-run-in' : 'refrigerant-run-out',
      ),
      properties,
    } as HvacElement;
  };

  const beforeNodes = split3d?.before ?? [];
  const afterNodes = split3d?.after ?? [];
  const runIn = inletBeforeOutlet
    ? makeHalf({
        routePoints: inletSplit.before,
        startConnection: spec.startConnection,
        endConnection: options.inletConnection ?? null,
        bundleId: `${teeId}-in`,
        teeRole: 'run-in',
        routeNodes3d: beforeNodes,
        minimumStationMm: 0,
        maximumStationMm: inletStationMm,
      })
    : makeHalf({
        routePoints: inletSplit.after,
        startConnection: options.inletConnection ?? null,
        endConnection: spec.endConnection,
        bundleId: `${teeId}-in`,
        teeRole: 'run-in',
        routeNodes3d: afterNodes,
        minimumStationMm: inletStationMm,
        maximumStationMm: totalLengthMm,
      });
  const runOut = inletBeforeOutlet
    ? makeHalf({
        routePoints: outletSplit.after,
        startConnection: options.runOutletConnection ?? null,
        endConnection: spec.endConnection,
        bundleId: `${teeId}-out`,
        teeRole: 'run-out',
        routeNodes3d: afterNodes,
        minimumStationMm: outletStationMm,
        maximumStationMm: totalLengthMm,
      })
    : makeHalf({
        routePoints: outletSplit.before,
        startConnection: spec.startConnection,
        endConnection: options.runOutletConnection ?? null,
        bundleId: `${teeId}-out`,
        teeRole: 'run-out',
        routeNodes3d: beforeNodes,
        minimumStationMm: 0,
        maximumStationMm: outletStationMm,
      });
  const originalStartConnection = Object.prototype.hasOwnProperty.call(baseProps, 'startConnection')
    ? baseProps.startConnection
    : spec.startConnection;
  const originalEndConnection = Object.prototype.hasOwnProperty.call(baseProps, 'endConnection')
    ? baseProps.endConnection
    : spec.endConnection;
  if (inletBeforeOutlet) {
    runIn.properties.startConnection = originalStartConnection;
    runOut.properties.endConnection = originalEndConnection;
  } else {
    runOut.properties.startConnection = originalStartConnection;
    runIn.properties.endConnection = originalEndConnection;
  }
  return [runIn, runOut];
}

function branchTerminalConnection(
  kitElementId: string,
  lineKind: RefrigerantBranchLineKind,
  role: 'inlet' | 'run-outlet' | 'branch-outlet',
  portPoint: Point2D,
  direction: Point2D,
  elevationMm: number,
): RefrigerantPipeConnection {
  const identity = refrigerantBranchKitTerminalIds(kitElementId, lineKind, role);
  return {
    portPoint: { ...portPoint },
    direction: normalize(direction),
    elevationMm,
    connectionKind: 'field-pipe',
    portId: identity.portId,
    nodeId: identity.nodeId,
    sourceElementId: kitElementId,
    terminalRole: role,
  };
}

/** Shared socket constraints for fitting-station selection and the final
 * branch guide. Reads the proposal's resolved settings without changing the
 * proposal, service sockets, or scene. */
export function getBranchKitApproachRouteOptions(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
  settingsOverride?: PipeRoutingSettings,
): OrthogonalConnectionRouteOptions {
  const gasOutlet = proposal.gasGhost.branchOutletPoint;
  const liquidOutlet = proposal.liquidGhost.branchOutletPoint;
  const settings = settingsOverride ?? proposal.levelPlan?.settings ?? getActivePipeRoutingSettings();
  const physicalRadius = Math.max(proposal.target.gasOuterDiameterMm, proposal.target.liquidOuterDiameterMm,
    startBundle.gasOuterDiameterMm ?? 0, startBundle.liquidOuterDiameterMm ?? 0) * Math.max(1, settings.bendRadiusFactor, proposal.bendRadiusFactor ?? 0);
  // The shared guide is filleted before the two service lines are offset.
  // Reserve the outermost offset too, so the inner line retains its specified
  // physical radius without consuming the protected socket straight.
  const approachSpacing = Math.max(
    Math.hypot(proposal.target.gasPoint.x - proposal.target.liquidPoint.x,
      proposal.target.gasPoint.y - proposal.target.liquidPoint.y),
    Math.hypot(startBundle.gasFieldPoint.x - startBundle.liquidFieldPoint.x,
      startBundle.gasFieldPoint.y - startBundle.liquidFieldPoint.y),
    settings.defaultPipeGapMm + (proposal.target.gasOuterDiameterMm + proposal.target.liquidOuterDiameterMm) / 2,
  );
  const approachRadius = physicalRadius + (proposal.bendRadiusFactor === undefined ? 0 : approachSpacing / 2);
  const startStraight = startBundle.connectionKind === 'unit-port'
    ? getUnitPortApproachStraightMm(startBundle, approachSpacing, physicalRadius, settings.minimumPortStubMm)
    : settings.defaultBranchKitClearanceMm;
  const endStraight = settings.defaultBranchKitClearanceMm;
  const outletDirection = normalize(
    add(proposal.gasGhost.branchOutletDirection, proposal.liquidGhost.branchOutletDirection),
  );
  const end = midpoint(gasOutlet, liquidOutlet);
  return {
    start: startBundle.point,
    end,
    startDirection: startBundle.direction,
    endDirection: outletDirection,
    startStraightMm: startStraight,
    endStraightMm: endStraight,
    bendRadiusMm: approachRadius,
  };
}

function buildBranchConnectionRouteCandidates(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
  authoredRoute?: readonly Point2D[],
): Point2D[][] {
  const options = getBranchKitApproachRouteOptions(proposal, startBundle);
  if (authoredRoute && authoredRoute.length > 2 &&
    authoredRoute.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    const waypoints = dedupeConsecutive([startBundle.point, ...authoredRoute.slice(1, -1)]);
    const previous = waypoints.at(-1)!;
    if (waypoints.length > 1) {
      const previousDirection = normalize(subtract(previous, waypoints.at(-2)!));
      // A clicked waypoint can be the next bend. Only a physical socket fixes
      // the departure axis and straight length; imposing those on a waypoint
      // creates a needless escape leg and a return bend.
      return buildOrthogonalConnectionRouteCandidates({
        ...options,
        start: previous,
        startDirection: undefined,
        incomingDirection: previousDirection,
        startStraightMm: 0,
      }).map((tail) => dedupeConsecutive([...waypoints, ...tail.slice(1)]));
    }
  }
  return buildOrthogonalConnectionRouteCandidates(options);
}

function buildBranchKitConnectionElements(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
  gasKitId: string,
  liquidKitId: string,
  authoredRoute?: readonly Point2D[],
  makeId = createBranchKitElementId,
): HvacElement[] {
  const routeClass =
    startBundle.connectionKind === 'unit-port' ? 'indoor-connection' : 'sub-branch';
  const gasOutlet = proposal.gasGhost.branchOutletPoint;
  const liquidOutlet = proposal.liquidGhost.branchOutletPoint;
  const centerline = proposal.connectionRoute
    ?? buildBranchConnectionRouteCandidates(proposal, startBundle, authoredRoute)[0];
  if (!centerline) return [];
  const gasBranchConnection = branchTerminalConnection(
    gasKitId,
    'gas',
    'branch-outlet',
    gasOutlet,
    proposal.gasGhost.branchOutletDirection,
    proposal.target.gasElevationMm,
  );
  const liquidBranchConnection = branchTerminalConnection(
    liquidKitId,
    'liquid',
    'branch-outlet',
    liquidOutlet,
    proposal.liquidGhost.branchOutletDirection,
    proposal.target.liquidElevationMm,
  );
  const endConnection: RefrigerantPipeBundleConnection = {
    point: midpoint(gasOutlet, liquidOutlet),
    gasPoint: gasOutlet,
    liquidPoint: liquidOutlet,
    gasFieldPoint: gasOutlet,
    liquidFieldPoint: liquidOutlet,
    gasOuterDiameterMm: proposal.target.gasOuterDiameterMm,
    liquidOuterDiameterMm: proposal.target.liquidOuterDiameterMm,
    gasDirection: proposal.gasGhost.branchOutletDirection,
    liquidDirection: proposal.liquidGhost.branchOutletDirection,
    direction: normalize(
      add(proposal.gasGhost.branchOutletDirection, proposal.liquidGhost.branchOutletDirection),
    ),
    elevationMm: proposal.target.elevationMm,
    gasElevationMm: proposal.target.gasElevationMm,
    liquidElevationMm: proposal.target.liquidElevationMm,
    connectionKind: 'field-pipe',
    sourceElementId: gasKitId,
    gasSourceElementId: gasKitId,
    liquidSourceElementId: liquidKitId,
    gasPortId: gasBranchConnection.portId,
    liquidPortId: liquidBranchConnection.portId,
    gasNodeId: gasBranchConnection.nodeId,
    liquidNodeId: liquidBranchConnection.nodeId,
    terminalRole: 'branch-outlet',
  };

  // Preserve one logical pair for selection, continuation, and later branching.
  const connectionBundleId = makeId('refrigerant-bundle-connection');
  const plannedStart = { ...startBundle };
  if (proposal.levelPlan && startBundle.connectionKind === 'field-pipe') {
    for (const service of ['gas', 'liquid'] as const) {
      const level = networkFieldConnectionLevel({
        connectionKind: 'field-pipe',
        portPoint: service === 'gas' ? startBundle.gasPoint : startBundle.liquidPoint,
        direction: startBundle.direction,
        sourceElementId: (service === 'gas' ? startBundle.gasSourceElementId : startBundle.liquidSourceElementId) ?? startBundle.sourceElementId,
        elevationMm: service === 'gas' ? startBundle.gasElevationMm : startBundle.liquidElevationMm,
      }, service, proposal.levelPlan);
      if (service === 'gas') plannedStart.gasElevationMm = level;
      else plannedStart.liquidElevationMm = level;
    }
    plannedStart.elevationMm = (plannedStart.gasElevationMm + plannedStart.liquidElevationMm) / 2;
  }
  const connElements = buildRefrigerantPipeElements(centerline, {
    startBundleConnection: plannedStart,
    endBundleConnection: endConnection,
    bendRadiusFactor: proposal.bendRadiusFactor,
  }).map((built) => {
    const lineKind =
      (built.properties as { lineKind?: string }).lineKind === 'liquid' ? 'liquid' : 'gas';
    return {
      ...built,
      id: makeId(`refrigerant-pipe-conn-${lineKind}`),
      properties: {
        ...(built.properties ?? {}),
        bundleId: connectionBundleId,
        routeClass,
      },
    } as HvacElement;
  });
  if (!proposal.levelPlan) return connElements;
  const coordinated = applyNetworkPipeLevels(connElements, proposal.levelPlan);
  return coordinated.issues.length ? [] : coordinated.elements;
}

/** Identical branch geometry to commit, without host mutations or generated IDs. */
export function buildBranchKitRoutePreview(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
  authoredRoute?: readonly Point2D[],
): HvacElement[] {
  if (proposal.validity === 'invalid') return [];
  return buildBranchKitConnectionElements(
    proposal, startBundle, 'preview-branch-kit-gas', 'preview-branch-kit-liquid',
    authoredRoute, (prefix) => `preview-${prefix}`,
  );
}

export function buildBranchKitInsertion(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
  sceneElements: HvacElement[] = [],
  authoredRoute?: readonly Point2D[],
): BranchKitInsertion | null {
  const insertion = prepareBranchKitInsertion(proposal, startBundle, sceneElements, authoredRoute);
  if (!insertion) return null;
  // Recheck against the complete current scene, including unrelated runs that
  // may have moved since the proposal. Preview checks the same split geometry.
  if (hasNewNetworkPipeClash(sceneElements,
    [...(insertion.updates ?? []), ...insertion.elementsToAdd], insertion.removeElementIds)) return null;
  return insertion;
}

function prepareBranchKitInsertion(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
  sceneElements: HvacElement[],
  authoredRoute?: readonly Point2D[],
  makeId = createBranchKitElementId,
): BranchKitInsertion | null {
  if (proposal.validity === 'invalid') return null;
  if (proposal.levelPlan && (!proposal.levelPlan.feasible || !isNetworkLevelPlanCurrent(proposal.levelPlan, sceneElements))) return null;
  const levelOverrides = new Map(proposal.levelPlan?.updates.map(element => [element.id, element]) ?? []);
  const plannedScene = sceneElements.map(element => levelOverrides.get(element.id) ?? element);
  const currentSettings = proposal.levelPlan?.settings ?? getActivePipeRoutingSettings();
  // The scene can change while the preview card is open. Recheck equipment and
  // fitting spacing at acceptance so a stale, now-obstructed ghost is never
  // committed as a decorative or physically inaccessible joint.
  if (branchStationClearanceViolation(
    proposal.gasGhost,
    proposal.liquidGhost,
    proposal.teePoint,
    plannedScene,
    currentSettings,
  )) return null;
  const gasKitId = makeId('refrigerant-branch-kit-gas');
  const liquidKitId = makeId('refrigerant-branch-kit-liquid');
  const gasKitElement: HvacElement = { ...proposal.gasGhost.element, id: gasKitId };
  const liquidKitElement: HvacElement = { ...proposal.liquidGhost.element, id: liquidKitId };
  const connections = buildBranchKitConnectionElements(
    proposal, startBundle, gasKitId, liquidKitId, authoredRoute, makeId,
  );
  if (connections.length !== 2) return null;
  const elementsToAdd: HvacElement[] = [gasKitElement, liquidKitElement, ...connections];

  // Real flow-connected tee (W3b, enabled by default): split the
  // tapped gas + liquid runs at the kit station into run-in/run-out halves and
  // remove the originals, so the network is genuinely connected through the kit
  // rather than overlaid on an intact run. The kit elements switch to fixed
  // (absolute) placement so they no longer depend on the now-deleted run element
  // for positioning. Both replacements must succeed before anything is added.
  let removeElementIds: string[] = [];
  { // New connections always replace the physical hosts, including legacy documents.
    const teeId = makeId('refrigerant-tee');
    const gasRunId = readSnapSourceElementId(proposal.gasGhost.element);
    const liquidRunId = readSnapSourceElementId(proposal.liquidGhost.element);
    const gasRun = findSnapSourceRun(plannedScene, gasRunId, 'gas');
    const liquidRun = findSnapSourceRun(plannedScene, liquidRunId, 'liquid');
    if (gasRun && liquidRun) {
      const gasTrunkDirection = normalize(
        subtract(proposal.gasGhost.runOutletPoint, proposal.gasGhost.inletPoint),
      );
      const liquidTrunkDirection = normalize(
        subtract(proposal.liquidGhost.runOutletPoint, proposal.liquidGhost.inletPoint),
      );
      const gasHalves = buildTeeRunHalves(
        gasRun,
        proposal.gasGhost.stationPoint,
        teeId,
        {
          inletPoint: proposal.gasGhost.inletPoint,
          runOutletPoint: proposal.gasGhost.runOutletPoint,
          inletConnection: branchTerminalConnection(
            gasKitId,
            'gas',
            'inlet',
            proposal.gasGhost.inletPoint,
            scale(gasTrunkDirection, -1),
            proposal.target.gasElevationMm,
          ),
          runOutletConnection: branchTerminalConnection(
            gasKitId,
            'gas',
            'run-outlet',
            proposal.gasGhost.runOutletPoint,
            gasTrunkDirection,
            proposal.target.gasElevationMm,
          ),
        },
        makeId,
      );
      const liquidHalves = buildTeeRunHalves(
        liquidRun,
        proposal.liquidGhost.stationPoint,
        teeId,
        {
          inletPoint: proposal.liquidGhost.inletPoint,
          runOutletPoint: proposal.liquidGhost.runOutletPoint,
          inletConnection: branchTerminalConnection(
            liquidKitId,
            'liquid',
            'inlet',
            proposal.liquidGhost.inletPoint,
            scale(liquidTrunkDirection, -1),
            proposal.target.liquidElevationMm,
          ),
          runOutletConnection: branchTerminalConnection(
            liquidKitId,
            'liquid',
            'run-outlet',
            proposal.liquidGhost.runOutletPoint,
            liquidTrunkDirection,
            proposal.target.liquidElevationMm,
          ),
        },
        makeId,
      );
      if (gasHalves && liquidHalves) {
        elementsToAdd.push(...gasHalves, ...liquidHalves);
        removeElementIds = [gasRun.id, liquidRun.id];
        gasKitElement.properties = {
          ...gasKitElement.properties,
          branchKitPlacementMode: 'fixed',
          branchType: 'y-joint',
          teeId,
        };
        liquidKitElement.properties = {
          ...liquidKitElement.properties,
          branchKitPlacementMode: 'fixed',
          branchType: 'y-joint',
          teeId,
        };
      }
    }
    if (removeElementIds.length !== 2) return null;
  }

  // Existing continuations may identify their host only by its old pipe or
  // bundle id. Retarget that identity to the half retaining the same physical
  // terminal; otherwise deleting the host silently disconnects later network
  // analysis even though the tubes still touch. Locks protect geometry, not an
  // obsolete source id, so these metadata updates include locked continuations.
  const removed = new Set(removeElementIds);
  const survivingScene = plannedScene.filter(element => !removed.has(element.id));
  const bindings: Array<{
    sources: string[];
    service: RefrigerantBranchLineKind;
    point: Point2D;
    replacementId: string;
    replacementBundleId: string;
  }> = [];
  for (const host of plannedScene.filter(element => removed.has(element.id))) {
    const spec = resolveRefrigerantPipeSpec(host.properties);
    const sourceIds = [host.id, spec.bundleId].filter((id): id is string => Boolean(id));
    for (const endpoint of [spec.routePoints[0], spec.routePoints.at(-1)]) {
      if (!endpoint) continue;
      const replacement = elementsToAdd.find(element => {
        if (element.type !== 'refrigerant-pipe' || !element.properties.teeRole) return false;
        const half = resolveRefrigerantPipeSpec(element.properties);
        return half.lineKind === spec.lineKind && [half.routePoints[0], half.routePoints.at(-1)]
          .some(point => point && distance(point, endpoint) <= 0.5);
      });
      if (replacement) bindings.push({
        sources: sourceIds, service: spec.lineKind, point: endpoint,
        replacementId: replacement.id,
        replacementBundleId: replacement.properties.bundleId as string,
      });
    }
  }
  const oldSources = new Set(bindings.flatMap(binding => binding.sources));
  const survivingSources = new Set(survivingScene.flatMap(element => [element.id,
    typeof element.properties.bundleId === 'string' ? element.properties.bundleId : ''].filter(Boolean)));
  let orphanedSource = false;
  const rebind = (element: HvacElement): HvacElement => {
    let properties = element.properties;
    for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
      const raw = properties[key];
      if (!raw || typeof raw !== 'object') continue;
      const connection = raw as Record<string, unknown>;
      if (connection.connectionKind !== 'field-pipe') continue;
      const bundleConnection = key.includes('Bundle');
      const services: RefrigerantBranchLineKind[] = bundleConnection ? ['gas', 'liquid']
        : element.properties.lineKind === 'gas' || element.properties.lineKind === 'liquid'
          ? [element.properties.lineKind] : [];
      let next = connection;
      const matched: typeof bindings = [];
      for (const service of services) {
        const serviceSource = bundleConnection ? connection[`${service}SourceElementId`] : undefined;
        const source = typeof serviceSource === 'string' ? serviceSource : connection.sourceElementId;
        if (typeof source !== 'string' || !oldSources.has(source)) continue;
        const rawPoint = bundleConnection ? connection[`${service}Point`] : connection.portPoint;
        const point = rawPoint as Point2D | undefined;
        const binding = point && Number.isFinite(point.x) && Number.isFinite(point.y)
          ? bindings.find(candidate => candidate.service === service && candidate.sources.includes(source)
            && distance(candidate.point, point) <= 0.5) : undefined;
        if (!binding) {
          if (!survivingSources.has(source)) orphanedSource = true;
          continue;
        }
        matched.push(binding);
        next = { ...next, [bundleConnection ? `${service}SourceElementId` : 'sourceElementId']: binding.replacementId };
      }
      if (bundleConnection && matched.length && typeof connection.sourceElementId === 'string'
        && oldSources.has(connection.sourceElementId)) {
        next = { ...next, sourceElementId: matched.every(binding => binding.replacementBundleId === matched[0]!.replacementBundleId)
          ? matched[0]!.replacementBundleId : matched[0]!.replacementId };
      }
      if (next !== connection) properties = { ...properties, [key]: next };
    }
    return properties === element.properties ? element : { ...element, properties };
  };
  const updateById = new Map((proposal.levelPlan?.updates ?? [])
    .filter(element => !removed.has(element.id)).map(element => [element.id, element]));
  for (const element of survivingScene) {
    const rebound = rebind(element);
    if (rebound !== element) updateById.set(element.id, rebound);
  }
  for (let index = 0; index < elementsToAdd.length; index += 1) elementsToAdd[index] = rebind(elementsToAdd[index]!);
  if (orphanedSource) return null;

  return {
    elementsToAdd,
    removeElementIds,
    kitElementIds: [gasKitId, liquidKitId],
    updates: [...updateById.values()],
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const CONNECTION_TYPE_LABELS: Record<BranchKitConnectionType, string> = {
  'indoor-to-branch': 'Indoor unit → branch',
  'indoor-to-sub-branch': 'Indoor unit → sub-branch',
  'sub-branch-to-main-branch': 'Sub-branch → main branch',
  'branch-to-main-line': 'Branch → main line',
  'generic-tee': 'Branch tee',
};

export function describeBranchKitConnectionType(type: BranchKitConnectionType): string {
  return CONNECTION_TYPE_LABELS[type];
}

/** Default min branch-kit spacing if not configured (exported for settings UI). */
export function defaultMinBranchKitSpacingMm(settings = DEFAULT_PIPE_ROUTING_SETTINGS): number {
  return resolveMinBranchKitSpacingMm(settings);
}
