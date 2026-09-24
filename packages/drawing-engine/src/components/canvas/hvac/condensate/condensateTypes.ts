/**
 * Condensate drainage — persisted element shapes and readers.
 *
 * Condensate uses its OWN element types rather than a `lineKind` of
 * `refrigerant-pipe`: the refrigerant readers coerce every non-liquid kind to
 * gas, clamp insulation to 25.4 mm and fit copper socket elbows, none of which
 * is true of a sloped PVC drain. Keeping the types separate keeps condensate
 * out of every refrigerant-gated code path by default.
 */
import type { HvacElement, Point2D } from '../../../../types';

export const CONDENSATE_GULLY_TYPE = 'condensate-gully' as const;
/** Tundish receptor height above the gully rim (mm); the drop ends an air break above it. */
export const CONDENSATE_TUNDISH_HEIGHT_MM = 110;
export const CONDENSATE_PIPE_TYPE = 'condensate-pipe' as const;

export type CondensateTerminationKind = 'floor-gully' | 'stack-connection' | 'external-discharge';
export type CondensateTerminalTrap = 'tundish' | 'hepvo' | 'p-trap' | 'none';
export type CondensatePipeSystemId = 'bs-en-1329' | 'jis-vp' | 'astm-sch40';
export type CondensateSegmentRole = 'unit-branch' | 'main' | 'lift' | 'drop' | 'terminal';
export type CondensateFittingKind =
  | 'wye'
  | 'elbow-90'
  | 'elbow-45'
  | 'cleanout'
  | 'air-vent'
  | 'p-trap'
  | 'tundish'
  | 'hepvo'
  | 'stack-wye'
  | 'wall-sleeve'
  | 'terminal-outlet'
  | 'reducer';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface CondensateFitting {
  id: string;
  kind: CondensateFittingKind;
  point: Point3;
  /** Nominal label of the run the fitting sits on (e.g. "32", "VP25"). */
  nominalSize: string;
  outerDiameterMm: number;
  /** Axis of the run through the fitting (downstream direction). */
  axis?: Point3;
  /** Axis of the branch arm (wye) or the trap / vent outlet. */
  branchAxis?: Point3;
  note?: string;
}

/**
 * Pipe end identity. Deliberately NOT `startConnection` / `sourceElementId`:
 * refrigerant readers and the auto-route rebuild guard scan those names, and a
 * drain must never read as a refrigerant connection.
 */
export interface CondensateConnection {
  kind: 'unit-drain' | 'junction' | 'gully';
  unitId?: string;
  gullyId?: string;
  nodeId?: string;
  point: Point2D;
  z: number;
}

export interface CondensateNetworkOwnership {
  version: 1;
  networkId: string;
  gullyId: string;
  unitIds: string[];
  /** Hash of the element as generated; a different hash means a field edit. */
  signature: string;
  /** Hash of the unit/gully inputs this network was solved against. */
  sourceSignature: string;
  editPolicy?: 'retain' | 'reconsider';
  [key: string]: unknown;
}

export interface CondensatePipeSpec {
  routePoints: Point2D[];
  routeNodes3d: Point3[];
  pipeSystem: CondensatePipeSystemId;
  nominalSize: string;
  outerDiameterMm: number;
  innerDiameterMm: number;
  insulationThicknessMm: number;
  designSlopePercent: number;
  segmentRole: CondensateSegmentRole;
  drainStart: CondensateConnection | null;
  drainEnd: CondensateConnection | null;
  upstreamUnitIds: string[];
  upstreamCapacityKw: number;
  fittings: CondensateFitting[];
  pumped: boolean;
  locked: boolean;
  /**
   * Length along the centreline, from the start, that is the unit's flexible
   * drain hose (socket → riser foot) rather than rigid insulated pipe. 0 = none.
   */
  drainHoseLengthMm: number;
  /** Hanger design the run was generated with (slab level + spacing); null when unknown. */
  hangers: CondensateHangerDesign | null;
}

export interface CondensateHangerDesign {
  /** Underside of the slab the hanger rods are fixed to (design soffit, mm). */
  topZ: number;
  supportSpacingHorizontalMm: number;
  supportSpacingVerticalMm: number;
  supportNearFittingMm: number;
}

function readHangers(value: unknown): CondensateHangerDesign | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!finite(raw.topZ)) return null;
  const spacing = (key: string, fallback: number) => (finite(raw[key]) && (raw[key] as number) > 0 ? raw[key] as number : fallback);
  return {
    topZ: raw.topZ,
    supportSpacingHorizontalMm: spacing('supportSpacingHorizontalMm', 1000),
    supportSpacingVerticalMm: spacing('supportSpacingVerticalMm', 1500),
    supportNearFittingMm: spacing('supportNearFittingMm', 300),
  };
}

