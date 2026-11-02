/**
 * What the condensate generator routes through: drain sources, terminations,
 * the ceiling-void envelope, plan obstacles, walls and the physical centrelines
 * of the other services it must coordinate with.
 *
 * The envelope is explicit because the drawing model has no storeys or beams:
 * the ceiling plane comes from the bottom of ceiling cassettes (they sit in the
 * ceiling), falling back to ducted-unit bottoms and room ceiling heights; the
 * soffit comes from the routing ceiling limit. Both are reported and can be
 * overridden in the condensate settings.
 */
import type { HvacElement, Point2D, Room, Wall } from '../../../../types';
import { buildingCeiling, buildingSoffitMm } from '../buildingSection';
import { getActiveDuctSettings } from '../duct/ductSettings';
import { solidBoxesInScene, type DuctBox } from '../duct/ductVolumes';
import { listNetworkPipeLanes, type NetworkPipeLaneView } from '../networkPipeClearance';
import type { PipeRoutingSettings } from '../pipeRoutingSettings';

import { closestOnSegment, distance, normalize, sub } from './condensateGeometry';
import { CONDENSATE_INDOOR_UNIT_TYPES, getIndoorUnitDrainPort, unitFootprintBoundsMm, type IndoorDrainPort } from './condensatePorts';
import type { CondensateDesignSettings } from './condensateSettings';
import {
  CONDENSATE_TUNDISH_HEIGHT_MM,
  condensateInsulatedRadiusMm,
  getCondensateOwnership,
  isCondensateGully,
  isCondensatePipe,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensateTerminalTrap,
  type CondensateTerminationKind,
  type Point3,
} from './condensateTypes';
import { refrigerantHopStretches } from './refrigerantHopProposal';

export interface CondensateEnvelope {
  ceilingPlaneMm: number;
  soffitMm: number;
  /** Lowest centreline allowed in the void, before the pipe radius. */
  voidFloorMm: number;
  /** Highest centreline allowed in the void, before the pipe radius. */
  voidTopMm: number;
  derivation: string;
}

export interface CondensateSink {
  gullyId: string;
  label: string;
  kind: CondensateTerminationKind;
  trap: CondensateTerminalTrap;
  /** Plan point the network must reach. */
  point: Point2D;
  /** Centreline level of the network's final point (drop bottom / stack branch / penetration). */
  terminalZ: number;
  /** Minimum vertical drop between the last horizontal node and the terminal point. */
  minimumDropMm: number;
  maxConnectedCapacityKw: number | null;
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  /** Outward wall normal for an external discharge. */
  wallNormal?: Point2D;
}

export interface PlanObstacle {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** Clearance applies (equipment) or the raw box is used (the source unit's own body). */
  kind: 'equipment' | 'source-body' | 'stack';
  /** A duct or air terminal: a drain high enough may pass over it. A unit's casing keeps its access. */
  crossable?: boolean;
  /** A branch kit: a drain may pass under it (or over it), clear of its height by the refrigerant gap. */
  passableUnder?: boolean;
}

export interface WallBarrier {
  id: string;
  a: Point2D;
  b: Point2D;
  thicknessMm: number;
}

export interface ServiceSegment {
  elementId: string;
  service: string;
  a: Point3;
  b: Point3;
  radiusMm: number;
  /** Units this service line is connected to (its own port stubs share their connection zone). */
  connectedUnitIds: string[];
  /** A refrigerant line: where on its plan a hop over a drain can stand (`refrigerantHopStretches`). */
  hopStretches?: ReadonlyArray<{ a: Point2D; b: Point2D }>;
}

/** Plan radius around a drain outlet where the unit's own pipework is exempt from coordination. */
export const UNIT_CONNECTION_ZONE_MM = 550;

/** Plan margin past both radii within which a run is taken to pass over another (mm). */
const RUN_OVER_MARGIN_MM = 10;

/** Where along a stretch (mm from `a`) a segment comes within `reach` of it in plan: its distance there is convex. */
function stretchWithinReach(a: Point2D, b: Point2D, c: Point2D, d: Point2D, reach: number): [number, number] | null {
  const length = distance(a, b);
  const at = (t: number) => ({ x: a.x + (b.x - a.x) * t / length, y: a.y + (b.y - a.y) * t / length });
  const gap = (t: number) => distance(at(t), closestOnSegment(at(t), c, d).point);
  let lo = 0;
  let hi = length;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (gap(m1) <= gap(m2)) hi = m2; else lo = m1;
  }
  const nearest = (lo + hi) / 2;
  if (gap(nearest) >= reach) return null;
  const edge = (inside: number, outside: number) => {
    if (gap(outside) < reach) return outside;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const mid = (inside + outside) / 2;
      if (gap(mid) < reach) inside = mid; else outside = mid;
    }
    return inside;
  };
  return [edge(nearest, 0), edge(nearest, length)];
}

