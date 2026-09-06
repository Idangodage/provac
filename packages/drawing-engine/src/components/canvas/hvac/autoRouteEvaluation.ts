import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement, Wall } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';
import type { JsonObject, PipeRun, Vec3, VrfPipingDocument } from '../../../vrf/domain/types';
import { validateBranchOrientation } from '../../../vrf/rules/branch-orientation';
import { selectBranchKit } from '../../../vrf/rules/branch-selection';
import { buildVrfGeometrySnapshot } from '../../../vrf/rules/document-validation-adapter';
import { selectPipeSize } from '../../../vrf/rules/pipe-sizing';
import { analyzeRouteElevation } from '../../../vrf/rules/route-elevation';
import {
  isVerifiedManufacturerValue,
  PROJECT_FALLBACK_RULE_PROFILE,
  type ManufacturerRuleProfile,
  type RuleValue,
} from '../../../vrf/rules/rule-profile';

import { routingSettingsFromRuleProfile, type PipeRoutingSettings } from './pipeRoutingSettings';
import { bendRadiusFromDiameterMm } from './pipeTopology';
import { DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM, DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM } from './refrigerantPipeDimensions';
import { DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM, getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

export interface AutoRouteCostRates {
  currency: string;
  gasPipePerMetre: number;
  liquidPipePerMetre: number;
  elbowEach: number;
  branchPairEach: number;
  riserEach: number;
}

export interface AutoRouteEvaluationOptions {
  elements: HvacElement[];
  outdoorUnitId: string;
  indoorUnitIds: string[];
  profile?: ManufacturerRuleProfile;
  rates?: AutoRouteCostRates;
  objective?: 'balanced' | 'cost' | 'fewest-fittings';
  /** New synthesis cannot invent gas low pockets; existing equipment-required geometry is reviewed, not deleted. */
  elevationPolicy?: 'new-layout' | 'existing-layout';
  walls?: Wall[];
}

export interface AutoRoutePathMetrics {
  outdoorUnitId: string;
  indoorUnitId: string;
  lineKind: 'gas' | 'liquid';
  runIds: string[];
  branchIds: string[];
  /** Actual field tubing; manufactured fitting bodies are accounted for separately. */
  actualLengthMm: number;
  /** Null when any fitting/curved-run equivalent length is unknown. */
  equivalentLengthMm: number | null;
  firstBranchToIndoorLengthMm: number;
  heightDifferenceMm: number;
}

export interface AutoRouteRecommendation {
  entityId: string;
  kind: 'pipe' | 'branch-kit';
  status: 'matches' | 'change-recommended' | 'missing-data';
  downstreamCapacityIndex: number | null;
  recommendedDiameterMm?: number;
  recommendedModel?: string;
  note: string;
}

export interface AutoRouteEvaluation {
  feasible: boolean;
  hardIssues: string[];
  advisoryIssues: string[];
  score: number;
  /** Profile-checked is a data check, never a hydraulic or installation certification. */
  manufacturerQualification: 'preliminary' | 'profile-checked';
  recommendations: AutoRouteRecommendation[];
  paths: AutoRoutePathMetrics[];
  metrics: {
    pipeLengthMm: number;
    gasLengthMm: number;
    liquidLengthMm: number;
    /** One-way network length: larger of the two coordinated service networks. */
    networkLengthMm: number;
    maxPathLengthMm: number;
    maxEquivalentPathLengthMm: number | null;
    /** Accumulated change of direction / 90 degrees, insensitive to arc faceting. */
    bendCount: number;
    branchPairCount: number;
    riserCount: number;
    verticalTravelMm: number;
    elevationReversalCount: number;
    connectedIndoorCount: number;
    estimatedCost: number | null;
    currency?: string;
    relativeCostIndex: number;
    wallCrossingCount: number;
    totalCapacityIndex: number | null;
  };
}

interface Link { id: string; next: string; runId?: string; branchId?: string; reducerId?: string; lengthMm: number }
interface TracedPath extends AutoRoutePathMetrics { points: Vec3[] }
interface ServiceTrace {
  paths: TracedPath[];
  runIds: Set<string>;
  branchIds: Set<string>;
  indoorIds: Set<string>;
}
const services = ['gas', 'liquid'] as const;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const numberMetadata = (metadata: JsonObject | undefined, key: string): number | undefined => finiteNonnegative(metadata?.[key]) ? metadata[key] as number : undefined;
const stringMetadata = (metadata: JsonObject | undefined, key: string): string | undefined => typeof metadata?.[key] === 'string' ? metadata[key] as string : undefined;
const runPoints = (document: VrfPipingDocument, run: PipeRun): Vec3[] => run.nodeIds.flatMap((id) => document.routeNodes[id] ? [document.routeNodes[id]!.position] : []);

/** Reserve profile-governed geometry before searching, without changing document preferences. */
export function effectiveAutoRouteSettings(
  profile: ManufacturerRuleProfile | undefined,
  settings: PipeRoutingSettings,
  elements: HvacElement[],
): PipeRoutingSettings {
  if (!profile) return { ...settings };
  const mapped = routingSettingsFromRuleProfile(profile);
  const maximum = (...values: Array<number | undefined>) => Math.max(...values.filter((value): value is number => finiteNonnegative(value)));
  const models = new Set(DEFAULT_AC_EQUIPMENT_LIBRARY.filter(item => item.type === 'refrigerant-branch-kit').map(item => item.modelLabel));
  for (const element of elements.filter(item => item.type === 'refrigerant-branch-kit')) {
    const model = element.properties.model ?? element.properties.modelCode ?? element.modelLabel ?? element.subtype;
    if (typeof model === 'string') models.add(model);
  }
  const knownKits = profile.branchKits.filter(row => models.has(row.model));
  const diameters = [DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM, DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
    ...getRefrigerantPipeBundleSnapTargets(elements).flatMap(port => [port.gasOuterDiameterMm, port.liquidOuterDiameterMm]),
    ...elements.filter(item => item.type === 'refrigerant-pipe').map(item => resolveRefrigerantPipeSpec(item.properties).pipeDiameterMm),
  ].filter((value): value is number => finiteNonnegative(value) && value > 0);
  const knownPipeRows = profile.pipeSizing.filter(row => diameters.some(value => Math.abs(value - row.outsideDiameterMm.value) <= 0.25));
  const minimumInsulatedDiameter = Math.min(...diameters) + 2 * DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM;
  const requiredRadius = maximum(profile.portDefaults.minimumBendRadiusMm.value, ...knownPipeRows.map(row => row.minimumBendRadiusMm.value));
  return {
    ...settings,
    minimumPortStubMm: maximum(settings.minimumPortStubMm, mapped.minimumPortStubMm),
    defaultUnitClearanceMm: maximum(settings.defaultUnitClearanceMm, mapped.defaultUnitClearanceMm),
    defaultBranchKitClearanceMm: maximum(settings.defaultBranchKitClearanceMm, mapped.defaultBranchKitClearanceMm,
      ...knownKits.flatMap(row => row.straightZones.flatMap(zone => [zone.upstreamMinimumMm?.value, zone.downstreamMinimumMm?.value]))),
    minBranchKitSpacingMm: maximum(settings.minBranchKitSpacingMm, mapped.minBranchKitSpacingMm),
    minimumFieldBendRadiusMm: maximum(settings.minimumFieldBendRadiusMm, mapped.minimumFieldBendRadiusMm,
      ...knownPipeRows.filter(row => isVerifiedManufacturerValue(row.minimumBendRadiusMm)).map(row => row.minimumBendRadiusMm.value)),
    bendRadiusFactor: maximum(settings.bendRadiusFactor, requiredRadius / minimumInsulatedDiameter),
  };
}

function geometryMeasures(points: Vec3[]) {
  let turnRadians = 0;
  let risers = 0;
  let previousDirection: Vec3 | undefined;
  let previousVerticalSign = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = distance(a, b);
    if (!Number.isFinite(length) || length < 1e-6) continue;
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length };
    if (previousDirection) turnRadians += Math.acos(Math.max(-1, Math.min(1,
      direction.x * previousDirection.x + direction.y * previousDirection.y + direction.z * previousDirection.z,
    )));
    const verticalSign = Math.abs(b.z - a.z) > 1e-3 ? Math.sign(b.z - a.z) : 0;
    if (verticalSign && verticalSign !== previousVerticalSign) risers += 1;
    previousVerticalSign = verticalSign;
    previousDirection = direction;
  }
  return { bends: turnRadians / (Math.PI / 2), risers };
}

