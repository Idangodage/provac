/**
 * Air systems: each ducted unit with the supply and return terminals dedicated
 * to it. A terminal belongs to a unit when it is assigned to it
 * (`properties.airSystem.unitId`, the designer's intent) or, unassigned, when
 * the unit's duct tree reaches it (the duct is the connection). Everything here
 * is derived from the scene: nothing but the assignment and the unit's system
 * tag (`properties.airSystemTag`, "DU-1") is stored.
 *
 * Pure and memoised per scene snapshot (scenes are immutable), like the duct
 * network index.
 */
import type { HvacElement, Point2D, Room } from '../../../../types';
import { isPointInPolygon } from '../../../../utils/geometry';

import { listAirPorts, type DuctAirPort } from './ductAirPorts';
import { ductParentOf } from './ductNetwork';
import { neckVelocityMs, shareAirflow } from './ductSizing';
import { basisAirflowM3h } from './ductSystemSizing';
import {
  isDuctTerminalElement,
  readDuctTerminalSpec,
  terminalLabel,
  terminalPressureDropPa,
  terminalTypeTag,
  TERMINAL_TAG_PATTERN,
  type DuctTerminalSpec,
  type TerminalDropSettings,
} from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctService } from './ductTypes';

export const AIR_SYSTEM_TAG_PREFIX = 'DU';
const DERIVED_TAG = /^DU-(\d+)$/i;

/**
 * One colour per system (categorical, distinct from supply blue, return teal,
 * selection amber and error red), by the unit's order among the ducted units.
 */
export const AIR_SYSTEM_COLORS = ['#7c3aed', '#c026d3', '#ea580c', '#4d7c0f', '#4338ca', '#a16207', '#db2777', '#57534e'] as const;

export function isAirSystemUnit(element: Pick<HvacElement, 'type'>): boolean {
  return element.type === 'ducted-ac';
}

/** The unit a terminal is assigned to (its "served by"), or null. */
export function readAirSystemAssignment(terminal: Pick<HvacElement, 'properties'>): string | null {
  const raw = terminal.properties.airSystem as { unitId?: unknown } | null | undefined;
  return raw && typeof raw === 'object' && typeof raw.unitId === 'string' && raw.unitId ? raw.unitId : null;
}

function storedTag(unit: Pick<HvacElement, 'properties'>): string | null {
  const raw = unit.properties.airSystemTag;
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 24) : null;
}

const TAG_CACHE = new WeakMap<readonly HvacElement[], Map<string, string>>();

/**
 * Every ducted unit's system tag, in scene order: its stored tag (the first
 * unit to use a tag keeps it), else the next free "DU-n" after every number
 * already in use, so a derived tag never collides with a stored one.
 */
export function airSystemTags(scene: readonly HvacElement[]): Map<string, string> {
  const cached = TAG_CACHE.get(scene);
  if (cached) return cached;
  const units = scene.filter(isAirSystemUnit);
  const tags = new Map<string, string>();
  const used = new Set<string>();
  let highest = 0;
  for (const unit of units) {
    const tag = storedTag(unit);
    const number = tag ? DERIVED_TAG.exec(tag)?.[1] : undefined;
    if (number) highest = Math.max(highest, Number(number));
  }
  for (const unit of units) {
    const tag = storedTag(unit);
    if (tag && !used.has(tag.toUpperCase())) {
      tags.set(unit.id, tag);
      used.add(tag.toUpperCase());
    }
  }
  for (const unit of units) {
    if (tags.has(unit.id)) continue;
    let tag: string;
    do { tag = `${AIR_SYSTEM_TAG_PREFIX}-${(highest += 1)}`; } while (used.has(tag));
    tags.set(unit.id, tag);
    used.add(tag);
  }
  TAG_CACHE.set(scene, tags);
  return tags;
}

export function airSystemTagOf(unit: Pick<HvacElement, 'id'>, scene: readonly HvacElement[]): string {
  return airSystemTags(scene).get(unit.id) ?? AIR_SYSTEM_TAG_PREFIX;
}

/** The tag a newly placed ducted unit takes: one past the highest "DU-n" in use (stored or derived). */
export function nextAirSystemTag(scene: readonly HvacElement[]): string {
  let highest = 0;
  for (const tag of airSystemTags(scene).values()) {
    const number = DERIVED_TAG.exec(tag)?.[1];
    if (number) highest = Math.max(highest, Number(number));
  }
  return `${AIR_SYSTEM_TAG_PREFIX}-${highest + 1}`;
}

