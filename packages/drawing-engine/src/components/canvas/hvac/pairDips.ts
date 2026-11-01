/**
 * Gas and liquid side by side on one level, as a site runs them on one hanger.
 * Their plan lanes keep them apart along the straights; at a tee one line's
 * branch has to get past the other's run, and a kit's branch tube lands on the
 * neighbouring lane. There the liquid dips under the gas: down far enough to
 * clear it and to take two full bends (a plumb step, as every level change in
 * this engine), along the stretch where the two would meet, then back up. Every liquid kit sits at the dipped level (its branch tube passes under
 * the gas), so the liquid runs dipped for its straight either side of a kit. The
 * gas stays level: a dip in it would be an oil trap.
 *
 * Pure: the network's elements at the shared corridor in, the same elements with
 * the liquid's nodes, kits and kit connections set for the dips out.
 */
import type { HvacElement, Point2D } from '../../../types';

import { normalizePipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { buildRefrigerantBranchKitViewModel } from './refrigerantBranchKitModel';
import { DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

const EPS = 1e-6;
/** Sampling along a liquid run when looking for where it meets the gas (mm). */
const SAMPLE_MM = 10;
/** How far past the meeting the dip carries on, beyond its bend (mm). */
const DIP_MARGIN_MM = 25;

export interface PairDipOptions {
  /** The level both services share (mm). */
  corridorZ: number;
  /** How far the liquid goes under the gas (mm): at least two of its bends (pairDipMm). */
  dipMm: number;
  /** The liquid's bend room (centreline radius): a step needs it either side, along its straight (mm). */
  bendMm: number;
  /** The straight kept level off a kit's mouth (mm): the dip runs at least this far. */
  kitClearanceMm: number;
}

interface GasBody { a: Point2D; b: Point2D; radius: number }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** A kit's tubes on the plan, each with the radius its cover has. */
function kitBodies(kit: HvacElement): GasBody[] {
  const model = buildRefrigerantBranchKitViewModel(kit);
  const line = model.gas;
  const angle = ((kit.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const world = (point: Point2D): Point2D => ({
    x: kit.position.x + kit.width / 2 + point.x * cos - point.y * sin,
    y: kit.position.y + kit.depth / 2 + point.x * sin + point.y * cos,
  });
  return [line.inletTube, line.inletRunTube, line.mainTube, line.branchTube].flatMap((tube) => {
    const points = tube.points.map(world);
    const radius = tube.outerDiameterMm / 2 + DEFAULT_REFRIGERANT_PIPE_INSULATION_THICKNESS_MM;
    return points.slice(1).map((point, index) => ({ a: points[index]!, b: point, radius }));
  });
}

/** What the liquid has to keep off at the corridor: the gas lines' level stretches and the gas kits' tubes. */
function gasBodies(elements: readonly HvacElement[], options: PairDipOptions): GasBody[] {
  const bodies: GasBody[] = [];
  for (const element of elements) {
    if (element.type === 'refrigerant-branch-kit') {
      if (element.properties.branchKitLineKind === 'gas') bodies.push(...kitBodies(element));
      continue;
    }
    if (element.type !== 'refrigerant-pipe') continue;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    if (spec.lineKind !== 'gas') continue;
    const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    for (let index = 1; index < nodes.length; index += 1) {
      const a = nodes[index - 1]!;
      const b = nodes[index]!;
      // A riser, or a stretch at another level, is no meeting at the corridor.
      if (Math.abs(a.z - options.corridorZ) > options.dipMm || Math.abs(b.z - options.corridorZ) > options.dipMm) continue;
      bodies.push({ a, b, radius: spec.outerDiameterMm / 2 });
    }
  }
  return bodies;
}

const planDistance = (point: Point2D, a: Point2D, b: Point2D): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(dx * dx + dy * dy, EPS)));
  return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
};

/** The stations along these nodes (plan length) where the pipe would meet a gas body, as spans. */
function meetingSpans(nodes: readonly PipeRouteNode3D[], radiusMm: number, bodies: readonly GasBody[], options: PairDipOptions): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let station = 0;
  let open: [number, number] | null = null;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPS) continue;
    const atCorridor = Math.abs(a.z - options.corridorZ) <= options.dipMm && Math.abs(b.z - options.corridorZ) <= options.dipMm;
    const near = atCorridor ? bodies.filter((body) => {
      const reach = radiusMm + body.radius;
      return Math.min(a.x, b.x) - reach <= Math.max(body.a.x, body.b.x) && Math.max(a.x, b.x) + reach >= Math.min(body.a.x, body.b.x)
        && Math.min(a.y, b.y) - reach <= Math.max(body.a.y, body.b.y) && Math.max(a.y, b.y) + reach >= Math.min(body.a.y, body.b.y);
    }) : [];
    const steps = Math.max(1, Math.ceil(length / SAMPLE_MM));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const at = station + length * t;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const meets = near.some((body) => planDistance(point, body.a, body.b) < radiusMm + body.radius - 0.5);
      if (meets) {
        if (open) open[1] = at;
        else open = [at, at];
      } else if (open) {
        spans.push(open);
        open = null;
      }
    }
    station += length;
  }
  if (open) spans.push(open);
  return spans;
}

