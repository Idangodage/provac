/**
 * Wall penetrations: where a duct passes through a wall, and what that takes
 * (one source for the router's crossing price, the realiser's no-fitting
 * zones and the planner's sleeves and fire dampers).
 *
 * A crossing is a level leg's centreline passing through a wall's centreline
 * where the duct's height band overlaps the wall's: a wall that stops below
 * the duct (a half-height partition, a wall to a false ceiling under it) is
 * passed over, with no penetration. Each crossing has a zone along the leg —
 * the wall's thickness seen along the duct — that must hold a plain straight
 * (no fitting, take-off or transverse joint, and never flexible duct: UL 181 /
 * NFPA 90A practice). Every penetration gets a sleeve (the opening, practice);
 * a fire damper by the project policy or the run's own choice.
 */
import type { Point2D } from '../../../../types';
import { isPointInPolygon } from '../../../../utils/geometry';

import type { DuctRoomOutline, DuctWall } from './ductBuilding';
import type { DuctDesignSettings } from './ductSettings';
import type { DuctRunSpec } from './ductTypes';

/** A crossing more oblique than this is no penetration a sleeve can make square: it is flagged (degrees). */
export const PENETRATION_MAX_ANGLE_DEG = 10;
/** Clear of joints either side of the wall zone (mm, practice: the take-off window margin). */
export const PENETRATION_JOINT_MARGIN_MM = 50;
/** How far beyond a wall's half thickness the rooms it divides are looked for (mm). */
const SIDE_PROBE_MM = 60;