/** Reuse measurements only while evaluating this immutable native document.
 * A later candidate/evaluation always gets fresh maps, even if IDs are reused. */
function evaluationMeasurements(document: VrfPipingDocument) {
  const pointsByRun = new Map<string, Vec3[]>();
  const geometryByRun = new Map<string, ReturnType<typeof geometryMeasures>>();
  const elevationByRun = new Map<string, ReturnType<typeof analyzeRouteElevation>>();
  const lengthByRun = new Map<string, number>();
  const elevationByPath = new Map<TracedPath, ReturnType<typeof analyzeRouteElevation>>();
  const points = (run: PipeRun) => {
    let measured = pointsByRun.get(run.id);
    if (!measured) { measured = runPoints(document, run); pointsByRun.set(run.id, measured); }
    return measured;
  };
  return {
    points,
    geometry(run: PipeRun) {
      let measured = geometryByRun.get(run.id);
      if (!measured) { measured = geometryMeasures(points(run)); geometryByRun.set(run.id, measured); }
      return measured;
    },
    elevation(run: PipeRun) {
      let measured = elevationByRun.get(run.id);
      if (!measured) { measured = analyzeRouteElevation(points(run)); elevationByRun.set(run.id, measured); }
      return measured;
    },
    length(run: PipeRun) {
      let measured = lengthByRun.get(run.id);
      if (measured === undefined) {
        // Keep the original edge order and reduction; a differently grouped
        // sum could change the final score's floating-point tie breakers.
        measured = run.segmentEdgeIds.reduce((sum, id) => {
          const edge = document.segmentEdges[id];
          const a = edge && document.routeNodes[edge.startNodeId]?.position;
          const b = edge && document.routeNodes[edge.endNodeId]?.position;
          return sum + (a && b ? distance(a, b) : 0);
        }, 0);
        lengthByRun.set(run.id, measured);
      }
      return measured;
    },
    pathElevation(path: TracedPath) {
      let measured = elevationByPath.get(path);
      if (!measured) { measured = analyzeRouteElevation(path.points); elevationByPath.set(path, measured); }
      return measured;
    },
  };
}
type EvaluationMeasurements = ReturnType<typeof evaluationMeasurements>;