/** The plan stretches of a run that are straight, as [from, to] stations (a fitted arc's chords are not). */
function straightSpans(nodes: readonly PipeRouteNode3D[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let station = 0;
  let previous: Point2D | null = null;
  let start = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPS) {
      // A riser ends a straight.
      if (previous) spans.push([start, station]);
      previous = null;
      start = station;
      continue;
    }
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    if (previous && previous.x * direction.x + previous.y * direction.y < 1 - 1e-6) {
      spans.push([start, station]);
      start = station;
    }
    previous = direction;
    station += length;
  }
  if (previous) spans.push([start, station]);
  return spans;
}

/**
 * The level along a run, its dips in it: `nodes` with the corridor stretch lowered over `spans`, each dip's ends a
 * plumb step a bend clear of the meeting, on a straight with a bend's room either side, moved along to where one has
 * (else the dip runs to the stretch's end). Null when there is nothing to do.
 */
export function dippedNodes(nodes: readonly PipeRouteNode3D[], spans: ReadonlyArray<readonly [number, number]>, options: Pick<PairDipOptions, 'corridorZ' | 'dipMm' | 'bendMm'>): PipeRouteNode3D[] | null {
  if (!spans.length) return null;
  const { corridorZ, dipMm, bendMm } = options;
  const dipZ = corridorZ - dipMm;
  // The stations of each node; the corridor's stretch: its first to last node at that level.
  const stations: number[] = [0];
  for (let index = 1; index < nodes.length; index += 1) stations.push(stations[index - 1]! + Math.hypot(nodes[index]!.x - nodes[index - 1]!.x, nodes[index]!.y - nodes[index - 1]!.y));
  const onCorridor = nodes.map((node) => Math.abs(node.z - corridorZ) <= 1e-3);
  const first = onCorridor.indexOf(true);
  const last = onCorridor.lastIndexOf(true);
  if (first < 0) return null;
  const from = stations[first]!;
  const to = stations[last]!;
  const straights = straightSpans(nodes.slice(first, last + 1)).map(([a, b]) => [a + from, b + from] as const);
  /** The latest station at or before `at` a step down can stand on (a bend's room either side on its straight); null: none. */
  const stepDown = (at: number): number | null => {
    for (let index = straights.length - 1; index >= 0; index -= 1) {
      const [a, b] = straights[index]!;
      const step = Math.min(at, b - bendMm);
      if (step >= a + bendMm - EPS) return step;
    }
    return null;
  };
  /** The first station at or after `at` a step up can stand on; null: none. */
  const stepUp = (at: number): number | null => {
    for (const [a, b] of straights) {
      const step = Math.max(at, a + bendMm);
      if (step <= b - bendMm + EPS) return step;
    }
    return null;
  };
  // Each meeting with its steps (null: dipped from the stretch's start, or to its end); those too close for the two
  // bottom bends between them become one dip.
  const merged: Array<{ down: number | null; up: number | null }> = [];
  for (const [low, high] of [...spans].filter(([low, high]) => high >= from && low <= to).sort((p, q) => p[0] - q[0])) {
    const down = low <= from + EPS ? null : stepDown(low - bendMm - DIP_MARGIN_MM);
    const up = high >= to - EPS ? null : stepUp(high + bendMm + DIP_MARGIN_MM);
    const previous = merged.at(-1);
    if (previous && (previous.up === null || down === null || previous.up + 2 * bendMm > down - EPS)) {
      previous.up = previous.up === null || up === null ? null : Math.max(previous.up, up);
      continue;
    }
    merged.push({ down, up });
  }
  if (!merged.length) return null;
  const dipped = (station: number) => merged.some(({ down, up }) => (down === null || station > down + EPS) && (up === null || station < up - EPS));
  // The steps become node pairs (plumb); the corridor's nodes between them take the dipped level.
  const steps = merged.flatMap(({ down, up }) => [...(down !== null ? [{ at: down, sense: -1 }] : []), ...(up !== null ? [{ at: up, sense: 1 }] : [])])
    .sort((p, q) => p.at - q.at);
  const pair = (point: Point2D, sense: number): PipeRouteNode3D[] => (sense < 0
    ? [{ ...point, z: corridorZ }, { ...point, z: dipZ }] : [{ ...point, z: dipZ }, { ...point, z: corridorZ }]);
  const out: PipeRouteNode3D[] = [];
  nodes.forEach((node, index) => {
    const here = stations[index]!;
    if (index > 0) {
      const before = stations[index - 1]!;
      const previous = nodes[index - 1]!;
      for (const step of steps.filter((entry) => entry.at > before + EPS && entry.at < here - EPS)) {
        const t = (step.at - before) / Math.max(here - before, EPS);
        out.push(...pair({ x: previous.x + (node.x - previous.x) * t, y: previous.y + (node.y - previous.y) * t }, step.sense));
      }
    }
    const onStep = onCorridor[index] ? steps.find((entry) => Math.abs(entry.at - here) <= EPS) : undefined;
    if (onStep) out.push(...pair({ x: node.x, y: node.y }, onStep.sense));
    else out.push(onCorridor[index] ? { ...node, z: dipped(here) ? dipZ : corridorZ } : { ...node });
  });
  return out;
}

