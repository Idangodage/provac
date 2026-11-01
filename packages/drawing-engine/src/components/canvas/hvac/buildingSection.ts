/**
 * The building's section, the one answer every service reads: where the ceiling
 * is, where the soffit above it is, and how high each wall goes. A pipe, duct or
 * drain that passes through a wall at its own height gets a sleeve there; above
 * the wall's top it passes over, with none.
 *
 *  - The ceiling: where what sits flush with it says (cassettes and air
 *    terminals), else just under the ducted units, else the rooms' ceilings.
 *  - The soffit: a level set in a service's settings, else the routing ceiling
 *    limit.
 *  - Walls run up to the soffit unless they are low by design (half-height and
 *    top-clearance partitions); an older drawing's walls are flagged, and raised
 *    in one click. Sleeves are worked out from the walls as they are now, so a
 *    raised wall has them at once.
 * Pure, but for the active building (duct/ductBuilding.ts) the 3D and the
 * schedules read.
 */
import type { HvacElement, Point2D, Wall } from '../../../types';
import type { VrfValidationIssue } from '../../../vrf/rules';

import type { CondensateFitting } from './condensate/condensateTypes';
import type { DuctRoomOutline, DuctWall } from './duct/ductBuilding';
import { crossingParameter, wallSides } from './duct/ductPenetrations';

/** The ceiling level when nothing in the drawing says (mm). */
const DEFAULT_CEILING_MM = 2400;
/** How far a sleeve's bore stands off the insulated pipe, on the diameter (mm, practice: room for the packing and seal). */
export const PIPE_SLEEVE_CLEARANCE_MM = 25;
/** How far a sleeve stands proud of each face of the wall (mm, as a duct's collar does). */
export const PIPE_SLEEVE_PROUD_MM = 12;
/** Beyond this angle off square a sleeve is not lengthened further (degrees). */
const SLEEVE_MAX_ANGLE_DEG = 70;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const counted = (count: number, what: string) => `${count} ${what}${count === 1 ? '' : 's'}`;

/** Where the ceiling is, and what says so. */
export function buildingCeiling(
  scene: readonly Pick<HvacElement, 'type' | 'elevation'>[],
  rooms: ReadonlyArray<{ properties3D?: { ceilingHeight?: number } | null }> = [],
): { ceilingMm: number; derivation: string } {
  const levels = (test: (type: HvacElement['type']) => boolean) => scene.filter((element) => test(element.type)).map((element) => element.elevation);
  const cassettes = levels((type) => type === 'ceiling-cassette-ac');
  const terminals = levels((type) => type === 'diffuser' || type === 'return-grille');
  if (cassettes.length || terminals.length) {
    const from = [cassettes.length ? counted(cassettes.length, 'ceiling cassette') : null, terminals.length ? counted(terminals.length, 'air terminal') : null];
    return { ceilingMm: median([...cassettes, ...terminals]), derivation: `ceiling plane from ${from.filter(Boolean).join(' and ')}` };
  }
  const ducted = levels((type) => type === 'ducted-ac');
  if (ducted.length) return { ceilingMm: Math.min(...ducted), derivation: `ceiling plane below ${counted(ducted.length, 'ducted unit')}` };
  const roomCeilings = rooms.map((room) => room.properties3D?.ceilingHeight).filter((value): value is number => Number.isFinite(value));
  if (roomCeilings.length) return { ceilingMm: median(roomCeilings), derivation: 'ceiling plane from room ceiling heights' };
  return { ceilingMm: DEFAULT_CEILING_MM, derivation: 'default ceiling plane' };
}

/** The soffit: a service's own setting, else the routing ceiling limit. */
export function buildingSoffitMm(routing: { ceilingLimitMm: number }, ownSetting: number | null | undefined = null): number {
  return ownSetting ?? routing.ceilingLimitMm;
}

/** The walls that stop under the soffit though nothing says they should. */
export function wallsBelowSoffit(walls: readonly DuctWall[], soffitMm: number): DuctWall[] {
  return walls.filter((wall) => !wall.lowByDesign && wall.topZ < soffitMm - 1);
}

/** A warning once services share a drawing with walls that stop short of the soffit (one click raises them). */
export function checkWallsReachSoffit(walls: readonly DuctWall[], soffitMm: number): VrfValidationIssue[] {
  const low = wallsBelowSoffit(walls, soffitMm);
  if (!low.length) return [];
  const tops = [...new Set(low.map((wall) => Math.round(wall.topZ)))].sort((a, b) => a - b);
  const top = tops.length === 1 ? `${tops[0]} mm` : `${tops[0]} to ${tops[tops.length - 1]} mm`;
  const walled = low.length === walls.length ? `All ${counted(low.length, 'wall')}` : `${low.length} of ${counted(walls.length, 'wall')}`;
  return [{
    id: `BUILDING_WALL_LOW:${low.length}:${tops.join(',')}`, level: 'advisory', code: 'BUILDING_WALL_LOW',
    message: `${walled} stop at ${top}, under the ${Math.round(soffitMm)} mm soffit: pipes and ducts higher up pass over them, with no sleeve.`,
    suggestedFix: 'Raise them to the soffit (one undo): every service crossing them then gets its sleeve at the height it crosses. Leave them if they do stop short.',
    fix: { kind: 'raise-walls-to-soffit', wallIds: low.map((wall) => wall.id), soffitMm },
  }];
}