/** Measured circular plan radii plus the same clamped plumb-corner radius used by the sweep. */
function actualBendRadii(document: VrfPipingDocument, run: PipeRun, points: Vec3[]): { radii: number[]; incomplete: boolean } {
  const explicit = run.metadata?.bendRadiiMm;
  const radii = Array.isArray(explicit) ? explicit.filter(finiteNonnegative) : [];
  const edge = document.segmentEdges[run.segmentEdgeIds[0]!];
  const outsideDiameter = (edge?.outsideDiameterMm ?? 0) + 2 * (edge?.insulationThicknessMm ?? 0);
  const storedFactor = numberMetadata(run.metadata, 'bendRadiusFactor');
  const requestedRadius = storedFactor === undefined ? undefined : bendRadiusFromDiameterMm(outsideDiameter, storedFactor);
  let incomplete = false;
  let cursor = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1]!; const b = points[index]!; const c = points[index + 1]!;
    const ab = distance(a, b); const bc = distance(b, c); const ac = distance(a, c);
    if (ab < 1e-6 || bc < 1e-6 || !cursor) continue;
    const u = { x: (b.x - a.x) / ab, y: (b.y - a.y) / ab, z: (b.z - a.z) / ab };
    const v = { x: (c.x - b.x) / bc, y: (c.y - b.y) / bc, z: (c.z - b.z) / bc };
    const cosine = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y + u.z * v.z));
    const angle = Math.acos(cosine);
    if (angle < 1e-5) { cursor = b; continue; }
    const planar = Math.abs(u.z) < 1e-6 && Math.abs(v.z) < 1e-6;
    if (planar) {
      // Collinear-to-arc boundary triples overestimate a circular radius; use
      // the interior equal-chord triples to recover the actual saved fillet.
      if (angle < Math.PI / 4 && Math.max(ab, bc) / Math.min(ab, bc) < 1.05) {
        const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
        if (sine > 1e-6) radii.push(ac / (2 * sine));
      } else if (angle >= Math.PI / 4) {
        // An unfilleted planar corner is rendered as saved, not silently rounded.
        radii.push(0);
      }
      cursor = b;
      continue;
    }
    if (requestedRadius === undefined) { incomplete = true; cursor = b; continue; }
    const tangent = Math.tan(angle / 2);
    if (tangent <= 1e-6 || angle >= Math.PI - 1e-5) { radii.push(0); cursor = b; continue; }
    const setback = Math.min(requestedRadius * tangent, distance(cursor, b), bc / 2);
    radii.push(setback / tangent);
    cursor = { x: b.x + v.x * setback, y: b.y + v.y * setback, z: b.z + v.z * setback };
  }
  return { radii, incomplete };
}