const isKitConnection = (connection: unknown) => {
  const raw = record(connection);
  return raw.connectionKind === 'field-pipe' && typeof raw.terminalRole === 'string';
};

/**
 * The network with its liquid dipped wherever it would meet the gas at the shared corridor: every liquid kit at the
 * dipped level, each liquid run's ends at a kit with it, and the runs lowered for those ends and the meetings.
 */
export function withPairDips(elements: readonly HvacElement[], options: PairDipOptions): HvacElement[] {
  const bodies = gasBodies(elements, options);
  return elements.map((element) => {
    if (element.type === 'refrigerant-branch-kit') {
      return element.properties.branchKitLineKind === 'liquid' ? { ...element, elevation: element.elevation - options.dipMm } : element;
    }
    if (element.type !== 'refrigerant-pipe') return element;
    const spec = resolveRefrigerantPipeSpec(element.properties);
    if (spec.lineKind !== 'liquid') return element;
    const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
    if (nodes.length < 2) return element;
    const atStartKit = isKitConnection(element.properties.startConnection);
    const atEndKit = isKitConnection(element.properties.endConnection);
    let total = 0;
    for (let index = 1; index < nodes.length; index += 1) total += Math.hypot(nodes[index]!.x - nodes[index - 1]!.x, nodes[index]!.y - nodes[index - 1]!.y);
    const spans: Array<[number, number]> = meetingSpans(nodes, spec.outerDiameterMm / 2, bodies, options);
    if (atStartKit) spans.push([0, Math.min(total, options.kitClearanceMm)]);
    if (atEndKit) spans.push([Math.max(0, total - options.kitClearanceMm), total]);
    const dipped = dippedNodes(nodes, spans, options);
    if (!dipped) return element;
    const lowered = (connection: unknown, atKit: boolean) => (atKit ? { ...record(connection), elevationMm: options.corridorZ - options.dipMm } : connection);
    const min = Math.min(...dipped.map((node) => node.z));
    const max = Math.max(...dipped.map((node) => node.z));
    const radius = spec.outerDiameterMm / 2;
    return {
      ...element, elevation: min - radius, height: max - min + 2 * radius,
      properties: {
        ...element.properties, routeNodes3d: dipped,
        startConnection: lowered(element.properties.startConnection, atStartKit),
        endConnection: lowered(element.properties.endConnection, atEndKit),
      },
    };
  });
}
