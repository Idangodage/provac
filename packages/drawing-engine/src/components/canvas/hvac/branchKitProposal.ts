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
 * IMPORTANT — this reuses the *existing* inline branch-kit placement model so
 * the proposed kits look identical to a hand-placed kit: each kit is placed
 * **on top of the intact run** with the full `branchKitSnap*` metadata that
 * {@link ./HvacPlanRenderer}'s `resolveInlineBranchKitRenderCenter` consumes
 * (segment, projected distance, source element, direction). The run is NOT
 * physically split — the renderer overlays the kit fitting on the continuous
 * pipe (the same way the manual placement tool does).
 *
 * Two public entry points:
 *  - {@link proposeBranchKit} — geometry used every mouse move to drive the
 *    dashed ghost preview + the "Insert branch kit" card.
 *  - {@link buildBranchKitInsertion} — turns an accepted proposal into the
 *    concrete element additions: the two kit elements + the gas/liquid branch
 *    drop (no run elements are removed).
 *
 * All distances are millimetres. This module is framework-free so it can be
 * unit-tested in isolation.
 */

import {
  DEFAULT_AC_EQUIPMENT_LIBRARY,
  type AcEquipmentDefinition,
} from '../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../types';

import { planBundleBypasses } from './pipeClashRouting';
import {
  DEFAULT_PIPE_ROUTING_SETTINGS,
  getActivePipeRoutingSettings,
  type PipeRoutingSettings,
} from './pipeRoutingSettings';
import {
  buildRefrigerantBranchKitViewModel,
  resolveRefrigerantBranchKitConnectionIdentity,
  resolveRefrigerantBranchKitInlineAnchorLocal,
  type RefrigerantBranchKitModelSpec,
  type RefrigerantBranchLineKind,
} from './refrigerantBranchKitModel';
import {
  buildRefrigerantPipeElements,
  findNearestRefrigerantPipeBundleSegmentTarget,
  findNearestRefrigerantPipeSegmentTarget,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeBundleSegmentConnection,
  type RefrigerantPipeSegmentConnection,
} from './refrigerantPipePairModel';
import {
  findNearestVisibleRefrigerantPipeBundleSegmentTarget,
  findNearestVisibleRefrigerantPipeSegmentTarget,
} from './refrigerantPipeRenderState';

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
}

export interface ProposeBranchKitOptions {
  /** Capture radius (mm) within which a run becomes a proposal candidate. */
  proposalRadiusMm?: number;
  /** Run sourceIds / element ids never tee'd into (e.g. the start's own run). */
  excludeSourceIds?: string[];
  /** Force the branch outlets to the flipped side (user pressed "Flip"). */
  flip?: boolean;
  settings?: PipeRoutingSettings;
}

/** The concrete element additions produced when a proposal is accepted. */
export interface BranchKitInsertion {
  /** Kit pair + the gas/liquid branch drop, each with a fresh id. */
  elementsToAdd: HvacElement[];
  /**
   * Element ids to delete. Empty for this engine — the run stays intact and the
   * renderer overlays the kit fitting (the trim path is disabled, see
   * HvacPlanRenderer). Kept in the shape for forward compatibility.
   */
  removeElementIds: string[];
  /** Ids of the two created kit elements (gas, liquid) for selection. */
  kitElementIds: string[];
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
/** Nearest unit axis (±x or ±y) to a direction. */
function snapToAxis(d: Point2D): Point2D {
  return Math.abs(d.x) >= Math.abs(d.y)
    ? { x: Math.sign(d.x) || 1, y: 0 }
    : { x: 0, y: Math.sign(d.y) || 1 };
}
/** Drop consecutive duplicate points. */
function dedupeConsecutive(points: Point2D[]): Point2D[] {
  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || distance(previous, point) > 1e-3;
  });
}
/**
 * Practical orthogonal (right-angle) route from a connection port to a joint
 * outlet: leave the port along its axis and arrive at the outlet along the
 * OUTLET axis (so the pair builder anchors the ends cleanly, not diagonally).
 * Perpendicular port/outlet axes give an L; parallel axes give a Z.
 */