function validateKnownCatalogGeometry(
  document: VrfPipingDocument,
  profile: ManufacturerRuleProfile,
  runs: PipeRun[],
  branchIds: Set<string>,
  paths: TracedPath[],
  hard: Set<string>,
  advisory: Set<string>,
  measurements: EvaluationMeasurements,
): void {
  const hasKnownGeometry = profile.verified || [profile.portDefaults.minimumBendRadiusMm, profile.portDefaults.minimumStraightStubMm]
    .some(isVerifiedManufacturerValue) || profile.pipeSizing.some(row => isVerifiedManufacturerValue(row.minimumBendRadiusMm))
    || profile.branchKits.some(row => [row.orientation.maximumRollDeviationDeg, row.orientation.maximumPitchDeviationDeg,
      ...row.straightZones.flatMap(zone => [zone.upstreamMinimumMm, zone.downstreamMinimumMm])]
      .some(value => value && isVerifiedManufacturerValue(value)));
  if (!hasKnownGeometry) return;
  const snapshot = buildVrfGeometrySnapshot(document, profile);
  const minimum = (actual: number | undefined, rule: RuleValue<number> | undefined, message: string) => {
    if (!rule) return;
    if (actual === undefined) { advisory.add(`${message} could not be measured.`); return; }
    if (actual + 1e-6 < rule.value) (isVerifiedManufacturerValue(rule) ? hard : advisory).add(`${message} is below ${rule.value} mm.`);
  };
  for (const branch of snapshot.branches.filter(item => branchIds.has(item.id))) {
    const native = document.branchKits[branch.id]!;
    const row = profile.branchKits.find(item => item.model === branch.model
      && item.manufacturer.toLowerCase() === native.manufacturer.toLowerCase()
      && item.family.toLowerCase() === native.family.toLowerCase());
    if (!row) continue;
    const orientation = row.orientation;
    const hardOrientation = { ...orientation,
      allowedModes: profile.verified ? orientation.allowedModes : ['horizontal-split', 'vertical-split', 'horizontal-header'] as const,
      prohibitedOutletDirections: profile.verified ? orientation.prohibitedOutletDirections : undefined,
      maximumRollDeviationDeg: orientation.maximumRollDeviationDeg && isVerifiedManufacturerValue(orientation.maximumRollDeviationDeg) ? orientation.maximumRollDeviationDeg : undefined,
      maximumPitchDeviationDeg: orientation.maximumPitchDeviationDeg && isVerifiedManufacturerValue(orientation.maximumPitchDeviationDeg) ? orientation.maximumPitchDeviationDeg : undefined,
    };
    const permitted = validateBranchOrientation(branch.frame, { ...hardOrientation, allowedModes: [...hardOrientation.allowedModes] });
    for (const issue of permitted.violations) hard.add(`Branch ${branch.id}: ${issue}`);
    for (const issue of validateBranchOrientation(branch.frame, orientation).violations) {
      if (!permitted.violations.includes(issue)) advisory.add(`Branch ${branch.id}: ${issue}`);
    }
    for (const zone of row.straightZones) {
      minimum(branch.upstreamStraightMm, zone.upstreamMinimumMm, `Branch ${branch.id} inlet straight length`);
      const outlets = zone.appliesToOutletIndex === undefined
        ? native.outletNodeIds.map((_, index) => index) : [zone.appliesToOutletIndex];
      for (const index of outlets) minimum(branch.downstreamStraightMm?.[index], zone.downstreamMinimumMm, `Branch ${branch.id} outlet ${index + 1} straight length`);
      // Follow native edges within reserved zones. A straight run ending at a
      // reducer/another branch must not masquerade as unlimited clear space.
      const checkIntrusions = (start: string, reserved: RuleValue<number> | undefined) => {
        if (!reserved || reserved.value <= 0) return;
        const pending = [{ node: start, travelled: 0 }]; const visited = new Set<string>();
        while (pending.length) {
          const current = pending.pop()!;
          if (visited.has(current.node) || current.travelled >= reserved.value - 1e-6) continue;
          visited.add(current.node);
          if (current.node !== start) {
            const reducer = Object.values(document.reducers).some(item => item.inletNodeId === current.node || item.outletNodeId === current.node);
            const otherBranch = Object.values(document.branchKits).some(item => item.id !== branch.id && [...item.inletNodeIds, ...item.outletNodeIds].includes(current.node));
            if ((zone.noReducerAllowed && reducer) || (zone.noOtherBranchAllowed && otherBranch)) {
              (isVerifiedManufacturerValue(reserved) ? hard : advisory).add(`Branch ${branch.id} has a ${reducer ? 'reducer' : 'branch'} inside its reserved straight zone.`);
            }
          }
          for (const id of document.routeNodes[current.node]?.connectedEdgeIds ?? []) {
            const edge = document.segmentEdges[id]; if (!edge) continue;
            const next = edge.startNodeId === current.node ? edge.endNodeId : edge.startNodeId;
            const a = document.routeNodes[current.node]?.position; const b = document.routeNodes[next]?.position;
            if (a && b) pending.push({ node: next, travelled: current.travelled + distance(a, b) });
          }
        }
      };
      native.inletNodeIds.forEach(id => checkIntrusions(id, zone.upstreamMinimumMm));
      outlets.forEach(index => { const id = native.outletNodeIds[index]; if (id) checkIntrusions(id, zone.downstreamMinimumMm); });
    }
  }
  for (const run of runs) {
    const sockets = snapshot.runs.find(item => item.id === run.id);
    if (sockets?.startPort) minimum(sockets.startPortStubMm, profile.portDefaults.minimumStraightStubMm, `Pipe ${run.id} equipment inlet stub`);
    if (sockets?.endPort) minimum(sockets.endPortStubMm, profile.portDefaults.minimumStraightStubMm, `Pipe ${run.id} equipment outlet stub`);
    const equipmentIds = [...new Set(paths.filter(path => path.runIds.includes(run.id)).map(path => path.indoorUnitId))];
    const capacities = equipmentIds.map(id => document.equipmentNodes[id]?.capacityIndex);
    const capacityKnown = capacities.length > 0 && capacities.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const diameter = document.segmentEdges[run.segmentEdgeIds[0]!]?.nominalDiameterMm;
    const rows = capacityKnown ? profile.pipeSizing.filter(row => row.systemType === run.systemType
      && Math.abs(row.outsideDiameterMm.value - (diameter ?? 0)) <= 0.25
      && (capacities as number[]).reduce((sum, value) => sum + value, 0) >= row.capacityIndexMin
      && (capacities as number[]).reduce((sum, value) => sum + value, 0) <= row.capacityIndexMax) : [];
    const requirements = [profile.portDefaults.minimumBendRadiusMm, ...rows.map(row => row.minimumBendRadiusMm)]
      .filter(isVerifiedManufacturerValue);
    if (!requirements.length) continue;
    const required = Math.max(...requirements.map(rule => rule.value));
    const { radii, incomplete } = actualBendRadii(document, run, measurements.points(run));
    if (radii.some(radius => radius + 0.01 < required)) hard.add(`Pipe ${run.id} has a measured bend radius below the verified ${required} mm minimum.`);
    else if (incomplete || (!radii.length && measurements.geometry(run).bends > 0.01)) advisory.add(`Pipe ${run.id} bend radii need explicit geometry data for the verified radius check.`);
  }
}

