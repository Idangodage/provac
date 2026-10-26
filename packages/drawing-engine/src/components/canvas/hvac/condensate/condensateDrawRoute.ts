/**
 * The drain tool: a drain drawn by hand on the plan.
 *
 *  - It starts at an open end a deleted piece left (the upstream part's end), or at the drain outlet of a unit that
 *    drains nowhere (its connection deleted, or never laid). From an outlet it leaves straight out to the riser foot
 *    Auto route would give it.
 *  - It finishes on the other part of its gap when the gap has one; else on any drain of a network that drains
 *    (joined there with a wye), or on a termination (a floor gully, a stack, a wall outlet: into the network that
 *    runs there, or a new one).
 *
 * The drawn drain is a run like any other, a new unit branch or the open part carried on, and its network is then
 * solved again along all its runs as Auto route solves one: continuous fall, risers, sizes, wyes (one undo). Pure.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { condensateOpenEnds, DRAIN_GAP_PROPERTY, drainGapRecord, readDrainGaps, type DrainOpenEndRef } from './condensateCut';
import { createCondensateEditSession, type CondensateEditContext } from './condensateEditing';
import { joinDrainAlong, stretchConflict } from './condensateGapProposal';
import { closestOnSegment, distance, polylineLength } from './condensateGeometry';
import { gravityRiserFoot } from './condensateNetworkPlanner';
import { getIndoorUnitDrainPorts } from './condensatePorts';
import { fixedPrefixLength, tidyRoute } from './condensateRouteOps';
import { formatFallRatio, type CondensateDesignSettings } from './condensateSettings';
import {
  CONDENSATE_PIPE_TYPE,
  getCondensateOwnership,
  isCondensateGully,
  isCondensatePipe,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensateConnection,
  type CondensateNetworkOwnership,
} from './condensateTypes';

export type DrainDrawStart =
  | { kind: 'open-end'; gapId: string; runId: string; point: Point2D; z: number }
  | { kind: 'unit'; unitId: string; label: string; outlet: Point2D; foot: Point2D; z: number; gapId: string | null };

export type DrainDrawTarget =
  | { kind: 'partner' }
  | { kind: 'pipe'; pipeId: string; point: Point2D }
  | { kind: 'gully'; gullyId: string };

export interface DrainDrawTargets {
  /** The other part of the start's gap (its open start): then the only place to finish. */
  partner: Point2D | null;
  /** Drains it may join (their plan routes). */
  pipes: Array<{ id: string; label: string; route: Point2D[] }>;
  /** Terminations it may run into, with the network that runs there (null: a new one). */
  gullies: Array<{ id: string; label: string; point: Point2D; networkId: string | null }>;
  /** Why there is nowhere to finish. */
  reason: string | null;
}

export type DrawnDrain =
  | { ok: true; updates: HvacElement[]; add: HvacElement[]; removeIds: string[]; runId: string | null; note: string }
  | { ok: false; message: string };

interface NetworkState {
  pipes: HvacElement[];
  gullyId: string;
  locked: boolean;
  /** Gaps open on its pipes. */
  gapIds: Set<string>;
}

function networksOf(scene: readonly HvacElement[]): Map<string, NetworkState> {
  const networks = new Map<string, NetworkState>();
  for (const element of scene) {
    if (!isCondensatePipe(element)) continue;
    const owner = getCondensateOwnership(element);
    if (!owner) continue;
    const state = networks.get(owner.networkId) ?? { pipes: [], gullyId: owner.gullyId, locked: false, gapIds: new Set<string>() };
    state.pipes.push(element);
    if (readCondensatePipeSpec(element).locked) state.locked = true;
    const gaps = readDrainGaps(element);
    if (gaps.start) state.gapIds.add(gaps.start.id);
    if (gaps.end) state.gapIds.add(gaps.end.id);
    networks.set(owner.networkId, state);
  }
  return networks;
}

/** A drain's plan route, if it has a run on the plan to join (drops and lifts stand vertical). */
function joinableRoute(pipe: HvacElement): Point2D[] | null {
  const spec = readCondensatePipeSpec(pipe);
  if (spec.segmentRole !== 'unit-branch' && spec.segmentRole !== 'main') return null;
  return spec.routePoints.length >= 2 && polylineLength(spec.routePoints) >= 1 ? spec.routePoints.map((point) => ({ ...point })) : null;
}

