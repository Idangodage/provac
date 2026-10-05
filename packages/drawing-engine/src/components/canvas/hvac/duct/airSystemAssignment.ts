/**
 * Balanced assignment of air terminals to ducted units: which unit should serve
 * each unassigned terminal. Solved exactly, per service, as a minimum-cost flow:
 *
 *   source → terminal (1) → unit (1, cost c(t, u)) → sink
 *
 * where each unit reaches the sink twice: up to its fair share of terminals at
 * no cost, and beyond it at `overloadMm` per terminal (a convex penalty, so the
 * flow stays exact). The fair share splits each terminal's demand among the
 * units it may go to in proportion to their airflow; terminals already assigned
 * pre-load their unit.
 *
 * Which units a terminal may go to:
 *  - a unit with a collar of the terminal's service;
 *  - if a unit in the terminal's room has one, only units in that room;
 *  - a room without such a unit may be served from any unit (its ducts cross
 *    walls, priced per wall crossed) — unless `adoptRoomsWithoutUnit` is off;
 *  - without room data, units within `nearbyMm`.
 *
 * c(t, u) = the L1 distance from the collar lip to the spigot lip (ducts run
 * orthogonally) + twice the depth behind the collar plane (the duct router
 * works in front of a collar) + `wallPenaltyMm` per wall the straight line
 * crosses. Distances in millimetres; ties break by id, so it is deterministic.
 */
import type { HvacElement, Point2D, Room, Wall } from '../../../../types';

import { listAirPorts } from './ductAirPorts';
import { analyseAirSystems, isAirSystemUnit, roomIdOf } from './ductAirSystems';
import type { DuctDesignSettings } from './ductSettings';
import { basisAirflowM3h } from './ductSystemSizing';
import { readDuctTerminalSpec, terminalSpigotPort } from './ductTerminals';
import type { DuctService } from './ductTypes';

export interface AssignmentCollar {
  lip: Point2D;
  normal: Point2D;
}

export interface AssignmentUnit {
  id: string;
  /** The unit's airflow (m³/h); its share of the terminals follows it. */
  airflowM3h: number;
  roomId: string | null;
  collars: Partial<Record<DuctService, AssignmentCollar>>;
  /** Terminals of each service already assigned to it. */
  preload?: Partial<Record<DuctService, number>>;
}

export interface AssignmentTerminal {
  id: string;
  service: DuctService;
  /** Its spigot lip (plan). */
  lip: Point2D;
  roomId: string | null;
}

export interface AssignmentWall {
  a: Point2D;
  b: Point2D;
}

export interface AssignmentOptions {
  wallPenaltyMm: number;
  overloadMm: number;
  nearbyMm: number;
  /**
   * A room without a unit of the service may be served from another room's
   * unit (through its walls). On for the designer's own Auto-assign; off for
   * automatic flows (Auto route), which never take on another room unasked.
   */
  adoptRoomsWithoutUnit?: boolean;
}

export interface AssignmentResult {
  assignments: Array<{ terminalId: string; unitId: string; costMm: number }>;
  unassignable: Array<{ terminalId: string; reason: string }>;
  /** Terminals per unit and service after the assignment, pre-loaded ones included. */
  loads: Map<string, Record<DuctService, number>>;
  /** The objective's value: pairing costs + overload penalties (mm-equivalent). */
  totalCostMm: number;
}

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Proper crossing of two segments (touching ends do not count). */
function segmentsCross(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
}

/** The price of serving `terminal` from `collar` (mm-equivalent). */
export function assignmentCostMm(collar: AssignmentCollar, terminal: Pick<AssignmentTerminal, 'lip'>, walls: readonly AssignmentWall[], wallPenaltyMm: number): number {
  const dx = terminal.lip.x - collar.lip.x;
  const dy = terminal.lip.y - collar.lip.y;
  const behind = Math.max(0, -(dx * collar.normal.x + dy * collar.normal.y));
  const crossings = walls.reduce((count, wall) => count + (segmentsCross(collar.lip, terminal.lip, wall.a, wall.b) ? 1 : 0), 0);
  return Math.abs(dx) + Math.abs(dy) + 2 * behind + crossings * wallPenaltyMm;
}

/** The units a terminal may be served from (and why none, when none). */
function eligibleUnits(terminal: AssignmentTerminal, units: readonly AssignmentUnit[], options: AssignmentOptions): { units: AssignmentUnit[]; reason: string | null } {
  const withCollar = units.filter((unit) => unit.collars[terminal.service]);
  if (!withCollar.length) return { units: [], reason: `no ducted unit has a ${terminal.service} collar` };
  if (terminal.roomId) {
    const sameRoom = withCollar.filter((unit) => unit.roomId === terminal.roomId);
    if (sameRoom.length) return { units: sameRoom, reason: null };
    return options.adoptRoomsWithoutUnit === false
      ? { units: [], reason: `no ducted unit with a ${terminal.service} collar in its room (dedicate it to a unit in another room to serve it from there)` }
      : { units: withCollar, reason: null };
  }
  const near = withCollar.filter((unit) => {
    const lip = unit.collars[terminal.service]!.lip;
    return Math.hypot(lip.x - terminal.lip.x, lip.y - terminal.lip.y) <= options.nearbyMm;
  });
  return { units: near, reason: near.length ? null : `no ducted unit with a ${terminal.service} collar within ${Math.round(options.nearbyMm / 1000)} m (no room data)` };
}

