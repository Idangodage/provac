import type { HvacElement, Point2D } from '../../../types';

import { getIndoorUnitDrainPort } from './condensate/condensatePorts';
import { condensateSocketExitLength } from './condensate/condensateSocketClearance';
import { readCondensatePipeSpec, type CondensateConnection } from './condensate/condensateTypes';
import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { getActiveDuctSettings } from './duct/ductSettings';
import { segmentBoxDistance, solidBoxesInScene, type DuctBox } from './duct/ductVolumes';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import type { PipeBypass } from './pipeBypass';
import { liftPipePlanRouteTo3d, normalizePipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { computeFittingRunMm } from './pipeRoutingRules';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipePhysicalPath,
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from './refrigerantPipePairModel';

type Vec3 = PipeRouteNode3D;
type Service = 'gas' | 'liquid' | 'drain';
const TOLERANCE_MM = 0.5;
const EPS = 1e-10;
const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

interface Bounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
interface Segment { a: Vec3; b: Vec3; from: number; to: number; bounds: Bounds }
interface PipeLane {
  id: string;
  key: string;
  bundleId?: string;
  service: Service;
  radius: number;
  segments: Segment[];
  bounds: Bounds;
  total: number;
  start: { point: Vec3; connection: RefrigerantPipeConnection | null };
  end: { point: Vec3; connection: RefrigerantPipeConnection | null };
  /** Declared rolled wye: the branch ends at the main's crown, above its axis. */
  drainSockets?: Array<{ end: 'start' | 'end'; nodeId: string; centre: Vec3; radius: number }>;
}

export interface NetworkPipeClash {
  elementIds: [string, string];
  /** Closest centreline distance, compared with the sum of insulated radii. */
  distanceMm: number;
  requiredMm: number;
}

function boundsOf(points: Vec3[], radius: number): Bounds {
  return { minX: Math.min(...points.map(p => p.x)) - radius, maxX: Math.max(...points.map(p => p.x)) + radius,
    minY: Math.min(...points.map(p => p.y)) - radius, maxY: Math.max(...points.map(p => p.y)) + radius,
    minZ: Math.min(...points.map(p => p.z)) - radius, maxZ: Math.max(...points.map(p => p.z)) + radius };
}
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}
function project(point: Vec3, a: Vec3, b: Vec3): Vec3 {
  const delta = subtract(b, a);
  return lerp(a, b, clamp(dot(subtract(point, a), delta) / Math.max(EPS, dot(delta, delta))));
}

