/**
 * Air-system design checks, in the one design-check list with the duct,
 * refrigerant and condensate checks:
 *  - DU_SYSTEM_MISMATCH: assigned to one unit, ducted from another;
 *  - DU_SERVICE_MISMATCH: a return terminal on a supply duct, or the reverse;
 *  - DU_SYSTEM_NO_COLLAR: assigned to a unit with no collar of its service;
 *  - DU_SYSTEM_AIRFLOW: a service's fixed airflows off the unit's by > 10 %
 *    (the usual balancing tolerance, practice);
 *  - DU_SHORT_CIRCUIT: a return face too close to a supply face in its room;
 *  - DU_ROOM_RETURN_PATH: a room a system supplies with no return of that
 *    system, while it has ducted returns elsewhere (needs a return or a
 *    transfer path, which the drawing does not model);
 *  - DU_TERMINAL_UNASSIGNED (information): a terminal in no system.
 */
import type { HvacElement, Point2D, Room } from '../../../../types';
import type { VrfValidationIssue } from '../../../../vrf/rules';

import { airSystemMembers, analyseAirSystems, roomIdOf, terminalTagOf, type AirSystem } from './ductAirSystems';
import { footprintCorners } from './ductAutoContext';
import type { DuctDesignSettings } from './ductSettings';
import { isDuctTerminalElement, readDuctTerminalSpec } from './ductTerminals';

/** Share of the unit's airflow the terminals may be off by before it is flagged (practice: the usual balancing tolerance). */
export const AIR_BALANCE_TOLERANCE = 0.1;
/** Terminals without room data are judged neighbours within this distance (mm). */
const NO_ROOM_NEIGHBOURHOOD_MM = 3000;

function pointSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insideConvex(p: Point2D, polygon: readonly Point2D[]): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** The plan gap between two convex outlines (0 when they touch or overlap), mm. */
export function outlineGapMm(a: readonly Point2D[], b: readonly Point2D[]): number {
  if (a.some((point) => insideConvex(point, b)) || b.some((point) => insideConvex(point, a))) return 0;
  let gap = Number.POSITIVE_INFINITY;
  for (const [from, to] of [[a, b], [b, a]] as const) {
    for (const point of from) {
      for (let index = 0; index < to.length; index += 1) gap = Math.min(gap, pointSegmentDistance(point, to[index]!, to[(index + 1) % to.length]!));
    }
  }
  return gap;
}

function issue(level: VrfValidationIssue['level'], code: string, entityId: string, message: string, suggestedFix?: string): VrfValidationIssue {
  return { id: `${code}:${entityId}:${message.length}`, level, code, entityId, message, ...(suggestedFix ? { suggestedFix } : {}) };
}