export function airSystemColorOf(unitId: string, scene: readonly HvacElement[]): string {
  const index = scene.filter(isAirSystemUnit).findIndex((unit) => unit.id === unitId);
  return AIR_SYSTEM_COLORS[(index < 0 ? 0 : index) % AIR_SYSTEM_COLORS.length]!;
}

/** The tag a terminal shows: its own short label ("RAG-3"), else its type ("RAG"). */
export function terminalTagOf(terminal: Pick<HvacElement, 'label'>, spec: Pick<DuctTerminalSpec, 'kind' | 'service'>): string {
  const label = (terminal.label ?? '').trim();
  return TERMINAL_TAG_PATTERN.test(label) ? label : terminalTypeTag(spec);
}

export interface ServingUnit {
  unitId: string;
  /** The service of the duct that reaches the terminal (its root's). */
  service: DuctService;
  /** The run that ends on the terminal. */
  runId: string;
}

const SERVING_CACHE = new WeakMap<readonly HvacElement[], Map<string, ServingUnit>>();

/** Per terminal: the unit whose duct tree reaches it (walked up from the run ending on it to the run off a collar). */
export function servingUnits(scene: readonly HvacElement[]): Map<string, ServingUnit> {
  const cached = SERVING_CACHE.get(scene);
  if (cached) return cached;
  const out = new Map<string, ServingUnit>();
  for (const element of scene) {
    if (!isDuctElement(element)) continue;
    const spec = readDuctRunSpec(element);
    if (!spec || spec.end.kind !== 'terminal') continue;
    let root = spec;
    const seen = new Set<string>([element.id]);
    for (let parent = ductParentOf(root, scene); parent && !seen.has(parent.id); parent = ductParentOf(root, scene)) {
      seen.add(parent.id);
      const parentSpec = readDuctRunSpec(parent);
      if (!parentSpec) break;
      root = parentSpec;
    }
    if (root.start.kind === 'unit-port') out.set(spec.end.terminalId, { unitId: root.start.unitId, service: root.service, runId: element.id });
  }
  SERVING_CACHE.set(scene, out);
  return out;
}

export function servingUnitOf(terminalId: string, scene: readonly HvacElement[]): ServingUnit | null {
  return servingUnits(scene).get(terminalId) ?? null;
}

/** No room data (a stable value, so the analysis cache hits). */
export const NO_ROOMS: ReadonlyArray<Pick<Room, 'id' | 'vertices'>> = [];

/** The room an element is in: its own room id, else the room polygon holding its centre (null outside every room). */
export function roomIdOf(element: Pick<HvacElement, 'roomId' | 'position' | 'width' | 'depth'>, rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices'>> = NO_ROOMS): string | null {
  if (element.roomId) return element.roomId;
  const centre: Point2D = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  return rooms.find((room) => room.vertices.length >= 3 && isPointInPolygon(centre, room.vertices))?.id ?? null;
}

export type AirSystemMemberSource = 'assigned' | 'connected' | 'both';

export interface AirSystemMember {
  terminal: HvacElement;
  spec: DuctTerminalSpec;
  tag: string;
  source: AirSystemMemberSource;
  /** The unit whose duct reaches the terminal, if any. */
  connection: ServingUnit | null;
  /** Assigned here but its duct comes from another unit. */
  mismatch: boolean;
  /** Its duct is of the other service (a return terminal on a supply duct). */
  serviceMismatch: boolean;
  airflowM3h: number;
  fixed: boolean;
  neckVelocityMs: number;
  roomId: string | null;
}

export interface AirSystemService {
  service: DuctService;
  collar: DuctAirPort | null;
  members: AirSystemMember[];
  /** Sum of the members' design airflows that are fixed, and of all their shares (m³/h). */
  fixedM3h: number;
  totalM3h: number;
  connected: number;
}

export interface AirSystem {
  unit: HvacElement;
  tag: string;
  color: string;
  index: number;
  /** The unit's airflow (its Airflow field, else its data at Hi), m³/h. */
  airflowM3h: number | null;
  supply: AirSystemService;
  return: AirSystemService;
  /** The unit's room and its members' rooms, unit's first. */
  roomIds: string[];
}

export interface AirSystemsAnalysis {
  systems: AirSystem[];
  byUnit: Map<string, AirSystem>;
  /** Each terminal's system (null = in none) and its member record. */
  byTerminal: Map<string, { unitId: string | null; member: AirSystemMember | null }>;
  /** Terminals in no system: unassigned (or assigned to a unit no longer in the drawing) and not connected. */
  unassigned: HvacElement[];
}

/** Per scene, per rooms array (both immutable snapshots). */
const ANALYSIS_CACHE = new WeakMap<readonly HvacElement[], WeakMap<object, AirSystemsAnalysis>>();

