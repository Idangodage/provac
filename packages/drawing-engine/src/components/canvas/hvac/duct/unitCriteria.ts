/**
 * Whose design criteria a unit's ducts are designed and checked by:
 *
 *  1. the unit's own (`properties.designCriteria`), set for it alone;
 *  2. else the strictest of the rooms its terminals are in, a room without
 *     criteria counting as the project's: a unit in a corridor serving offices
 *     is designed by the offices. Strictest is the lowest main velocity limit
 *     (then runout, then supply neck);
 *  3. with no terminals yet, its own room's;
 *  4. else the project's.
 *
 * A room's criteria are stored on the room (they survive re-detection, undo
 * and save), so a new unit in a room designs by them from the start.
 */
import type { HvacElement, Room } from '../../../../types';

import { analyseAirSystems, roomIdOf } from './ductAirSystems';
import { criteriaDuctSettings, criteriaStillApply, readDesignCriteria, readUnitCriteria, type DesignCriteria } from './ductDesignCriteria';
import type { DuctDesignSettings } from './ductSettings';

/** A room as the criteria read it. */
export type CriteriaRoom = Pick<Room, 'id' | 'vertices'> & Partial<Pick<Room, 'name' | 'roomType' | 'designCriteria'>>;

export interface CriteriaWhere {
  scene: readonly HvacElement[];
  rooms: ReadonlyArray<CriteriaRoom>;
  /** Terminals a design in hand serves (a preview's), besides the unit's own system. */
  terminalIds?: readonly string[];
}

export type CriteriaWhose = { kind: 'unit' } | { kind: 'room'; roomId: string } | { kind: 'project' };

export interface UnitCriteria {
  /** The settings its ducts are designed and checked by. */
  settings: DuctDesignSettings;
  /** The criteria those settings come from (null: the project's limits are the designer's own). */
  criteria: DesignCriteria | null;
  whose: CriteriaWhose;
  /** The rooms its system serves (its terminals', else its own), the one that sets the limits first. */
  roomIds: string[];
}

/** A room's own criteria (none: the project's). */
export function readRoomCriteria(room: Pick<Room, 'designCriteria'> | null | undefined): DesignCriteria | null {
  return room ? readDesignCriteria(room.designCriteria) : null;
}

/** The rooms a unit's system serves: its terminals' (and a design's in hand), else its own room. */
export function servedRoomIds(unit: HvacElement, where: CriteriaWhere): string[] {
  const ids = new Set<string>();
  const system = analyseAirSystems(where.scene, where.rooms).byUnit.get(unit.id);
  for (const member of system ? [...system.supply.members, ...system.return.members] : []) {
    if (member.roomId) ids.add(member.roomId);
  }
  if (where.terminalIds?.length) {
    const byId = new Map(where.scene.map((element) => [element.id, element]));
    for (const id of where.terminalIds) {
      const terminal = byId.get(id);
      const roomId = terminal ? roomIdOf(terminal, where.rooms) : null;
      if (roomId) ids.add(roomId);
    }
  }
  if (!ids.size) {
    const own = roomIdOf(unit, where.rooms);
    if (own) ids.add(own);
  }
  return [...ids];
}

/** Negative when `a` is the stricter: the lower main limit, then runout, then supply neck. */
function stricter(a: DuctDesignSettings, b: DuctDesignSettings): number {
  return a.autoMaxVelocityTrunkMs - b.autoMaxVelocityTrunkMs
    || a.autoMaxVelocityRunoutMs - b.autoMaxVelocityRunoutMs
    || a.autoMaxNeckVelocitySupplyMs - b.autoMaxNeckVelocitySupplyMs;
}

const projectCriteria = (settings: DuctDesignSettings) => (criteriaStillApply(settings) ? settings.designCriteria : null);

/** Whose criteria `unit`'s ducts follow, and the settings they give (see the module comment). */
export function unitCriteria(settings: DuctDesignSettings, unit: HvacElement | null | undefined, where: CriteriaWhere): UnitCriteria {
  if (!unit) return { settings, criteria: projectCriteria(settings), whose: { kind: 'project' }, roomIds: [] };
  const roomIds = servedRoomIds(unit, where);
  const own = readUnitCriteria(unit);
  if (own) return { settings: criteriaDuctSettings(settings, own), criteria: own, whose: { kind: 'unit' }, roomIds };
  const byId = new Map(where.rooms.map((room) => [room.id, room]));
  let best: { roomId: string; criteria: DesignCriteria | null; settings: DuctDesignSettings } | null = null;
  for (const roomId of roomIds) {
    const criteria = readRoomCriteria(byId.get(roomId));
    const candidate = { roomId, criteria, settings: criteriaDuctSettings(settings, criteria) };
    if (!best) { best = candidate; continue; }
    const order = stricter(candidate.settings, best.settings);
    // On a tie, a room's own criteria rather than the project's (the chip can name the room).
    if (order < 0 || (order === 0 && candidate.criteria && !best.criteria)) best = candidate;
  }
  if (!best?.criteria) return { settings, criteria: projectCriteria(settings), whose: { kind: 'project' }, roomIds };
  return {
    settings: best.settings, criteria: best.criteria, whose: { kind: 'room', roomId: best.roomId },
    roomIds: [best.roomId, ...roomIds.filter((id) => id !== best!.roomId)],
  };
}

/**
 * The settings `unit`'s ducts are designed and checked by. Without `where`
 * (no rooms at hand) only the unit's own criteria are read.
 */
export function designSettingsForUnit(settings: DuctDesignSettings, unit: HvacElement | null | undefined, where?: CriteriaWhere): DuctDesignSettings {
  if (!where) return criteriaDuctSettings(settings, readUnitCriteria(unit));
  return unitCriteria(settings, unit, where).settings;
}

const CRITERIA_KEYS = new WeakMap<object, string>();

/** The rooms' criteria as one string (an open preview is stale once it changes). */
export function roomCriteriaKey(rooms: ReadonlyArray<CriteriaRoom>): string {
  let key = CRITERIA_KEYS.get(rooms);
  if (key === undefined) {
    key = rooms.flatMap((room) => {
      const criteria = readRoomCriteria(room);
      return criteria ? [`${room.id}:${criteria.room}|${criteria.location}`] : [];
    }).join(',');
    CRITERIA_KEYS.set(rooms, key);
  }
  return key;
}
