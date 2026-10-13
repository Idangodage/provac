/**
 * What a refrigerant piece's card says about it, read from the drawing and the
 * active rule profile, each value with where it came from:
 *  - the line: copper tube OD (and its inch size), insulation, outside Ø, hard
 *    or flexible copper;
 *  - the piece: its length, level, rise and slope; a bend's angle, radius,
 *    construction, catalogue part and plane (and, for a formed bend, its radius
 *    against the profile's minimum); a port's straight approach against the
 *    straight the port reserves;
 *  - the circuit (the outdoor unit's network evaluation): the indoor units it
 *    serves, its downstream capacity index, the longest path through it against
 *    the profile's limit, the equivalent length when every allowance is known,
 *    the height difference, and the profile's size recommendation — or that no
 *    sizing table is loaded, never a made-up one;
 *  - a liquid line's additional charge, from a practice table, flagged
 *    unverified (the outdoor unit's own table governs).
 *
 * PURE and cached per drawing.
 */
import type { HvacElement } from '../../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../../vrf/domain';
import { hvacVrfSemanticIds } from '../../../../vrf/domain/hvac-element-adapter';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile, type RuleValue } from '../../../../vrf/rules/rule-profile';
import { evaluateAutoRouteNetwork, type AutoRoutePathMetrics, type AutoRouteRecommendation } from '../autoRouteEvaluation';

import type { RefrigerantLine, RefrigerantPiece } from './refrigerantPieces';

export type FigureStatus = 'ok' | 'near' | 'over';

/** The ACR copper tube series (OD mm → inch label). */
const COPPER_SERIES: ReadonlyArray<[number, string]> = [
  [6.35, '1/4″'], [9.52, '3/8″'], [12.7, '1/2″'], [15.88, '5/8″'], [19.05, '3/4″'], [22.22, '7/8″'], [25.4, '1″'],
  [28.58, '1-1/8″'], [31.75, '1-1/4″'], [34.92, '1-3/8″'], [38.1, '1-1/2″'], [41.28, '1-5/8″'], [44.45, '1-3/4″'], [53.98, '2-1/8″'],
];

export const COPPER_TUBE_SERIES_MM: readonly number[] = COPPER_SERIES.map(([od]) => od);

/** A tube OD's inch size, when it is one of the series (within 0.05 mm). */
export function copperInchLabel(odMm: number): string | null {
  return COPPER_SERIES.find(([od]) => Math.abs(od - odMm) <= 0.05)?.[1] ?? null;
}

/**
 * Additional refrigerant per metre of liquid line (kg/m), by tube OD: typical
 * published R410A values, NOT any one manufacturer's. Practice only — the
 * outdoor unit's charge table governs.
 */
const LIQUID_CHARGE_KG_PER_M: ReadonlyArray<[number, number]> = [
  [6.35, 0.022], [9.52, 0.06], [12.7, 0.12], [15.88, 0.18], [19.05, 0.27], [22.22, 0.38], [25.4, 0.52], [28.58, 0.68],
];

export interface RefrigerantCircuitFigures {
  outdoorUnitId: string;
  outdoorLabel: string;
  /** Indoor units the line serves (whose paths run through it). */
  indoorUnitIds: string[];
  downstreamCapacityIndex: number | null;
  recommendation: AutoRouteRecommendation | null;
  /** The longest outdoor-to-indoor path through the line (mm), and the profile's per-path (equivalent length) limit. */
  longestPathMm: number | null;
  pathLimit: RuleValue<number> | null;
  pathStatus: FigureStatus | null;
  /** Null while a fitting's equivalent length is unknown. */
  equivalentPathMm: number | null;
  equivalentLimit: RuleValue<number> | null;
  heightDifferenceMm: number | null;
  heightLimit: RuleValue<number> | null;
  heightStatus: FigureStatus | null;
  /** The line is on the circuit's longest path. */
  onLongestPath: boolean;
  profileId: string;
  profileVerified: boolean;
  /** The profile has a pipe sizing table. */
  sizingTable: boolean;
}

