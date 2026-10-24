/**
 * What Auto route advises for a ducted unit it cannot serve well, each with
 * the change that puts it right:
 *  - a unit turned away from its terminals (a duct leaves a collar forwards):
 *    the quarter turn that puts them ahead of their collars;
 *  - too few terminals for the unit's airflow (every neck over its velocity
 *    limit): how many it needs at each catalogue neck, and a proposal that
 *    adds them, spread evenly over the free ceiling, and re-necks the ones
 *    there, so each neck stays within the limit.
 * Pure: elements in, advice and elements out.
 */
import { DEFAULT_AC_EQUIPMENT_LIBRARY, type AcEquipmentDefinition } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D, Room } from '../../../../types';
import { isPointInPolygon } from '../../../../utils/geometry';

import { isCondensateGully, isCondensatePipe } from '../condensate/condensateTypes';

import { resolveUnitAirPorts, type DuctAirPort } from './ductAirPorts';
import type { DuctDesignSettings } from './ductSettings';
import { neckVelocityMs } from './ductSizing';
import type { DuctTerminalKind } from './ductTerminalCatalog';
import { nextTerminalTag, readDuctTerminalSpec, terminalCeilingPlane } from './ductTerminals';
import { isDuctElement, type DuctService } from './ductTypes';

const centreOf = (element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D => ({
  x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2,
});

/** The quarter turn that puts more of a unit's terminals ahead of their collars. */
export interface UnitTurnAdvice {
  angleDeg: 90 | 180 | 270;
  /** Terminals ahead of their collar after the turn, and now. */
  ahead: number;
  aheadNow: number;
  total: number;
}

/**
 * The quarter turn (180° first: the unit keeps its footprint) that puts the
 * most of these terminals ahead of their collars, when that is more than now;
 * null when no turn helps. A terminal is ahead when its centre lies in front
 * of the plane of its service's collar.
 */
export function unitTurnToFaceTerminals(unit: HvacElement, terminals: readonly HvacElement[]): UnitTurnAdvice | null {
  const served = terminals.flatMap((terminal) => {
    const spec = readDuctTerminalSpec(terminal);
    return spec ? [{ centre: centreOf(terminal), service: spec.service }] : [];
  });
  if (!served.length) return null;
  const aheadAfter = (turnDeg: number) => {
    const ports = resolveUnitAirPorts({ ...unit, rotation: (unit.rotation ?? 0) + turnDeg }).filter((port) => !port.vertical);
    return served.filter(({ centre, service }) => {
      const port = ports.find((candidate) => candidate.kind === service);
      return port !== undefined && (centre.x - port.lip.x) * port.normal.x + (centre.y - port.lip.y) * port.normal.y > 0;
    }).length;
  };
  const aheadNow = aheadAfter(0);
  let best: UnitTurnAdvice | null = null;
  for (const angleDeg of [180, 90, 270] as const) {
    const ahead = aheadAfter(angleDeg);
    if (ahead > aheadNow && (!best || ahead > best.ahead)) best = { angleDeg, ahead, aheadNow, total: served.length };
  }
  return best;
}

/** The most air a round neck takes within a velocity limit (m³/h). */
export function neckCapacityM3h(neckMm: number, maxVelocityMs: number): number {
  return maxVelocityMs * Math.PI * (neckMm / 2000) ** 2 * 3600;
}

/** A service whose terminals cannot pass the unit's airflow within the neck velocity limit. */
export interface TerminalShortfall {
  service: DuctService;
  airflowM3h: number;
  count: number;
  /** Each terminal's equal share (m³/h). */
  perTerminalM3h: number;
  /** The smallest neck among them, and the velocity its share gives there. */
  neckMm: number;
  velocityMs: number;
  capMs: number;
  /** The fewest terminals that keep every neck within the limit, at each catalogue neck of their face (largest first). */
  needed: Array<{ neckMm: number; count: number }>;
}

/** The catalogue's terminals for a face and service, smallest neck first. */
export function catalogueTerminals(kind: DuctTerminalKind, service: DuctService): AcEquipmentDefinition[] {
  return DEFAULT_AC_EQUIPMENT_LIBRARY.filter((definition) => {
    const spec = definition.defaultProperties?.terminal as { kind?: string; service?: string; neckDiameterMm?: number; filter?: unknown } | undefined;
    return spec?.kind === kind && spec.service === service && !spec.filter && typeof spec.neckDiameterMm === 'number';
  }).sort((a, b) => (a.defaultProperties!.terminal as { neckDiameterMm: number }).neckDiameterMm
    - (b.defaultProperties!.terminal as { neckDiameterMm: number }).neckDiameterMm);
}

/**
 * Whether one service's terminals can pass the unit's airflow: each takes an
 * equal share, and the share must keep its neck within the velocity limit.
 * Null when they can (or there are none).
 */
export function terminalShortfall(
  terminals: readonly HvacElement[], service: DuctService, airflowM3h: number, settings: Pick<DuctDesignSettings, 'autoMaxNeckVelocitySupplyMs' | 'autoMaxNeckVelocityReturnMs'>,
): TerminalShortfall | null {
  const specs = terminals.flatMap((terminal) => {
    const spec = readDuctTerminalSpec(terminal);
    return spec && spec.service === service ? [spec] : [];
  });
  if (!specs.length || !(airflowM3h > 0)) return null;
  const capMs = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const perTerminalM3h = airflowM3h / specs.length;
  const neckMm = Math.min(...specs.map((spec) => spec.neckDiameterMm));
  const velocityMs = neckVelocityMs({ neckDiameterMm: neckMm }, perTerminalM3h);
  if (velocityMs <= capMs * 1.001) return null;
  const kind = mostCommon(specs.map((spec) => spec.kind));
  const necks = [...new Set(catalogueTerminals(kind, service).map((definition) => (definition.defaultProperties!.terminal as { neckDiameterMm: number }).neckDiameterMm))]
    .filter((neck) => neck >= neckMm).sort((a, b) => b - a);
  const needed = (necks.length ? necks : [neckMm]).map((neck) => ({ neckMm: neck, count: Math.ceil(airflowM3h / neckCapacityM3h(neck, capMs) - 1e-9) }));
  return { service, airflowM3h, count: specs.length, perTerminalM3h, neckMm, velocityMs, capMs, needed };
}

function mostCommon<T>(values: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Terminals added (and re-necked) for one service of a unit: shown as a preview, applied as one undo. */
export interface TerminalProposal {
  unitId: string;
  service: DuctService;
  neckMm: number;
  /** Terminals the service will have, and has now. */
  total: number;
  current: number;
  add: HvacElement[];
  /** The service's terminals there, as they will be: in the unit's air system, a smaller neck made the chosen one. */
  updates: HvacElement[];
}

/** Clear distances the proposal keeps (mm, practice): from walls, the unit, other bodies, and the other service. */
const WALL_CLEARANCE_MM = 800;
const UNIT_CLEARANCE_MM = 900;
const BODY_CLEARANCE_MM = 300;
const OTHER_SERVICE_MM = 1500;
/** How far ahead of its service's collar a new terminal goes at least: a duct leaves a collar forwards (mm). */
const AHEAD_OF_COLLAR_MM = 1500;
/** A row of terminals: at least this far ahead of the collar, terminals within this of it on it, its stations' step (mm). */
const ROW_MIN_AHEAD_MM = 2500;
const ROW_TOLERANCE_MM = 1200;
const ROW_STEP_MM = 50;
/** The step of the candidate positions (a ceiling-tile module). */
const GRID_STEP_MM = 300;

/**
 * The terminals one service of a unit needs for its airflow, at the largest
 * catalogue neck of their face: the ones there re-necked to it, the rest
 * added as a designer lays them out: in a row parallel to the collar's face
 * with the service's terminals already there, in its free places (see
 * rowPlaces); where no row takes them, each where it is farthest from the
 * service's other terminals. Always inside the room of the unit (or of its
 * terminals), at least 1.5 m ahead of the service's collar (a duct leaves a
 * collar forwards), clear of the walls, the unit, other equipment and, where
 * the room allows, the other service's terminals (supply and return apart, so
 * the air does not short-circuit). Null when nothing is short or there is no
 * room to place in.
 */
export function proposeTerminals(
  scene: readonly HvacElement[], rooms: readonly Room[], unitId: string, terminalIds: readonly string[], service: DuctService,
  airflowM3h: number, settings: Pick<DuctDesignSettings, 'autoMaxNeckVelocitySupplyMs' | 'autoMaxNeckVelocityReturnMs' | 'defaultCollarEntry'>,
  newId: () => string,
): TerminalProposal | null {
  const unit = scene.find((element) => element.id === unitId);
  if (!unit) return null;
  const ids = new Set(terminalIds);
  const own = scene.filter((element) => ids.has(element.id) && readDuctTerminalSpec(element)?.service === service);
  const shortfall = terminalShortfall(own, service, airflowM3h, settings);
  if (!shortfall) return null;
  const neckMm = shortfall.needed[0]!.neckMm;
  const total = Math.max(own.length, shortfall.needed[0]!.count);
  const kind = mostCommon(own.map((element) => readDuctTerminalSpec(element)!.kind));
  const definition = catalogueTerminals(kind, service).find((entry) => (entry.defaultProperties!.terminal as { neckDiameterMm: number }).neckDiameterMm === neckMm);
  if (!definition) return null;
  const spec = definition.defaultProperties!.terminal as Record<string, unknown>;

  // Where to place: the room holding the unit, else the rooms holding its terminals.
  const roomOf = (point: Point2D) => rooms.find((room) => room.vertices.length >= 3 && isPointInPolygon(point, room.vertices));
  const unitRoom = roomOf(centreOf(unit));
  const places = unitRoom ? [unitRoom] : [...new Set(own.map((element) => roomOf(centreOf(element))).filter((room): room is Room => Boolean(room)))];
  const count = total - own.length;
  const halfFace = Math.max(definition.widthMm, definition.depthMm) / 2;
  // Bodies in the ceiling plane: units and terminals (pipes, kits, drains and ducts run in the void above it).
  const others = scene.filter((element) => element.id !== unit.id && !ids.has(element.id) && element.width > 0 && element.depth > 0
    && element.type !== 'refrigerant-pipe' && element.type !== 'refrigerant-branch-kit' && !isDuctElement(element)
    && !isCondensatePipe(element) && !isCondensateGully(element));
  const otherService = scene.filter((element) => readDuctTerminalSpec(element) && readDuctTerminalSpec(element)!.service !== service).map(centreOf);
  // A duct leaves its collar forwards: a new terminal goes ahead of its service's collar (behind it, no duct reaches).
  const collar = resolveUnitAirPorts(unit).find((port) => port.kind === service && !port.vertical);
  const ahead = (point: Point2D) => !collar
    || (point.x - collar.lip.x) * collar.normal.x + (point.y - collar.lip.y) * collar.normal.y >= AHEAD_OF_COLLAR_MM;
  const gap = halfFace * 2 + BODY_CLEARANCE_MM;
  const fits = (point: Point2D, room: Room) => isPointInPolygon(point, room.vertices) && edgeDistance(point, room.vertices) >= WALL_CLEARANCE_MM
    && rectangleDistance(point, unit) >= UNIT_CLEARANCE_MM + halfFace
    && others.every((element) => rectangleDistance(point, element) >= BODY_CLEARANCE_MM + halfFace);
  const placed: Point2D[] = own.map(centreOf);
  // A row first, as a designer lays them out: the service's terminals evenly along a line parallel to the collar's
  // face, where its terminals already are, else halfway across the room ahead of it. The terminals there move onto
  // their places in it (a proposal, shown before it is applied); the new ones take its free places.
  const row = count > 0 && collar && unitRoom ? rowLayout(collar, unitRoom, placed, total, count, gap, (point) => fits(point, unitRoom)) : null;

  // The service's terminals there: each joins the unit's air system, one with a smaller neck takes the catalogue
  // entry with the chosen neck, and one on the row moves onto its place (each centred where it then is).
  const updates = own.flatMap((element, index): HvacElement[] => {
    const reneck = readDuctTerminalSpec(element)!.neckDiameterMm < neckMm;
    const joins = (element.properties.airSystem as { unitId?: unknown } | undefined)?.unitId !== unitId;
    const moveTo = row?.snapped[index] ?? null;
    if (!reneck && !joins && !moveTo) return [];
    const centre = moveTo ?? centreOf(element);
    const joined = { ...element, properties: { ...element.properties, airSystem: { unitId } } };
    if (!reneck) return [{ ...joined, position: { x: centre.x - element.width / 2, y: centre.y - element.depth / 2 } }];
    const old = (element.properties.terminal ?? {}) as Record<string, unknown>;
    return [{
      ...joined, modelLabel: definition.modelLabel, subtype: definition.subtype,
      position: { x: centre.x - definition.widthMm / 2, y: centre.y - definition.depthMm / 2 },
      width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm,
      properties: { ...joined.properties, definitionId: definition.id, terminal: { ...spec, ...pick(old, ['spigotSide', 'spigotEntry', 'designAirflowM3h']) } },
    }];
  });

  const add: HvacElement[] = [];
  if (count > 0 && places.length) {
    const chosen: Point2D[] = [...(row?.add ?? [])];
    const settledPlaces = own.map((element, index) => row?.snapped[index] ?? centreOf(element));
    // Where no row takes them all: the free spot farthest from the service's terminals, one by one.
    if (chosen.length < count) {
      const candidates = places.flatMap((room) => {
        const xs = room.vertices.map((vertex) => vertex.x);
        const ys = room.vertices.map((vertex) => vertex.y);
        const out: Point2D[] = [];
        for (let x = Math.min(...xs) + GRID_STEP_MM / 2; x < Math.max(...xs); x += GRID_STEP_MM) {
          for (let y = Math.min(...ys) + GRID_STEP_MM / 2; y < Math.max(...ys); y += GRID_STEP_MM) {
            const point = { x, y };
            if (ahead(point) && fits(point, room)) out.push(point);
          }
        }
        return out;
      });
      const clearOfOther = (point: Point2D) => otherService.every((centre) => Math.hypot(point.x - centre.x, point.y - centre.y) >= OTHER_SERVICE_MM);
      while (chosen.length < count) {
        const taken = [...settledPlaces, ...chosen];
        const pool = candidates.filter((point) => taken.every((centre) => Math.hypot(point.x - centre.x, point.y - centre.y) >= gap));
        const preferred = pool.filter(clearOfOther);
        const choices = preferred.length ? preferred : pool;
        if (!choices.length) break;
        chosen.push(choices.reduce((winner, point) => (nearest(point, taken) > nearest(winner, taken) ? point : winner)));
      }
    }
    for (const best of chosen) {
      const label = nextTerminalTag([...scene, ...add], readDuctTerminalSpec({ type: definition.type, properties: definition.defaultProperties ?? {} })!);
      add.push({
        id: newId(), type: definition.type, category: definition.equipmentCategory, subtype: definition.subtype, modelLabel: definition.modelLabel,
        position: { x: best.x - definition.widthMm / 2, y: best.y - definition.depthMm / 2 }, rotation: 0,
        width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm,
        elevation: terminalCeilingPlane([...scene]), mountType: definition.mountType, label,
        ...(unitRoom ?? roomOf(best) ? { roomId: (unitRoom ?? roomOf(best))!.id } : {}),
        supplyZoneRatio: definition.supplyZoneRatio ?? 0.5,
        properties: {
          definitionId: definition.id, ...(definition.defaultProperties ?? {}), airSystem: { unitId },
          ...(settings.defaultCollarEntry === 'top' ? { terminal: { ...spec, spigotEntry: 'top' } } : {}),
        },
      } as HvacElement);
    }
  }
  if (!add.length && !updates.length) return null;
  return { unitId, service, neckMm, total: own.length + add.length, current: own.length, add, updates };
}

/**
 * A row of `total` terminals: a line parallel to the collar's face, where the
 * service's terminals already are (at least 2.5 m ahead; the median of
 * theirs), else halfway across the room ahead of the collar; across the
 * longest stretch of the room there, cut into `total` equal strips, a place
 * at the middle of each (each terminal serving an equal share of the room).
 * A terminal near the row moves onto the nearest free place (where it fits);
 * the new ones take the free places left, those farthest from the terminals
 * first, each moved along the row (up to a quarter of the spacing) where a
 * wall or equipment is too near its place. Null when no row fits.
 */
function rowLayout(collar: DuctAirPort, room: Room, existing: readonly Point2D[], total: number, count: number, gap: number,
  fits: (point: Point2D) => boolean): { add: Point2D[]; snapped: Array<Point2D | null> } | null {
  const n = collar.normal;
  const t = { x: -n.y, y: n.x };
  const lip = collar.lip;
  const aheadOf = (point: Point2D) => (point.x - lip.x) * n.x + (point.y - lip.y) * n.y;
  const acrossOf = (point: Point2D) => (point.x - lip.x) * t.x + (point.y - lip.y) * t.y;
  const at = (ahead: number, across: number): Point2D => ({ x: lip.x + n.x * ahead + t.x * across, y: lip.y + n.y * ahead + t.y * across });
  const reach = Math.max(...room.vertices.map(aheadOf)) - WALL_CLEARANCE_MM;
  const already = existing.map(aheadOf).filter((value) => value >= ROW_MIN_AHEAD_MM).sort((a, b) => a - b);
  const ahead = Math.min(already.length ? already[Math.floor(already.length / 2)]! : Math.max(ROW_MIN_AHEAD_MM, reach / 2), reach);
  if (ahead < ROW_MIN_AHEAD_MM) return null;
  const span = Math.max(...room.vertices.map((vertex) => Math.hypot(vertex.x - lip.x, vertex.y - lip.y))) + 1000;
  let best: { from: number; to: number } | null = null;
  let run: { from: number; to: number } | null = null;
  for (let across = -span; across <= span; across += ROW_STEP_MM) {
    if (isPointInPolygon(at(ahead, across), room.vertices)) {
      run = run ? { from: run.from, to: across } : { from: across, to: across };
      if (!best || run.to - run.from > best.to - best.from) best = { ...run };
    } else run = null;
  }
  if (!best || best.to <= best.from) return null;
  const spacing = (best.to - best.from) / total;
  const slots = Array.from({ length: total }, (_, index) => best!.from + (index + 0.5) * spacing);
  // The terminals near the row onto their nearest free places (where they fit there), nearest first.
  const taken = new Set<number>();
  const snapped: Array<Point2D | null> = existing.map(() => null);
  const near = existing.map((point, index) => ({ point, index })).filter(({ point }) => Math.abs(aheadOf(point) - ahead) <= ROW_TOLERANCE_MM)
    .map(({ point, index }) => {
      const slot = slots.reduce((winner, candidate, k) => (Math.abs(candidate - acrossOf(point)) < Math.abs(slots[winner]! - acrossOf(point)) ? k : winner), 0);
      return { index, slot, off: Math.abs(slots[slot]! - acrossOf(point)) };
    }).sort((a, b) => a.off - b.off);
  for (const { index, slot, off } of near) {
    if (taken.has(slot) || off >= spacing / 2) continue;
    const point = at(ahead, slots[slot]!);
    if (!fits(point)) continue;
    taken.add(slot);
    snapped[index] = point;
  }
  const settled = existing.map((point, index) => snapped[index] ?? point);
  const fromSettled = (slot: number) => nearest(at(ahead, slot), settled);
  const free = slots.filter((_, k) => !taken.has(k)).sort((a, b) => fromSettled(b) - fromSettled(a));
  const add: Point2D[] = [];
  for (const slot of free) {
    if (add.length >= count) break;
    const shifts = [0];
    for (let shift = 150; shift <= spacing / 4; shift += 150) shifts.push(shift, -shift);
    for (const shift of shifts) {
      const point = at(ahead, slot + shift);
      const clear = (other: Point2D) => Math.hypot(point.x - other.x, point.y - other.y) >= gap;
      if (fits(point) && settled.every(clear) && add.every(clear)) { add.push(point); break; }
    }
  }
  return { add, snapped };
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

const nearest = (point: Point2D, centres: readonly Point2D[]) => centres.reduce((least, centre) => Math.min(least, Math.hypot(point.x - centre.x, point.y - centre.y)), Number.POSITIVE_INFINITY);

/** Plan distance from a point to an element's (unrotated) body; 0 inside. */
function rectangleDistance(point: Point2D, element: Pick<HvacElement, 'position' | 'width' | 'depth'>): number {
  const dx = Math.max(element.position.x - point.x, 0, point.x - (element.position.x + element.width));
  const dy = Math.max(element.position.y - point.y, 0, point.y - (element.position.y + element.depth));
  return Math.hypot(dx, dy);
}

/** Plan distance from a point to the nearest edge of a polygon. */
function edgeDistance(point: Point2D, vertices: readonly Point2D[]): number {
  let least = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
    least = Math.min(least, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return least;
}
