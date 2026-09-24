/**
 * Solved condensate network → persisted `condensate-pipe` elements.
 *
 * One element per pipe between significant nodes (unit outlet, junction,
 * top of drop, termination). Fittings are derived here from the solved
 * geometry and stored on the element they sit on: socket bends, the wye
 * where a branch drops into the crown of a main, P-traps for
 * negative-pressure gravity units, rodding eyes and air vents at the head of
 * collective mains, wall sleeves, and the termination fitting (tundish,
 * waterless valve, external outlet).
 */
import type { HvacElement, Point2D } from '../../../../types';
import { ownedElementSignature } from '../pipeEditRetention';

import { distance, normalize, planStations, pointToSegmentDistance, samePoint } from './condensateGeometry';
import type { CondensateNetworkPlan, NetNode, SolvedCondensateNetwork } from './condensateNetworkPlanner';
import { getCondensatePipeSystem } from './condensatePipeCatalog';
import type { CondensateDesignSettings } from './condensateSettings';
import { condensatePipeBounds } from './condensateTransforms';
import {
  CONDENSATE_PIPE_TYPE,
  type CondensateConnection,
  type CondensateFitting,
  type CondensateNetworkOwnership,
  type CondensateSegmentRole,
  type Point3,
} from './condensateTypes';

export function hashCondensateText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

const round = (value: number) => Math.round(value * 2) / 2;

/** Fingerprint of the inputs a network was solved against (unit outlets + termination). */
export function condensateNetworkSourceSignature(network: {
  sink: Pick<SolvedCondensateNetwork['sink'], 'gullyId' | 'point' | 'terminalZ' | 'kind'>;
  units: ReadonlyArray<{ source: Pick<SolvedCondensateNetwork['units'][number]['source'], 'unitId' | 'point' | 'z'> }>;
}): string {
  return hashCondensateText(JSON.stringify({
    sink: [network.sink.gullyId, round(network.sink.point.x), round(network.sink.point.y), round(network.sink.terminalZ), network.sink.kind],
    units: network.units
      .map((unit) => [unit.source.unitId, round(unit.source.point.x), round(unit.source.point.y), round(unit.source.z)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  }));
}

interface Chain {
  nodes: NetNode[];
  /** Crown point where the chain drops into a main (branches only). */
  crown: Point3 | null;
  joinTarget: NetNode | null;
  role: CondensateSegmentRole;
}

function vec3(node: NetNode): Point3 {
  return { x: node.point.x, y: node.point.y, z: node.z };
}

function buildChains(network: SolvedCondensateNetwork): Chain[] {
  const { nodes } = network;
  const byId = (id: string | null) => (id ? nodes.get(id) ?? null : null);
  const starts = [...nodes.values()].filter((node) => node.kind === 'port' || node.kind === 'junction' || node.kind === 'drop-top')
    .sort((a, b) => a.id.localeCompare(b.id));
  const chains: Chain[] = [];
  for (const start of starts) {
    const chainNodes: NetNode[] = [start];
    let crown: Point3 | null = null;
    let joinTarget: NetNode | null = null;
    let cursor = start;
    const guard = new Set<string>([start.id]);
    for (;;) {
      const next = byId(cursor.down);
      if (!next || guard.has(next.id)) break;
      guard.add(next.id);
      if (cursor.edge === 'join') {
        const main = network.sizes.get(next.id);
        crown = { x: next.point.x, y: next.point.y, z: next.z + (main?.outerDiameterMm ?? 32) / 2 };
        joinTarget = next;
        break;
      }
      chainNodes.push(next);
      if (next.kind === 'junction' || next.kind === 'drop-top' || next.kind === 'root') break;
      cursor = next;
    }
    const units = network.upstreamUnits.get(start.id) ?? [];
    const role: CondensateSegmentRole = start.kind === 'drop-top'
      ? (network.sink.kind === 'floor-gully' ? 'drop' : 'terminal')
      : units.length <= 1 ? 'unit-branch' : 'main';
    if (chainNodes.length >= 2 || crown) chains.push({ nodes: chainNodes, crown, joinTarget, role });
  }
  return chains;
}

function dedupe3(points: Point3[]): Point3[] {
  const result: Point3[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01 && Math.abs(last.z - point.z) < 0.01) continue;
    result.push(point);
  }
  return result;
}

function direction3(a: Point3, b: Point3): Point3 {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length };
}