export interface RefrigerantPieceFigures {
  lineKind: RefrigerantLine['lineKind'];
  tubeOdMm: number;
  inch: string | null;
  insulationMm: number;
  outsideDiameterMm: number;
  material: 'hard' | 'flexible' | null;
  lengthMm: number;
  /** Mean centreline level (mm above the floor datum), a riser's rise and a sloped straight's fall (%). */
  levelMm: number;
  riseMm: number;
  slopePercent: number | null;
  bend: {
    angleDeg: number;
    radiusMm: number;
    construction: 'socket-elbow' | 'formed-bend';
    catalogueModel: string | null;
    plane: 'horizontal' | 'vertical' | 'inclined';
    /** A formed bend's minimum radius (none for a factory elbow). */
    minimumRadius: RuleValue<number> | null;
    radiusStatus: FigureStatus | null;
  } | null;
  port: {
    label: string;
    kind: string;
    required: RuleValue<number>;
    /** The straight there before the first fitting (mm). */
    availableMm: number;
    status: FigureStatus;
  } | null;
  charge: { kgPerM: number; pieceKg: number; lineKg: number } | null;
  circuit: RefrigerantCircuitFigures | null;
}

const statusOf = (actual: number, limit: number | null | undefined, nearFraction = 0.9): FigureStatus | null => {
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit <= 0) return null;
  return actual > limit + 1e-6 ? 'over' : actual >= limit * nearFraction ? 'near' : 'ok';
};

// ---------------------------------------------------------------------------------------------------- the circuit

interface CircuitCacheEntry {
  profile: ManufacturerRuleProfile;
  byElement: Map<string, RefrigerantCircuitFigures | null>;
  outdoorOf: Map<string, string[]>;
  indoorsOf: Map<string, string[]>;
  evaluations: Map<string, ReturnType<typeof evaluateAutoRouteNetwork>>;
}

const CIRCUIT_CACHE = new WeakMap<readonly HvacElement[], CircuitCacheEntry>();

/** Which outdoor units each element's circuit holds, and each outdoor unit's indoor units (native connectivity). */
function connectivity(scene: readonly HvacElement[]): Pick<CircuitCacheEntry, 'outdoorOf' | 'indoorsOf'> {
  const document = buildVrfDocumentFromHvacElements(scene);
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parents.has(root)) root = parents.get(root)!;
    return root;
  };
  const join = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parents.set(left, right);
  };
  const route = (id: string) => `route:${id}`;
  const equipment = (id: string) => `equipment:${id}`;
  const sources = new Map<string, string>();
  for (const edge of Object.values(document.segmentEdges)) join(route(edge.startNodeId), route(edge.endNodeId));
  for (const branch of Object.values(document.branchKits)) {
    const nodes = [...branch.inletNodeIds, ...branch.outletNodeIds].map(route);
    for (const node of nodes.slice(1)) join(nodes[0]!, node);
    const source = branch.metadata?.sourceElementId;
    if (typeof source === 'string' && nodes[0]) sources.set(source, nodes[0]);
  }
  for (const run of Object.values(document.pipeRuns)) {
    for (const [portId, nodeId] of [[run.sourcePortId, run.nodeIds[0]], [run.targetPortId, run.nodeIds.at(-1)]] as const) {
      const unitId = portId ? document.equipmentPorts[portId]?.equipmentId : undefined;
      if (unitId && nodeId) join(equipment(unitId), route(nodeId));
    }
    const source = run.metadata?.sourceElementId;
    if (typeof source === 'string' && run.nodeIds[0]) sources.set(source, route(run.nodeIds[0]));
  }
  const outdoorsByRoot = new Map<string, string[]>();
  const indoorsByRoot = new Map<string, string[]>();
  for (const unit of Object.values(document.equipmentNodes)) {
    const root = find(equipment(unit.id));
    const into = unit.equipmentType === 'outdoor-unit' ? outdoorsByRoot : unit.equipmentType === 'indoor-unit' ? indoorsByRoot : null;
    into?.set(root, [...(into.get(root) ?? []), unit.id]);
  }
  const outdoorOf = new Map<string, string[]>();
  for (const [elementId, node] of sources) outdoorOf.set(elementId, outdoorsByRoot.get(find(node)) ?? []);
  const indoorsOf = new Map<string, string[]>();
  for (const [root, outdoors] of outdoorsByRoot) for (const outdoor of outdoors) indoorsOf.set(outdoor, [...(indoorsByRoot.get(root) ?? [])].sort());
  return { outdoorOf, indoorsOf };
}

