/**
 * Auto-turn, Auto route's first step: a 4-way ceiling cassette turned on its
 * centre by a quarter, a half or three quarters when its refrigerant pair and
 * its drain then reach their networks shorter. A 4-way cassette throws the same
 * air at every quarter turn and stays square to the ceiling grid, so only its
 * connections move.
 *
 *  - Eligible: a 4-way cassette whose services this Auto route lays, and whose
 *    refrigerant and drains are all ones this run replaces (or it has none
 *    yet). Never one turned by hand, locked, or piped by hand.
 *  - Scored: the approach of its pair to the outdoor unit and of its drain to
 *    the nearest termination, each routed square round the equipment and ducts
 *    (walls are crossed with sleeves), elbows counted. An estimate: the
 *    approach, not the whole network.
 *  - Compliant: in front of each connection, its straight stub, its first
 *    bend, and the service clearance on the connection side (practice) clear
 *    of walls and equipment.
 *  - Turned only for a real gain: at least `minGainMm`, and `minGainPercent` of
 *    the approach as placed.
 * Pure.
 */
import type { HvacElement, Point2D, Wall } from '../../../types';

import { getIndoorUnitDrainPort } from './condensate/condensatePorts';
import type { CondensateDesignSettings } from './condensate/condensateSettings';
import { isCondensateGully, isCondensatePipe, readCondensateGullySpec, readCondensatePipeSpec } from './condensate/condensateTypes';
import { ductWallsFromWalls } from './duct/ductBuilding';
import { boxOf, cardinalOf, frame, planObstacles } from './duct/ductCollarReroute';
import { findObstacleAwareOrthogonalRoute } from './obstacleAwareOrthogonalRoute';
import type { PipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

export interface AutoTurnSettings {
  /** Auto route may turn 4-way cassettes. */
  enabled: boolean;
  /** Clear space kept in front of a cassette's connection side for its fitting and service (practice). */
  connectionClearanceMm: number;
  /** A turn is made only when it saves at least this much approach … */
  minGainMm: number;
  /** … and this share of the approach as placed (%). */
  minGainPercent: number;
}

export const DEFAULT_AUTO_TURN_SETTINGS: AutoTurnSettings = { enabled: true, connectionClearanceMm: 300, minGainMm: 300, minGainPercent: 5 };

/** Who set a unit's rotation: a person (never turned by Auto route) or Auto route. */
export type OrientationSetBy = 'user' | 'auto-route';
export const ORIENTATION_SET_BY = 'orientationSetBy';

export interface UnitApproach {
  /** The pair's approach to the outdoor unit (mm, elbows counted); null when not laid. */
  refrigerantMm: number | null;
  /** The drain's approach to its termination; null when not laid. */
  drainMm: number | null;
}

export interface UnitTurn {
  unitId: string;
  label: string;
  /** The turn, clockwise on the plan: 90, 180 or 270. */
  angleDeg: number;
  fromDeg: number;
  toDeg: number;
  before: UnitApproach;
  after: UnitApproach;
  /** What it saves (mm); null when, as placed, its connections had no room. */
  gainMm: number | null;
}

export interface UnitKept {
  unitId: string;
  label: string;
  reason: string;
}

export interface UnitOrientationOptions {
  /** The services this Auto route lays. */
  refrigerant: boolean;
  condensate: boolean;
  walls: readonly Wall[];
  settings: AutoTurnSettings;
  condensateSettings: Pick<CondensateDesignSettings, 'defaultPumpMaxLiftMm'>;
  routing: Pick<PipeRoutingSettings, 'minimumPortStubMm'>;
  /** The units in scope (a selection); absent: every cassette. */
  unitIds?: readonly string[];
  /** The terminations in scope; absent: every one. */
  gullyIds?: readonly string[];
  /** Refrigerant and drain runs this Auto route replaces. */
  replaceable: ReadonlySet<string>;
}

const QUARTERS = [0, 90, 270, 180] as const;
const BEND_PENALTY_MM = 600;
const PAIR_HALF_WIDTH_MM = 60;
const DRAIN_HALF_WIDTH_MM = 40;
const DRAIN_STUB_MM = 150;
const BEND_RADIUS_MM = 80;

const normalisedDeg = (deg: number) => ((Math.round(deg * 1e6) / 1e6) % 360 + 360) % 360;
const labelOf = (element: HvacElement) => element.label || element.modelLabel || element.id;

/** A 4-way cassette (its throw the same at every quarter turn). */
export function isFourWayCassette(element: Pick<HvacElement, 'type' | 'label' | 'modelLabel' | 'properties'>): boolean {
  if (element.type !== 'ceiling-cassette-ac') return false;
  const ways = element.properties?.dischargeWays;
  if (typeof ways === 'number') return ways === 4;
  if (/\b4[- ]?way\b/i.test(`${element.label ?? ''} ${element.modelLabel ?? ''}`)) return true;
  // MHI's FDT is the 4-way cassette (FDTS one-way, FDTW two-way).
  const code = String(element.properties?.modelCode ?? element.properties?.model ?? '');
  return /^FDT(?![SW])/i.test(code);
}

/** `element` turned `angleDeg` on its centre (its position is the unturned box's corner, so it stays), marked as Auto route's. */
export function turnedUnit(element: HvacElement, angleDeg: number, by: OrientationSetBy = 'auto-route'): HvacElement {
  return { ...element, rotation: normalisedDeg((element.rotation ?? 0) + angleDeg), properties: { ...element.properties, [ORIENTATION_SET_BY]: by } };
}

export function applyUnitTurns(scene: readonly HvacElement[], turns: readonly UnitTurn[]): HvacElement[] {
  const byId = new Map(turns.map((turn) => [turn.unitId, turn]));
  return scene.map((element) => {
    const turn = byId.get(element.id);
    return turn ? turnedUnit(element, turn.angleDeg) : element;
  });
}

/** The command updates that turn the units (Auto route's one undo). */
export function unitTurnUpdates(scene: readonly HvacElement[], turns: readonly UnitTurn[]): Array<{ id: string; updates: Partial<HvacElement> }> {
  const byId = new Map(scene.map((element) => [element.id, element]));
  return turns.flatMap((turn) => {
    const element = byId.get(turn.unitId);
    if (!element) return [];
    const turned = turnedUnit(element, turn.angleDeg);
    return [{ id: turn.unitId, updates: { rotation: turned.rotation, properties: turned.properties } }];
  });
}

/** The Auto-turn settings a document's routing settings (Route defaults) hold. */
export function autoTurnSettingsOf(settings: Pick<PipeRoutingSettings, 'autoTurnCassettes' | 'cassetteConnectionClearanceMm' | 'autoTurnMinGainMm' | 'autoTurnMinGainPercent'>): AutoTurnSettings {
  return {
    enabled: settings.autoTurnCassettes, connectionClearanceMm: settings.cassetteConnectionClearanceMm,
    minGainMm: settings.autoTurnMinGainMm, minGainPercent: settings.autoTurnMinGainPercent,
  };
}

/** The runs connected to `unitId`: its refrigerant lines and its drain branch. */
export function unitRuns(scene: readonly HvacElement[], unitId: string): HvacElement[] {
  return scene.filter((element) => {
    if (element.type === 'refrigerant-pipe') {
      const spec = resolveRefrigerantPipeSpec(element.properties);
      return spec.startConnection?.sourceElementId === unitId || spec.endConnection?.sourceElementId === unitId;
    }
    return isCondensatePipe(element) && readCondensatePipeSpec(element).drainStart?.unitId === unitId;
  });
}

interface Approach { point: Point2D; direction: Point2D }

/** The unit's connections at a turn: its pair's bundle and its drain outlet. */
function connections(unit: HvacElement, options: UnitOrientationOptions): { pair: Approach | null; drain: Approach | null } {
  const bundle = options.refrigerant
    ? getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port' && target.sourceElementId === unit.id) ?? null
    : null;
  const drain = options.condensate ? getIndoorUnitDrainPort(unit, options.condensateSettings) : null;
  return {
    pair: bundle ? { point: { ...bundle.point }, direction: { ...bundle.direction } } : null,
    drain: drain ? { point: { ...drain.point }, direction: { ...drain.direction } } : null,
  };
}

/** Where its services go: the nearest outdoor unit's ports, the nearest termination. */
function targets(scene: readonly HvacElement[], unit: HvacElement, options: UnitOrientationOptions): { pair: Approach | null; drain: Point2D | null } {
  const centre = { x: unit.position.x + unit.width / 2, y: unit.position.y + unit.depth / 2 };
  const nearest = <T>(list: T[], at: (item: T) => Point2D) => list
    .map((item) => ({ item, gap: Math.hypot(at(item).x - centre.x, at(item).y - centre.y) }))
    .sort((a, b) => a.gap - b.gap)[0]?.item ?? null;
  const outdoor = options.refrigerant
    ? nearest(getRefrigerantPipeBundleSnapTargets(scene.filter((element) => element.type === 'outdoor-unit'))
      .filter((target) => target.connectionKind === 'unit-port'), (target) => target.point)
    : null;
  const inScope = options.gullyIds ? new Set(options.gullyIds) : null;
  const gully = options.condensate
    ? nearest(scene.filter((element) => isCondensateGully(element) && (!inScope || inScope.has(element.id))), (element) => readCondensateGullySpec(element).connectionPoint)
    : null;
  return {
    pair: outdoor ? { point: { ...outdoor.point }, direction: { ...outdoor.direction } } : null,
    drain: gully ? readCondensateGullySpec(gully).connectionPoint : null,
  };
}

/**
 * The approach from `from` (its outward direction) to `to`, routed square in the unit's own frame round the
 * obstacles; its length with each elbow counted, or null when no way is found.
 */
function approachMm(
  from: Approach,
  to: { point: Point2D; direction: Point2D | null },
  obstacles: ReturnType<typeof planObstacles>,
  axis: Point2D,
  halfWidthMm: number,
  stubMm: number,
): number | null {
  const f = frame(from.point, axis);
  const start = cardinalOf(f.dirToLocal(from.direction));
  const end = f.toLocal(to.point);
  // The end's own outward direction when it has one (a port), else facing back the way the route comes.
  const facing = to.direction ? cardinalOf(f.dirToLocal(to.direction))
    : Math.abs(end.x) >= Math.abs(end.y) ? { x: -Math.sign(end.x) || 1, y: 0 } : { x: 0, y: -Math.sign(end.y) || 1 };
  if (!start || !facing) return null;
  const boxes = obstacles.map((obstacle) => (obstacle.shape.kind === 'leg'
    ? boxOf([obstacle.shape.a, obstacle.shape.b].map(f.toLocal), obstacle.shape.halfWidthMm)
    : boxOf(obstacle.shape.corners.map(f.toLocal))));
  const route = findObstacleAwareOrthogonalRoute({
    start: { x: 0, y: 0 }, startDirection: start, end, endDirection: facing, startStraightMm: stubMm, endStraightMm: 0,
    bendRadiusMm: BEND_RADIUS_MM, obstacles: boxes, clearanceMm: halfWidthMm, bendPenaltyMm: BEND_PENALTY_MM,
  });
  return route ? route.lengthMm + route.bends * BEND_PENALTY_MM : null;
}

/** Whether the stretch in front of a connection (stub, first bend, service clearance) is clear of walls and equipment. */
function roomInFront(from: Approach, reachMm: number, halfWidthMm: number, obstacles: ReturnType<typeof planObstacles>): boolean {
  const tip = { x: from.point.x + from.direction.x * reachMm, y: from.point.y + from.direction.y * reachMm };
  const box = boxOf([from.point, tip], halfWidthMm);
  // Just clear of the unit's own face: the stretch starts where the connection leaves it.
  return !obstacles.some((obstacle) => {
    const other = obstacle.shape.kind === 'leg' ? boxOf([obstacle.shape.a, obstacle.shape.b], obstacle.shape.halfWidthMm) : boxOf(obstacle.shape.corners);
    return other.minX < box.maxX && box.minX < other.maxX && other.minY < box.maxY && box.minY < other.maxY;
  });
}

/** The turns Auto route makes before it routes (see the module comment), and why the others were kept. */
export function planUnitOrientations(scene: readonly HvacElement[], options: UnitOrientationOptions): { turns: UnitTurn[]; kept: UnitKept[] } {
  const turns: UnitTurn[] = [];
  const kept: UnitKept[] = [];
  if (!options.settings.enabled || (!options.refrigerant && !options.condensate)) return { turns, kept };
  const scope = options.unitIds ? new Set(options.unitIds) : null;
  const walls = ductWallsFromWalls(options.walls);
  for (const unit of scene) {
    if (!isFourWayCassette(unit) || (scope && !scope.has(unit.id))) continue;
    const label = labelOf(unit);
    if (unit.properties?.[ORIENTATION_SET_BY] === 'user') { kept.push({ unitId: unit.id, label, reason: 'turned by hand' }); continue; }
    if (unit.properties?.locked === true) { kept.push({ unitId: unit.id, label, reason: 'locked' }); continue; }
    if (unitRuns(scene, unit.id).some((run) => !options.replaceable.has(run.id))) {
      kept.push({ unitId: unit.id, label, reason: 'its pipes or drain are kept as they are (drawn by hand, edited or locked)' });
      continue;
    }
    const goal = targets(scene, unit, options);
    if (!goal.pair && !goal.drain) continue;
    // Everything but this unit and what it connects to stands in the way (walls only in front of its connections).
    const around = planObstacles(scene, new Set([unit.id]), []);
    const inFront = planObstacles(scene, new Set([unit.id]), walls);
    const axis = { x: Math.cos(((unit.rotation ?? 0) * Math.PI) / 180), y: Math.sin(((unit.rotation ?? 0) * Math.PI) / 180) };
    const reach = Math.max(options.routing.minimumPortStubMm + 2 * BEND_RADIUS_MM, options.settings.connectionClearanceMm);
    const scored = QUARTERS.map((angleDeg) => {
      const at = connections(angleDeg ? turnedUnit(unit, angleDeg) : unit, options);
      const clear = (!at.pair || roomInFront(at.pair, reach, PAIR_HALF_WIDTH_MM, inFront))
        && (!at.drain || roomInFront(at.drain, Math.max(DRAIN_STUB_MM + 2 * BEND_RADIUS_MM, options.settings.connectionClearanceMm), DRAIN_HALF_WIDTH_MM, inFront));
      const refrigerantMm = goal.pair && at.pair
        ? approachMm(at.pair, goal.pair, around.filter((obstacle) => !isOutdoorObstacle(scene, obstacle.ownerId)), axis, PAIR_HALF_WIDTH_MM, options.routing.minimumPortStubMm)
        : null;
      const drainMm = goal.drain && at.drain
        ? approachMm(at.drain, { point: goal.drain, direction: null }, around.filter((obstacle) => !isGullyObstacle(scene, obstacle.ownerId)), axis, DRAIN_HALF_WIDTH_MM, DRAIN_STUB_MM)
        : null;
      const missing = (goal.pair && refrigerantMm === null) || (goal.drain && drainMm === null);
      const score = !clear || missing ? Number.POSITIVE_INFINITY : (refrigerantMm ?? 0) + (drainMm ?? 0);
      return { angleDeg, approach: { refrigerantMm, drainMm }, score, clear };
    });
    const asPlaced = scored[0]!;
    // The best turn (the smaller one on a tie: QUARTERS lists a quarter before a half).
    const best = scored.slice(1).reduce((winner, candidate) => (candidate.score < winner.score ? candidate : winner));
    if (!Number.isFinite(best.score)) continue;
    const gainMm = Number.isFinite(asPlaced.score) ? asPlaced.score - best.score : null;
    const worthIt = gainMm === null
      || (gainMm >= options.settings.minGainMm && gainMm >= (asPlaced.score * options.settings.minGainPercent) / 100);
    if (!worthIt) continue;
    const fromDeg = normalisedDeg(unit.rotation ?? 0);
    turns.push({
      unitId: unit.id, label, angleDeg: best.angleDeg, fromDeg, toDeg: normalisedDeg(fromDeg + best.angleDeg),
      before: asPlaced.approach, after: best.approach, gainMm: gainMm === null ? null : Math.round(gainMm),
    });
  }
  return { turns, kept };
}

function isOutdoorObstacle(scene: readonly HvacElement[], ownerId: string): boolean {
  return scene.some((element) => element.id === ownerId && element.type === 'outdoor-unit');
}

function isGullyObstacle(scene: readonly HvacElement[], ownerId: string): boolean {
  return scene.some((element) => element.id === ownerId && isCondensateGully(element));
}

/** "FDT28 (Office 2) turned 90° clockwise: pipes 2.10 m, drain 0.80 m shorter". */
export function unitTurnText(turn: UnitTurn): string {
  const saved = (before: number | null, after: number | null) => (before !== null && after !== null && before - after > 50
    ? `${((before - after) / 1000).toFixed(2)} m` : null);
  const pipes = saved(turn.before.refrigerantMm, turn.after.refrigerantMm);
  const drain = saved(turn.before.drainMm, turn.after.drainMm);
  const gains = [pipes ? `pipes ${pipes}` : null, drain ? `drain ${drain}` : null].filter(Boolean);
  const how = turn.angleDeg === 90 ? '90° clockwise' : turn.angleDeg === 270 ? '90° anticlockwise' : `${turn.angleDeg}°`;
  return `${turn.label} turned ${how}: ${turn.gainMm === null ? 'its connections had no room as placed'
    : gains.length ? `${gains.join(', ')} shorter` : `${(turn.gainMm / 1000).toFixed(2)} m shorter`}`;
}