/** A line's hop stretches less where another run passes over it in plan: a liquid dipped under its gas cannot rise into it. */
function clearOfRunsOver(stretches: ReadonlyArray<{ a: Point2D; b: Point2D; z: number }>, lane: NetworkPipeLaneView,
  lanes: readonly NetworkPipeLaneView[]): Array<{ a: Point2D; b: Point2D }> {
  const clear: Array<{ a: Point2D; b: Point2D }> = [];
  for (const stretch of stretches) {
    const length = distance(stretch.a, stretch.b);
    const cuts: Array<[number, number]> = [];
    for (const other of lanes) {
      if (other.elementId === lane.elementId || other.service === 'drain') continue;
      const reach = lane.radiusMm + other.radiusMm + RUN_OVER_MARGIN_MM;
      for (const segment of other.segments) {
        if (Math.max(segment.a.z, segment.b.z) <= stretch.z + 1) continue;
        if (Math.min(segment.a.x, segment.b.x) - reach > Math.max(stretch.a.x, stretch.b.x)
          || Math.max(segment.a.x, segment.b.x) + reach < Math.min(stretch.a.x, stretch.b.x)
          || Math.min(segment.a.y, segment.b.y) - reach > Math.max(stretch.a.y, stretch.b.y)
          || Math.max(segment.a.y, segment.b.y) + reach < Math.min(stretch.a.y, stretch.b.y)) continue;
        const span = length > 1 ? stretchWithinReach(stretch.a, stretch.b, segment.a, segment.b, reach) : null;
        if (span) cuts.push(span);
      }
    }
    cuts.sort((left, right) => left[0] - right[0]);
    let from = 0;
    const keep = (to: number) => {
      if (to - from < 1) return;
      const point = (t: number) => ({ x: stretch.a.x + (stretch.b.x - stretch.a.x) * t / length, y: stretch.a.y + (stretch.b.y - stretch.a.y) * t / length });
      clear.push({ a: point(from), b: point(to) });
    };
    for (const [start, end] of cuts) {
      if (start > from) keep(start);
      from = Math.max(from, end);
    }
    keep(length);
  }
  return clear;
}

/** Units a refrigerant element is welded to, read from its connection records. */
export function connectedUnitIdsOf(element: HvacElement | undefined): string[] {
  if (!element) return [];
  const ids = new Set<string>();
  for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
    const connection = element.properties[key] as Record<string, unknown> | undefined;
    if (!connection || typeof connection !== 'object') continue;
    for (const field of ['sourceElementId', 'gasSourceElementId', 'liquidSourceElementId']) {
      if (typeof connection[field] === 'string') ids.add(connection[field] as string);
    }
  }
  return [...ids];
}

export interface CondensateEnvironment {
  settings: CondensateDesignSettings;
  envelope: CondensateEnvelope;
  sources: IndoorDrainPort[];
  sinks: CondensateSink[];
  obstacles: PlanObstacle[];
  /** Insulated physical bodies shared with the final coordination check. */
  solids: DuctBox[];
  walls: WallBarrier[];
  services: ServiceSegment[];
  /** Units whose drains belong to a locked / hand-edited network; never regenerated. */
  protectedUnitIds: Set<string>;
  /** Existing generated condensate pipes this run may replace. */
  replaceableElementIds: string[];
  /** Units excluded from the run and why. */
  skipped: Array<{ unitId: string; reason: string }>;
}