/** The circuit figures of a refrigerant line (or a branch kit): null when it reaches no outdoor unit. */
export function refrigerantCircuitFigures(
  scene: readonly HvacElement[],
  element: HvacElement,
  lineKind: 'gas' | 'liquid',
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
): RefrigerantCircuitFigures | null {
  let entry = CIRCUIT_CACHE.get(scene);
  if (!entry || entry.profile !== profile) {
    entry = { profile, byElement: new Map(), evaluations: new Map(), ...connectivity(scene) };
    CIRCUIT_CACHE.set(scene, entry);
  }
  const cacheKey = `${element.id}|${lineKind}`;
  if (entry.byElement.has(cacheKey)) return entry.byElement.get(cacheKey)!;
  const outdoorUnitId = entry.outdoorOf.get(element.id)?.[0] ?? null;
  const indoorUnitIds = outdoorUnitId ? entry.indoorsOf.get(outdoorUnitId) ?? [] : [];
  let figures: RefrigerantCircuitFigures | null = null;
  if (outdoorUnitId && indoorUnitIds.length) {
    let evaluation = entry.evaluations.get(outdoorUnitId);
    if (!evaluation) {
      evaluation = evaluateAutoRouteNetwork({ elements: [...scene], outdoorUnitId, indoorUnitIds, profile, elevationPolicy: 'existing-layout' });
      entry.evaluations.set(outdoorUnitId, evaluation);
    }
    const coordinated = element.type === 'refrigerant-pipe-pair';
    const vrfId = element.type === 'refrigerant-branch-kit'
      ? hvacVrfSemanticIds.branchKit(element.id, lineKind, coordinated)
      : hvacVrfSemanticIds.pipeRun(element.id, lineKind, coordinated);
    const through = (path: AutoRoutePathMetrics) => path.lineKind === lineKind && (path.runIds.includes(vrfId) || path.branchIds.includes(vrfId));
    const paths = evaluation.paths.filter(through);
    const longest = paths.reduce<AutoRoutePathMetrics | null>((best, path) => (!best || path.actualLengthMm > best.actualLengthMm ? path : best), null);
    const circuitLongest = evaluation.paths.filter((path) => path.lineKind === lineKind)
      .reduce((max, path) => Math.max(max, path.actualLengthMm), 0);
    const limits = profile.routeLimits;
    const height = paths.reduce((max, path) => Math.max(max, path.heightDifferenceMm), 0);
    figures = {
      outdoorUnitId,
      outdoorLabel: scene.find((candidate) => candidate.id === outdoorUnitId)?.label || outdoorUnitId,
      indoorUnitIds: [...new Set(paths.map((path) => path.indoorUnitId))],
      downstreamCapacityIndex: evaluation.recommendations.find((item) => item.entityId === vrfId)?.downstreamCapacityIndex ?? null,
      recommendation: evaluation.recommendations.find((item) => item.entityId === vrfId) ?? null,
      longestPathMm: longest?.actualLengthMm ?? null,
      // Per path, the profile limits the equivalent length (the actual length stands in while an allowance is unknown).
      pathLimit: limits.maximumEquivalentLengthMm ?? null,
      pathStatus: longest ? statusOf(longest.equivalentLengthMm ?? longest.actualLengthMm, limits.maximumEquivalentLengthMm?.value) : null,
      equivalentPathMm: longest?.equivalentLengthMm ?? null,
      equivalentLimit: limits.maximumEquivalentLengthMm ?? null,
      heightDifferenceMm: paths.length ? height : null,
      heightLimit: limits.maximumHeightDifferenceMm ?? null,
      heightStatus: paths.length ? statusOf(height, limits.maximumHeightDifferenceMm?.value) : null,
      onLongestPath: Boolean(longest) && Math.abs(longest!.actualLengthMm - circuitLongest) < 1,
      profileId: profile.id,
      profileVerified: profile.verified,
      sizingTable: profile.pipeSizing.some((row) => row.systemType === (lineKind === 'gas' ? 'refrigerant-gas' : 'refrigerant-liquid')),
    };
  }
  entry.byElement.set(cacheKey, figures);
  return figures;
}

// ---------------------------------------------------------------------------------------------------- a piece

/** A formed bend's minimum radius for its tube: the profile's sizing row for that OD, else its port default. */
function minimumBendRadius(profile: ManufacturerRuleProfile, tubeOdMm: number): RuleValue<number> {
  const row = profile.pipeSizing.find((candidate) => Math.abs(candidate.outsideDiameterMm.value - tubeOdMm) <= 0.25);
  return row?.minimumBendRadiusMm ?? profile.portDefaults.minimumBendRadiusMm;
}