/** The updates that take these walls up to the soffit (one undo, through the store's updateWalls). */
export function raisedWallUpdates(walls: readonly Pick<Wall, 'id' | 'properties3D'>[], wallIds: readonly string[], soffitMm: number): Array<{ id: string; updates: Partial<Wall> }> {
  const raise = new Set(wallIds);
  return walls.filter((wall) => raise.has(wall.id)).map((wall) => ({
    id: wall.id,
    updates: { properties3D: { ...wall.properties3D, height: soffitMm - (wall.properties3D.baseElevation ?? 0) } },
  }));
}

/** Where a pipe passes through a wall, at its own height. */
export interface PipeWallCrossing {
  wallId: string;
  point: Point2D;
  z: number;
  /** Along the pipe, on the plan (unit). */
  direction: Point2D;
  /** Off square to the wall (degrees). */
  angleDeg: number;
  thicknessMm: number;
  /** The wall's thickness seen along the pipe (mm). */
  throughMm: number;
  structural: boolean;
  material?: DuctWall['material'];
  exterior: boolean;
}

/**
 * Every wall a pipe's centreline passes through where its band holds the pipe
 * (insulation included): above a wall's top, or below its base, it does not.
 * Segments are in flow order; a riser crosses nothing.
 */
export function pipeWallCrossings(
  segments: ReadonlyArray<{ a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } }>,
  radiusMm: number,
  walls: readonly DuctWall[],
  rooms: readonly DuctRoomOutline[] = [],
): PipeWallCrossing[] {
  const out: PipeWallCrossing[] = [];
  for (const { a, b } of segments) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.5) continue;
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const found: Array<PipeWallCrossing & { t: number }> = [];
    for (const wall of walls) {
      const t = crossingParameter(a, b, wall.a, wall.b);
      if (t === null) continue;
      const z = a.z + (b.z - a.z) * t;
      if (z + radiusMm <= wall.baseZ || z - radiusMm >= wall.topZ) continue;
      const wallLength = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
      const normal = { x: -(wall.b.y - wall.a.y) / wallLength, y: (wall.b.x - wall.a.x) / wallLength };
      const square = Math.min(1, Math.abs(direction.x * normal.x + direction.y * normal.y));
      const angleDeg = (Math.acos(square) * 180) / Math.PI;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const sides = rooms.length ? wallSides(wall, point, rooms) : null;
      found.push({
        t, wallId: wall.id, point, z, direction, angleDeg, thicknessMm: wall.thicknessMm,
        throughMm: wall.thicknessMm / Math.cos((Math.min(angleDeg, SLEEVE_MAX_ANGLE_DEG) * Math.PI) / 180),
        structural: wall.structural, ...(wall.material ? { material: wall.material } : {}),
        exterior: sides ? sides[0] === null || sides[1] === null : false,
      });
    }
    found.sort((p, q) => p.t - q.t);
    for (const { t: _t, ...crossing } of found) out.push(crossing);
  }
  return out;
}

/** The bore of the sleeve a pipe of this insulated radius takes (mm, to the next 5). */
export function pipeSleeveBoreMm(radiusMm: number): number {
  return Math.ceil((2 * radiusMm + PIPE_SLEEVE_CLEARANCE_MM) / 5) * 5;
}

/**
 * A drain's fittings as built: a wall sleeve stands only where a wall now holds
 * the pipe at its own height, so none floats above a wall the drain passes over
 * and a raised wall has its sleeves at once. An outlet's own sleeve (no wall
 * named) always stands; with no walls known, nothing can be judged.
 */
export function drainFittingsAsBuilt<F extends Pick<CondensateFitting, 'kind' | 'point' | 'outerDiameterMm' | 'note'>>(fittings: readonly F[], walls: readonly DuctWall[]): F[] {
  if (!walls.length) return [...fittings];
  return fittings.filter((fitting) => fitting.kind !== 'wall-sleeve' || !fitting.note || walls.some((wall) => holdsAt(wall, fitting.point, fitting.outerDiameterMm / 2)));
}

function holdsAt(wall: DuctWall, point: { x: number; y: number; z: number }, radiusMm: number): boolean {
  if (point.z + radiusMm <= wall.baseZ || point.z - radiusMm >= wall.topZ) return false;
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const t = Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
  return Math.hypot(point.x - (wall.a.x + dx * t), point.y - (wall.a.y + dy * t)) <= wall.thicknessMm / 2 + 5;
}