export interface CondensateEnvironmentOptions {
  settings: CondensateDesignSettings;
  routingSettings: Pick<PipeRoutingSettings, 'ceilingLimitMm' | 'floorLimitMm'>;
  walls?: readonly Wall[];
  rooms?: readonly Room[];
  unitIds?: readonly string[];
  gullyIds?: readonly string[];
  /**
   * A network being re-solved by a micro-edit: its own pipes are replaceable
   * (not protected by the hand-edit / retain policy) and are not obstacles.
   */
  editNetworkId?: string;
}

export function deriveCondensateEnvelope(
  scene: readonly HvacElement[],
  settings: CondensateDesignSettings,
  routingSettings: Pick<PipeRoutingSettings, 'ceilingLimitMm'>,
  rooms: readonly Room[] = [],
): CondensateEnvelope {
  const { ceilingMm: ceilingPlane, derivation } = settings.ceilingPlaneMm !== null
    ? { ceilingMm: settings.ceilingPlaneMm, derivation: 'ceiling plane from condensate settings' }
    : buildingCeiling(scene, rooms);
  const soffit = buildingSoffitMm(routingSettings, settings.soffitMm);
  const soffitNote = settings.soffitMm !== null ? 'soffit from condensate settings' : 'soffit = routing ceiling limit';
  const voidFloor = ceilingPlane + settings.envelopeClearanceMm;
  const voidTop = Math.max(voidFloor, soffit - settings.envelopeClearanceMm);
  return {
    ceilingPlaneMm: ceilingPlane,
    soffitMm: soffit,
    voidFloorMm: voidFloor,
    voidTopMm: voidTop,
    derivation: `${derivation}; ${soffitNote}`,
  };
}

function nearestWallNormal(point: Point2D, walls: readonly Wall[], wallId?: string): { normal: Point2D; face: Point2D } | null {
  let best: { distance: number; normal: Point2D; face: Point2D } | null = null;
  for (const wall of walls) {
    if (wallId && wall.id !== wallId) continue;
    const { point: closest } = closestOnSegment(point, wall.startPoint, wall.endPoint);
    const d = distance(point, closest);
    if (best && d >= best.distance) continue;
    // Outward = from the interior point through the wall centreline.
    const normal = normalize(sub(closest, point));
    if (normal.x === 0 && normal.y === 0) continue;
    best = { distance: d, normal, face: closest };
  }
  return best ? { normal: best.normal, face: best.face } : null;
}

export function buildCondensateSink(element: HvacElement, settings: CondensateDesignSettings, walls: readonly Wall[]): CondensateSink {
  const spec = readCondensateGullySpec(element);
  const bounds = unitFootprintBoundsMm(element);
  let point = spec.connectionPoint;
  let terminalZ = spec.inletElevationMm;
  let minimumDropMm = 0;
  let wallNormal: Point2D | undefined;
  if (spec.terminationKind === 'floor-gully') {
    // The drop discharges an air break above the receptor's flood rim.
    const receptor = spec.terminalTrap === 'tundish' ? CONDENSATE_TUNDISH_HEIGHT_MM : 0;
    terminalZ = spec.inletElevationMm + receptor + Math.max(spec.airBreakMm, settings.airBreakMm);
  } else if (spec.terminationKind === 'stack-connection') {
    // A waterless valve sits vertically above the branch socket.
    minimumDropMm = spec.terminalTrap === 'hepvo' ? 200 : spec.terminalTrap === 'p-trap' ? 150 : 0;
  } else {
    const wall = nearestWallNormal(point, walls, element.wallId);
    if (wall) {
      wallNormal = wall.normal;
      point = wall.face;
    }
  }
  return {
    gullyId: element.id,
    label: element.label || element.id,
    kind: spec.terminationKind,
    trap: spec.terminalTrap,
    point,
    terminalZ,
    minimumDropMm,
    maxConnectedCapacityKw: spec.maxConnectedCapacityKw,
    boundsMm: bounds,
    ...(wallNormal ? { wallNormal } : {}),
  };
}