function buildOrthogonalConnectionRoute(
  port: Point2D,
  portDirection: Point2D,
  outlet: Point2D,
  outletDirection: Point2D,
): Point2D[] {
  const portAxis = snapToAxis(portDirection);
  const outletAxis = snapToAxis(outletDirection);
  const parallel = Math.abs(portAxis.x * outletAxis.x + portAxis.y * outletAxis.y) >= 0.5;
  if (!parallel) {
    // L: meet at the right-angle corner of the two axis lines, so the final leg
    // runs along the outlet axis.
    const corner =
      Math.abs(portAxis.x) > 0 ? { x: outlet.x, y: port.y } : { x: port.x, y: outlet.y };
    return dedupeConsecutive([port, corner, outlet]);
  }
  // Z: leave the port along its axis, jog across, then run along the outlet axis.
  const stubMm = Math.min(150, Math.max(40, distance(port, outlet) * 0.3));
  const leg = add(port, scale(portAxis, stubMm));
  const corner =
    Math.abs(portAxis.x) > 0 ? { x: leg.x, y: outlet.y } : { x: outlet.x, y: leg.y };
  return dedupeConsecutive([port, leg, corner, outlet]);
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
  if (!definition) {
    return null;
  }
  const baseProperties: Record<string, unknown> = {
    definitionId: definition.id,
    ...definition.defaultProperties,
  };
  const model = buildRefrigerantBranchKitViewModel({
    type: 'refrigerant-branch-kit',
    subtype: definition.subtype,
    modelLabel: definition.modelLabel,
    properties: baseProperties,
  });
  const footprint = resolveLineKitFootprint(model, lineKind);
  const runDirection = normalize(segment.direction);

  const minStation = footprint.requiredBackwardMm + clearanceMm;
  const maxStation = segment.segmentLengthMm - footprint.requiredForwardMm - clearanceMm;
  if (maxStation < minStation) {
    return null; // run too short to host this kit with clearance
  }
  const clampedStation = clamp(segment.projectedDistanceMm, minStation, maxStation);
  const nudged = Math.abs(clampedStation - segment.projectedDistanceMm) > 1;
  const stationPoint = add(segment.segmentStart, scale(runDirection, clampedStation));

  const baseRotationDeg = angleDeg(runDirection) - angleDeg(footprint.anchorDirectionLocal);
  const candidateRotations = [baseRotationDeg, baseRotationDeg + 180];
  const evaluate = (rotationDeg: number) => {
    const center = subtract(stationPoint, rotateDeg(footprint.anchorLocal, rotationDeg));
    const identity = resolveRefrigerantBranchKitConnectionIdentity({
      model,
      role: 'branch-outlet',
      lineSelection: lineKind,
      worldCenter: center,
      rotationDeg,
    });
    if (!identity) {
      return null;
    }
    const branchOutletPoint = lineKind === 'gas' ? identity.gasPoint : identity.liquidPoint;
    return { rotationDeg, center, faceScore: distance(branchOutletPoint, faceToward) };
  };
  const evaluated = candidateRotations
    .map(evaluate)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (evaluated.length === 0) {
    return null;
  }
  evaluated.sort((a, b) => a.faceScore - b.faceScore);
  // Default faces the drop origin; "Flip" forces the opposite orientation.
  const chosen = params.flip && evaluated.length > 1 ? evaluated[1]! : evaluated[0]!;

  const terminalIdentity = (role: 'inlet' | 'run-outlet' | 'branch-outlet') =>
    resolveRefrigerantBranchKitConnectionIdentity({
      model,
      role,
      lineSelection: lineKind,
      worldCenter: chosen.center,
      rotationDeg: chosen.rotationDeg,
    });
  const inletId = terminalIdentity('inlet');
  const runOutletId = terminalIdentity('run-outlet');
  const branchOutletId = terminalIdentity('branch-outlet');
  if (!inletId || !runOutletId || !branchOutletId) {
    return null;
  }
  const pick = (id: NonNullable<ReturnType<typeof resolveRefrigerantBranchKitConnectionIdentity>>) =>
    lineKind === 'gas'
      ? { point: id.gasPoint, direction: id.gasDirection }
      : { point: id.liquidPoint, direction: id.liquidDirection };
  const inlet = pick(inletId);
  const runOutlet = pick(runOutletId);
  const branchOutlet = pick(branchOutletId);
  const line = lineKind === 'gas' ? model.gas : model.liquid;

  const position: Point2D = {
    x: chosen.center.x - model.widthMm / 2,
    y: chosen.center.y - model.depthMm / 2,
  };
  const element: Omit<HvacElement, 'id'> = {
    type: 'refrigerant-branch-kit',
    category: 'accessory',
    subtype: definition.subtype,
    modelLabel: definition.modelLabel,
    position,
    rotation: chosen.rotationDeg,
    width: model.widthMm,
    depth: model.depthMm,
    height: model.heightMm,
    elevation: definition.elevationMm,
    mountType: 'ceiling',
    label: definition.name,
    supplyZoneRatio: definition.supplyZoneRatio ?? 0.5,
    properties: {
      ...baseProperties,
      // Full inline-snap metadata — identical shape to the manual placement
      // tool so HvacPlanRenderer.resolveInlineBranchKitRenderCenter glues the
      // kit to the run exactly like a hand-placed kit.
      branchKitPlacementMode: 'inline-pipe-run',
      branchKitSnapLineKind: lineKind,
      branchKitSnapAnchorLocal: footprint.anchorLocal,
      branchKitSnapSourceElementId: segment.sourceElementId ?? null,
      branchKitSnapConnectionKind: 'field-pipe',
      branchKitSnapPoint: stationPoint,
      branchKitSnapDirection: runDirection,
      branchKitSnapSegmentStart: segment.segmentStart,
      branchKitSnapSegmentEnd: segment.segmentEnd,
      branchKitSnapProjectedDistanceMm: clampedStation,
      routeClass: 'branch',
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

function isPointInsideExpandedBox(
  point: Point2D,
  element: HvacElement,
  marginMm: number,
): boolean {
  return (
    point.x >= element.position.x - marginMm &&
    point.x <= element.position.x + element.width + marginMm &&
    point.y >= element.position.y - marginMm &&
    point.y <= element.position.y + element.depth + marginMm
  );
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

// ---------------------------------------------------------------------------
// proposeBranchKit
// ---------------------------------------------------------------------------

function findLineSegmentNear(
  scene: HvacElement[],
  lineKind: RefrigerantBranchLineKind,
  point: Point2D,
  radiusMm: number,
  minSegmentLengthMm: number,
): RefrigerantPipeSegmentConnection | null {
  return (
    findNearestRefrigerantPipeSegmentTarget(scene, point, radiusMm, {
      lineKind,
      minSegmentLengthMm,
    }) ??
    (findNearestVisibleRefrigerantPipeSegmentTarget(scene, point, radiusMm, {
      lineKind,
      minSegmentLengthMm,
    }) as unknown as RefrigerantPipeSegmentConnection | null)
  );
}

export function proposeBranchKit(
  scene: HvacElement[],
  startBundle: RefrigerantPipeBundleConnection | null,
  cursorPoint: Point2D,
  options?: ProposeBranchKitOptions,
): BranchKitProposal | null {
  if (!startBundle) {
    return null;
  }
  const settings = options?.settings ?? getActivePipeRoutingSettings();
  const proposalRadiusMm = options?.proposalRadiusMm ?? Math.max(140, settings.snapRadiusPx * 8);
  const excludeSourceIds = new Set(options?.excludeSourceIds ?? []);
  if (startBundle.sourceElementId) {
    excludeSourceIds.add(startBundle.sourceElementId);
  }
  const minSegmentLengthMm = estimateMinRunLengthMm();

  // The bundle target gives a consistent gas+liquid station + run direction.
  const modelBundleTarget = findNearestRefrigerantPipeBundleSegmentTarget(
    scene,
    cursorPoint,
    proposalRadiusMm,
    { minSegmentLengthMm },
  );
  const bundleTarget: RefrigerantPipeBundleSegmentConnection | null =
    modelBundleTarget ??
    (findNearestVisibleRefrigerantPipeBundleSegmentTarget(scene, cursorPoint, proposalRadiusMm, {
      minSegmentLengthMm,
    }) as unknown as RefrigerantPipeBundleSegmentConnection | null);
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

  const gasSegment = findLineSegmentNear(scene, 'gas', gasStationPoint, proposalRadiusMm, minSegmentLengthMm);
  const liquidSegment = findLineSegmentNear(
    scene,
    'liquid',
    liquidStationPoint,
    proposalRadiusMm,
    minSegmentLengthMm,
  );
  if (!gasSegment || !liquidSegment) {
    return null;
  }

  const clearanceMm = Math.max(0, settings.defaultBranchKitClearanceMm);
  const faceToward = startBundle.point ?? cursorPoint;
  const flip = options?.flip ?? false;
  const gasGhost = placeKitOnLineSegment({
    lineKind: 'gas',
    segment: gasSegment,
    faceToward,
    clearanceMm,
    flip,
  });
  const liquidGhost = placeKitOnLineSegment({
    lineKind: 'liquid',
    segment: liquidSegment,
    faceToward,
    clearanceMm,
    flip,
  });

  const violations: string[] = [];
  let validity: BranchKitProposalValidity = 'valid';
  if (!gasGhost || !liquidGhost) {
    // Run too short for the kit body + clearance — report a best-effort invalid
    // proposal anchored at the cursor station so the user gets feedback.
    return buildInvalidProposal(target, gasStationPoint, liquidStationPoint, startBundle, flip);
  }
  if (gasGhost.nudged || liquidGhost.nudged) {
    validity = 'needs-nudge';
    violations.push('Kit slid along the run to keep clearance from the run ends.');
  }

  const teePoint = midpoint(gasGhost.stationPoint, liquidGhost.stationPoint);

  // Clearance from existing branch kits and indoor-unit bodies.
  const minKitSpacingMm = resolveMinBranchKitSpacingMm(settings);
  for (const element of scene) {
    if (element.type === 'refrigerant-branch-kit') {
      if (distance(elementCenter(element), teePoint) < minKitSpacingMm) {
        validity = 'invalid';
        violations.unshift('Too close to an existing branch kit.');
        break;
      }
    }
  }
  if (validity !== 'invalid') {
    const unitClearanceMm = Math.max(0, settings.defaultUnitClearanceMm);
    for (const element of scene) {
      if (isIndoorUnitElement(element) && isPointInsideExpandedBox(teePoint, element, unitClearanceMm)) {
        validity = 'invalid';
        violations.unshift('Inside an indoor unit clearance zone.');
        break;
      }
    }
  }

  const connectionType = classifyConnectionType(startBundle, target);
  const cursorPenalty = distance(cursorPoint, teePoint);
  const nudgePenalty = validity === 'needs-nudge' ? 120 : 0;
  const invalidPenalty = validity === 'invalid' ? 10000 : 0;
  const score = cursorPenalty + nudgePenalty + invalidPenalty;

  return {
    connectionType,
    validity,
    violations,
    score,
    teePoint,
    runDirection,
    gasGhost,
    liquidGhost,
    target,
    flip,
  };
}

/** Best-effort invalid proposal (run too short) so the card can warn the user. */
function buildInvalidProposal(
  target: BranchKitProposalTarget,
  gasStationPoint: Point2D,
  liquidStationPoint: Point2D,
  startBundle: RefrigerantPipeBundleConnection,
  flip: boolean,
): BranchKitProposal | null {
  const faceToward = startBundle.point ?? gasStationPoint;
  // Place with zero clearance just to produce a ghost; mark invalid.
  const makeSegment = (
    lineKind: RefrigerantBranchLineKind,
    stationPoint: Point2D,
  ): RefrigerantPipeSegmentConnection => ({
    point: stationPoint,
    direction: target.direction,
    segmentStart: target.segmentStart,
    segmentEnd: target.segmentEnd,
    segmentLengthMm: target.segmentLengthMm,
    projectedDistanceMm: dot(subtract(stationPoint, target.segmentStart), target.direction),
    lineKind,
    elevationMm: lineKind === 'gas' ? target.gasElevationMm : target.liquidElevationMm,
    outerDiameterMm: lineKind === 'gas' ? target.gasOuterDiameterMm : target.liquidOuterDiameterMm,
    sourceElementId: undefined,
  });
  const gasGhost = placeKitOnLineSegment({
    lineKind: 'gas',
    segment: makeSegment('gas', gasStationPoint),
    faceToward,
    clearanceMm: 0,
    flip,
  });
  const liquidGhost = placeKitOnLineSegment({
    lineKind: 'liquid',
    segment: makeSegment('liquid', liquidStationPoint),
    faceToward,
    clearanceMm: 0,
    flip,
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

/** True only when two polylines genuinely intersect (not merely run close). */
function polylinesIntersect(p: Point2D[], q: Point2D[]): boolean {
  const orientation = (a: Point2D, b: Point2D, c: Point2D): number =>
    Math.sign((b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y));
  for (let i = 0; i < p.length - 1; i += 1) {
    for (let j = 0; j < q.length - 1; j += 1) {
      const a = p[i]!;
      const b = p[i + 1]!;
      const c = q[j]!;
      const d = q[j + 1]!;
      if (
        orientation(a, b, c) !== orientation(a, b, d) &&
        orientation(c, d, a) !== orientation(c, d, b)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Turns an accepted proposal into the concrete element additions: the two branch
 * joints (gas + liquid) placed on the intact run, plus the connecting pipes from
 * the start unit/branch to each joint's branch outlet.
 *
 * The connection is routed as a gas/liquid PAIR along a single ORTHOGONAL
 * (right-angle) centerline — the pair builder offsets the two lines
 * concentrically around the bends so they stay parallel (the gap never
 * collapses), how field pipes actually run. A genuine gas↔liquid crossing
 * (when the unit's gas/liquid order is opposed to the run's) is resolved as a
 * clean over/under. No run elements are removed.
 */
export function buildBranchKitInsertion(
  proposal: BranchKitProposal,
  startBundle: RefrigerantPipeBundleConnection,
): BranchKitInsertion | null {
  if (proposal.validity === 'invalid') {
    return null;
  }
  const gasKitId = createBranchKitElementId('refrigerant-branch-kit-gas');
  const liquidKitId = createBranchKitElementId('refrigerant-branch-kit-liquid');
  const gasKitElement: HvacElement = { ...proposal.gasGhost.element, id: gasKitId };
  const liquidKitElement: HvacElement = { ...proposal.liquidGhost.element, id: liquidKitId };

  const routeClass =
    startBundle.connectionKind === 'unit-port' ? 'indoor-connection' : 'sub-branch';
  const gasOutlet = proposal.gasGhost.branchOutletPoint;
  const liquidOutlet = proposal.liquidGhost.branchOutletPoint;

  // Orthogonal bundle centerline from the unit/branch to the joint outlets,
  // arriving along the outlet axis so the ends anchor cleanly (not diagonally).
  const outletDirection = normalize(
    add(proposal.gasGhost.branchOutletDirection, proposal.liquidGhost.branchOutletDirection),
  );
  const centerline = buildOrthogonalConnectionRoute(
    startBundle.point,
    startBundle.direction,
    midpoint(gasOutlet, liquidOutlet),
    outletDirection,
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
    terminalRole: 'branch-outlet',
  };

  // Distinct bundle ids per line so the clash engine can see them as separate
  // pipes and detect the (occasional) gas↔liquid crossing at the outlet splay.
  const connBundleIds = {
    gas: createBranchKitElementId('refrigerant-bundle-conn-gas'),
    liquid: createBranchKitElementId('refrigerant-bundle-conn-liquid'),
  };
  const connElements = buildRefrigerantPipeElements(centerline, {
    startBundleConnection: startBundle,
    endBundleConnection: endConnection,
  }).map((built) => {
    const lineKind =
      (built.properties as { lineKind?: string }).lineKind === 'liquid' ? 'liquid' : 'gas';
    return {
      ...built,
      id: createBranchKitElementId(`refrigerant-pipe-conn-${lineKind}`),
      properties: {
        ...(built.properties ?? {}),
        bundleId: connBundleIds[lineKind],
        routeClass,
      },
    } as HvacElement;
  });
  let gasConnection = connElements.find(
    (e) => (e.properties as { lineKind?: string }).lineKind === 'gas',
  );
  const liquidConnection = connElements.find(
    (e) => (e.properties as { lineKind?: string }).lineKind === 'liquid',
  );

  // Resolve a genuine gas↔liquid crossing as a clean over/under (lift gas over
  // liquid at that single point). Gated on a true intersection so the parallel
  // run — which is always within clearance — is never flagged.
  if (
    gasConnection &&
    liquidConnection &&
    polylinesIntersect(readRoutePoints(gasConnection), readRoutePoints(liquidConnection))
  ) {
    try {
      const plan = planBundleBypasses([gasConnection, liquidConnection], [gasConnection.id], {
        mode: 'auto',
      });
      const bypasses = plan.byElementId.get(gasConnection.id);
      if (bypasses && bypasses.length > 0) {
        gasConnection = {
          ...gasConnection,
          properties: { ...gasConnection.properties, bypasses },
        };
      }
    } catch {
      // Best effort — never block placing the connection over a bypass failure.
    }
  }

  const elementsToAdd: HvacElement[] = [gasKitElement, liquidKitElement];
  if (gasConnection) {
    elementsToAdd.push(gasConnection);
  }
  if (liquidConnection) {
    elementsToAdd.push(liquidConnection);
  }

  return {
    elementsToAdd,
    removeElementIds: [],
    kitElementIds: [gasKitId, liquidKitId],
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
export function defaultMinBranchKitSpacingMm(): number {
  return resolveMinBranchKitSpacingMm(DEFAULT_PIPE_ROUTING_SETTINGS);
}