export interface DuctWallCrossing {
  wallId: string;
  /** This wall's occurrence along the run (0 = the first time it is crossed). */
  occurrence: number;
  /** `${wallId}:${occurrence}`: where a run keeps its choice for this crossing. */
  key: string;
  legIndex: number;
  /** The crossing on the leg's centreline, from the leg's start (mm). */
  legStationMm: number;
  point: Point2D;
  /** Angle between the duct and the wall's normal (0 = square to the wall). */
  angleDeg: number;
  thicknessMm: number;
  /** Where along the leg the duct is inside the wall (mm from the leg's start). */
  zoneFromMm: number;
  zoneToMm: number;
  /** The rooms either side (null = outside every room); `exterior` when one side is outside. */
  rooms: [string | null, string | null];
  exterior: boolean;
  structural: boolean;
  material?: DuctWall['material'];
  /** On the flexible runout to a terminal. */
  onFlex: boolean;
}

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Where segment ab properly crosses segment cd, as the parameter along ab (null if they do not). */
function crossingParameter(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number | null {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  const proper = ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
  return proper ? d1 / (d1 - d2) : null;
}

function roomAt(point: Point2D, rooms: readonly DuctRoomOutline[]): string | null {
  return rooms.find((room) => room.vertices.length >= 3 && isPointInPolygon(point, room.vertices))?.id ?? null;
}

/** The rooms either side of a wall at a point on its centre line (null = outside every room). */
export function wallSides(wall: Pick<DuctWall, 'a' | 'b' | 'thicknessMm'>, point: Point2D, rooms: readonly DuctRoomOutline[]): [string | null, string | null] {
  const length = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
  const normal = { x: -(wall.b.y - wall.a.y) / length, y: (wall.b.x - wall.a.x) / length };
  const off = wall.thicknessMm / 2 + SIDE_PROBE_MM;
  return [
    roomAt({ x: point.x + normal.x * off, y: point.y + normal.y * off }, rooms),
    roomAt({ x: point.x - normal.x * off, y: point.y - normal.y * off }, rooms),
  ];
}

/**
 * Every wall a run passes through, in order along the run. A run ending on
 * a flexible runout has it as its last leg.
 */
export function ductWallCrossings(
  spec: Pick<DuctRunSpec, 'path' | 'legs' | 'insulationThicknessMm' | 'end'>,
  walls: readonly DuctWall[],
  rooms: readonly DuctRoomOutline[] = [],
): DuctWallCrossing[] {
  if (!walls.length) return [];
  const flexLeg = spec.end.kind === 'terminal' && spec.end.flex ? spec.legs.length - 1 : -1;
  const out: DuctWallCrossing[] = [];
  const occurrences = new Map<string, number>();
  spec.legs.forEach((leg, legIndex) => {
    const a = spec.path[legIndex]!;
    const b = spec.path[legIndex + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.5) return;
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const insulation = spec.insulationThicknessMm ?? 0;
    const bottom = Math.min(a.z, b.z) - insulation;
    const top = Math.max(a.z, b.z) + (leg.diameterMm ?? leg.heightMm) + insulation;
    const found: DuctWallCrossing[] = [];
    for (const wall of walls) {
      if (wall.topZ <= bottom || wall.baseZ >= top) continue;
      const t = crossingParameter(a, b, wall.a, wall.b);
      if (t === null) continue;
      const wallLength = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
      const normal = { x: -(wall.b.y - wall.a.y) / wallLength, y: (wall.b.x - wall.a.x) / wallLength };
      const cos = Math.min(1, Math.abs(direction.x * normal.x + direction.y * normal.y));
      const angleDeg = (Math.acos(cos) * 180) / Math.PI;
      const half = wall.thicknessMm / 2 / Math.max(cos, 0.17);
      const station = t * length;
      const point = { x: a.x + direction.x * station, y: a.y + direction.y * station };
      const sides = wallSides(wall, point, rooms);
      found.push({
        wallId: wall.id, occurrence: 0, key: '', legIndex, legStationMm: station, point, angleDeg, thicknessMm: wall.thicknessMm,
        zoneFromMm: station - half, zoneToMm: station + half, rooms: sides,
        exterior: rooms.length > 0 && (!sides[0] || !sides[1]), structural: wall.structural,
        ...(wall.material ? { material: wall.material } : {}), onFlex: legIndex === flexLeg,
      });
    }
    found.sort((p, q) => p.legStationMm - q.legStationMm);
    for (const crossing of found) {
      const occurrence = occurrences.get(crossing.wallId) ?? 0;
      occurrences.set(crossing.wallId, occurrence + 1);
      out.push({ ...crossing, occurrence, key: `${crossing.wallId}:${occurrence}` });
    }
  });
  return out;
}

/** Whether a crossing gets a fire damper: the run's own choice for it, else the project policy. */
export function penetrationHasFireDamper(
  crossing: Pick<DuctWallCrossing, 'key' | 'structural'>,
  overrides: DuctRunSpec['penetrations'],
  policy: DuctDesignSettings['fireDamperPolicy'],
): boolean {
  const own = overrides?.[crossing.key]?.fireDamper;
  if (typeof own === 'boolean') return own;
  return policy === 'all' || (policy === 'structural' && crossing.structural);
}

/** The opening a sleeve needs: the duct's outer size (insulation included) and a clearance all round (mm). */
export function sleeveOpeningMm(outerWidthMm: number, outerHeightMm: number, clearanceMm: number, round: boolean): { widthMm: number; heightMm: number; round: boolean } {
  return { widthMm: outerWidthMm + 2 * clearanceMm, heightMm: (round ? outerWidthMm : outerHeightMm) + 2 * clearanceMm, round };
}

/** A penetration as a run's plan carries it: the crossing, its sleeve, whether it has a fire damper, and where. */
export interface DuctPenetration extends DuctWallCrossing {
  /** Penetration mark on the run: PN-01, PN-02 … */
  mark: string;
  fireDamper: boolean;
  /** The fire damper piece (FD-01 …) where one was placed. */
  damperMark?: string;
  /** Along the run (mm from its start): the crossing, and where the duct is inside the wall. */
  stationMm: number;
  fromStationMm: number;
  toStationMm: number;
  /** Clear section of the duct through the wall (mm), its outer size, and the opening the sleeve needs. */
  widthMm: number;
  heightMm: number;
  diameterMm?: number;
  outerWidthMm: number;
  outerHeightMm: number;
  opening: { widthMm: number; heightMm: number; round: boolean };
  /** Clear bottom of the duct where it crosses (mm). */
  bottomZ: number;
  /** Plan direction of the duct through the wall. */
  direction: Point2D;
}

/** Whether a crossing found on a run is one a system spanning rooms may make: through an interior wall. */
export function crossingAllowed(crossing: Pick<DuctWallCrossing, 'rooms' | 'exterior'>): boolean {
  return !crossing.exterior && crossing.rooms[0] !== null && crossing.rooms[1] !== null;
}

/**
 * Where the auto layout of a system spanning rooms may pass through walls:
 * interior walls (a room either side), never an exterior one. A crossing's
 * price is its sleeve, with a fire damper and its access door where the
 * policy puts one, at the reference size (the plan prices the real ones).
 */
export interface WallCrossingRule {
  allows(wall: DuctWall, point: Point2D): boolean;
  fireDamper(wall: DuctWall): boolean;
  price(wall: DuctWall): number;
}

export function wallCrossingRule(
  rooms: readonly DuctRoomOutline[],
  settings: Pick<DuctDesignSettings, 'fireDamperPolicy' | 'econPenetrationEach' | 'econFireDamperEach' | 'econAccessDoorEach'>,
): WallCrossingRule {
  const fireDamper = (wall: DuctWall) => penetrationHasFireDamper({ key: '', structural: wall.structural }, undefined, settings.fireDamperPolicy);
  return {
    allows: (wall, point) => crossingAllowed({ rooms: wallSides(wall, point, rooms), exterior: false }),
    fireDamper,
    price: (wall) => settings.econPenetrationEach + (fireDamper(wall) ? settings.econFireDamperEach + settings.econAccessDoorEach : 0),
  };
}

type ZoneSettings = Pick<DuctDesignSettings, 'fireDamperPolicy' | 'fireDamperSleeveExtensionMm'>;

/**
 * Where along a run's path (stations from its start, mm) it is inside a wall:
 * each crossing's zone, widened by a fire damper's sleeve where one goes and
 * by the joint margin. The auto layout and the resizer keep their take-offs,
 * reducers and neck transitions out of them.
 */
export function runPenetrationZones(
  spec: Pick<DuctRunSpec, 'path' | 'legs' | 'insulationThicknessMm' | 'end' | 'penetrations'>,
  walls: readonly DuctWall[],
  settings: ZoneSettings,
): Array<{ from: number; to: number; wallId: string }> {
  if (!walls.length || spec.path.length < 2) return [];
  const starts = [0];
  for (let index = 1; index < spec.path.length; index += 1) {
    const a = spec.path[index - 1]!;
    const b = spec.path[index]!;
    starts.push(starts[index - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return ductWallCrossings(spec, walls).map((crossing) => {
    const extra = (penetrationHasFireDamper(crossing, spec.penetrations, settings.fireDamperPolicy) ? settings.fireDamperSleeveExtensionMm : 0) + PENETRATION_JOINT_MARGIN_MM;
    return { from: starts[crossing.legIndex]! + crossing.zoneFromMm - extra, to: starts[crossing.legIndex]! + crossing.zoneToMm + extra, wallId: crossing.wallId };
  });
}

/** The same for a level polyline, `heightMm` high at `bottomZ` (a route before its run is built). */
export function polylinePenetrationZones(
  points: readonly Point2D[],
  bottomZ: number,
  heightMm: number,
  walls: readonly DuctWall[],
  settings: ZoneSettings,
  overrides?: DuctRunSpec['penetrations'],
): Array<{ from: number; to: number; wallId: string }> {
  return runPenetrationZones({
    path: points.map((point) => ({ x: point.x, y: point.y, z: bottomZ })),
    legs: points.slice(1).map(() => ({ widthMm: heightMm, heightMm })),
    insulationThicknessMm: 0,
    end: { kind: 'open' },
    ...(overrides ? { penetrations: overrides } : {}),
  }, walls, settings);
}