function bendPlane(normal: { z: number }): 'horizontal' | 'vertical' | 'inclined' {
  const z = Math.abs(normal.z);
  return z >= 0.9 ? 'horizontal' : z <= 0.1 ? 'vertical' : 'inclined';
}

export function refrigerantPieceFigures(
  scene: readonly HvacElement[],
  element: HvacElement,
  line: RefrigerantLine,
  piece: RefrigerantPiece,
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
): RefrigerantPieceFigures {
  const path = piece.path;
  const first = path[0]!;
  const last = path[path.length - 1]!;
  const rise = last.z - first.z;
  const run = Math.hypot(last.x - first.x, last.y - first.y);
  const leg = piece.legIndex !== null ? line.design.legs[piece.legIndex] ?? null : null;
  const levelMm = path.reduce((sum, point) => sum + point.z, 0) / path.length;
  const slopePercent = piece.kind === 'straight' && run > 1 && Math.abs(rise) > 0.5 ? (rise / run) * 100 : null;
  let bend: RefrigerantPieceFigures['bend'] = null;
  if (piece.kind === 'bend' && piece.joint && piece.angleDeg !== null && piece.radiusMm !== null) {
    const construction = piece.catalogueModel ? 'socket-elbow' : line.socketElbows && piece.joint.construction === 'socket-elbow' ? 'socket-elbow' : 'formed-bend';
    const minimumRadius = construction === 'formed-bend' ? minimumBendRadius(profile, line.tubeOdMm) : null;
    bend = {
      angleDeg: piece.angleDeg,
      radiusMm: piece.radiusMm,
      construction,
      catalogueModel: piece.catalogueModel,
      plane: bendPlane(piece.joint.planeNormal),
      minimumRadius,
      // Under the minimum is over the rule; within 10 % of it is near.
      radiusStatus: minimumRadius ? (piece.radiusMm < minimumRadius.value - 0.5 ? 'over' : piece.radiusMm < minimumRadius.value * 1.1 ? 'near' : 'ok') : null,
    };
  }
  let port: RefrigerantPieceFigures['port'] = null;
  if (piece.kind === 'port' && piece.endpoint) {
    const frame = line.design.ports[piece.endpoint];
    const index = piece.endpoint === 'start' ? 0 : line.design.legs.length - 1;
    const legLength = line.design.legs[index]?.lengthMm ?? 0;
    // The straight up to the first fitting from the port: the leg, less the fitting at its far end.
    const fitting = line.pieces.find((candidate) => candidate.kind === 'bend'
      && candidate.joint?.nodeId === line.design.nodes[piece.endpoint === 'start' ? 1 : line.design.nodes.length - 2]?.id);
    const availableMm = Math.max(0, legLength - (fitting?.takeoffMm ?? 0));
    const required = frame.straightApproachMm;
    port = {
      label: frame.label,
      kind: frame.kind === 'unit-port' ? 'unit port' : 'branch-kit port',
      required,
      availableMm,
      status: availableMm + 0.5 >= required.value ? 'ok' : availableMm >= required.value * 0.9 ? 'near' : 'over',
    };
  }
  const lineKind = line.lineKind === 'pair' ? 'gas' : line.lineKind;
  let charge: RefrigerantPieceFigures['charge'] = null;
  if (line.lineKind === 'liquid') {
    const row = LIQUID_CHARGE_KG_PER_M.find(([od]) => Math.abs(od - line.tubeOdMm) <= 0.05);
    if (row) {
      const lineLength = line.design.legs.reduce((sum, candidate) => sum + candidate.lengthMm, 0);
      charge = { kgPerM: row[1], pieceKg: (row[1] * piece.lengthMm) / 1000, lineKg: (row[1] * lineLength) / 1000 };
    }
  }
  return {
    lineKind: line.lineKind,
    tubeOdMm: line.tubeOdMm,
    inch: copperInchLabel(line.tubeOdMm),
    insulationMm: line.insulationMm,
    outsideDiameterMm: line.outsideDiameterMm,
    material: leg?.material ?? null,
    lengthMm: piece.lengthMm,
    levelMm,
    riseMm: rise,
    slopePercent,
    bend,
    port,
    charge,
    circuit: refrigerantCircuitFigures(scene, element, lineKind, profile),
  };
}