interface Edge { to: number; cap: number; cost: number; rev: number }

/** Successive shortest augmenting paths (Dijkstra on reduced costs); every cost is ≥ 0, so potentials start at 0. */
function minCostFlow(graph: Edge[][], source: number, sink: number, want: number): { flow: number; cost: number } {
  const n = graph.length;
  const potential = new Float64Array(n);
  let flow = 0;
  let cost = 0;
  while (flow < want) {
    const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
    const previous = new Int32Array(n).fill(-1);
    const previousEdge = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[source] = 0;
    for (;;) {
      // O(V²) Dijkstra: the graphs are a few hundred nodes, and the scan order (lowest index first) breaks ties deterministically.
      let u = -1;
      for (let v = 0; v < n; v += 1) if (!done[v] && dist[v]! < Number.POSITIVE_INFINITY && (u < 0 || dist[v]! < dist[u]! - 1e-9)) u = v;
      if (u < 0) break;
      done[u] = 1;
      graph[u]!.forEach((edge, index) => {
        if (edge.cap <= 0) return;
        const next = dist[u]! + edge.cost + potential[u]! - potential[edge.to]!;
        if (next < dist[edge.to]! - 1e-9) {
          dist[edge.to] = next;
          previous[edge.to] = u;
          previousEdge[edge.to] = index;
        }
      });
    }
    if (!(dist[sink]! < Number.POSITIVE_INFINITY)) break;
    for (let v = 0; v < n; v += 1) if (dist[v]! < Number.POSITIVE_INFINITY) potential[v] += dist[v]!;
    let push = want - flow;
    for (let v = sink; v !== source; v = previous[v]!) push = Math.min(push, graph[previous[v]!]![previousEdge[v]!]!.cap);
    for (let v = sink; v !== source; v = previous[v]!) {
      const edge = graph[previous[v]!]![previousEdge[v]!]!;
      edge.cap -= push;
      graph[v]![edge.rev]!.cap += push;
      cost += push * edge.cost;
    }
    flow += push;
  }
  return { flow, cost };
}

function addEdge(graph: Edge[][], from: number, to: number, cap: number, cost: number): void {
  graph[from]!.push({ to, cap, cost, rev: graph[to]!.length });
  graph[to]!.push({ to: from, cap: 0, cost: -cost, rev: graph[from]!.length - 1 });
}

/**
 * Assigns `terminals` (the unassigned ones) to `units`, balanced by airflow.
 * `units[].preload` counts terminals already assigned to each unit by service.
 */
export function solveAirSystemAssignment(
  units: readonly AssignmentUnit[],
  terminals: readonly AssignmentTerminal[],
  walls: readonly AssignmentWall[],
  options: AssignmentOptions,
): AssignmentResult {
  const sortedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id));
  const loads = new Map(sortedUnits.map((unit) => [unit.id, { supply: unit.preload?.supply ?? 0, return: unit.preload?.return ?? 0 }]));
  const result: AssignmentResult = { assignments: [], unassignable: [], loads, totalCostMm: 0 };
  for (const service of ['supply', 'return'] as const) {
    const pending = terminals.filter((terminal) => terminal.service === service).sort((a, b) => a.id.localeCompare(b.id));
    if (!pending.length) continue;
    const options2 = pending.map((terminal) => eligibleUnits(terminal, sortedUnits, options));
    pending.forEach((terminal, index) => {
      if (!options2[index]!.units.length) result.unassignable.push({ terminalId: terminal.id, reason: options2[index]!.reason ?? 'no unit can serve it' });
    });
    const solvable = pending.filter((_, index) => options2[index]!.units.length);
    if (!solvable.length) continue;
    // Fair share: each terminal's demand split among its units by airflow. A terminal already assigned is part
    // of its room's demand too: it is split among the units of that room the same way.
    const share = new Map(sortedUnits.map((unit) => [unit.id, 0]));
    for (const unit of sortedUnits) {
      const preload = unit.preload?.[service] ?? 0;
      if (!preload) continue;
      const peers = unit.roomId ? sortedUnits.filter((peer) => peer.collars[service] && peer.roomId === unit.roomId) : [unit];
      const total = peers.reduce((sum, peer) => sum + Math.max(peer.airflowM3h, 1), 0);
      for (const peer of peers) share.set(peer.id, share.get(peer.id)! + (preload * Math.max(peer.airflowM3h, 1)) / total);
    }
    pending.forEach((_, index) => {
      const eligible = options2[index]!.units;
      if (!eligible.length) return;
      const total = eligible.reduce((sum, unit) => sum + Math.max(unit.airflowM3h, 1), 0);
      for (const unit of eligible) share.set(unit.id, share.get(unit.id)! + Math.max(unit.airflowM3h, 1) / total);
    });
    // Node layout: 0 source, 1..T terminals, then units, then the sink.
    const unitIndex = new Map(sortedUnits.map((unit, index) => [unit.id, 1 + solvable.length + index]));
    const sink = 1 + solvable.length + sortedUnits.length;
    const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
    const pairCost = new Map<string, number>();
    solvable.forEach((terminal, k) => {
      addEdge(graph, 0, 1 + k, 1, 0);
      const eligible = options2[pending.indexOf(terminal)]!.units;
      for (const unit of eligible) {
        const cost = assignmentCostMm(unit.collars[service]!, terminal, walls, options.wallPenaltyMm);
        pairCost.set(`${terminal.id}|${unit.id}`, cost);
        addEdge(graph, 1 + k, unitIndex.get(unit.id)!, 1, cost);
      }
    });
    for (const unit of sortedUnits) {
      if (!unit.collars[service]) continue;
      const free = Math.max(0, Math.round(share.get(unit.id)!) - (unit.preload?.[service] ?? 0));
      const node = unitIndex.get(unit.id)!;
      if (free > 0) addEdge(graph, node, sink, free, 0);
      addEdge(graph, node, sink, solvable.length, options.overloadMm);
    }
    const solved = minCostFlow(graph, 0, sink, solvable.length);
    result.totalCostMm += solved.cost;
    solvable.forEach((terminal, k) => {
      const used = graph[1 + k]!.find((edge) => edge.to !== 0 && edge.cap === 0 && edge.to >= 1 + solvable.length && edge.to < sink);
      if (!used) {
        result.unassignable.push({ terminalId: terminal.id, reason: 'no unit could take it' });
        return;
      }
      const unit = sortedUnits[used.to - 1 - solvable.length]!;
      result.assignments.push({ terminalId: terminal.id, unitId: unit.id, costMm: pairCost.get(`${terminal.id}|${unit.id}`) ?? 0 });
      const load = loads.get(unit.id)!;
      load[service] += 1;
    });
  }
  return result;
}