export interface CondensateGullySpec {
  terminationKind: CondensateTerminationKind;
  /** Floor gully rim / stack wye centreline / wall penetration centreline (mm above FFL). */
  inletElevationMm: number;
  airBreakMm: number;
  terminalTrap: CondensateTerminalTrap;
  maxConnectedCapacityKw: number | null;
  /** Plan point the network must reach (gully centre, stack axis or wall face). */
  connectionPoint: Point2D;
}

export function isCondensatePipe(element: Pick<HvacElement, 'type'> | null | undefined): boolean {
  return element?.type === CONDENSATE_PIPE_TYPE;
}

export function isCondensateGully(element: Pick<HvacElement, 'type'> | null | undefined): boolean {
  return element?.type === CONDENSATE_GULLY_TYPE;
}

export function isCondensateElement(element: Pick<HvacElement, 'type'> | null | undefined): boolean {
  return isCondensatePipe(element) || isCondensateGully(element);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readNumber(properties: Record<string, unknown>, key: string, fallback: number): number {
  const value = properties[key];
  if (finite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readPoint2(value: unknown): Point2D | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as { x?: unknown; y?: unknown };
  return finite(point.x) && finite(point.y) ? { x: point.x, y: point.y } : null;
}

function readPoint3(value: unknown): Point3 | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as { x?: unknown; y?: unknown; z?: unknown };
  return finite(point.x) && finite(point.y) && finite(point.z) ? { x: point.x, y: point.y, z: point.z } : null;
}

function readConnection(value: unknown): CondensateConnection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind === 'unit-drain' || raw.kind === 'junction' || raw.kind === 'gully' ? raw.kind : null;
  const point = readPoint2(raw.point);
  if (!kind || !point || !finite(raw.z)) return null;
  return {
    kind,
    point,
    z: raw.z,
    ...(typeof raw.unitId === 'string' ? { unitId: raw.unitId } : {}),
    ...(typeof raw.gullyId === 'string' ? { gullyId: raw.gullyId } : {}),
    ...(typeof raw.nodeId === 'string' ? { nodeId: raw.nodeId } : {}),
  };
}

const FITTING_KINDS = new Set<CondensateFittingKind>([
  'wye', 'elbow-90', 'elbow-45', 'cleanout', 'air-vent', 'p-trap', 'tundish', 'hepvo',
  'stack-wye', 'wall-sleeve', 'terminal-outlet', 'reducer',
]);

function readFittings(value: unknown): CondensateFitting[] {
  if (!Array.isArray(value)) return [];
  const fittings: CondensateFitting[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    const point = readPoint3(raw.point);
    if (!point || typeof raw.kind !== 'string' || !FITTING_KINDS.has(raw.kind as CondensateFittingKind)) continue;
    fittings.push({
      id: typeof raw.id === 'string' ? raw.id : `${raw.kind}:${fittings.length}`,
      kind: raw.kind as CondensateFittingKind,
      point,
      nominalSize: typeof raw.nominalSize === 'string' ? raw.nominalSize : '',
      outerDiameterMm: finite(raw.outerDiameterMm) ? raw.outerDiameterMm : 32,
      ...(readPoint3(raw.axis) ? { axis: readPoint3(raw.axis)! } : {}),
      ...(readPoint3(raw.branchAxis) ? { branchAxis: readPoint3(raw.branchAxis)! } : {}),
      ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
    });
  }
  return fittings;
}

const SEGMENT_ROLES = new Set<CondensateSegmentRole>(['unit-branch', 'main', 'lift', 'drop', 'terminal']);
const PIPE_SYSTEMS = new Set<CondensatePipeSystemId>(['bs-en-1329', 'jis-vp', 'astm-sch40']);