function isProtectedCondensatePipe(element: HvacElement): boolean {
  const spec = readCondensatePipeSpec(element);
  if (spec.locked) return true;
  const owner = getCondensateOwnership(element);
  return !owner || owner.editPolicy === 'retain';
}

/**
 * Generated, unprotected condensate pipes a run with this scope will replace:
 * networks draining an in-scope unit, or (when terminations are scoped)
 * ending at an in-scope termination. A drawing-wide run replaces them all.
 */
function replaceableCondensatePipeIdsFor(
  scene: readonly HvacElement[],
  sourceIds: ReadonlySet<string>,
  unitScope: ReadonlySet<string> | null,
  gullyScope: ReadonlySet<string> | null,
): string[] {
  // An explicit empty unit selection is not drawing scope, even if a selected
  // gully happens to receive other units' existing networks.
  if (unitScope && sourceIds.size === 0) return [];
  const ids: string[] = [];
  for (const element of scene) {
    if (!isCondensatePipe(element) || isProtectedCondensatePipe(element)) continue;
    const owner = getCondensateOwnership(element);
    if (!owner) continue;
    const touchesScope = owner.unitIds.some((id) => sourceIds.has(id))
      || (gullyScope ? gullyScope.has(owner.gullyId) : !unitScope);
    if (touchesScope) ids.push(element.id);
  }
  return ids;
}

/** The condensate pipes a generation with this scope would replace (for coordinated multi-service runs). */
export function replaceableCondensatePipeIds(
  scene: readonly HvacElement[],
  settings: Pick<CondensateDesignSettings, 'defaultPumpMaxLiftMm'>,
  scope: { unitIds?: readonly string[]; gullyIds?: readonly string[] } = {},
): string[] {
  const unitScope = scope.unitIds ? new Set(scope.unitIds) : null;
  const gullyScope = scope.gullyIds?.length ? new Set(scope.gullyIds) : null;
  const protectedUnitIds = new Set(scene.filter((element) => isCondensatePipe(element) && isProtectedCondensatePipe(element))
    .flatMap((element) => readCondensatePipeSpec(element).upstreamUnitIds));
  const sourceIds = new Set(scene
    .filter((element) => CONDENSATE_INDOOR_UNIT_TYPES.has(element.type)
      && (!unitScope || unitScope.has(element.id))
      && !protectedUnitIds.has(element.id)
      && getIndoorUnitDrainPort(element, settings) !== null)
    .map((element) => element.id));
  return replaceableCondensatePipeIdsFor(scene, sourceIds, unitScope, gullyScope);
}