function bendFittings(points: Point3[], nominalSize: string, outerDiameterMm: number, prefix: string): CondensateFitting[] {
  const fittings: CondensateFitting[] = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = direction3(points[index - 1]!, points[index]!);
    const after = direction3(points[index]!, points[index + 1]!);
    const cosine = before.x * after.x + before.y * after.y + before.z * after.z;
    const angle = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
    if (angle < 8) continue; // a slope change along a straight run needs no fitting
    fittings.push({
      id: `${prefix}-bend-${index}`,
      kind: angle > 60 ? 'elbow-90' : 'elbow-45',
      point: points[index]!,
      nominalSize,
      outerDiameterMm,
      axis: after,
      note: `${Math.round(angle)}°`,
    });
  }
  return fittings;
}

/** Plan run kept at the design fall between a bend and the start of a 45° offset (mm). */
const OFFSET_MARGIN_MM = 20;
/** Extra fall (mm) above the design fall on one segment that is shaped as an offset. */
const OFFSET_TOLERANCE_MM = 3;
/** Flexible drain hose climbs this far up the riser before the rigid pipe starts (mm). */
const DRAIN_HOSE_RISE_MM = 80;

function planDistance3(a: Point3, b: Point3): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The segment a → b falls further than its design slope allows for (a level
 * change forced by a crossing, a lower main, or a branch dropping into a wye).
 * Site practice keeps the design fall and makes the step as a 45° offset right
 * before b; when the plan run is too short for all of it, the remainder is a
 * plumb drop at the top of the offset.
 */
function offsetDive(a: Point3, b: Point3, slope: number): Point3[] {
  const run = planDistance3(a, b);
  const excess = (a.z - b.z) - slope * run;
  if (run < 1 || excess <= OFFSET_TOLERANCE_MM) return [a, b];
  const along = (distanceFromA: number) => (run > 1e-9 ? distanceFromA / run : 0);
  const ideal = excess / (1 - slope);
  const diagonal = Math.min(ideal, Math.max(0, run - OFFSET_MARGIN_MM));
  const startT = along(run - diagonal);
  const top: Point3 = { x: a.x + (b.x - a.x) * startT, y: a.y + (b.y - a.y) * startT, z: a.z - slope * (run - diagonal) };
  const plumb = (a.z - b.z) - slope * (run - diagonal) - diagonal;
  if (plumb <= 0.5) return [a, top, b];
  return [a, top, { ...top, z: top.z - plumb }, b];
}

/**
 * Level changes shaped as 45° offsets. `slopes[i]` is the design fall
 * (fraction) of segment i → i+1. A chain that ends in a plumb step into the
 * crown of a main enters it at 45° from above instead (a wye rolled up).
 */
function shapeLevelChanges(points: Point3[], slopes: number[], endsInCrown: boolean): Point3[] {
  let working = points;
  let workingSlopes = slopes;
  if (endsInCrown && working.length >= 3) {
    const crown = working[working.length - 1]!;
    const branchEnd = working[working.length - 2]!;
    const before = working[working.length - 3]!;
    if (planDistance3(branchEnd, crown) < 0.5 && planDistance3(before, branchEnd) >= 1) {
      // Treat before → crown as one diving segment along the branch's last leg.
      working = [...working.slice(0, -2), crown];
      workingSlopes = [...slopes.slice(0, working.length - 2), slopes[slopes.length - 2] ?? slopes[slopes.length - 1] ?? 0.01];
    }
  }
  const result: Point3[] = [working[0]!];
  for (let index = 1; index < working.length; index += 1) {
    const shaped = offsetDive(working[index - 1]!, working[index]!, workingSlopes[index - 1] ?? 0.01);
    result.push(...shaped.slice(1));
  }
  return result;
}

function drainHoseLength(points: Point3[], pumped: boolean): number {
  if (!pumped || points.length < 3) return 0;
  const [port, foot, riserTop] = points as [Point3, Point3, Point3];
  const rise = riserTop.z - foot.z;
  if (planDistance3(foot, riserTop) > 0.5 || rise <= 0) return 0;
  return Math.hypot(foot.x - port.x, foot.y - port.y, foot.z - port.z) + Math.min(DRAIN_HOSE_RISE_MM, rise / 2);
}