/** Tolerant reader: persisted properties are an open bag and may be partial. */
export function readCondensatePipeSpec(element: Pick<HvacElement, 'properties'>): CondensatePipeSpec {
  const properties = element.properties ?? {};
  const routeNodes3d = Array.isArray(properties.routeNodes3d)
    ? (properties.routeNodes3d as unknown[]).map(readPoint3).filter((point): point is Point3 => point !== null)
    : [];
  const routePoints = Array.isArray(properties.routePoints)
    ? (properties.routePoints as unknown[]).map(readPoint2).filter((point): point is Point2D => point !== null)
    : routeNodes3d.map(({ x, y }) => ({ x, y }));
  const outerDiameterMm = Math.max(6, readNumber(properties, 'outerDiameterMm', 32));
  return {
    routePoints,
    routeNodes3d,
    pipeSystem: PIPE_SYSTEMS.has(properties.pipeSystem as CondensatePipeSystemId)
      ? properties.pipeSystem as CondensatePipeSystemId
      : 'bs-en-1329',
    nominalSize: typeof properties.nominalSize === 'string' ? properties.nominalSize : `${Math.round(outerDiameterMm)}`,
    outerDiameterMm,
    innerDiameterMm: Math.max(1, Math.min(outerDiameterMm, readNumber(properties, 'innerDiameterMm', outerDiameterMm * 0.88))),
    insulationThicknessMm: Math.max(0, readNumber(properties, 'insulationThicknessMm', 0)),
    designSlopePercent: readNumber(properties, 'designSlopePercent', 1),
    segmentRole: SEGMENT_ROLES.has(properties.segmentRole as CondensateSegmentRole)
      ? properties.segmentRole as CondensateSegmentRole
      : 'main',
    drainStart: readConnection(properties.drainStart),
    drainEnd: readConnection(properties.drainEnd),
    upstreamUnitIds: Array.isArray(properties.upstreamUnitIds)
      ? (properties.upstreamUnitIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
    upstreamCapacityKw: Math.max(0, readNumber(properties, 'upstreamCapacityKw', 0)),
    fittings: readFittings(properties.fittings),
    pumped: properties.pumped === true,
    locked: properties.locked === true || properties.routeLocked === true,
    drainHoseLengthMm: Math.max(0, readNumber(properties, 'drainHoseLengthMm', 0)),
    hangers: readHangers(properties.hangers),
  };
}

/** Insulated outer radius — what clash checks and the plan tube use. */
export function condensateInsulatedRadiusMm(spec: Pick<CondensatePipeSpec, 'outerDiameterMm' | 'insulationThicknessMm'>): number {
  return spec.outerDiameterMm / 2 + spec.insulationThicknessMm;
}

const TERMINATION_KINDS = new Set<CondensateTerminationKind>(['floor-gully', 'stack-connection', 'external-discharge']);
const TERMINAL_TRAPS = new Set<CondensateTerminalTrap>(['tundish', 'hepvo', 'p-trap', 'none']);

export function defaultInletElevationMm(kind: CondensateTerminationKind): number {
  if (kind === 'floor-gully') return 50;
  if (kind === 'stack-connection') return 2300;
  return 2350;
}

export function defaultTerminalTrap(kind: CondensateTerminationKind): CondensateTerminalTrap {
  if (kind === 'floor-gully') return 'tundish';
  if (kind === 'stack-connection') return 'hepvo';
  return 'none';
}

export function elementCenter(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
}

export function readCondensateGullySpec(element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'properties'>): CondensateGullySpec {
  const properties = element.properties ?? {};
  const terminationKind = TERMINATION_KINDS.has(properties.terminationKind as CondensateTerminationKind)
    ? properties.terminationKind as CondensateTerminationKind
    : 'floor-gully';
  const terminalTrap = TERMINAL_TRAPS.has(properties.terminalTrap as CondensateTerminalTrap)
    ? properties.terminalTrap as CondensateTerminalTrap
    : defaultTerminalTrap(terminationKind);
  const maxCapacity = readNumber(properties, 'maxConnectedCapacityKw', Number.NaN);
  return {
    terminationKind,
    inletElevationMm: readNumber(properties, 'inletElevationMm', defaultInletElevationMm(terminationKind)),
    airBreakMm: Math.max(0, readNumber(properties, 'airBreakMm', 25)),
    terminalTrap,
    maxConnectedCapacityKw: Number.isFinite(maxCapacity) && maxCapacity > 0 ? maxCapacity : null,
    connectionPoint: elementCenter(element),
  };
}

export function getCondensateOwnership(element: Pick<HvacElement, 'properties'>): CondensateNetworkOwnership | null {
  const value = element.properties?.condensateNetwork as Partial<CondensateNetworkOwnership> | undefined;
  return value?.version === 1
    && typeof value.networkId === 'string'
    && typeof value.gullyId === 'string'
    && Array.isArray(value.unitIds)
    && value.unitIds.every((id) => typeof id === 'string')
    && typeof value.signature === 'string'
    && typeof value.sourceSignature === 'string'
    ? value as CondensateNetworkOwnership
    : null;
}