/** Every ducted unit's supply and return system, and the terminals in none. */
export function analyseAirSystems(scene: readonly HvacElement[], rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices'>> = NO_ROOMS): AirSystemsAnalysis {
  const cached = ANALYSIS_CACHE.get(scene)?.get(rooms);
  if (cached) return cached;
  const units = scene.filter(isAirSystemUnit);
  const unitIds = new Set(units.map((unit) => unit.id));
  const tags = airSystemTags(scene);
  const serving = servingUnits(scene);
  const ports = listAirPorts(scene);
  // Which unit each terminal belongs to: its assignment (when that unit exists), else the unit its duct comes from.
  const owner = new Map<string, { unitId: string; assigned: boolean }>();
  const unassigned: HvacElement[] = [];
  const terminals = scene.filter(isDuctTerminalElement);
  for (const terminal of terminals) {
    const assigned = readAirSystemAssignment(terminal);
    const connection = serving.get(terminal.id);
    if (assigned && unitIds.has(assigned)) owner.set(terminal.id, { unitId: assigned, assigned: true });
    else if (connection && unitIds.has(connection.unitId)) owner.set(terminal.id, { unitId: connection.unitId, assigned: false });
    else unassigned.push(terminal);
  }
  const byTerminal: AirSystemsAnalysis['byTerminal'] = new Map(unassigned.map((terminal) => [terminal.id, { unitId: null, member: null }]));
  const systems: AirSystem[] = units.map((unit, index) => {
    const airflow = basisAirflowM3h(unit, { airflowM3h: null, fanSpeed: 'hi' }).airflowM3h;
    const serviceOf = (service: DuctService): AirSystemService => {
      const own = terminals.filter((terminal) => owner.get(terminal.id)?.unitId === unit.id && readDuctTerminalSpec(terminal)?.service === service);
      const specs = own.map((terminal) => readDuctTerminalSpec(terminal)!);
      const shares = shareAirflow(airflow ?? 0, own.map((terminal, k) => ({ id: terminal.id, spec: specs[k]! })));
      const members = own.map((terminal, k): AirSystemMember => {
        const spec = specs[k]!;
        const share = shares[k]!;
        const connection = serving.get(terminal.id) ?? null;
        const assigned = owner.get(terminal.id)!.assigned;
        const connectedHere = connection?.unitId === unit.id;
        return {
          terminal, spec, tag: terminalTagOf(terminal, spec),
          source: assigned && connectedHere ? 'both' : assigned ? 'assigned' : 'connected',
          connection,
          mismatch: Boolean(connection) && !connectedHere,
          serviceMismatch: Boolean(connection) && connection!.service !== spec.service,
          airflowM3h: share.airflowM3h, fixed: share.fixed,
          neckVelocityMs: neckVelocityMs(spec, share.airflowM3h),
          roomId: roomIdOf(terminal, rooms),
        };
      });
      return {
        service,
        collar: ports.find((port) => port.unitId === unit.id && port.kind === service) ?? null,
        members,
        fixedM3h: members.filter((member) => member.fixed).reduce((sum, member) => sum + member.airflowM3h, 0),
        totalM3h: members.reduce((sum, member) => sum + member.airflowM3h, 0),
        connected: members.filter((member) => member.connection && !member.mismatch).length,
      };
    };
    const supply = serviceOf('supply');
    const ret = serviceOf('return');
    const unitRoom = roomIdOf(unit, rooms);
    const roomIds = [...new Set([unitRoom, ...supply.members.map((member) => member.roomId), ...ret.members.map((member) => member.roomId)]
      .filter((id): id is string => Boolean(id)))];
    const system: AirSystem = {
      unit, tag: tags.get(unit.id) ?? AIR_SYSTEM_TAG_PREFIX, color: AIR_SYSTEM_COLORS[index % AIR_SYSTEM_COLORS.length]!, index,
      airflowM3h: airflow, supply, return: ret, roomIds,
    };
    for (const member of [...supply.members, ...ret.members]) byTerminal.set(member.terminal.id, { unitId: unit.id, member });
    return system;
  });
  const analysis: AirSystemsAnalysis = { systems, byUnit: new Map(systems.map((system) => [system.unit.id, system])), byTerminal, unassigned };
  let byRooms = ANALYSIS_CACHE.get(scene);
  if (!byRooms) ANALYSIS_CACHE.set(scene, (byRooms = new WeakMap()));
  byRooms.set(rooms, analysis);
  return analysis;
}

/** A system's members of both services. */
export function airSystemMembers(system: AirSystem): AirSystemMember[] {
  return [...system.supply.members, ...system.return.members];
}