/** Where drains may be drawn from: the open ends deleted pieces left, and the drain outlets of units that drain nowhere. */
export function drainDrawStarts(scene: readonly HvacElement[], settings: CondensateDesignSettings): DrainDrawStart[] {
  const ends = condensateOpenEnds(scene);
  const starts: DrainDrawStart[] = ends.filter((end) => end.end === 'end').map((end) => ({
    kind: 'open-end' as const, gapId: end.gap.id, runId: end.runId, point: { x: end.point.x, y: end.point.y }, z: end.point.z,
  }));
  const drained = new Set<string>();
  for (const element of scene) {
    if (!isCondensatePipe(element)) continue;
    const start = readCondensatePipeSpec(element).drainStart;
    if (start?.kind === 'unit-drain' && start.unitId) drained.add(start.unitId);
  }
  for (const port of getIndoorUnitDrainPorts(scene, settings)) {
    if (drained.has(port.unitId)) continue;
    // Its connection deleted: the run it fed waits for it, open at its start.
    const fed = ends.find((end) => end.end === 'start' && end.gap.was?.kind === 'unit-drain' && end.gap.was.unitId === port.unitId);
    starts.push({
      kind: 'unit', unitId: port.unitId, label: port.label, outlet: { ...port.point }, foot: gravityRiserFoot(port, settings), z: port.z,
      gapId: fed?.gap.id ?? null,
    });
  }
  return starts;
}

/** Where a drain drawn from `start` may finish (see the module comment). */
export function drainDrawTargets(scene: readonly HvacElement[], start: DrainDrawStart): DrainDrawTargets {
  const none = (reason: string): DrainDrawTargets => ({ partner: null, pipes: [], gullies: [], reason });
  const ends = condensateOpenEnds(scene);
  const gapId = start.kind === 'open-end' ? start.gapId : start.gapId;
  if (gapId) {
    const other = ends.find((end) => end.gap.id === gapId && end.end === 'start');
    if (other) return { partner: { x: other.point.x, y: other.point.y }, pipes: [], gullies: [], reason: null };
    if (start.kind === 'unit') return none('The run it fed is no longer open.');
  }
  const networks = networksOf(scene);
  const pipes: DrainDrawTargets['pipes'] = [];
  const gullies: DrainDrawTargets['gullies'] = [];
  if (start.kind === 'open-end') {
    // A lone open end: on into its own network (a drain it does not feed, or the network's termination).
    const run = scene.find((element) => element.id === start.runId);
    const networkId = run ? getCondensateOwnership(run)?.networkId : undefined;
    const network = networkId ? networks.get(networkId) : undefined;
    if (!run || !networkId || !network) return none('This drain is not part of a network.');
    if (network.locked) return none('This drain network is locked: unlock it to draw.');
    if ([...network.gapIds].some((id) => id !== start.gapId)) return none('Another gap of this drain network is open: reconnect it first.');
    const fed = new Set(readCondensatePipeSpec(run).upstreamUnitIds);
    for (const pipe of network.pipes) {
      if (pipe.id === run.id) continue;
      const upstream = readCondensatePipeSpec(pipe).upstreamUnitIds;
      // A drain carrying only what this one carries is upstream of it: joining it would close a loop.
      if (upstream.length && upstream.every((unitId) => fed.has(unitId))) continue;
      const route = joinableRoute(pipe);
      if (route) pipes.push({ id: pipe.id, label: pipe.label || 'Drain', route });
    }
    const gully = scene.find((element) => element.id === network.gullyId);
    if (gully) gullies.push({ id: gully.id, label: gully.label || 'Termination', point: readCondensateGullySpec(gully).connectionPoint, networkId });
    return { partner: null, pipes, gullies, reason: pipes.length || gullies.length ? null : 'Nothing of this network is left to run into.' };
  }
  // A unit's outlet: into any network that drains, or a termination.
  const sound = (state: NetworkState) => !state.locked && state.gapIds.size === 0;
  for (const state of networks.values()) {
    if (!sound(state)) continue;
    for (const pipe of state.pipes) {
      const route = joinableRoute(pipe);
      if (route) pipes.push({ id: pipe.id, label: pipe.label || 'Drain', route });
    }
  }
  for (const gully of scene) {
    if (!isCondensateGully(gully)) continue;
    const serving = [...networks.entries()].filter(([, state]) => state.gullyId === gully.id).sort(([a], [b]) => a.localeCompare(b));
    const open = serving.find(([, state]) => sound(state));
    if (serving.length && !open) continue;
    gullies.push({ id: gully.id, label: gully.label || 'Termination', point: readCondensateGullySpec(gully).connectionPoint, networkId: open?.[0] ?? null });
  }
  return { partner: null, pipes, gullies, reason: pipes.length || gullies.length ? null : 'There is no drain or termination to run into: place a floor gully first.' };
}