/** Root a real, connected service graph. Visual crossings never create graph edges. */
function traceService(
  document: VrfPipingDocument,
  options: Pick<AutoRouteEvaluationOptions, 'outdoorUnitId' | 'indoorUnitIds'>,
  lineKind: 'gas' | 'liquid',
  profile: ManufacturerRuleProfile,
  hard: Set<string>,
  measurements: EvaluationMeasurements,
): ServiceTrace {
  const result: ServiceTrace = { paths: [], runIds: new Set(), branchIds: new Set(), indoorIds: new Set() };
  const graph = new Map<string, Link[]>();
  const join = (a: string, b: string, link: Omit<Link, 'next'>) => {
    if (!document.routeNodes[a] || !document.routeNodes[b]) return;
    graph.set(a, [...(graph.get(a) ?? []), { ...link, next: b }]);
    graph.set(b, [...(graph.get(b) ?? []), { ...link, next: a }]);
  };
  for (const edge of Object.values(document.segmentEdges)) {
    if (edge.lineKind !== lineKind) continue;
    const a = document.routeNodes[edge.startNodeId]?.position;
    const b = document.routeNodes[edge.endNodeId]?.position;
    if (!a || !b) continue;
    const lengthMm = distance(a, b);
    if (!Number.isFinite(lengthMm)) hard.add(`Pipe ${edge.runId} contains non-finite coordinates.`);
    join(edge.startNodeId, edge.endNodeId, { id: edge.id, runId: edge.runId, lengthMm: Number.isFinite(lengthMm) ? lengthMm : 0 });
  }
  for (const branch of Object.values(document.branchKits)) {
    if (branch.lineKind !== lineKind) continue;
    for (const inlet of branch.inletNodeIds) for (const outlet of branch.outletNodeIds) {
      join(inlet, outlet, { id: `${branch.id}:${inlet}:${outlet}`, branchId: branch.id, lengthMm: 0 });
    }
  }
  for (const reducer of Object.values(document.reducers)) {
    if (reducer.lineKind !== lineKind) continue;
    join(reducer.inletNodeId, reducer.outletNodeId, { id: reducer.id, reducerId: reducer.id, lengthMm: 0 });
  }
  const equipmentTerminals = new Map<string, Set<string>>();
  for (const run of Object.values(document.pipeRuns)) {
    if (run.lineKind !== lineKind) continue;
    for (const [portId, nodeId] of [
      [run.sourcePortId, run.nodeIds[0]], [run.targetPortId, run.nodeIds.at(-1)],
    ] as const) {
      if (!portId || !nodeId) continue;
      const equipmentId = document.equipmentPorts[portId]?.equipmentId;
      if (!equipmentId) continue;
      const nodes = equipmentTerminals.get(equipmentId) ?? new Set<string>();
      nodes.add(nodeId);
      equipmentTerminals.set(equipmentId, nodes);
    }
  }
  const rootTerminals = [...(equipmentTerminals.get(options.outdoorUnitId) ?? [])];
  if (rootTerminals.length !== 1 || !graph.has(rootTerminals[0]!)) {
    hard.add(`Outdoor unit needs exactly one connected ${lineKind} outlet.`);
    return result;
  }
  const root = rootTerminals[0]!;
  const ordered = [root];
  const visited = new Set(ordered);
  const parent = new Map<string, { previous: string; link: Link }>();
  const linkIds = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]!;
    for (const link of graph.get(node) ?? []) {
      linkIds.add(link.id);
      if (link.runId) result.runIds.add(link.runId);
      if (link.branchId) result.branchIds.add(link.branchId);
      if (visited.has(link.next)) continue;
      visited.add(link.next);
      parent.set(link.next, { previous: node, link });
      ordered.push(link.next);
    }
  }
  if (linkIds.size !== visited.size - 1) hard.add(`The ${lineKind} network contains a cycle or duplicate connection.`);
  const equipmentNodeIds = new Set<string>();
  for (const [equipmentId, nodes] of equipmentTerminals) {
    const connected = [...nodes].filter((id) => visited.has(id));
    if (!connected.length) continue;
    connected.forEach((id) => equipmentNodeIds.add(id));
    const equipment = document.equipmentNodes[equipmentId];
    if (equipment?.equipmentType === 'outdoor-unit' && equipmentId !== options.outdoorUnitId) {
      hard.add(`The ${lineKind} network joins more than one outdoor unit without a supported outdoor assembly.`);
    }
    if (connected.length !== 1 || (graph.get(connected[0]!)?.length ?? 0) !== 1) {
      hard.add(`Equipment ${equipmentId} has multiple ${lineKind} pipe connections.`);
    }
    if (equipment?.equipmentType !== 'indoor-unit') continue;
    result.indoorIds.add(equipmentId);
    const target = connected[0]!;
    let current = target;
    const reverseNodes = [target];
    const reverseLinks: Link[] = [];
    while (current !== root) {
      const entry = parent.get(current);
      if (!entry) break;
      reverseLinks.push(entry.link);
      current = entry.previous;
      reverseNodes.push(current);
    }
    if (current !== root) continue;
    const links = reverseLinks.reverse();
    const points = reverseNodes.reverse().map((id) => document.routeNodes[id]!.position);
    const runIds = [...new Set(links.flatMap((link) => link.runId ? [link.runId] : []))];
    const branchIds = [...new Set(links.flatMap((link) => link.branchId ? [link.branchId] : []))];
    const actualLengthMm = links.reduce((sum, link) => sum + link.lengthMm, 0);
    let equivalentLengthMm: number | null = actualLengthMm;
    for (const runId of runIds) {
      const run = document.pipeRuns[runId]!;
      const explicit = numberMetadata(run.metadata, 'equivalentLengthMm');
      const actual = measurements.length(run);
      if (explicit !== undefined && equivalentLengthMm !== null) equivalentLengthMm += Math.max(0, explicit - actual);
      else if (measurements.geometry(run).bends > 0.01) equivalentLengthMm = null;
    }
    for (const branchId of branchIds) {
      const branch = document.branchKits[branchId]!;
      const equivalent = numberMetadata(branch.metadata, 'equivalentLengthMm')
        ?? profile.branchKits.find((rule) => rule.model === branch.model)?.equivalentLengthMm?.value;
      if (equivalent === undefined) equivalentLengthMm = null;
      else if (equivalentLengthMm !== null) equivalentLengthMm += equivalent;
    }
    for (const link of links.filter((entry) => entry.reducerId)) {
      const equivalent = numberMetadata(document.reducers[link.reducerId!]!.metadata, 'equivalentLengthMm');
      if (equivalent === undefined) equivalentLengthMm = null;
      else if (equivalentLengthMm !== null) equivalentLengthMm += equivalent;
    }
    const firstBranchIndex = links.findIndex((link) => link.branchId);
    result.paths.push({
      outdoorUnitId: options.outdoorUnitId, indoorUnitId: equipmentId, lineKind, runIds, branchIds,
      actualLengthMm, equivalentLengthMm,
      firstBranchToIndoorLengthMm: firstBranchIndex < 0 ? 0 : links.slice(firstBranchIndex + 1).reduce((sum, link) => sum + link.lengthMm, 0),
      heightDifferenceMm: Math.abs(points[0]!.z - points.at(-1)!.z), points,
    });
  }
  for (const id of options.indoorUnitIds) if (!result.indoorIds.has(id)) hard.add(`Indoor unit ${id} is disconnected from the outdoor ${lineKind} network.`);
  for (const node of ordered) {
    const connections = graph.get(node) ?? [];
    if (connections.length === 1 && !equipmentNodeIds.has(node)) hard.add(`The ${lineKind} network has an open pipe or unused branch outlet.`);
    if (connections.length > 2 && !connections.some((link) => link.branchId)) hard.add(`The ${lineKind} network contains a bare tee without a copper branch kit.`);
  }
  for (const id of result.branchIds) {
    const branch = document.branchKits[id]!;
    for (const inlet of branch.inletNodeIds) {
      if (parent.get(inlet)?.link.branchId === id) hard.add(`Branch ${id} has its inlet facing away from the outdoor connection.`);
    }
  }
  return result;
}