export function buildCondensateEnvironment(
  scene: HvacElement[],
  options: CondensateEnvironmentOptions,
): CondensateEnvironment {
  const { settings } = options;
  const walls = options.walls ?? [];
  const envelope = deriveCondensateEnvelope(scene, settings, options.routingSettings, options.rooms ?? []);
  const unitScope = options.unitIds ? new Set(options.unitIds) : null;
  const gullyScope = options.gullyIds?.length ? new Set(options.gullyIds) : null;

  const protectedUnitIds = new Set<string>();
  const replaceableElementIds: string[] = [];
  const services: ServiceSegment[] = [];
  const editedPipeIds = options.editNetworkId
    ? scene.filter((element) => isCondensatePipe(element) && getCondensateOwnership(element)?.networkId === options.editNetworkId).map((element) => element.id)
    : [];
  const edited = new Set(editedPipeIds);
  for (const element of scene) {
    if (!isCondensatePipe(element) || edited.has(element.id)) continue;
    const spec = readCondensatePipeSpec(element);
    if (isProtectedCondensatePipe(element)) {
      spec.upstreamUnitIds.forEach((id) => protectedUnitIds.add(id));
    }
  }
  const skipped: CondensateEnvironment['skipped'] = [];
  const sources: IndoorDrainPort[] = [];
  for (const element of scene) {
    if (!CONDENSATE_INDOOR_UNIT_TYPES.has(element.type)) continue;
    if (unitScope && !unitScope.has(element.id)) continue;
    if (protectedUnitIds.has(element.id)) {
      skipped.push({ unitId: element.id, reason: 'drain belongs to a locked or edited network' });
      continue;
    }
    const port = getIndoorUnitDrainPort(element, settings);
    if (!port) {
      skipped.push({ unitId: element.id, reason: 'no drain outlet' });
      continue;
    }
    sources.push(port);
  }
  sources.sort((a, b) => a.unitId.localeCompare(b.unitId));
  const sourceIds = new Set(sources.map((source) => source.unitId));
  replaceableElementIds.push(...new Set([...replaceableCondensatePipeIdsFor(scene, sourceIds, unitScope, gullyScope), ...editedPipeIds]));
  // Every surviving drain is a solid service, including generated networks
  // outside a selected regeneration scope. Only replaced pipes disappear.
  const replaced = new Set(replaceableElementIds);
  for (const element of scene) {
    if (!isCondensatePipe(element) || replaced.has(element.id)) continue;
    const spec = readCondensatePipeSpec(element);
    const radius = condensateInsulatedRadiusMm(spec);
    for (let index = 1; index < spec.routeNodes3d.length; index += 1) {
      services.push({ elementId: element.id, service: 'drain', a: spec.routeNodes3d[index - 1]!, b: spec.routeNodes3d[index]!, radiusMm: radius, connectedUnitIds: spec.upstreamUnitIds });
    }
  }

  const sinks = scene
    .filter((element) => isCondensateGully(element) && (!gullyScope || gullyScope.has(element.id)))
    .map((element) => buildCondensateSink(element, settings, walls))
    .sort((a, b) => a.gullyId.localeCompare(b.gullyId));

  const solids = solidBoxesInScene(scene, getActiveDuctSettings());
  const obstacles: PlanObstacle[] = solids.map((solid) => ({
    id: solid.elementId, ...solid.bounds,
    kind: sourceIds.has(solid.elementId) ? 'source-body' : 'equipment',
    ...(solid.mark !== 'equipment casing' ? { crossable: true } : {}),
  }));
  for (const element of scene) {
    // Branch kits have their own tube model rather than an equipment box.
    // Retain the conservative placement keepout until that model is queried.
    if (element.type === 'refrigerant-branch-kit') {
      obstacles.push({ id: element.id, ...unitFootprintBoundsMm(element),
        minZ: element.elevation, maxZ: element.elevation + element.height, kind: 'equipment', passableUnder: true });
      continue;
    }
    if (isCondensateGully(element)) {
      if (readCondensateGullySpec(element).terminationKind === 'stack-connection') {
        const b = unitFootprintBoundsMm(element);
        obstacles.push({ id: element.id, ...b, minZ: element.elevation, maxZ: element.elevation + element.height, kind: 'stack' });
      }
      continue;
    }
  }

  const wallBarriers: WallBarrier[] = walls
    .filter((wall) => {
      const top = (wall.properties3D?.baseElevation ?? 0) + (wall.properties3D?.height ?? Number.POSITIVE_INFINITY);
      return top > envelope.voidFloorMm;
    })
    .map((wall) => ({ id: wall.id, a: wall.startPoint, b: wall.endPoint, thicknessMm: wall.thickness }));

  const byId = new Map(scene.map((element) => [element.id, element]));
  const lanes = listNetworkPipeLanes(scene);
  for (const lane of lanes) {
    // Condensate lanes are handled above: kept ones are services, replaceable ones vanish.
    if (lane.service === 'drain') continue;
    const element = byId.get(lane.elementId);
    const connectedUnitIds = connectedUnitIdsOf(element);
    const hopStretches = element?.type === 'refrigerant-pipe' ? clearOfRunsOver(refrigerantHopStretches(element, scene), lane, lanes) : undefined;
    for (const segment of lane.segments) {
      services.push({ elementId: lane.elementId, service: lane.service, a: segment.a, b: segment.b, radiusMm: lane.radiusMm, connectedUnitIds,
        ...(hopStretches ? { hopStretches } : {}) });
    }
  }

  return {
    settings,
    envelope,
    sources,
    sinks,
    obstacles,
    solids,
    walls: wallBarriers,
    services,
    protectedUnitIds,
    replaceableElementIds,
    skipped,
  };
}