/** The point of `route` nearest `point`, and how far it is. */
export function nearestOnRoute(route: readonly Point2D[], point: Point2D): { point: Point2D; distanceMm: number } | null {
  let best: { point: Point2D; distanceMm: number } | null = null;
  for (let index = 1; index < route.length; index += 1) {
    const on = closestOnSegment(point, route[index - 1]!, route[index]!).point;
    const gap = distance(on, point);
    if (!best || gap < best.distanceMm) best = { point: on, distanceMm: gap };
  }
  return best;
}

let drawnCounter = 0;
const drawnId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(drawnCounter++).toString(36)}`;

/**
 * The network solved along a trial scene in which the drawn drain is a run (`runId`, routed along `route`), mapped
 * back onto `scene`: runs new to it added, the drawn run's closed gap cleared outright (the store merges properties).
 */
function solveDrawn(
  scene: readonly HvacElement[],
  trial: HvacElement[],
  networkId: string,
  runId: string,
  route: Point2D[],
  stretch: readonly Point2D[],
  context: CondensateEditContext,
  fallPercent: number | null | undefined,
  unitId: string | null,
): DrawnDrain {
  const solved = createCondensateEditSession(trial, networkId, context)?.solve({
    routes: new Map([[runId, route]]),
    ...(fallPercent !== undefined && fallPercent !== null ? { fallPercent } : {}),
  });
  if (!solved) return { ok: false, message: 'This drain network could not be read.' };
  if (!solved.ok) return { ok: false, message: solved.message };
  const conflict = stretchConflict(scene, solved.generation, stretch);
  if (conflict) return { ok: false, message: conflict };
  const existing = new Set(scene.map((element) => element.id));
  const clear = (element: HvacElement) => (element.id === runId
    ? { ...element, properties: { ...element.properties, [DRAIN_GAP_PROPERTY]: undefined } } : element);
  const all = [...solved.updates, ...solved.add].map(clear);
  // The drawn run: the unit's new branch, else the run carried on (it keeps its id).
  const drawn = unitId
    ? all.find((element) => readCondensatePipeSpec(element).drainStart?.unitId === unitId) ?? null
    : all.find((element) => element.id === runId) ?? null;
  const network = solved.generation?.networks[0];
  return {
    ok: true,
    updates: all.filter((element) => existing.has(element.id)),
    add: all.filter((element) => !existing.has(element.id)),
    removeIds: solved.removeIds.filter((id) => existing.has(id)),
    runId: drawn?.id ?? null,
    note: `levels solved${network ? ` for the ${formatFallRatio(network.mainSlopePercent)} fall` : ''}`,
  };
}

function endOf(target: Exclude<DrainDrawTarget, { kind: 'partner' }>, scene: readonly HvacElement[], z: number): { point: Point2D; connection: CondensateConnection } | null {
  if (target.kind === 'pipe') {
    return { point: { ...target.point }, connection: { kind: 'junction', point: { ...target.point }, z } };
  }
  const gully = scene.find((element) => element.id === target.gullyId);
  if (!gully || !isCondensateGully(gully)) return null;
  const spec = readCondensateGullySpec(gully);
  return { point: { ...spec.connectionPoint }, connection: { kind: 'gully', gullyId: gully.id, point: { ...spec.connectionPoint }, z: spec.inletElevationMm } };
}

/**
 * A drain drawn from `start` through `via` (plan points where it turns, in the direction of flow) to `target`, its
 * network solved again (see the module comment). Refused, saying why, when the target cannot be reached so.
 * `fallPercent`: the design fall of a network it starts (a network it joins keeps its own).
 */
export function drawDrainAlong(
  scene: readonly HvacElement[],
  start: DrainDrawStart,
  via: readonly Point2D[],
  target: DrainDrawTarget,
  context: CondensateEditContext,
  options: { fallPercent?: number | null } = {},
): DrawnDrain {
  const targets = drainDrawTargets(scene, start);
  const ends = condensateOpenEnds(scene);
  if (target.kind === 'partner') {
    if (!targets.partner) return { ok: false, message: targets.reason ?? 'This gap has no other part to join.' };
    if (start.kind === 'open-end') {
      const joined = joinDrainAlong(scene, start.gapId, via, context);
      return joined.ok ? { ...joined, runId: start.runId, note: joined.note } : joined;
    }
    // A unit's connection drawn again: the run it fed carried back to its outlet.
    const fed = ends.find((end) => end.gap.id === start.gapId && end.end === 'start') as DrainOpenEndRef;
    const run = scene.find((element) => element.id === fed.runId);
    const networkId = run ? getCondensateOwnership(run)?.networkId : undefined;
    if (!run || !networkId) return { ok: false, message: 'This drain is not part of a network.' };
    if ([...(networksOf(scene).get(networkId)?.gapIds ?? [])].some((id) => id !== start.gapId)) {
      return { ok: false, message: 'Another gap of this drain network is open: reconnect it first.' };
    }
    const spec = readCondensatePipeSpec(run);
    const route = tidyRoute([start.outlet, start.foot, ...via, ...spec.routePoints], fixedPrefixLength(true));
    const trial = scene.map((element) => (element.id === run.id ? {
      ...run,
      properties: { ...run.properties, routePoints: route, drainStart: fed.gap.was, [DRAIN_GAP_PROPERTY]: drainGapRecord(null, readDrainGaps(run).end) },
    } as HvacElement : element));
    return solveDrawn(scene, trial, networkId, run.id, route, [start.foot, ...via, fed.point], context, undefined, null);
  }

  if (target.kind === 'pipe' && !targets.pipes.some((pipe) => pipe.id === target.pipeId)) {
    return { ok: false, message: targets.reason ?? 'It cannot join that drain.' };
  }
  if (target.kind === 'gully' && !targets.gullies.some((gully) => gully.id === target.gullyId)) {
    return { ok: false, message: targets.reason ?? 'It cannot run into that termination.' };
  }
  const end = endOf(target, scene, start.z);
  if (!end) return { ok: false, message: 'That termination is no longer in the drawing.' };

  if (start.kind === 'open-end') {
    // A lone open end carried on into its own network.
    const run = scene.find((element) => element.id === start.runId)!;
    const networkId = getCondensateOwnership(run)!.networkId;
    const spec = readCondensatePipeSpec(run);
    const branch = spec.drainStart?.kind === 'unit-drain';
    const route = tidyRoute([...spec.routePoints, ...via, end.point], fixedPrefixLength(branch));
    const trial = scene.map((element) => (element.id === run.id ? {
      ...run,
      properties: { ...run.properties, routePoints: route, drainEnd: end.connection, [DRAIN_GAP_PROPERTY]: drainGapRecord(readDrainGaps(run).start, null) },
    } as HvacElement : element));
    return solveDrawn(scene, trial, networkId, run.id, route, [start.point, ...via, end.point], context, undefined, null);
  }

  // A unit that drains nowhere: its new branch, into the network that runs there or a new one.
  const pipe = target.kind === 'pipe' ? scene.find((element) => element.id === target.pipeId) : undefined;
  const joined = pipe ? getCondensateOwnership(pipe) : null;
  const gullyEntry = target.kind === 'gully' ? targets.gullies.find((gully) => gully.id === target.gullyId) : undefined;
  const servingId = joined?.networkId ?? gullyEntry?.networkId ?? null;
  const serving = servingId ? scene.find((element) => isCondensatePipe(element) && getCondensateOwnership(element)?.networkId === servingId) : undefined;
  const owner: CondensateNetworkOwnership = serving
    ? { ...getCondensateOwnership(serving)! }
    : { version: 1, networkId: drawnId('cdn'), gullyId: (target as { gullyId: string }).gullyId, unitIds: [start.unitId], signature: '', sourceSignature: '' };
  const route = tidyRoute([start.outlet, start.foot, ...via, end.point], fixedPrefixLength(true));
  const run: HvacElement = {
    id: drawnId('cdp'), type: CONDENSATE_PIPE_TYPE, position: { ...start.outlet }, rotation: 0, width: 1, depth: 1, height: 32, elevation: start.z,
    mountType: 'ceiling', label: 'Drain', supplyZoneRatio: 0.5,
    properties: {
      routePoints: route, routeNodes3d: [], segmentRole: 'unit-branch', upstreamUnitIds: [start.unitId], fittings: [],
      drainStart: { kind: 'unit-drain', unitId: start.unitId, point: { ...start.outlet }, z: start.z }, drainEnd: end.connection,
      condensateNetwork: owner,
    },
  } as HvacElement;
  return solveDrawn(scene, [...scene, run], owner.networkId, run.id, route, [start.foot, ...via, end.point], context,
    serving ? undefined : options.fallPercent, start.unitId);
}
