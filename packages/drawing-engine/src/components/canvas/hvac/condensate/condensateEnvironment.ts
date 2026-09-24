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
import { listNetworkPipeLanes } from '../networkPipeClearance';
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
  /** Clearance applies (equipment) or the raw box is used (the source unit's own body). */
  kind: 'equipment' | 'source-body' | 'stack';
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
}

/** Plan radius around a drain outlet where the unit's own pipework is exempt from coordination. */
export const UNIT_CONNECTION_ZONE_MM = 550;

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
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function deriveCondensateEnvelope(
  scene: readonly HvacElement[],
  settings: CondensateDesignSettings,
  routingSettings: Pick<PipeRoutingSettings, 'ceilingLimitMm'>,
  rooms: readonly Room[] = [],
): CondensateEnvelope {
  let ceilingPlane: number;
  let derivation: string;
  const cassettes = scene.filter((element) => element.type === 'ceiling-cassette-ac').map((element) => element.elevation);
  const ducted = scene.filter((element) => element.type === 'ducted-ac').map((element) => element.elevation);
  const roomCeilings = rooms.map((room) => room.properties3D?.ceilingHeight).filter((value): value is number => Number.isFinite(value));
  if (settings.ceilingPlaneMm !== null) {
    ceilingPlane = settings.ceilingPlaneMm;
    derivation = 'ceiling plane from condensate settings';
  } else if (cassettes.length) {
    ceilingPlane = median(cassettes)!;
    derivation = `ceiling plane from ${cassettes.length} ceiling cassette${cassettes.length === 1 ? '' : 's'}`;
  } else if (ducted.length) {
    ceilingPlane = Math.min(...ducted);
    derivation = `ceiling plane below ${ducted.length} ducted unit${ducted.length === 1 ? '' : 's'}`;
  } else if (roomCeilings.length) {
    ceilingPlane = median(roomCeilings)!;
    derivation = 'ceiling plane from room ceiling heights';
  } else {
    ceilingPlane = 2400;
    derivation = 'default ceiling plane';
  }
  const soffit = settings.soffitMm ?? routingSettings.ceilingLimitMm;
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

const BODY_TYPES: ReadonlySet<HvacElement['type']> = new Set<HvacElement['type']>([
  ...CONDENSATE_INDOOR_UNIT_TYPES,
  'outdoor-unit',
  'refrigerant-branch-kit',
  'duct',
  'filter',
  'accessory',
  'control-panel',
]);

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
  const unitScope = scope.unitIds?.length ? new Set(scope.unitIds) : null;
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
  const unitScope = options.unitIds?.length ? new Set(options.unitIds) : null;
  const gullyScope = options.gullyIds?.length ? new Set(options.gullyIds) : null;

  const protectedUnitIds = new Set<string>();
  const replaceableElementIds: string[] = [];
  const services: ServiceSegment[] = [];
  for (const element of scene) {
    if (!isCondensatePipe(element)) continue;
    const spec = readCondensatePipeSpec(element);
    if (isProtectedCondensatePipe(element)) {
      spec.upstreamUnitIds.forEach((id) => protectedUnitIds.add(id));
      const radius = condensateInsulatedRadiusMm(spec);
      for (let index = 1; index < spec.routeNodes3d.length; index += 1) {
        services.push({ elementId: element.id, service: 'drain', a: spec.routeNodes3d[index - 1]!, b: spec.routeNodes3d[index]!, radiusMm: radius, connectedUnitIds: spec.upstreamUnitIds });
      }
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
  replaceableElementIds.push(...replaceableCondensatePipeIdsFor(scene, sourceIds, unitScope, gullyScope));

  const sinks = scene
    .filter((element) => isCondensateGully(element) && (!gullyScope || gullyScope.has(element.id)))
    .map((element) => buildCondensateSink(element, settings, walls))
    .sort((a, b) => a.gullyId.localeCompare(b.gullyId));

  const obstacles: PlanObstacle[] = [];
  for (const element of scene) {
    if (isCondensateGully(element)) {
      if (readCondensateGullySpec(element).terminationKind === 'stack-connection') {
        const b = unitFootprintBoundsMm(element);
        obstacles.push({ id: element.id, ...b, kind: 'stack' });
      }
      continue;
    }
    if (!BODY_TYPES.has(element.type)) continue;
    const bottom = element.elevation;
    const top = element.elevation + element.height;
    // Only bodies that occupy the ceiling-void band obstruct a void run.
    if (top < envelope.voidFloorMm - 1 || bottom > envelope.soffitMm) continue;
    const bounds = unitFootprintBoundsMm(element);
    obstacles.push({ id: element.id, ...bounds, kind: sourceIds.has(element.id) ? 'source-body' : 'equipment' });
  }

  const wallBarriers: WallBarrier[] = walls
    .filter((wall) => {
      const top = (wall.properties3D?.baseElevation ?? 0) + (wall.properties3D?.height ?? Number.POSITIVE_INFINITY);
      return top > envelope.voidFloorMm;
    })
    .map((wall) => ({ id: wall.id, a: wall.startPoint, b: wall.endPoint, thicknessMm: wall.thickness }));

  const byId = new Map(scene.map((element) => [element.id, element]));
  for (const lane of listNetworkPipeLanes(scene)) {
    // Condensate lanes are handled above: kept ones are services, replaceable ones vanish.
    if (lane.service === 'drain') continue;
    const connectedUnitIds = connectedUnitIdsOf(byId.get(lane.elementId));
    for (const segment of lane.segments) {
      services.push({ elementId: lane.elementId, service: lane.service, a: segment.a, b: segment.b, radiusMm: lane.radiusMm, connectedUnitIds });
    }
  }

  return {
    settings,
    envelope,
    sources,
    sinks,
    obstacles,
    walls: wallBarriers,
    services,
    protectedUnitIds,
    replaceableElementIds,
    skipped,
  };
}