/** Terminals without a room count as a unit's within this distance of its collar (mm), as in the Auto duct card. */
export const NEARBY_TERMINALS_MM = 10000;

export interface AssignmentScope {
  /** Only these units may receive terminals (default: every ducted unit). */
  unitIds?: readonly string[];
  /** Only these terminals are assigned (default: every terminal in no system). */
  terminalIds?: readonly string[];
  /** Only terminals in this room (and only that room's units, when it has any). */
  roomId?: string | null;
}

/**
 * The assignment problem a drawing poses: its ducted units (airflow, room,
 * collars, the terminals already theirs) and the terminals in no system yet
 * (their spigot lips and rooms), with the walls as straight-line crossings.
 */
export function assignmentProblemFromScene(
  scene: readonly HvacElement[],
  rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices'>>,
  walls: ReadonlyArray<Pick<Wall, 'startPoint' | 'endPoint'>>,
  scope: AssignmentScope = {},
): { units: AssignmentUnit[]; terminals: AssignmentTerminal[]; walls: AssignmentWall[] } {
  const analysis = analyseAirSystems(scene, rooms);
  const ports = listAirPorts(scene);
  const allowedUnits = scope.unitIds ? new Set(scope.unitIds) : null;
  const units: AssignmentUnit[] = scene.filter(isAirSystemUnit).filter((unit) => !allowedUnits || allowedUnits.has(unit.id)).map((unit) => {
    const system = analysis.byUnit.get(unit.id);
    const collars: AssignmentUnit['collars'] = {};
    for (const port of ports) {
      if (port.unitId === unit.id) collars[port.kind] = { lip: { x: port.lip.x, y: port.lip.y }, normal: port.normal };
    }
    return {
      id: unit.id,
      airflowM3h: basisAirflowM3h(unit, { airflowM3h: null, fanSpeed: 'hi' }).airflowM3h ?? 1,
      roomId: roomIdOf(unit, rooms),
      collars,
      preload: { supply: system?.supply.members.length ?? 0, return: system?.return.members.length ?? 0 },
    };
  });
  const wanted = scope.terminalIds ? new Set(scope.terminalIds) : null;
  const terminals: AssignmentTerminal[] = analysis.unassigned.flatMap((terminal) => {
    if (wanted && !wanted.has(terminal.id)) return [];
    const spec = readDuctTerminalSpec(terminal);
    const port = terminalSpigotPort(terminal);
    if (!spec || !port) return [];
    const roomId = roomIdOf(terminal, rooms);
    if (scope.roomId !== undefined && roomId !== scope.roomId) return [];
    return [{ id: terminal.id, service: spec.service, lip: { x: port.lip.x, y: port.lip.y }, roomId }];
  });
  return { units, terminals, walls: walls.map((wall) => ({ a: wall.startPoint, b: wall.endPoint })) };
}

/** The solver's options from the project's duct settings. */
export function assignmentOptions(settings: Pick<DuctDesignSettings, 'autoAssignWallPenaltyMm' | 'autoAssignOverloadMm'>): AssignmentOptions {
  return { wallPenaltyMm: settings.autoAssignWallPenaltyMm, overloadMm: settings.autoAssignOverloadMm, nearbyMm: NEARBY_TERMINALS_MM };
}