function wallCrossings(runs: PipeRun[], walls: Wall[], measurements: EvaluationMeasurements): number {
  const intersections = new Map<string, Vec3[]>();
  // Count one service to avoid reporting each paired penetration twice.
  for (const run of runs.filter((candidate) => candidate.lineKind === 'gas')) {
    const points = measurements.points(run);
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!; const b = points[index]!;
      for (const wall of walls) {
        const c = wall.startPoint; const d = wall.endPoint;
        const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
        if (Math.abs(denominator) < 1e-8) continue;
        const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
        const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const point = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z) };
        const existing = intersections.get(wall.id) ?? [];
        if (!existing.some((entry) => distance(entry, point) < 1)) existing.push(point);
        intersections.set(wall.id, existing);
      }
    }
  }
  return [...intersections.values()].reduce((sum, entries) => sum + entries.length, 0);
}

/** Evaluate a candidate without mutating its dimensions, ports or fitting geometry. */
export function evaluateAutoRouteNetwork(options: AutoRouteEvaluationOptions): AutoRouteEvaluation {
  const document = buildVrfDocumentFromHvacElements(options.elements);
  const byId = new Map(options.elements.map(element => [element.id, element]));
  for (const run of Object.values(document.pipeRuns)) {
    const sourceId = stringMetadata(run.metadata, 'sourceElementId');
    const factor = sourceId ? byId.get(sourceId)?.properties.bendRadiusFactor : undefined;
    if (finiteNonnegative(factor)) run.metadata = { ...run.metadata, bendRadiusFactor: factor };
  }
  return evaluateAutoRouteDocument(document, options);
}