export interface AirTerminalScheduleRow {
  tag: string;
  system: string;
  service: DuctService;
  type: string;
  face: string;
  neckMm: number;
  airflowM3h: number;
  /** The airflow is the terminal's design airflow (else an equal share of its unit's). */
  fixed: boolean;
  neckVelocityMs: number;
  /** Its own drop at that airflow (Pa; the filter included). */
  pressureDropPa: number;
  filter: string;
  room: string;
  status: 'ducted' | 'not ducted' | 'ducted from another unit' | 'unassigned';
}

/** The air terminal schedule: every terminal, by system and service (supply first), then by tag. */
export function airTerminalSchedule(
  analysis: AirSystemsAnalysis,
  settings: TerminalDropSettings,
  roomNames: ReadonlyMap<string, string> = new Map(),
): AirTerminalScheduleRow[] {
  const face = (spec: DuctTerminalSpec) => (spec.kind === 'round' ? `Ø${Math.round(spec.faceWidthMm)}` : `${Math.round(spec.faceWidthMm)}×${Math.round(spec.faceDepthMm)}`);
  const rows: AirTerminalScheduleRow[] = [];
  for (const system of analysis.systems) {
    for (const member of [...system.supply.members, ...system.return.members].sort((a, b) => (a.spec.service === b.spec.service ? a.tag.localeCompare(b.tag, undefined, { numeric: true }) : a.spec.service === 'supply' ? -1 : 1))) {
      rows.push({
        tag: member.tag, system: system.tag, service: member.spec.service, type: terminalLabel(member.spec), face: face(member.spec),
        neckMm: member.spec.neckDiameterMm, airflowM3h: Math.round(member.airflowM3h), fixed: member.fixed,
        neckVelocityMs: Math.round(member.neckVelocityMs * 10) / 10,
        pressureDropPa: Math.round(terminalPressureDropPa(member.spec, member.airflowM3h, settings) * 10) / 10,
        filter: member.spec.filter ?? '', room: member.roomId ? roomNames.get(member.roomId) ?? '' : '',
        status: member.mismatch ? 'ducted from another unit' : member.connection ? 'ducted' : 'not ducted',
      });
    }
  }
  for (const terminal of analysis.unassigned) {
    const spec = readDuctTerminalSpec(terminal);
    if (!spec) continue;
    rows.push({
      tag: terminalTagOf(terminal, spec), system: '', service: spec.service, type: terminalLabel(spec), face: face(spec),
      neckMm: spec.neckDiameterMm, airflowM3h: Math.round(spec.designAirflowM3h ?? 0), fixed: Boolean(spec.designAirflowM3h),
      neckVelocityMs: spec.designAirflowM3h ? Math.round(neckVelocityMs(spec, spec.designAirflowM3h) * 10) / 10 : 0,
      pressureDropPa: spec.designAirflowM3h ? Math.round(terminalPressureDropPa(spec, spec.designAirflowM3h, settings) * 10) / 10 : 0,
      filter: spec.filter ?? '', room: terminal.roomId ? roomNames.get(terminal.roomId) ?? '' : '', status: 'unassigned',
    });
  }
  return rows;
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function airTerminalScheduleToCsv(rows: readonly AirTerminalScheduleRow[]): string {
  const header = ['Tag', 'System', 'Service', 'Type', 'Face (mm)', 'Neck (mm)', 'Airflow (m3/h)', 'Airflow basis', 'Neck velocity (m/s)', 'Pressure drop (Pa)', 'Filter', 'Room', 'Status'];
  return [header, ...rows.map((row) => [row.tag, row.system, row.service, row.type, row.face, row.neckMm, row.airflowM3h, row.fixed ? 'design' : 'share',
    row.neckVelocityMs, row.pressureDropPa, row.filter, row.room, row.status])].map((line) => line.map(csvCell).join(',')).join('\n');
}

/**
 * The terminals an applied design serves that no system holds yet, dedicated
 * to its unit, merged into the terminal updates already in the command (a
 * turned spigot or a set airflow keeps its change).
 */
export function withSystemAssignments(terminalUpdates: readonly HvacElement[], runs: readonly HvacElement[], scene: readonly HvacElement[], unitId: string): HvacElement[] {
  const byId = new Map(terminalUpdates.map((element) => [element.id, element]));
  for (const run of runs) {
    const end = readDuctRunSpec(run)?.end;
    if (end?.kind !== 'terminal') continue;
    const terminal = byId.get(end.terminalId) ?? scene.find((element) => element.id === end.terminalId);
    if (!terminal || readAirSystemAssignment(terminal)) continue;
    byId.set(terminal.id, { ...terminal, properties: { ...terminal.properties, airSystem: { unitId } } });
  }
  return [...byId.values()];
}