function systemIssues(system: AirSystem, tagsByUnit: ReadonlyMap<string, string>, roomNames: ReadonlyMap<string, string>): VrfValidationIssue[] {
  const out: VrfValidationIssue[] = [];
  for (const member of airSystemMembers(system)) {
    if (member.mismatch && member.connection) {
      out.push(issue('error', 'DU_SYSTEM_MISMATCH', member.terminal.id,
        `${member.tag} is assigned to ${system.tag}, but its duct comes from ${tagsByUnit.get(member.connection.unitId) ?? 'another unit'}.`,
        `Assign it to ${tagsByUnit.get(member.connection.unitId) ?? 'the unit its duct comes from'}, or re-route its duct from ${system.tag}.`));
    }
    if (member.serviceMismatch && member.connection) {
      out.push(issue('error', 'DU_SERVICE_MISMATCH', member.terminal.id,
        `${member.tag} is a ${member.spec.service} terminal on a ${member.connection.service} duct.`,
        `Connect it to the unit's ${member.spec.service} collar, or change the terminal's service.`));
    }
  }
  for (const service of [system.supply, system.return]) {
    if (!service.members.length) continue;
    if (!service.collar) {
      out.push(issue('error', 'DU_SYSTEM_NO_COLLAR', system.unit.id,
        `${system.tag} has no ${service.service} collar, but ${service.members.length} ${service.service} terminal${service.members.length === 1 ? ' is' : 's are'} assigned to it.`,
        `Assign ${service.members.length === 1 ? 'it' : 'them'} to a unit with a ${service.service} collar.`));
    }
    const airflow = system.airflowM3h;
    if (airflow && airflow > 0) {
      const allFixed = service.members.every((member) => member.fixed);
      const over = service.fixedM3h > airflow * (1 + AIR_BALANCE_TOLERANCE);
      const off = allFixed && Math.abs(service.fixedM3h - airflow) > airflow * AIR_BALANCE_TOLERANCE;
      if (over || off) {
        out.push(issue('warning', 'DU_SYSTEM_AIRFLOW', system.unit.id,
          `${system.tag} ${service.service}: the terminals' design airflows add up to ${Math.round(service.fixedM3h)} m³/h, the unit moves ${Math.round(airflow)} m³/h.`,
          'Balance the terminal airflows to the unit (within 10 %), or change the unit or its fan speed.'));
      }
    }
  }
  // A room the system supplies but takes nothing back from, while its return is ducted elsewhere.
  if (system.return.members.length) {
    const returned = new Set(system.return.members.map((member) => member.roomId));
    const supplied = [...new Set(system.supply.members.map((member) => member.roomId))].filter((roomId): roomId is string => Boolean(roomId) && !returned.has(roomId));
    for (const roomId of supplied) {
      out.push(issue('warning', 'DU_ROOM_RETURN_PATH', system.unit.id,
        `${roomNames.get(roomId) ?? 'A room'} gets supply air from ${system.tag} but has no ${system.tag} return: the room pressurises and the unit starves its return.`,
        `Add a ${system.tag} return terminal in it, or a transfer path (door undercut or transfer grille) to a room with one.`));
    }
  }
  return out;
}

/** The air-system checks for a scene (room polygons place terminals without a room id). */
export function checkAirSystems(
  scene: readonly HvacElement[],
  settings: Pick<DuctDesignSettings, 'returnSupplyMinGapMm'>,
  rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices' | 'name'>> = [],
): VrfValidationIssue[] {
  const analysis = analyseAirSystems(scene, rooms);
  const tagsByUnit = new Map(analysis.systems.map((system) => [system.unit.id, system.tag]));
  const roomNames = new Map(rooms.map((room) => [room.id, room.name]));
  const issues: VrfValidationIssue[] = analysis.systems.flatMap((system) => systemIssues(system, tagsByUnit, roomNames));
  // Short circuit: each return face against the nearest supply face in its room.
  const terminals = scene.filter(isDuctTerminalElement).flatMap((element) => {
    const spec = readDuctTerminalSpec(element);
    return spec ? [{ element, spec, outline: footprintCorners(element), roomId: roomIdOf(element, rooms) }] : [];
  });
  const supplies = terminals.filter((terminal) => terminal.spec.service === 'supply');
  for (const ret of terminals.filter((terminal) => terminal.spec.service === 'return')) {
    let nearest: { gap: number; tag: string } | null = null;
    for (const supply of supplies) {
      const neighbours = ret.roomId || supply.roomId ? ret.roomId === supply.roomId
        : Math.hypot(ret.element.position.x - supply.element.position.x, ret.element.position.y - supply.element.position.y) <= NO_ROOM_NEIGHBOURHOOD_MM;
      if (!neighbours) continue;
      const gap = outlineGapMm(ret.outline, supply.outline);
      if (!nearest || gap < nearest.gap) nearest = { gap, tag: terminalTagOf(supply.element, supply.spec) };
    }
    if (nearest && nearest.gap < settings.returnSupplyMinGapMm) {
      issues.push(issue('warning', 'DU_SHORT_CIRCUIT', ret.element.id,
        `${terminalTagOf(ret.element, ret.spec)} is ${(nearest.gap / 1000).toFixed(2)} m from ${nearest.tag}: supply air may go straight back to the return.`,
        `Keep at least ${(settings.returnSupplyMinGapMm / 1000).toFixed(1)} m between them (practice), out of the diffuser's throw.`));
    }
  }
  for (const terminal of analysis.unassigned) {
    const spec = readDuctTerminalSpec(terminal);
    issues.push(issue('information', 'DU_TERMINAL_UNASSIGNED', terminal.id,
      `${spec ? terminalTagOf(terminal, spec) : terminal.label} belongs to no air system.`, 'Assign it to the ducted unit that serves it.'));
  }
  return issues;
}