/** Also accepts the native graph so imported/saved networks share the same accounting. */
export function evaluateAutoRouteDocument(
  document: VrfPipingDocument,
  options: Omit<AutoRouteEvaluationOptions, 'elements'>,
): AutoRouteEvaluation {
  const profile = options.profile ?? PROJECT_FALLBACK_RULE_PROFILE;
  const hard = new Set<string>();
  const advisory = new Set<string>();
  const recommendations: AutoRouteRecommendation[] = [];
  const measurements = evaluationMeasurements(document);
  if (document.equipmentNodes[options.outdoorUnitId]?.equipmentType !== 'outdoor-unit') hard.add('Select an outdoor unit as the network source.');
  if (options.indoorUnitIds.length === 0) hard.add('The network needs at least one indoor unit.');
  for (const id of options.indoorUnitIds) if (document.equipmentNodes[id]?.equipmentType !== 'indoor-unit') hard.add(`Equipment ${id} is not an indoor unit.`);
  const traces = services.map((service) => traceService(document, options, service, profile, hard, measurements));
  const paths = traces.flatMap((trace) => trace.paths);
  if ([...traces[0]!.indoorIds].sort().join('|') !== [...traces[1]!.indoorIds].sort().join('|')) hard.add('Gas and liquid networks connect different indoor units.');
  const branchTopology = (trace: ServiceTrace) => [...trace.branchIds].map((id) => (
    [...new Set(trace.paths.filter((path) => path.branchIds.includes(id)).map((path) => path.indoorUnitId))].sort().join(',')
  )).sort().join('|');
  if (branchTopology(traces[0]!) !== branchTopology(traces[1]!)) hard.add('Gas and liquid branch kits do not split into the same downstream equipment groups.');
  const runIds = new Set(traces.flatMap((trace) => [...trace.runIds]));
  const branchIds = new Set(traces.flatMap((trace) => [...trace.branchIds]));
  const runs = [...runIds].flatMap((id) => document.pipeRuns[id] ? [document.pipeRuns[id]!] : []);
  const branches = [...branchIds].flatMap((id) => document.branchKits[id] ? [document.branchKits[id]!] : []);
  validateKnownCatalogGeometry(document, profile, runs, branchIds, paths, hard, advisory, measurements);
  const connectedIndoorIds = [...traces[0]!.indoorIds].filter((id) => traces[1]!.indoorIds.has(id));
  const capacity = (ids: string[]) => {
    const values = ids.map((id) => document.equipmentNodes[id]?.capacityIndex);
    return values.length > 0 && values.every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      ? (values as number[]).reduce((sum, value) => sum + value, 0) : null;
  };
  const totalCapacityIndex = capacity(connectedIndoorIds);
  if (totalCapacityIndex === null) advisory.add('Indoor manufacturer capacity indices are missing; kW and BTU values cannot substitute for a capacity index.');
  if (!profile.verified) advisory.add('Manufacturer model rules are not verified; this network is a preliminary layout.');
  const ruleCheck = (actual: number, rule: RuleValue<number> | undefined, message: string) => {
    if (rule && actual > rule.value + 1e-6) (isVerifiedManufacturerValue(rule) ? hard : advisory).add(message);
  };
  let gasLengthMm = 0; let liquidLengthMm = 0; let bendCount = 0; let riserCount = 0; let verticalTravelMm = 0;
  for (const run of runs) {
    const points = measurements.points(run);
    if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))) hard.add(`Pipe ${run.id} contains non-finite coordinates.`);
    const measures = measurements.geometry(run);
    const elevation = measurements.elevation(run);
    if (run.lineKind === 'gas') gasLengthMm += elevation.centerlineLengthMm;
    else liquidLengthMm += elevation.centerlineLengthMm;
    bendCount += measures.bends; riserCount += measures.risers; verticalTravelMm += elevation.totalVerticalTravelMm;
    const downstreamIds = [...new Set(paths.filter((path) => path.runIds.includes(run.id)).map((path) => path.indoorUnitId))];
    const downstreamCapacityIndex = capacity(downstreamIds);
    const diameter = document.segmentEdges[run.segmentEdgeIds[0]!]?.nominalDiameterMm;
    const attachedPorts = [run.sourcePortId, run.targetPortId].flatMap((id) => id && document.equipmentPorts[id] ? [document.equipmentPorts[id]!] : []);
    const terminalPort = attachedPorts.find((port) => document.equipmentNodes[port.equipmentId]?.equipmentType === 'indoor-unit');
    const main = attachedPorts.some((port) => port.equipmentId === options.outdoorUnitId);
    if (terminalPort) {
      const matches = diameter !== undefined && Math.abs(diameter - terminalPort.connectionDiameterMm) <= 0.25;
      recommendations.push({ entityId: run.id, kind: 'pipe', downstreamCapacityIndex,
        status: matches ? 'matches' : 'change-recommended', recommendedDiameterMm: terminalPort.connectionDiameterMm,
        note: matches ? 'Terminal tube matches the equipment connection diameter.' : 'Rebuild the terminal tube and reducer geometry for the equipment connection diameter.' });
    } else if (main || downstreamCapacityIndex === null) {
      recommendations.push({ entityId: run.id, kind: 'pipe', downstreamCapacityIndex, status: 'missing-data',
        note: main ? 'The outdoor-to-first-branch main needs its model-specific table and length-dependent sizing rules.' : 'All downstream capacity indices are required before pipe sizing.' });
    } else {
      const selected = selectPipeSize(profile, { systemType: run.systemType, downstreamCapacityIndex, currentOutsideDiameterMm: diameter });
      const recommendedDiameterMm = selected.preferred?.rule.outsideDiameterMm.value;
      recommendations.push({ entityId: run.id, kind: 'pipe', downstreamCapacityIndex, recommendedDiameterMm,
        status: recommendedDiameterMm === undefined ? 'missing-data' : Math.abs(recommendedDiameterMm - (diameter ?? 0)) > 0.25 ? 'change-recommended' : 'matches',
        note: recommendedDiameterMm === undefined ? 'No capacity sizing row covers this run.' : 'Manufacturer capacity-table recommendation; geometry changes require rebuilding clearances and fittings.' });
    }
  }
  for (const branch of branches) {
    const affectedPaths = paths.filter((path) => path.branchIds.includes(branch.id));
    const downstreamIds = [...new Set(affectedPaths.map((path) => path.indoorUnitId))];
    const downstreamCapacityIndex = capacity(downstreamIds);
    const first = affectedPaths.some((path) => path.branchIds[0] === branch.id);
    const selected = downstreamCapacityIndex === null ? null : selectBranchKit(profile, {
      manufacturer: branch.manufacturer, family: branch.family,
      refrigerant: stringMetadata(branch.metadata, 'refrigerant') ?? 'unspecified',
      arrangement: stringMetadata(branch.metadata, 'arrangement') === 'heat-recovery' ? 'heat-recovery' : 'heat-pump',
      systemRole: first ? 'first-branch' : branch.systemRole === 'terminal-header' ? 'terminal-header' : 'intermediate-branch',
      branchType: branch.branchType, outdoorCapacity: document.equipmentNodes[options.outdoorUnitId]?.capacityIndex,
      downstreamCapacityIndex, downstreamBranchCount: downstreamIds.length,
      upstreamDiametersMm: branch.inletNodeIds.flatMap((nodeId) => document.routeNodes[nodeId]?.connectedEdgeIds.flatMap((id) => document.segmentEdges[id] ? [document.segmentEdges[id]!.nominalDiameterMm] : []) ?? []),
      downstreamDiametersMm: branch.outletNodeIds.flatMap((nodeId) => document.routeNodes[nodeId]?.connectedEdgeIds.flatMap((id) => document.segmentEdges[id] ? [document.segmentEdges[id]!.nominalDiameterMm] : []) ?? []),
      currentModel: branch.model,
    });
    const recommendedModel = selected?.preferred?.rule.model;
    recommendations.push({ entityId: branch.id, kind: 'branch-kit', downstreamCapacityIndex, recommendedModel,
      status: recommendedModel === undefined ? 'missing-data' : recommendedModel === branch.model ? 'matches' : 'change-recommended',
      note: recommendedModel === undefined ? 'A compatible manufacturer kit and complete capacity data are needed for final selection.' : 'Kit selection follows actual downstream equipment and the outdoor-facing inlet.' });
  }
  if (recommendations.some((item) => item.status === 'missing-data')) advisory.add('Pipe and branch-kit sizing needs additional manufacturer data; see the component recommendations.');
  if (recommendations.some((item) => item.status === 'change-recommended')) advisory.add('The profile recommends component size changes; apply them with a geometry and clearance rebuild.');
  const networkLengthMm = Math.max(gasLengthMm, liquidLengthMm);
  ruleCheck(networkLengthMm, profile.routeLimits.maximumTotalLengthMm, 'The one-way network length exceeds the active profile limit.');
  ruleCheck(connectedIndoorIds.length, profile.routeLimits.maximumIndoorUnitCount, 'The connected indoor count exceeds the active profile limit.');
  for (const path of paths) {
    ruleCheck(path.equivalentLengthMm ?? path.actualLengthMm, profile.routeLimits.maximumEquivalentLengthMm, `The ${path.lineKind} path to ${path.indoorUnitId} exceeds the equivalent-length limit.`);
    ruleCheck(path.firstBranchToIndoorLengthMm, profile.routeLimits.maximumIndoorToBranchLengthMm, `The first-branch-to-indoor path to ${path.indoorUnitId} exceeds the profile limit.`);
    ruleCheck(path.heightDifferenceMm, path.points[0]!.z < path.points.at(-1)!.z
      ? profile.routeLimits.maximumOutdoorBelowHeightDifferenceMm ?? profile.routeLimits.maximumHeightDifferenceMm
      : profile.routeLimits.maximumHeightDifferenceMm, `The outdoor-to-indoor height difference for ${path.indoorUnitId} exceeds the profile limit.`);
  }
  if (paths.some((path) => path.equivalentLengthMm === null)) advisory.add('Equivalent length is incomplete until model-specific bend and fitting allowances are supplied.');
  const elevationReversalCount = paths.reduce((sum, path) => sum + measurements.pathElevation(path).elevationReversals, 0);
  const lowPocketPaths = paths.filter((path) => measurements.pathElevation(path).lowPockets.length > 0);
  if (lowPocketPaths.length > 0) advisory.add('The complete elevation profile contains a low pocket; review model-specific oil-return requirements.');
  if (options.elevationPolicy !== 'existing-layout') {
    for (const path of lowPocketPaths.filter((candidate) => candidate.lineKind === 'gas')) {
      hard.add(`Automatic routing cannot introduce a gas low pocket on the path to ${path.indoorUnitId}; use a continuous service level or explicitly design the manufacturer-required geometry.`);
    }
  }
  const branchPairCount = Math.max(branches.filter((branch) => branch.lineKind === 'gas').length, branches.filter((branch) => branch.lineKind === 'liquid').length);
  const wallCrossingCount = wallCrossings(runs, options.walls ?? [], measurements);
  if (wallCrossingCount) advisory.add(`${wallCrossingCount} plan wall crossing${wallCrossingCount === 1 ? '' : 's'} need opening coordination; wall construction, heights and available sleeves are not verified.`);
  const rates = options.rates;
  const validRates = rates && typeof rates.currency === 'string' && rates.currency.trim().length > 0
    && [rates.gasPipePerMetre, rates.liquidPipePerMetre, rates.elbowEach, rates.branchPairEach, rates.riserEach].every(finiteNonnegative);
  if (rates && !validRates) advisory.add('Cost rates are incomplete or invalid; the comparison uses a relative material and fitting index.');
  const estimatedCost = validRates ? gasLengthMm / 1000 * rates.gasPipePerMetre + liquidLengthMm / 1000 * rates.liquidPipePerMetre
    + bendCount * rates.elbowEach + branchPairCount * rates.branchPairEach + riserCount * rates.riserEach : null;
  // Explicit comparison weights, not pressure-loss coefficients or monetary rates.
  const relativeCostIndex = (gasLengthMm + liquidLengthMm) / 1000 + bendCount * 0.75 + branchPairCount * 3 + riserCount * 1.5;
  // A common change of monetary units (EUR -> cents, for example) must never
  // change the route. Divide money by a reference made from those same rates.
  const rateReference = validRates ? Math.max(rates.gasPipePerMetre, rates.liquidPipePerMetre, rates.elbowEach, rates.branchPairEach, rates.riserEach) : 0;
  const cost = estimatedCost !== null && rateReference > 0 ? estimatedCost / rateReference : relativeCostIndex;
  const geometryPenalty = elevationReversalCount * 20 + wallCrossingCount * 2;
  const secondary = networkLengthMm / 1000 + geometryPenalty;
  const score = options.objective === 'fewest-fittings'
    ? bendCount + branchPairCount * 2 + riserCount + 0.001 * secondary / (1 + secondary)
    : options.objective === 'cost' ? cost : cost + bendCount * 2 + riserCount * 5 + geometryPenalty;
  return {
    feasible: hard.size === 0, hardIssues: [...hard], advisoryIssues: [...advisory], score,
    manufacturerQualification: profile.verified && recommendations.every((item) => item.status === 'matches')
      && hard.size === 0 && advisory.size === 0 ? 'profile-checked' : 'preliminary',
    recommendations, paths: paths.map(({ points: _points, ...path }) => path),
    metrics: {
      pipeLengthMm: gasLengthMm + liquidLengthMm, gasLengthMm, liquidLengthMm, networkLengthMm,
      maxPathLengthMm: Math.max(0, ...paths.map((path) => path.actualLengthMm)),
      maxEquivalentPathLengthMm: paths.length && paths.every((path) => path.equivalentLengthMm !== null) ? Math.max(...paths.map((path) => path.equivalentLengthMm!)) : null,
      bendCount, branchPairCount, riserCount, verticalTravelMm, elevationReversalCount,
      connectedIndoorCount: connectedIndoorIds.length, estimatedCost, currency: validRates ? rates.currency : undefined,
      relativeCostIndex, wallCrossingCount, totalCapacityIndex,
    },
  };
}