function pointAtStation(points: Point3[], station: number): Point3 {
  const stations = planStations(points);
  for (let index = 1; index < points.length; index += 1) {
    if (station <= stations[index]! + 1e-9) {
      const span = stations[index]! - stations[index - 1]!;
      const t = span > 1e-9 ? (station - stations[index - 1]!) / span : 0;
      const a = points[index - 1]!;
      const b = points[index]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
  }
  return points[points.length - 1]!;
}

export interface BuildCondensateElementsOptions {
  settings: CondensateDesignSettings;
  idFactory: (prefix: string) => string;
  /** Design soffit the hanger rods are fixed to. */
  soffitMm?: number;
}

export function buildCondensateNetworkElements(
  network: SolvedCondensateNetwork,
  options: BuildCondensateElementsOptions,
): HvacElement[] {
  const { settings } = options;
  const system = getCondensatePipeSystem(settings.pipeSystem);
  const chains = buildChains(network);
  const unitById = new Map(network.units.map((unit) => [unit.source.unitId, unit]));
  const sourceSignature = condensateNetworkSourceSignature(network);
  const allUnitIds = network.units.map((unit) => unit.source.unitId).sort();
  const elements: HvacElement[] = [];
  const pumpedIds = new Set(network.units.filter((unit) => unit.pumped).map((unit) => unit.source.unitId));

  // Heads of collective mains: junctions fed only by unit branches.
  const inflow = new Map<string, NetNode[]>();
  for (const node of network.nodes.values()) {
    if (!node.down) continue;
    const list = inflow.get(node.down) ?? [];
    list.push(node);
    inflow.set(node.down, list);
  }
  const headJunctions = new Set<string>();
  for (const node of network.nodes.values()) {
    if (node.kind !== 'junction') continue;
    const feedsFromMain = (inflow.get(node.id) ?? []).some((upstream) => (network.upstreamUnits.get(upstream.id) ?? []).length > 1);
    if (!feedsFromMain) headJunctions.add(node.id);
  }

  chains.forEach((chain, chainIndex) => {
    const first = chain.nodes[0]!;
    const size = network.sizes.get(first.id) ?? network.sizes.get(chain.nodes[1]?.id ?? '') ?? system.sizes[1] ?? system.sizes[0]!;
    const upstreamUnitIds = network.upstreamUnits.get(first.id) ?? [];
    const capacity = upstreamUnitIds.reduce((sum, id) => sum + (unitById.get(id)?.source.capacityKw ?? 0), 0);
    const rawNodes = [...chain.nodes.map(vec3), ...(chain.crown ? [chain.crown] : [])];
    // Design fall of each segment (the upstream node's slope), crown step included.
    const segmentSlopes = rawNodes.slice(1).map((_, index) => {
      const node = chain.nodes[Math.min(index, chain.nodes.length - 1)]!;
      return (network.slopes.get(node.id) ?? network.mainSlopePercent) / 100;
    });
    const shaped = chain.role === 'drop' || chain.role === 'terminal'
      ? rawNodes
      : shapeLevelChanges(rawNodes, segmentSlopes, Boolean(chain.crown));
    const points = dedupe3(shaped);
    if (points.length < 2) return;
    const prefix = `f${chainIndex}`;
    const fittings: CondensateFitting[] = bendFittings(points, size.nominalSize, size.outerDiameterMm, prefix);
    const add = (fitting: Omit<CondensateFitting, 'id' | 'nominalSize' | 'outerDiameterMm'>, id: string) => {
      fittings.push({ id: `${prefix}-${id}`, nominalSize: size.nominalSize, outerDiameterMm: size.outerDiameterMm, ...fitting });
    };

    // Wye where a branch drops into the crown of a main.
    if (chain.crown && chain.joinTarget) {
      const main = chain.joinTarget;
      const mainDown = main.down ? network.nodes.get(main.down) : null;
      const flow = mainDown ? normalize({ x: mainDown.point.x - main.point.x, y: mainDown.point.y - main.point.y }) : { x: 1, y: 0 };
      const mainSize = network.sizes.get(main.id) ?? size;
      const approach = points.length >= 2 ? direction3(points[points.length - 1]!, points[points.length - 2]!) : { x: 0, y: 0, z: 1 };
      fittings.push({
        id: `${prefix}-wye`,
        kind: 'wye',
        point: { x: main.point.x, y: main.point.y, z: main.z },
        nominalSize: mainSize.nominalSize,
        outerDiameterMm: mainSize.outerDiameterMm,
        axis: { x: flow.x, y: flow.y, z: 0 },
        branchAxis: approach,
        note: `branch ${size.nominalSize} from the top`,
      });
    }

    // Unit outlet: trap for a negative-pressure gravity unit.
    if (first.kind === 'port' && first.unitId) {
      const unit = unitById.get(first.unitId);
      const stub = first.down ? network.nodes.get(first.down) : null;
      if (unit?.trap && stub) {
        const esp = unit.source.externalStaticPressurePa ?? 100;
        const depth = Math.ceil(esp * 0.102 + settings.trapSealMarginMm);
        add({ kind: 'p-trap', point: vec3(stub), axis: { ...unit.source.direction, z: 0 }, note: `${depth}` }, 'trap');
      }
    }

    // Head of a collective main: rodding eye, plus an air vent when pumped units feed it.
    if (first.kind === 'junction' && headJunctions.has(first.id) && chain.role === 'main') {
      const next = chain.nodes[1];
      const back = next ? normalize({ x: first.point.x - next.point.x, y: first.point.y - next.point.y }) : { x: -1, y: 0 };
      add({ kind: 'cleanout', point: vec3(first), axis: { x: back.x, y: back.y, z: 0 }, note: 'rodding eye at head of main' }, 'head-co');
      if (settings.airVentForPumpedMains && upstreamUnitIds.some((id) => pumpedIds.has(id))) {
        add({ kind: 'air-vent', point: { x: first.point.x, y: first.point.y, z: first.z + size.outerDiameterMm / 2 }, axis: { x: 0, y: 0, z: 1 }, note: 'air vent at the head of the collective main' }, 'vent');
      }
    }

    // Intermediate rodding eyes on long mains.
    if (chain.role === 'main') {
      const stations = planStations(points);
      const total = stations[stations.length - 1]!;
      for (let station = settings.cleanoutMaxSpacingMm; station < total - 500; station += settings.cleanoutMaxSpacingMm) {
        add({ kind: 'cleanout', point: pointAtStation(points, station), note: 'intermediate rodding eye' }, `co-${Math.round(station)}`);
      }
    }

    // Termination.
    if (first.kind === 'drop-top') {
      const root = chain.nodes[chain.nodes.length - 1]!;
      add({ kind: 'cleanout', point: vec3(first), axis: { x: 0, y: 0, z: 1 }, note: 'access at top of drop' }, 'drop-co');
      if (network.sink.kind === 'floor-gully') {
        add({ kind: 'tundish', point: vec3(root), axis: { x: 0, y: 0, z: -1 }, note: 'air break into tundish' }, 'tundish');
      } else if (network.sink.kind === 'stack-connection') {
        if (network.sink.trap === 'hepvo') add({ kind: 'hepvo', point: { ...vec3(root), z: root.z + network.sink.minimumDropMm / 2 }, axis: { x: 0, y: 0, z: -1 } }, 'hepvo');
        else if (network.sink.trap === 'p-trap') add({ kind: 'p-trap', point: vec3(first), note: '75' }, 'stack-trap');
        add({ kind: 'stack-wye', point: vec3(root), axis: { x: 0, y: 0, z: -1 }, note: 'branch into stack from above' }, 'stack-wye');
      } else {
        const normal = network.sink.wallNormal ?? { x: 1, y: 0 };
        add({ kind: 'wall-sleeve', point: vec3(root), axis: { x: normal.x, y: normal.y, z: 0 } }, 'ext-sleeve');
        add({ kind: 'terminal-outlet', point: { x: root.point.x + normal.x * 150, y: root.point.y + normal.y * 150, z: root.z }, axis: { x: normal.x, y: normal.y, z: 0 } }, 'ext-outlet');
      }
    }

    // Wall penetrations along this pipe.
    network.wallCrossings.forEach((crossing, index) => {
      for (let segment = 1; segment < points.length; segment += 1) {
        const a = points[segment - 1]!;
        const b = points[segment]!;
        if (pointToSegmentDistance(crossing.point, a, b) > 1) continue;
        const span = distance(a, b);
        const t = span > 1e-6 ? distance(a, crossing.point) / span : 0;
        add({ kind: 'wall-sleeve', point: { x: crossing.point.x, y: crossing.point.y, z: a.z + (b.z - a.z) * t }, axis: direction3(a, b), note: crossing.wallId }, `sleeve-${index}`);
        break;
      }
    });

    const planPoints: Point2D[] = [];
    for (const point of points) {
      const last = planPoints[planPoints.length - 1];
      if (!last || !samePoint(last, point, 0.01)) planPoints.push({ x: point.x, y: point.y });
    }
    if (planPoints.length === 1) planPoints.push({ ...planPoints[0]! });

    const last = chain.nodes[chain.nodes.length - 1]!;
    const connection = (node: NetNode): CondensateConnection => {
      if (node.kind === 'port') return { kind: 'unit-drain', unitId: node.unitId, point: node.point, z: node.z };
      if (node.kind === 'root') return { kind: 'gully', gullyId: network.sink.gullyId, point: node.point, z: node.z };
      return { kind: 'junction', nodeId: node.id, point: node.point, z: node.z };
    };
    const drainEnd = chain.crown && chain.joinTarget
      ? { kind: 'junction' as const, nodeId: chain.joinTarget.id, point: chain.joinTarget.point, z: chain.crown.z }
      : connection(last);
    const slopes = chain.nodes.map((node) => network.slopes.get(node.id)).filter((value): value is number => value !== undefined);
    const designSlope = slopes.length ? Math.min(...slopes) : network.mainSlopePercent;
    const pumped = first.kind === 'port' && first.unitId ? pumpedIds.has(first.unitId) : false;
    const radius = size.outerDiameterMm / 2 + settings.insulationThicknessMm;
    const ownership: CondensateNetworkOwnership = {
      version: 1,
      networkId: network.networkId,
      gullyId: network.sink.gullyId,
      unitIds: allUnitIds,
      signature: '',
      sourceSignature,
    };
    const element: HvacElement = {
      id: options.idFactory('cdp'),
      type: CONDENSATE_PIPE_TYPE,
      category: 'accessory',
      subtype: chain.role,
      modelLabel: `Condensate ${system.label} ${size.nominalSize}`,
      label: `CD ${size.nominalSize}`,
      rotation: 0,
      mountType: 'ceiling',
      supplyZoneRatio: 0.5,
      ...condensatePipeBounds(points, radius),
      properties: {
        routePoints: planPoints,
        routeNodes3d: points,
        pipeSystem: system.id,
        nominalSize: size.nominalSize,
        outerDiameterMm: size.outerDiameterMm,
        innerDiameterMm: size.innerDiameterMm,
        insulationThicknessMm: settings.insulationThicknessMm,
        designSlopePercent: Math.round(designSlope * 1000) / 1000,
        segmentRole: chain.role,
        drainStart: connection(first),
        drainEnd,
        upstreamUnitIds,
        upstreamCapacityKw: Math.round(capacity * 100) / 100,
        fittings,
        pumped,
        drainHoseLengthMm: Math.round(drainHoseLength(points, pumped) * 10) / 10,
        ...(options.soffitMm !== undefined ? {
          hangers: {
            topZ: options.soffitMm,
            supportSpacingHorizontalMm: settings.supportSpacingHorizontalMm,
            supportSpacingVerticalMm: settings.supportSpacingVerticalMm,
            supportNearFittingMm: settings.supportNearFittingMm,
          },
        } : {}),
        condensateNetwork: ownership,
      },
    };
    ownership.signature = ownedElementSignature(element, 'condensateNetwork');
    elements.push(element);
  });
  return elements;
}

export function buildCondensatePlanElements(plan: CondensateNetworkPlan, options: BuildCondensateElementsOptions): HvacElement[] {
  return plan.networks.flatMap((network) => buildCondensateNetworkElements(network, { soffitMm: plan.envelope.soffitMm, ...options }));
}