/** Exact closest points on finite 3D segments, including parallel/degenerate cases. */
function closest(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { a: Vec3; b: Vec3; distance: number } {
  const u = subtract(b, a); const v = subtract(d, c); const w = subtract(a, c);
  const uu = dot(u, u); const vv = dot(v, v); const uv = dot(u, v); const uw = dot(u, w); const vw = dot(v, w);
  let s = 0; let t = 0;
  if (uu <= EPS) t = vv <= EPS ? 0 : clamp(vw / vv);
  else if (vv <= EPS) s = clamp(-uw / uu);
  else {
    const denominator = uu * vv - uv * uv;
    s = denominator > EPS ? clamp((uv * vw - uw * vv) / denominator) : 0;
    t = (uv * s + vw) / vv;
    if (t < 0) { t = 0; s = clamp(-uw / uu); }
    else if (t > 1) { t = 1; s = clamp((uv - uw) / uu); }
  }
  const p = lerp(a, b, s); const q = lerp(c, d, t);
  return { a: p, b: q, distance: distance(p, q) };
}

/** Legacy bypass interpolation matches buildHvacElementMesh's stored profile.
 * Authored routeNodes3d always supersede this metadata, as in the renderer. */
function legacyGuide(points: Point2D[], baseZ: number, bypasses: PipeBypass[]): Vec3[] {
  if (points.length < 2 || !bypasses.length) return points.map(point => ({ ...point, z: baseZ }));
  const stations = [0];
  for (let i = 1; i < points.length; i += 1) stations.push(stations[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const nearStation = (point: Point2D): number => {
    let best = Number.POSITIVE_INFINITY; let station = 0;
    for (let i = 1; i < points.length; i += 1) {
      const start = { ...points[i - 1]!, z: 0 }; const end = { ...points[i]!, z: 0 };
      const projected = project({ ...point, z: 0 }, start, end);
      const gap = Math.hypot(projected.x - point.x, projected.y - point.y);
      if (gap < best) { best = gap; station = stations[i - 1]! + distance(start, projected); }
    }
    return station;
  };
  const spans = bypasses.flatMap(bypass => {
    const rise = bypass.bypassElevationMm - bypass.baseElevationMm;
    const from = nearStation(bypass.enterPoint); const to = nearStation(bypass.exitPoint);
    const start = Math.min(from, to); const end = Math.max(from, to);
    if (Math.abs(rise) < 0.5 || end - start < 4) return [];
    const run = Math.min(Math.max(8, computeFittingRunMm(Math.abs(rise), bypass.fittingAngleDeg)), (end - start) * 0.45);
    return [{ start, upEnd: start + run, downStart: end - run, end, rise }];
  });
  const samples = [...new Set([...stations, ...spans.flatMap(span => [span.start, span.upEnd, span.downStart, span.end])])].sort((a, b) => a - b);
  let previous = Number.NEGATIVE_INFINITY;
  return samples.flatMap(station => {
    if (station - previous < 0.25) return [];
    previous = station;
    let index = 1; while (index < stations.length - 1 && stations[index]! < station) index += 1;
    const t = (station - stations[index - 1]!) / Math.max(EPS, stations[index]! - stations[index - 1]!);
    let offset = 0;
    for (const span of spans) {
      if (station <= span.start || station >= span.end) continue;
      const factor = station < span.upEnd ? (station - span.start) / (span.upEnd - span.start)
        : station <= span.downStart ? 1 : (span.end - station) / (span.end - span.downStart);
      if (Math.abs(factor * span.rise) > Math.abs(offset)) offset = factor * span.rise;
    }
    return [lerp({ ...points[index - 1]!, z: baseZ + offset }, { ...points[index]!, z: baseZ + offset }, t)];
  });
}

function makeLane(element: HvacElement, service: Service, radius: number, nodes: Vec3[], start: RefrigerantPipeConnection | null, end: RefrigerantPipeConnection | null): PipeLane | null {
  if (nodes.length < 2 || !Number.isFinite(radius) || radius <= 0) return null;
  const stations = [0];
  for (let i = 1; i < nodes.length; i += 1) stations.push(stations[i - 1]! + distance(nodes[i - 1]!, nodes[i]!));
  const total = stations.at(-1)!;
  const portStub = Math.max(0, getActivePipeRoutingSettings().minimumPortStubMm);
  const adapterStart = start?.connectionKind === 'unit-port' ? start.sourceElementId : undefined;
  const adapterEnd = end?.connectionKind === 'unit-port' ? end.sourceElementId : undefined;
  const segments: Segment[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const from = stations[i - 1]!; const to = stations[i]!;
    if (to - from <= EPS) continue;
    // Split at the exact protected boundary; do not exempt an entire long span
    // merely because it starts at an equipment port.
    const cuts = [from, ...[adapterStart ? portStub : -1, adapterEnd ? total - portStub : -1].filter(s => s > from && s < to), to].sort((a, b) => a - b);
    for (let j = 1; j < cuts.length; j += 1) {
      const lo = cuts[j - 1]!; const hi = cuts[j]!;
      const a = lerp(nodes[i - 1]!, nodes[i]!, (lo - from) / (to - from));
      const b = lerp(nodes[i - 1]!, nodes[i]!, (hi - from) / (to - from));
      segments.push({ a, b, from: lo, to: hi, bounds: boundsOf([a, b], radius) });
    }
  }
  if (!segments.length) return null;
  return { id: element.id, key: `${element.id}:${service}`, bundleId: typeof element.properties.bundleId === 'string' ? element.properties.bundleId : undefined,
    service, radius, segments, bounds: boundsOf(nodes, radius), total,
    start: { point: nodes[0]!, connection: start }, end: { point: nodes.at(-1)!, connection: end } };
}

function bundleLineConnection(bundle: RefrigerantPipeBundleConnection | null, service: Service): RefrigerantPipeConnection | null {
  if (!bundle) return null;
  const gas = service === 'gas';
  return { connectionKind: bundle.connectionKind, elevationMm: gas ? bundle.gasElevationMm : bundle.liquidElevationMm,
    direction: (gas ? bundle.gasDirection : bundle.liquidDirection) ?? bundle.direction,
    portPoint: gas ? bundle.gasPoint : bundle.liquidPoint, sourceElementId: (gas ? bundle.gasSourceElementId : bundle.liquidSourceElementId) ?? bundle.sourceElementId,
    portId: gas ? bundle.gasPortId : bundle.liquidPortId, nodeId: gas ? bundle.gasNodeId : bundle.liquidNodeId, terminalRole: bundle.terminalRole };
}

function fittedLane(element: HvacElement, service: Service, radius: number, copperDiameterMm: number,
  nodes: Vec3[], start: RefrigerantPipeConnection | null, end: RefrigerantPipeConnection | null): PipeLane | null {
  if (!usesCopperSocketElbows(element.properties)) return makeLane(element, service, radius, nodes, start, end);
  const route = compileCopperSocketElbowRoute(nodes, copperDiameterMm, {
    minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
    startStraightMm: start?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
    endStraightMm: end?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
  });
  // Include the larger female cup in the lane's conservative radial budget;
  // hiding covers in the inspection view never removes physical insulation.
  const effectiveRadius = Math.max(radius, ...route.fittings.map(fitting =>
    radius + (fitting.spec.socketOutsideDiameterMm - copperDiameterMm) / 2));
  return makeLane(element, service, effectiveRadius, route.centerline, start, end);
}

interface LaneGeometry {
  radius: number;
  segments: Segment[];
  bounds: Bounds;
  total: number;
  startPoint: Vec3;
  endPoint: Vec3;
}

// Only private physical geometry is shared. Public visual models and live
// connection records are never cached here. Clearance treats these segments,
// points and bounds as immutable; clipping creates a new segment when needed.
const laneGeometryCache = new Map<string, LaneGeometry>();
const MAX_GEOMETRY_ENTRIES = 384;
const MAX_GEOMETRY_SEGMENTS = 60000;
const MAX_GEOMETRY_KEY_CHARACTERS = 4000000;
let retainedGeometrySegments = 0;
let retainedGeometryKeyCharacters = 0;

interface LaneInputSnapshot {
  metadataKey: string;
  geometryKey: string;
  routePoints: Point2D[];
  authored: Vec3[];
  segmentMaterials: string[];
}
// Weak source identities retain only a number. Snapshot records have their own
// global budgets, so evicted geometry cannot leave unbounded coordinate copies
// or serialized keys behind while old public route arrays remain alive.
const laneInputIdentities = new WeakMap<object, number>();
const laneInputSnapshots = new Map<number, LaneInputSnapshot>();
const MAX_INPUT_SNAPSHOT_ENTRIES = 384;
const MAX_INPUT_SNAPSHOT_VALUES = 60000;
const MAX_INPUT_SNAPSHOT_KEY_CHARACTERS = 4000000;
let nextLaneInputIdentity = 0;
let retainedInputSnapshotValues = 0;
let retainedInputSnapshotKeyCharacters = 0;
function inputSnapshotValueCount(snapshot: LaneInputSnapshot): number {
  return snapshot.routePoints.length * 2 + snapshot.authored.length * 3 + snapshot.segmentMaterials.length;
}
function inputSnapshotKeyLength(snapshot: LaneInputSnapshot): number {
  return snapshot.metadataKey.length + snapshot.geometryKey.length;
}
function deleteLaneInputSnapshot(identity: number, snapshot: LaneInputSnapshot): void {
  laneInputSnapshots.delete(identity);
  retainedInputSnapshotValues -= inputSnapshotValueCount(snapshot);
  retainedInputSnapshotKeyCharacters -= inputSnapshotKeyLength(snapshot);
}
function getLaneInputSnapshot(source: object): LaneInputSnapshot | undefined {
  const identity = laneInputIdentities.get(source);
  if (identity === undefined) return undefined;
  const snapshot = laneInputSnapshots.get(identity);
  if (snapshot) {
    laneInputSnapshots.delete(identity);
    laneInputSnapshots.set(identity, snapshot);
  }
  return snapshot;
}
function retainLaneInputSnapshot(source: object, snapshot: LaneInputSnapshot): void {
  let identity = laneInputIdentities.get(source);
  if (identity === undefined) {
    identity = ++nextLaneInputIdentity;
    laneInputIdentities.set(source, identity);
  }
  const previous = laneInputSnapshots.get(identity);
  if (previous) deleteLaneInputSnapshot(identity, previous);
  const values = inputSnapshotValueCount(snapshot); const characters = inputSnapshotKeyLength(snapshot);
  if (values > MAX_INPUT_SNAPSHOT_VALUES || characters > MAX_INPUT_SNAPSHOT_KEY_CHARACTERS) return;
  laneInputSnapshots.set(identity, snapshot);
  retainedInputSnapshotValues += values;
  retainedInputSnapshotKeyCharacters += characters;
  while (laneInputSnapshots.size > MAX_INPUT_SNAPSHOT_ENTRIES || retainedInputSnapshotValues > MAX_INPUT_SNAPSHOT_VALUES
    || retainedInputSnapshotKeyCharacters > MAX_INPUT_SNAPSHOT_KEY_CHARACTERS) {
    const oldest = laneInputSnapshots.entries().next().value!;
    deleteLaneInputSnapshot(oldest[0], oldest[1]);
  }
}
function samePlanPoints(a: Point2D[], b: Point2D[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]!.x !== b[index]!.x || a[index]!.y !== b[index]!.y) return false;
  }
  return true;
}
function sameRouteNodes(a: Vec3[], b: Vec3[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]!.x !== b[index]!.x || a[index]!.y !== b[index]!.y || a[index]!.z !== b[index]!.z) return false;
  }
  return true;
}
function sameMaterials(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function connectionGeometry(connection: RefrigerantPipeConnection | null) {
  return connection && {
    portPoint: connection.portPoint,
    direction: connection.direction,
    elevationMm: connection.elevationMm,
    connectionKind: connection.connectionKind,
    terminalRole: connection.terminalRole,
    // makeLane splits the exact protected stub only for an identified unit.
    // Its identity itself belongs to the fresh adapter/binding records below.
    hasSource: Boolean(connection.sourceElementId),
  };
}

function retainLaneGeometry(key: string, geometry: LaneGeometry): void {
  if (geometry.segments.length > MAX_GEOMETRY_SEGMENTS || key.length > MAX_GEOMETRY_KEY_CHARACTERS) return;
  laneGeometryCache.set(key, geometry);
  retainedGeometrySegments += geometry.segments.length;
  retainedGeometryKeyCharacters += key.length;
  while (laneGeometryCache.size > MAX_GEOMETRY_ENTRIES || retainedGeometrySegments > MAX_GEOMETRY_SEGMENTS
    || retainedGeometryKeyCharacters > MAX_GEOMETRY_KEY_CHARACTERS) {
    const oldest = laneGeometryCache.entries().next().value!;
    laneGeometryCache.delete(oldest[0]);
    retainedGeometrySegments -= oldest[1].segments.length;
    retainedGeometryKeyCharacters -= oldest[0].length;
  }
}

function singlePhysicalLane(element: HvacElement, elements: HvacElement[], authored: Vec3[]): PipeLane | null {
  // Resolve before lookup: equipment moves, rotations, sizing and branch port
  // changes can heal a saved connection even when the pipe itself is unchanged.
  const spec = resolveRefrigerantPipeSpec(element.properties, elements);
  const metadataKey = JSON.stringify([
    { ...spec, routePoints: undefined, segmentMaterials: undefined, bundleId: undefined,
      startConnection: connectionGeometry(spec.startConnection), endConnection: connectionGeometry(spec.endConnection) },
    element.position, element.width, element.depth, element.elevation,
    Array.isArray(element.properties.authoredCenterlineRoute),
    element.properties.bendRadiusFactor, usesCopperSocketElbows(element.properties),
    resolveCopperSocketElbowMinimumRadius(element.properties), getActivePipeRoutingSettings(),
  ]);
  const source = Array.isArray(element.properties.routePoints) ? element.properties.routePoints : element.properties;
  const snapshot = getLaneInputSnapshot(source);
  const unchanged = snapshot?.metadataKey === metadataKey
    && samePlanPoints(snapshot.routePoints, spec.routePoints) && sameRouteNodes(snapshot.authored, authored)
    && sameMaterials(snapshot.segmentMaterials, spec.segmentMaterials);
  const key = unchanged ? snapshot.geometryKey : JSON.stringify([metadataKey, spec.routePoints, authored, spec.segmentMaterials]);
  if (!unchanged) retainLaneInputSnapshot(source, { metadataKey, geometryKey: key,
    routePoints: spec.routePoints, authored, segmentMaterials: spec.segmentMaterials });
  let geometry = laneGeometryCache.get(key);
  if (geometry) {
    laneGeometryCache.delete(key);
    laneGeometryCache.set(key, geometry);
  } else {
    const visual = buildRefrigerantPipePhysicalPath(element, elements);
    const points = visual.continuousOuterPoints;
    const guide = authored.length >= 2 ? authored : legacyGuide(points, element.elevation + visual.localZMm, visual.bypasses);
    const nodes = liftPipePlanRouteTo3d(points, guide, { startConnection: visual.startConnection, endConnection: visual.endConnection, outerDiameterMm: visual.outerRadiusMm * 2,
      pipeDiameterMm: usesCopperSocketElbows(element.properties) ? visual.pipeDiameterMm : undefined,
      minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
      bendRadiusMm: resolveFieldPipeBendRadiusMm(visual.outerRadiusMm * 2, element.properties.bendRadiusFactor) });
    const lane = fittedLane(element, visual.lineKind, visual.outerRadiusMm, visual.pipeDiameterMm, nodes, visual.startConnection, visual.endConnection);
    if (!lane) return null;
    geometry = { radius: lane.radius, segments: lane.segments, bounds: lane.bounds, total: lane.total,
      startPoint: lane.start.point, endPoint: lane.end.point };
    retainLaneGeometry(key, geometry);
  }
  return { id: element.id, key: `${element.id}:${spec.lineKind}`, bundleId: spec.bundleId, service: spec.lineKind,
    radius: geometry.radius, segments: geometry.segments, bounds: geometry.bounds, total: geometry.total,
    start: { point: geometry.startPoint, connection: spec.startConnection }, end: { point: geometry.endPoint, connection: spec.endConnection } };
}

/**
 * Lanes for one element.
 *
 * Not safely cacheable on element identity plus connection sources: the context
 * also reaches `buildRefrigerantPipePhysicalPath`, which an inline branch kit
 * resolves against nearby runs. That memo was tried and reverted — it broke 20
 * cases in `networkPipeClearanceReuse.test.ts`.
 */
/**
 * A condensate drain is coordinated like any other service: its sloped
 * `routeNodes3d` centreline with the insulated radius. Its unit outlet reads as
 * a unit port so the drain stub and the refrigerant stubs leaving the SAME unit
 * get the usual shared-equipment adapter allowance.
 */
function condensateLane(element: HvacElement, nodes: Vec3[]): PipeLane[] {
  const properties = element.properties;
  const outer = typeof properties.outerDiameterMm === 'number' && Number.isFinite(properties.outerDiameterMm) ? properties.outerDiameterMm : 32;
  const insulation = typeof properties.insulationThicknessMm === 'number' && Number.isFinite(properties.insulationThicknessMm) ? properties.insulationThicknessMm : 0;
  const spec = readCondensatePipeSpec(element);
  const connection = (end: CondensateConnection | null | undefined): RefrigerantPipeConnection | null => end ? {
    connectionKind: end.kind === 'unit-drain' || end.kind === 'gully' ? 'unit-port' : 'field-pipe',
    sourceElementId: end.kind === 'unit-drain' ? end.unitId : end.kind === 'gully' ? end.gullyId : undefined,
    nodeId: end.kind === 'junction' ? end.nodeId : undefined,
    portPoint: end.point, direction: { x: 0, y: 0 }, elevationMm: end.z,
  } : null;
  const lane = makeLane(element, 'drain', outer / 2 + insulation, nodes, connection(spec?.drainStart), connection(spec?.drainEnd));
  if (lane) {
    lane.drainSockets = (['start', 'end'] as const).flatMap(end => {
      const binding = end === 'start' ? spec.drainStart : spec.drainEnd;
      if (binding?.kind !== 'junction' || !binding.nodeId) return [];
      const point = lane[end].point;
      return spec.fittings.filter(fitting => fitting.kind === 'wye'
        && Math.hypot(point.x - fitting.point.x, point.y - fitting.point.y) <= TOLERANCE_MM
        && Math.abs(point.z - fitting.point.z - fitting.outerDiameterMm / 2) <= TOLERANCE_MM)
        .map(fitting => ({ end, nodeId: binding.nodeId!, centre: fitting.point, radius: fitting.outerDiameterMm / 2 }));
    });
  }
  return lane ? [lane] : [];
}

function elementLanes(element: HvacElement, elements: HvacElement[]): PipeLane[] {

    const authored = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    if (element.type === 'condensate-pipe') return condensateLane(element, authored);
    if (element.type === 'refrigerant-pipe') {
      const lane = singlePhysicalLane(element, elements, authored);
      return lane ? [lane] : [];
    }
    if (element.type !== 'refrigerant-pipe-pair') return [];
    const visual = buildRefrigerantPipePairVisual(element, elements);
    const baseZ = element.elevation + (visual.gasLocalZMm + visual.liquidLocalZMm) / 2;
    const guide = authored.length >= 2 ? authored : visual.routePoints.map(point => ({ ...point, z: baseZ }));
    const vertical = guide.length >= 2 && guide.every(node => Math.hypot(node.x - guide[0]!.x, node.y - guide[0]!.y) <= 1e-6)
      && !visual.startBundleConnection && !visual.endBundleConnection;
    return (['gas', 'liquid'] as const).flatMap(service => {
      const gas = service === 'gas'; const radius = gas ? visual.gasOuterRadiusMm : visual.liquidOuterRadiusMm;
      const offset = element.elevation + (gas ? visual.gasLocalZMm : visual.liquidLocalZMm) - baseZ;
      const elevated = guide.map(node => ({ ...node, z: node.z + offset }));
      const start = bundleLineConnection(visual.startBundleConnection, service); const end = bundleLineConnection(visual.endBundleConnection, service);
      const nodes = vertical ? elevated.map(node => ({ ...node, x: node.x + (gas ? -1 : 1) * visual.centerSpacingMm / 2 }))
        : liftPipePlanRouteTo3d(gas ? visual.gasContinuousOuterPoints : visual.liquidContinuousOuterPoints, elevated, { startConnection: start, endConnection: end, outerDiameterMm: radius * 2,
          pipeDiameterMm: usesCopperSocketElbows(element.properties) ? (gas ? visual.gasPipeDiameterMm : visual.liquidPipeDiameterMm) : undefined,
          minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
          bendRadiusMm: resolveFieldPipeBendRadiusMm(radius * 2, element.properties.bendRadiusFactor) });
      const lane = fittedLane(element, service, radius, gas ? visual.gasPipeDiameterMm : visual.liquidPipeDiameterMm, nodes, start, end);
      return lane ? [lane] : [];
    });
}

function physicalLanes(elements: HvacElement[]): PipeLane[] {
  return elements.flatMap(element => elementLanes(element, elements));
}

export interface NetworkPipeLaneView {
  elementId: string;
  service: string;
  /** Insulated radius used by the clash check (socket cups included). */
  radiusMm: number;
  segments: Array<{ a: Vec3; b: Vec3 }>;
}

/**
 * Read-only copy of the physical centrelines the clash check measures, for
 * other services (condensate) that must coordinate with refrigerant runs.
 * Computed fresh per call; callers compute it once per planning run.
 */
export function listNetworkPipeLanes(scene: HvacElement[]): NetworkPipeLaneView[] {
  return physicalLanes(scene).map(lane => ({
    elementId: lane.id,
    service: lane.service,
    radiusMm: lane.radius,
    segments: lane.segments.map(segment => ({ a: { ...segment.a }, b: { ...segment.b } })),
  }));
}

const baselineCache = new WeakMap<HvacElement[], { signature: string; lanes: PipeLane[] }>();
function baselineLanes(scene: HvacElement[]): PipeLane[] {
  // Keep one baseline per scene array. The signature also detects legacy
  // in-place mutations and equipment/profile changes that affect healed ports;
  // reference equality alone is insufficient at the public API boundary.
  //
  // This serialization is expensive (4.97 ms per call at 24 elements, against
  // 288 calls in one branch-kit proposal) and an identity-based key was tried
  // and reverted: `networkPipeClearance.test.ts` > "rechecks an in-place changed
  // scene" fails, because a caller may mutate an element through `Object.assign`
  // and still expect a fresh classification. Cutting this cost means calling
  // `baselineLanes` fewer times, not weakening what it detects.
  const signature = JSON.stringify([getActivePipeRoutingSettings(), scene]);
  const cached = baselineCache.get(scene);
  if (cached?.signature === signature) return cached.lanes;
  const lanes = physicalLanes(scene);
  baselineCache.set(scene, { signature, lanes });
  return lanes;
}

function boundTogether(a: PipeLane, endA: 'start' | 'end', b: PipeLane, endB: 'start' | 'end'): boolean {
  if (a.service !== b.service) return false;
  const ca = a[endA].connection; const cb = b[endB].connection;
  if (distance(a[endA].point, b[endB].point) > TOLERANCE_MM) {
    if (a.service !== 'drain' || !ca?.nodeId || ca.nodeId !== cb?.nodeId) return false;
    const anchor = (lane: PipeLane, end: 'start' | 'end') => lane.drainSockets?.find(socket => socket.end === end && socket.nodeId === ca.nodeId)?.centre ?? lane[end].point;
    if (distance(anchor(a, endA), anchor(b, endB)) > TOLERANCE_MM) return false;
  }
  const sameSource = !ca?.sourceElementId || !cb?.sourceElementId || ca.sourceElementId === cb.sourceElementId;
  if (sameSource && ((ca?.nodeId && ca.nodeId === cb?.nodeId) || (ca?.portId && ca.portId === cb?.portId))) return true;
  const refersTo = (connection: RefrigerantPipeConnection | null, target: PipeLane) => connection?.connectionKind === 'field-pipe'
    && !!connection.sourceElementId && (connection.sourceElementId === target.id || connection.sourceElementId === target.bundleId);
  return refersTo(ca, b) || refersTo(cb, a);
}

function clipSegment(segment: Segment, minimum: number, maximum: number, radius: number): Segment | null {
  const from = Math.max(segment.from, minimum); const to = Math.min(segment.to, maximum);
  if (to - from <= EPS) return null;
  if (from === segment.from && to === segment.to) return segment;
  const a = lerp(segment.a, segment.b, (from - segment.from) / (segment.to - segment.from));
  const b = lerp(segment.a, segment.b, (to - segment.from) / (segment.to - segment.from));
  return { ...segment, a, b, from, to, bounds: boundsOf([a, b], radius) };
}

/** Finite socket allowance: only a straight, outward departure from the live
 * equipment port may cross its casing envelope. Later re-entry is checked. */
function equipmentSocketTrim(lane: PipeLane, body: DuctBox, end: 'start' | 'end',
  ports: ReadonlyMap<string, RefrigerantPipeBundleConnection>, elements: ReadonlyMap<string, HvacElement>): number {
  const connection = lane[end].connection;
  if (body.mark !== 'equipment casing' || connection?.connectionKind !== 'unit-port' || connection.sourceElementId !== body.elementId) return 0;
  const element = elements.get(body.elementId);
  if (!element) return 0;
  const drainPort = lane.service === 'drain' ? getIndoorUnitDrainPort(element) : null;
  if (drainPort) {
    const points = [lane.segments[0]!.a, ...lane.segments.map(segment => segment.b)];
    return condensateSocketExitLength(drainPort, body, lane.radius, end === 'start' ? points : points.reverse());
  }
  const refrigerantPort = lane.service !== 'drain' ? ports.get(body.elementId) : null;
  const gas = lane.service === 'gas';
  const point = refrigerantPort ? {
    ...(gas ? refrigerantPort.gasPoint : refrigerantPort.liquidPoint),
    z: gas ? refrigerantPort.gasElevationMm : refrigerantPort.liquidElevationMm,
  } : null;
  const direction = refrigerantPort ?
    (gas ? refrigerantPort.gasDirection : refrigerantPort.liquidDirection) ?? refrigerantPort.direction : null;
  if (!point || !direction || distance(point, lane[end].point) > 0.5) return 0;
  const length = Math.hypot(direction.x, direction.y);
  if (length < EPS) return 0;
  const normal = { x: direction.x / length, y: direction.y / length, z: 0 };
  const axes = [body.axisT, body.axisN, body.axisU];
  const halves = [body.halfLength, body.halfWidth, body.halfHeight];
  let exit = Number.POSITIVE_INFINITY;
  for (let i = 0; i < axes.length; i += 1) {
    const coordinate = dot(subtract(point, body.centre), axes[i]!);
    const extent = halves[i]! + lane.radius;
    if (Math.abs(coordinate) > extent + TOLERANCE_MM) return 0;
    const advance = dot(normal, axes[i]!);
    if (Math.abs(advance) > EPS) exit = Math.min(exit, (Math.sign(advance) * extent - coordinate) / advance);
  }
  if (!Number.isFinite(exit) || exit < 0) return 0;
  const oriented = end === 'start' ? lane.segments : [...lane.segments].reverse().map(segment => ({
    ...segment, a: segment.b, b: segment.a, from: lane.total - segment.to, to: lane.total - segment.from,
  }));
  let permitted = 0;
  for (const segment of oriented) {
    const delta = subtract(segment.b, segment.a);
    const segmentLength = distance(segment.a, segment.b);
    if (dot(delta, normal) < segmentLength * (1 - 1e-8)) break;
    permitted = Math.min(segment.to, exit + TOLERANCE_MM);
    if (segment.to >= exit) break;
  }
  return permitted;
}

/** Subtract only collinear geometry already present in the baseline, preserving
 * unchanged contacts while still checking extensions and moved intersections. */
function unpreservedSegments(segment: Segment, lane: PipeLane, predecessors: readonly PipeLane[]): Segment[] {
  if (predecessors.some(old => old.segments === lane.segments && old.radius >= lane.radius - TOLERANCE_MM)) return [];
  const length = segment.to - segment.from;
  const delta = subtract(segment.b, segment.a);
  const normSquared = dot(delta, delta);
  const coverage: Array<[number, number]> = [];
  for (const old of predecessors) {
    if (old.radius < lane.radius - TOLERANCE_MM) continue;
    for (const previous of old.segments) {
      const oldDelta = subtract(previous.b, previous.a);
      if (Math.abs(dot(delta, oldDelta)) / Math.max(EPS, Math.sqrt(normSquared * dot(oldDelta, oldDelta))) < 1 - 1e-8) continue;
      const projectT = (point: Vec3) => dot(subtract(point, segment.a), delta) / Math.max(EPS, normSquared);
      const ta = projectT(previous.a); const tb = projectT(previous.b);
      if (distance(previous.a, lerp(segment.a, segment.b, ta)) > TOLERANCE_MM
        || distance(previous.b, lerp(segment.a, segment.b, tb)) > TOLERANCE_MM) continue;
      const low = Math.max(0, Math.min(ta, tb)); const high = Math.min(1, Math.max(ta, tb));
      if (high > low) coverage.push([low, high]);
    }
  }
  if (!coverage.length) return [segment];
  coverage.sort((a, b) => a[0] - b[0]);
  const result: Segment[] = [];
  let cursor = 0;
  const append = (from: number, to: number) => {
    const clipped = clipSegment(segment, segment.from + from * length, segment.from + to * length, lane.radius);
    if (clipped) result.push(clipped);
  };
  for (const [low, high] of coverage) {
    if (low > cursor + EPS) append(cursor, low);
    cursor = Math.max(cursor, high);
  }
  if (cursor < 1 - EPS) append(cursor, 1);
  return result;
}

function solidGeometryKey(body: DuctBox): string {
  return JSON.stringify([body.elementId, body.mark, body.centre, body.axisT, body.axisN, body.axisU,
    body.halfLength, body.halfWidth, body.halfHeight]);
}

interface AdapterRegion { aEnd: 'start' | 'end'; bEnd: 'start' | 'end'; aLength: number; bLength: number }

// Segment arrays are private, immutable products of physical lane construction.
// Their identity survives candidate ID changes but never an actual geometry edit.
// Weak identities do not retain evicted lane geometry; the separate result caches
// are bounded by both entries and retained contact witnesses.
const segmentIdentities = new WeakMap<Segment[], number>();
let nextSegmentIdentity = 0;
function segmentIdentity(segments: Segment[]): number {
  let identity = segmentIdentities.get(segments);
  if (identity === undefined) {
    identity = ++nextSegmentIdentity;
    segmentIdentities.set(segments, identity);
  }
  return identity;
}
function lanePairGeometryKey(a: PipeLane, b: PipeLane): string {
  return `${segmentIdentity(a.segments)}:${segmentIdentity(b.segments)}:${a.radius}:${b.radius}`;
}
const adapterRegionsCache = new Map<string, AdapterRegion[]>();
const MAX_ADAPTER_CACHE_ENTRIES = 512;

function cachedEquipmentAdapters(a: PipeLane, b: PipeLane): AdapterRegion[] {
  if (a.service === b.service) return [];
  const endpointPairs: number[] = [];
  const ends = ['start', 'end'] as const;
  for (let ai = 0; ai < ends.length; ai += 1) for (let bi = 0; bi < ends.length; bi += 1) {
    const ca = a[ends[ai]!].connection; const cb = b[ends[bi]!].connection;
    if (ca?.connectionKind !== 'unit-port' || cb?.connectionKind !== 'unit-port'
      || !ca.sourceElementId || ca.sourceElementId !== cb.sourceElementId
      || distance(a[ends[ai]!].point, b[ends[bi]!].point) >= a.radius + b.radius - TOLERANCE_MM) continue;
    // Record the live binding relationship, never its serialized element ID.
    endpointPairs.push(ai, bi, ca.direction.x, ca.direction.y, cb.direction.x, cb.direction.y);
  }
  if (!endpointPairs.length) return [];
  const key = `${lanePairGeometryKey(a, b)}:${Math.max(0, getActivePipeRoutingSettings().minimumPortStubMm)}:${endpointPairs.join(':')}`;
  const cached = adapterRegionsCache.get(key);
  if (cached) {
    adapterRegionsCache.delete(key);
    adapterRegionsCache.set(key, cached);
    return cached;
  }
  const regions = sharedEquipmentAdapters(a, b);
  adapterRegionsCache.set(key, regions);
  if (adapterRegionsCache.size > MAX_ADAPTER_CACHE_ENTRIES) adapterRegionsCache.delete(adapterRegionsCache.keys().next().value!);
  return regions;
}

interface ContactWitness {
  sa: Segment;
  sb: Segment;
  a: Vec3;
  b: Vec3;
  distance: number;
  aStation: number;
  bStation: number;
}
const contactWitnessCache = new Map<string, ContactWitness[]>();
const MAX_CONTACT_CACHE_ENTRIES = 512;
const MAX_CONTACT_CACHE_WITNESSES = 32768;
const MAX_CONTACT_WITNESSES_PER_PAIR = 4096;
let retainedContactWitnesses = 0;

function visitLaneContacts(a: PipeLane, b: PipeLane, trimA: { start: number; end: number }, trimB: { start: number; end: number },
  visit: (contact: ContactWitness) => boolean): boolean {
  const key = `${lanePairGeometryKey(a, b)}:${trimA.start}:${trimA.end}:${trimB.start}:${trimB.end}`;
  const cached = contactWitnessCache.get(key);
  if (cached) {
    contactWitnessCache.delete(key);
    contactWitnessCache.set(key, cached);
    for (const contact of cached) if (visit(contact)) return true;
    return false;
  }
  const required = a.radius + b.radius;
  let witnesses: ContactWitness[] | null = [];
  // Endpoint trimming is constant for this lane pair. Resolve it once while
  // retaining the original segment/contact ordering and exact closest points.
  const clippedB = b.segments
    .map(segment => clipSegment(segment, trimB.start, trimB.end, b.radius))
    .filter((segment): segment is Segment => segment !== null && overlaps(segment.bounds, a.bounds));
  for (const rawA of a.segments) {
    const sa = clipSegment(rawA, trimA.start, trimA.end, a.radius); if (!sa) continue;
    if (!overlaps(sa.bounds, b.bounds)) continue;
    for (const sb of clippedB) {
      if (!overlaps(sa.bounds, sb.bounds)) continue;
      const nearest = closest(sa.a, sa.b, sb.a, sb.b);
      if (nearest.distance >= required - TOLERANCE_MM) continue;
      // Endpoint witnesses detect new extensions of existing parallel overlaps.
      const contacts = [nearest,
        ...[sa.a, sa.b].map(p => { const q = project(p, sb.a, sb.b); return { a: p, b: q, distance: distance(p, q) }; }),
        ...[sb.a, sb.b].map(q => { const p = project(q, sa.a, sa.b); return { a: p, b: q, distance: distance(p, q) }; })];
      for (const contact of contacts) {
        if (contact.distance >= required - TOLERANCE_MM) continue;
        const witness = { sa, sb, ...contact,
          aStation: sa.from + distance(sa.a, contact.a), bStation: sb.from + distance(sb.a, contact.b) };
        if (witnesses) {
          if (witnesses.length < MAX_CONTACT_WITNESSES_PER_PAIR) witnesses.push(witness);
          else witnesses = null;
        }
        // An existence query may stop after a proven new clash. Never retain a
        // partially visited pair as though it were a complete contact result.
        if (visit(witness)) return true;
      }
    }
  }
  // Very dense geometry still receives every exact check; it is simply streamed
  // without retention once this pair's memory allowance has been exhausted.
  if (!witnesses) return false;
  contactWitnessCache.set(key, witnesses);
  retainedContactWitnesses += witnesses.length;
  while (contactWitnessCache.size > MAX_CONTACT_CACHE_ENTRIES || retainedContactWitnesses > MAX_CONTACT_CACHE_WITNESSES) {
    const oldest = contactWitnessCache.entries().next().value!;
    contactWitnessCache.delete(oldest[0]);
    retainedContactWitnesses -= oldest[1].length;
  }
  return false;
}

/** The full short gather from close manufacturer ports belongs to the adapter,
 * including the fan-out AFTER its protected straight. End the exception as soon
 * as both services clear the other's actual adapter envelope. Never extend it
 * across a long field span, a reversal, or an unrelated piece of equipment. */
function sharedEquipmentAdapters(a: PipeLane, b: PipeLane): AdapterRegion[] {
  if (a.service === b.service) return [];
  const required = a.radius + b.radius;
  const stub = Math.max(0, getActivePipeRoutingSettings().minimumPortStubMm);
  const searchLength = stub + required * 4;
  const regions: AdapterRegion[] = [];
  for (const aEnd of ['start', 'end'] as const) for (const bEnd of ['start', 'end'] as const) {
    const ca = a[aEnd].connection; const cb = b[bEnd].connection;
    if (ca?.connectionKind !== 'unit-port' || cb?.connectionKind !== 'unit-port'
      || !ca.sourceElementId || ca.sourceElementId !== cb.sourceElementId
      || distance(a[aEnd].point, b[bEnd].point) >= required - TOLERANCE_MM) continue;
    const region: AdapterRegion = { aEnd, bEnd, aLength: stub, bLength: stub };
    regions.push(region);
    const directionLengthA = Math.hypot(ca.direction.x, ca.direction.y);
    const directionLengthB = Math.hypot(cb.direction.x, cb.direction.y);
    if (directionLengthA < EPS || directionLengthB < EPS) continue;
    const axis = { x: ca.direction.x / directionLengthA, y: ca.direction.y / directionLengthA, z: 0 };
    if ((axis.x * cb.direction.x + axis.y * cb.direction.y) / directionLengthB < 0.98) continue;
    const origin = lerp(a[aEnd].point, b[bEnd].point, 0.5);
    const forward = (point: Vec3) => dot(subtract(point, origin), axis);
    const prefix = (lane: PipeLane, end: 'start' | 'end') => {
      const oriented = end === 'start' ? lane.segments : [...lane.segments].reverse().map(segment => ({ ...segment,
        a: segment.b, b: segment.a, from: lane.total - segment.to, to: lane.total - segment.from }));
      const result: Segment[] = [];
      for (const segment of oriented) {
        const clipped = clipSegment(segment, 0, searchLength, lane.radius);
        if (!clipped) break;
        // An adapter can fan out or change level while advancing away from its
        // port. A subsequent return or perpendicular field turn ends this scan.
        if (forward(clipped.b) <= forward(clipped.a) + EPS) break;
        result.push(clipped);
      }
      return result;
    };
    const prefixA = prefix(a, aEnd); const prefixB = prefix(b, bEnd);
    if (!prefixA.length || !prefixB.length) continue;
    const pointAtForward = (segments: Segment[], station: number) => {
      const segment = segments.find(candidate => forward(candidate.a) <= station + EPS && forward(candidate.b) >= station - EPS);
      if (!segment) return null;
      const t = clamp((station - forward(segment.a)) / (forward(segment.b) - forward(segment.a)));
      return { point: lerp(segment.a, segment.b, t), length: segment.from + t * (segment.to - segment.from) };
    };
    const start = Math.max(forward(a[aEnd].point), forward(b[bEnd].point)) + stub;
    const limit = Math.min(forward(prefixA.at(-1)!.b), forward(prefixB.at(-1)!.b));
    const clearAt = (station: number) => {
      const pa = pointAtForward(prefixA, station); const pb = pointAtForward(prefixB, station);
      if (!pa || !pb) return null;
      const gapA = Math.min(...prefixB.map(segment => distance(pa.point, project(pa.point, segment.a, segment.b))));
      const gapB = Math.min(...prefixA.map(segment => distance(pb.point, project(pb.point, segment.a, segment.b))));
      return gapA >= required + TOLERANCE_MM && gapB >= required + TOLERANCE_MM ? { aLength: pa.length, bLength: pb.length } : null;
    };
    let previous = start;
    for (let station = start; station <= limit + 4; station += 4) {
      const current = Math.min(station, limit);
      const cleared = clearAt(current);
      if (cleared) {
        let lo = previous; let hi = current;
        for (let step = 0; step < 12; step += 1) {
          const middle = (lo + hi) / 2;
          if (clearAt(middle)) hi = middle; else lo = middle;
        }
        Object.assign(region, clearAt(hi) ?? cleared);
        break;
      }
      if (current >= limit) break;
      previous = current;
    }
  }
  return regions;
}

/** Pipe-body interference screening, not a full BIM collision proof. This checks
 * insulated tube envelopes, not kit bodies, buildings, supports or service gaps.
 * Closely spaced adapters serving the SAME equipment are exempt through their
 * protected straights and bounded initial fan-out; unrelated pipes are checked
 * there too. A pair that does not separate keeps only its straight exemption.
 * Existing contacts retained at the same position, service and radius are not
 * new, including physical host portions retained under split replacement IDs. */
function findNetworkPipeClashes(scene: HvacElement[], proposed: HvacElement[], removedIds: string[], stopAtFirst: boolean): NetworkPipeClash[] {
  if (!proposed.length) return [];
  const proposedIds = new Set(proposed.map(element => element.id)); const removed = new Set(removedIds);
  const overrides = new Map(proposed.map(element => [element.id, element]));
  const afterElements = scene.filter(element => !removed.has(element.id) && !proposedIds.has(element.id)).concat([...overrides.values()]);
  const after = physicalLanes(afterElements).sort((a, b) => a.bounds.minX - b.bounds.minX || a.key.localeCompare(b.key));
  // Most trial routes have no nonexempt contact. Only those that do need the
  // old physical geometry and its mutation-safe full-scene signature.
  let baseline: { lanes: PipeLane[]; byKey: Map<string, PipeLane> } | undefined;
  const previousByKey = new Map<string, PipeLane[]>();
  const predecessors = (lane: PipeLane): PipeLane[] => {
    const cached = previousByKey.get(lane.key);
    if (cached) return cached;
    if (!baseline) {
      const lanes = baselineLanes(scene);
      baseline = { lanes, byKey: new Map(lanes.map(previous => [previous.key, previous])) };
    }
    const old = baseline.byKey.get(lane.key);
    const previous = old ? [old] : baseline.lanes.filter(prior => removed.has(prior.id)
      && prior.service === lane.service && overlaps(prior.bounds, lane.bounds));
    previousByKey.set(lane.key, previous);
    return previous;
  };
  const preservationSegments = new Map<string, WeakMap<Segment, Array<{ key: string; segments: Segment[] }>>>();
  const preservedAt = (lane: PipeLane, segment: Segment, point: Vec3): string[] => {
    let laneCandidates = preservationSegments.get(lane.key);
    if (!laneCandidates) {
      laneCandidates = new WeakMap();
      preservationSegments.set(lane.key, laneCandidates);
    }
    let candidates = laneCandidates.get(segment);
    if (!candidates) {
      const direction = subtract(segment.b, segment.a); const directionLength = Math.hypot(direction.x, direction.y, direction.z);
      candidates = predecessors(lane).flatMap(previous => {
        if (previous.radius < lane.radius - TOLERANCE_MM) return [];
        const segments = previous.segments.filter(old => {
          if (!overlaps(old.bounds, segment.bounds)) return false;
          const oldDirection = subtract(old.b, old.a); const length = Math.hypot(oldDirection.x, oldDirection.y, oldDirection.z);
          return Math.abs(dot(direction, oldDirection)) / Math.max(EPS, directionLength * length) > 1 - 1e-8;
        });
        return segments.length ? [{ key: previous.key, segments }] : [];
      });
      laneCandidates.set(segment, candidates);
    }
    return candidates.filter(previous => previous.segments.some(old => distance(point, project(point, old.a, old.b)) <= TOLERANCE_MM))
      .map(previous => previous.key);
  };
  const found = new Map<string, NetworkPipeClash>();
  for (let i = 0; i < after.length; i += 1) {
    const a = after[i]!;
    for (let j = i + 1; j < after.length && after[j]!.bounds.minX <= a.bounds.maxX; j += 1) {
      const b = after[j]!;
      if ((!proposedIds.has(a.id) && !proposedIds.has(b.id)) || !overlaps(a.bounds, b.bounds)) continue;
      const required = a.radius + b.radius;
      const adapters = cachedEquipmentAdapters(a, b);
      const trimA = { start: 0, end: a.total }; const trimB = { start: 0, end: b.total };
      for (const endA of ['start', 'end'] as const) for (const endB of ['start', 'end'] as const) {
        if (!boundTogether(a, endA, b, endB)) continue;
        let jointReach = required;
        if (a.service === 'drain' && b.service === 'drain') {
          const heading = (lane: PipeLane, end: 'start' | 'end') => {
            const segment = end === 'start' ? lane.segments[0]! : lane.segments.at(-1)!;
            const delta = end === 'start' ? subtract(segment.b, segment.a) : subtract(segment.a, segment.b);
            const magnitude = Math.sqrt(dot(delta, delta));
            return { x: delta.x / magnitude, y: delta.y / magnitude, z: delta.z / magnitude };
          };
          // Two declared wye arms diverging by theta cease touching at
          // station (r1+r2)/(2*sin(theta/2)); cap the allowance for a malformed
          // parallel junction so a long duplicated run is still a clash.
          jointReach = required / Math.max(0.25, Math.sqrt(Math.max(0, 2 - 2 * dot(heading(a, endA), heading(b, endB)))));
        }
        trimA[endA] = endA === 'start' ? jointReach : a.total - jointReach;
        trimB[endB] = endB === 'start' ? jointReach : b.total - jointReach;
      }
      let newDistance = Number.POSITIVE_INFINITY;
      visitLaneContacts(a, b, trimA, trimB, contact => {
        if (adapters.some(adapter => (adapter.aEnd === 'start' ? contact.aStation : a.total - contact.aStation) <= adapter.aLength + TOLERANCE_MM
          && (adapter.bEnd === 'start' ? contact.bStation : b.total - contact.bStation) <= adapter.bLength + TOLERANCE_MM)) return false;
        // Preservation belongs to this candidate scene, not the geometry cache:
        // identical contacts may be existing overlaps or newly introduced ones.
        const oldA = preservedAt(a, contact.sa, contact.a); const oldB = preservedAt(b, contact.sb, contact.b);
        if (oldA.some(key => oldB.some(other => key !== other))) return false;
        newDistance = Math.min(newDistance, contact.distance);
        return stopAtFirst;
      });
      if (Number.isFinite(newDistance)) {
        const ids = [a.id, b.id].sort() as [string, string]; const key = ids.join('\u0000');
        if (stopAtFirst) return [{ elementIds: ids, distanceMm: newDistance, requiredMm: required }];
        const previous = found.get(key);
        if (!previous || required - newDistance > previous.requiredMm - previous.distanceMm) found.set(key, { elementIds: ids, distanceMm: newDistance, requiredMm: required });
      }
    }
  }
  // All services share the same physical solid envelopes, including equipment
  // and terminal faces/necks. A screen-space crossing alone is not a clash.
  const solids = solidBoxesInScene(afterElements, getActiveDuctSettings());
  if (solids.length) {
    const oldSolids = new Set(solidBoxesInScene(scene, getActiveDuctSettings()).map(solidGeometryKey));
    const preservedBodies = new Set(solids.filter(body => oldSolids.has(solidGeometryKey(body))));
    const equipmentIds = new Set(solids.filter(body => body.mark === 'equipment casing').map(body => body.elementId));
    const equipment = afterElements.filter(element => equipmentIds.has(element.id));
    const ports = new Map(getRefrigerantPipeBundleSnapTargets(equipment).filter(port => port.connectionKind === 'unit-port' && port.sourceElementId)
      .map(port => [port.sourceElementId!, port]));
    const elementsById = new Map(afterElements.map(element => [element.id, element]));
    const clashWith = (lane: PipeLane, body: DuctBox): number => {
      let nearest = Number.POSITIVE_INFINITY;
      if (!overlaps(lane.bounds, body.bounds)) return nearest;
      const trimStart = equipmentSocketTrim(lane, body, 'start', ports, elementsById);
      const trimEnd = lane.total - equipmentSocketTrim(lane, body, 'end', ports, elementsById);
      for (const raw of lane.segments) {
        const clipped = clipSegment(raw, trimStart, trimEnd, lane.radius);
        if (!clipped || !overlaps(clipped.bounds, body.bounds)) continue;
        const rawHit = segmentBoxDistance(clipped.a, clipped.b, body).distance;
        if (rawHit >= lane.radius - TOLERANCE_MM) continue;
        const old = preservedBodies.has(body) ? predecessors(lane) : [];
        for (const segment of unpreservedSegments(clipped, lane, old)) {
          const hit = segment === clipped ? rawHit : segmentBoxDistance(segment.a, segment.b, body).distance;
          if (hit < lane.radius - TOLERANCE_MM) nearest = Math.min(nearest, hit);
        }
      }
      return nearest;
    };
    for (const lane of after) {
      for (const body of solids) {
        if ((!proposedIds.has(lane.id) && !proposedIds.has(body.elementId)) || body.elementId === lane.id) continue;
        const hit = clashWith(lane, body);
        if (!Number.isFinite(hit)) continue;
        const ids = [lane.id, body.elementId].sort() as [string, string];
        if (stopAtFirst) return [{ elementIds: ids, distanceMm: hit, requiredMm: lane.radius }];
        const key = ids.join('\u0000');
        const previous = found.get(key);
        if (!previous || lane.radius - hit > previous.requiredMm - previous.distanceMm) found.set(key, { elementIds: ids, distanceMm: hit, requiredMm: lane.radius });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.elementIds[0].localeCompare(b.elementIds[0]) || a.elementIds[1].localeCompare(b.elementIds[1]));
}

/** Full, deterministic reporting of all new pipe-body clashes. */
export function findNewNetworkPipeClashes(scene: HvacElement[], proposed: HvacElement[], removedIds: string[] = []): NetworkPipeClash[] {
  return findNetworkPipeClashes(scene, proposed, removedIds, false);
}

/** Exact rejection predicate: stop only when a new clash has been established.
 * A false result always evaluates the complete applicable collision search. */
export function hasNewNetworkPipeClash(scene: HvacElement[], proposed: HvacElement[], removedIds: string[] = []): boolean {
  return findNetworkPipeClashes(scene, proposed, removedIds, true).length > 0;
}
