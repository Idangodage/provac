/**
 * Condensate network planner — "route in plan, solve in Z, repair, size, fit".
 *
 * 1. Environment: drain sources, terminations, ceiling-void envelope, plan
 *    obstacles, walls, refrigerant centrelines.
 * 2. Assignment: every unit is routed to its K nearest terminations; each gets
 *    the cheapest one it can DRAIN to (gravity preferred over pump lift),
 *    respecting termination capacity limits (greedy by regret).
 * 3. Tree growth per termination (a gravity arborescence): units farthest-first
 *    so the critical unit forms the trunk; each next unit runs a multi-target
 *    search to the termination or any admissible station on the tree, and a
 *    target is accepted only if the branch can still fall to it. Several trunk
 *    orders are tried and the cheapest complete tree kept.
 * 4. Sizing by connected capacity (never smaller than an outlet, never
 *    decreasing downstream), then the exact Z solve (condensateProfileSolver):
 *    steepest uniform fall in [min, preferred], minimal pump lifts, steeper
 *    branches where they have spare head without lowering the main.
 * 5. Refrigerant coordination with gravity priority: each crossing window is
 *    held below the refrigerant run, else above it, else a refrigerant hop is
 *    proposed (the drain keeps its fall).
 *
 * Pure and deterministic (injectable id factory); safe to run in a worker.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { getActivePipeRoutingSettings, resolvePipeRoutingSettings, setActivePipeRoutingSettings, type PipeRoutingSettings } from '../pipeRoutingSettings';

import {
  UNIT_CONNECTION_ZONE_MM,
  buildCondensateEnvironment,
  type CondensateEnvelope,
  type CondensateEnvironment,
  type CondensateEnvironmentOptions,
  type CondensateSink,
  type ServiceSegment,
} from './condensateEnvironment';
import { add, closestOnSegment, distance, dot, normalize, pointToSegmentDistance, scale, sub } from './condensateGeometry';
import { selectCondensatePipeSize, type CondensatePipeSize } from './condensatePipeCatalog';
import type { IndoorDrainPort } from './condensatePorts';
import { maxFeasibleSlope, solveProfile, type ProfileNode, type ProfileSolution } from './condensateProfileSolver';
import { routeCondensateBranch, type RouteTarget, type RouterBox, type RouterServiceLine, type RouterTreeSegment } from './condensateRouter';
import type { CondensateDesignSettings } from './condensateSettings';

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export type CondensateUnitStatus = 'gravity' | 'pumped' | 'infeasible' | 'skipped';

export interface CondensateUnitResult {
  unitId: string;
  label: string;
  gullyId: string | null;
  status: CondensateUnitStatus;
  lengthMm: number;
  fallUsedMm: number;
  headMarginMm: number;
  liftMm: number;
  shortfallMm?: number;
  reason?: string;
}

export interface CondensateCrossing {
  key: string;
  serviceElementId: string;
  /** All refrigerant lines inside this crossing window (a pair crosses as one). */
  serviceElementIds: string[];
  point: Point2D;
  relation: 'below' | 'above' | 'hop' | 'unresolved';
  condensateZ: number;
  serviceZMin: number;
  serviceZMax: number;
  requiredClearanceMm: number;
  networkId: string;
}

export interface RefrigerantHopProposal {
  key: string;
  refrigerantElementId: string;
  point: Point2D;
  networkId: string;
  condensateZ: number;
  /** Refrigerant centreline must rise to at least this level over the drain. */
  requiredCentrelineZ: number;
  /** Plan half-span of the drain's clash window (for the hop's flat top). */
  halfWindowMm: number;
  withinSoffit: boolean;
}

export type NetNodeKind = 'port' | 'stub' | 'lift-top' | 'vertex' | 'junction' | 'branch-end' | 'crossing' | 'drop-top' | 'root';
export type NetEdgeKind = 'stub' | 'lift' | 'run' | 'join' | 'drop' | 'none';

export interface NetNode {
  id: string;
  kind: NetNodeKind;
  point: Point2D;
  down: string | null;
  edge: NetEdgeKind;
  unitId?: string;
  /** Solved centreline elevation. */
  z: number;
  slackMm: number;
  /** Extra bounds (crossing windows, the Mitsubishi −100 mm rule…). */
  upper?: number;
  lower?: number;
  upperReason?: string;
  lowerReason?: string;
  crossingKey?: string;
}

export interface SolvedUnit {
  source: IndoorDrainPort;
  portId: string;
  stubId: string;
  liftTopId: string;
  pumped: boolean;
  liftMm: number;
  trap: boolean;
  routeLengthMm: number;
}

export interface SolvedCondensateNetwork {
  networkId: string;
  sink: CondensateSink;
  exposed: boolean;
  nodes: Map<string, NetNode>;
  rootId: string;
  dropTopId: string;
  units: SolvedUnit[];
  /** Slope per node edge (percent) for sloped edges. */
  slopes: Map<string, number>;
  /** Selected pipe size per node edge. */
  sizes: Map<string, CondensatePipeSize>;
  upstreamUnits: Map<string, string[]>;
  mainSlopePercent: number;
  wallCrossings: Array<{ wallId: string; point: Point2D }>;
  crossings: CondensateCrossing[];
  feasible: boolean;
}

export interface CondensateNetworkPlan {
  environment: CondensateEnvironment;
  envelope: CondensateEnvelope;
  networks: SolvedCondensateNetwork[];
  perUnit: CondensateUnitResult[];
  hopProposals: RefrigerantHopProposal[];
  unresolvedPaths: Array<{ unitId: string; points: Point2D[]; shortfallMm: number | null }>;
  issues: string[];
}

export interface CondensatePlanOptions extends Omit<CondensateEnvironmentOptions, 'routingSettings'> {
  routingSettings?: Partial<PipeRoutingSettings>;
  idFactory?: (prefix: string) => string;
  onProgress?: (progress: { stage: string; completed: number; total: number }) => void;
}

// ---------------------------------------------------------------------------
// Constants of the drainage installation (geometry, not rules)
// ---------------------------------------------------------------------------

const STUB_LENGTH_MM = 150;
const LEAD_IN_MM = 150;
const DEFAULT_NOMINAL = { nominalSize: '32', outerDiameterMm: 32, innerDiameterMm: 28.4 };
const PUMP_ASSIGNMENT_PENALTY_MM = 3000;
const INFEASIBLE_PENALTY = 1e9;
const LIFT_STEP_MM = 25;

function defaultIdFactory(): (prefix: string) => string {
  let counter = 0;
  const salt = Math.random().toString(36).slice(2, 8);
  return (prefix) => `${prefix}-${salt}${(counter++).toString(36)}`;
}

function radiusOf(size: { outerDiameterMm: number }, settings: CondensateDesignSettings): number {
  return size.outerDiameterMm / 2 + settings.insulationThicknessMm;
}

// ---------------------------------------------------------------------------
// Router inputs
// ---------------------------------------------------------------------------

interface RouterContext {
  obstaclesFor: (unitId: string | null, gullyId: string) => RouterBox[];
  services: RouterServiceLine[];
  walls: Array<{ id: string; a: Point2D; b: Point2D }>;
}

function buildRouterContext(environment: CondensateEnvironment, defaultRadius: number): RouterContext {
  const { settings } = environment;
  const inflate = settings.equipmentClearanceMm + defaultRadius;
  const inflated = environment.obstacles.map((obstacle) => ({
    raw: { id: obstacle.id, minX: obstacle.minX, minY: obstacle.minY, maxX: obstacle.maxX, maxY: obstacle.maxY },
    padded: {
      id: obstacle.id,
      minX: obstacle.minX - inflate,
      minY: obstacle.minY - inflate,
      maxX: obstacle.maxX + inflate,
      maxY: obstacle.maxY + inflate,
    },
  }));
  const services: RouterServiceLine[] = [];
  environment.services.forEach((segment, index) => {
    if (distance(segment.a, segment.b) < 1) return; // risers are handled as crossing windows
    services.push({
      id: `${segment.elementId}#${index}`,
      a: { x: segment.a.x, y: segment.a.y },
      b: { x: segment.b.x, y: segment.b.y },
      halfWidthMm: segment.radiusMm + defaultRadius + settings.refrigerantClearanceMm,
    });
  });
  return {
    obstaclesFor: (unitId, gullyId) => inflated
      .filter(({ raw }) => raw.id !== gullyId)
      .map(({ raw, padded }) => (raw.id === unitId ? { ...raw, minX: raw.minX - 2, minY: raw.minY - 2, maxX: raw.maxX + 2, maxY: raw.maxY + 2 } : padded)),
    services,
    walls: environment.walls.map((wall) => ({ id: wall.id, a: wall.a, b: wall.b })),
  };
}

// ---------------------------------------------------------------------------
// Network construction
// ---------------------------------------------------------------------------

interface UnitPlan {
  source: IndoorDrainPort;
  exposed: boolean;
  pumped: boolean;
  headTopZ: number;
  stubEnd: Point2D;
  stubLength: number;
}

interface CandidateRoute {
  sink: CondensateSink;
  points: Point2D[];
  lengthMm: number;
  cost: number;
  feasibleGravity: boolean;
  feasiblePumped: boolean;
  shortfallMm: number;
}

class NetBuilder {
  nodes = new Map<string, NetNode>();
  rootId: string;
  dropTopId: string;
  units: Array<{ plan: UnitPlan; portId: string; stubId: string; liftTopId: string; routeLengthMm: number; routeCost: number }> = [];
  wallCrossings: Array<{ wallId: string; point: Point2D }> = [];
  totalCost = 0;
  private counter = 0;

  constructor(readonly networkId: string, readonly sink: CondensateSink) {
    this.rootId = this.add({ kind: 'root', point: sink.point, down: null, edge: 'none' });
    this.dropTopId = this.add({ kind: 'drop-top', point: sink.point, down: this.rootId, edge: 'drop' });
  }

  clone(): NetBuilder {
    const copy = new NetBuilder(this.networkId, this.sink);
    copy.nodes = new Map([...this.nodes].map(([id, node]) => [id, { ...node, point: { ...node.point } }]));
    copy.rootId = this.rootId;
    copy.dropTopId = this.dropTopId;
    copy.units = this.units.map((unit) => ({ ...unit }));
    copy.wallCrossings = [...this.wallCrossings];
    copy.totalCost = this.totalCost;
    copy.counter = this.counter;
    return copy;
  }

  add(node: Omit<NetNode, 'id' | 'z' | 'slackMm'>): string {
    const id = `${this.networkId}:n${this.counter++}`;
    this.nodes.set(id, { ...node, id, z: 0, slackMm: 0 });
    return id;
  }

  upstreamOf(id: string): string[] {
    return [...this.nodes.values()].filter((node) => node.down === id).map((node) => node.id);
  }

  /** Splits the run from `upId` to its downstream node at `point`; returns the new node id. */
  split(upId: string, point: Point2D, kind: NetNodeKind): string {
    const up = this.nodes.get(upId)!;
    const id = this.add({ kind, point: { ...point }, down: up.down, edge: 'run' });
    up.down = id;
    return id;
  }

  /** Horizontal run edges available as attach targets. */
  treeSegments(settings: CondensateDesignSettings): RouterTreeSegment[] {
    const segments: RouterTreeSegment[] = [];
    for (const node of this.nodes.values()) {
      if (node.edge !== 'run' || !node.down) continue;
      const down = this.nodes.get(node.down)!;
      const length = distance(node.point, down.point);
      if (length < 2 * settings.junctionSpacingMm) continue;
      segments.push({
        edgeId: node.id,
        a: node.point,
        b: down.point,
        minStation: settings.junctionSpacingMm,
        maxStation: length - settings.junctionSpacingMm,
      });
    }
    // The termination point itself is also an attach target (handled as the sink).
    return segments.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  }

  hasInflow(): boolean {
    return this.upstreamOf(this.dropTopId).length > 0;
  }
}

/**
 * Riser foot positions tried beside a pumped unit, as (along the outlet,
 * across it) in mm, ordered by how far they sit from the usual foot 150 mm
 * straight out. The flexible drain hose reaches any of them; a foot tight
 * against the unit face or beside the unit's own refrigerant stubs is often the
 * only one that climbs clear of them.
 */
const RISER_FOOT_OFFSETS: ReadonlyArray<readonly [number, number]> = (() => {
  const offsets: Array<[number, number]> = [];
  for (const along of [150, 100, 60, 220, 280]) {
    for (const across of [0, 110, -110, 160, -160, 220, -220, 260, -260]) offsets.push([along, across]);
  }
  return offsets.sort((a, b) => Math.hypot(a[0] - 150, a[1]) - Math.hypot(b[0] - 150, b[1])
    || Math.abs(a[1]) - Math.abs(b[1]) || b[1] - a[1]);
})();
const RISER_SAMPLE_MM = 20;

/**
 * Highest centreline level a plumb riser at `foot` can reach from `baseZ`
 * before it comes within clearance of a service pipe (the unit's OWN
 * refrigerant included: a riser climbs straight through their level) or
 * null when the riser foot itself is already too close.
 */
function clearRiserTop(
  foot: Point2D,
  baseZ: number,
  topZ: number,
  radius: number,
  environment: CondensateEnvironment,
): number | null {
  let top = topZ;
  for (const service of environment.services) {
    const required = service.radiusMm + radius + environment.settings.refrigerantClearanceMm;
    if (pointToSegmentDistance(foot, service.a, service.b) >= required) continue;
    const span = Math.hypot(service.b.x - service.a.x, service.b.y - service.a.y, service.b.z - service.a.z);
    const samples = Math.max(1, Math.ceil(span / RISER_SAMPLE_MM));
    for (let index = 0; index <= samples; index += 1) {
      const t = index / samples;
      const x = service.a.x + (service.b.x - service.a.x) * t;
      const y = service.a.y + (service.b.y - service.a.y) * t;
      const plan = Math.hypot(x - foot.x, y - foot.y);
      if (plan >= required) continue;
      const z = service.a.z + (service.b.z - service.a.z) * t;
      const reach = Math.sqrt(required * required - plan * plan);
      if (z + reach <= baseZ) continue; // passes below the riser
      if (z - reach <= baseZ + 0.5) return null; // at the riser foot
      top = Math.min(top, z - reach);
    }
  }
  return top;
}

function insideObstacle(point: Point2D, environment: CondensateEnvironment, margin: number): boolean {
  return environment.obstacles.some((box) => point.x > box.minX - margin && point.x < box.maxX + margin
    && point.y > box.minY - margin && point.y < box.maxY + margin);
}

function makeUnitPlan(source: IndoorDrainPort, environment: CondensateEnvironment, defaultRadius: number): UnitPlan {
  const { settings, envelope } = environment;
  const voidLower = envelope.voidFloorMm + defaultRadius;
  const voidUpper = envelope.voidTopMm - defaultRadius;
  const exposed = source.z < voidLower - 1;
  const pumped = source.hasDrainPump && settings.pumpPolicy !== 'never' && source.pumpMaxLiftMm > 0 && !exposed;
  // Snapped to the router's 0.5 mm grid so the riser and the first run share one vertical.
  const footAt = (along: number, across: number): Point2D => {
    const side = { x: -source.direction.y, y: source.direction.x };
    const end = add(add(source.point, scale(source.direction, along)), scale(side, across));
    return { x: Math.round(end.x * 2) / 2, y: Math.round(end.y * 2) / 2 };
  };
  const gravityFoot = footAt(Math.min(STUB_LENGTH_MM, settings.liftMaxHorizontalMm), 0);
  if (!pumped) {
    return { source, exposed, pumped, headTopZ: source.z, stubEnd: gravityFoot, stubLength: distance(source.point, gravityFoot) };
  }
  // Site practice: the drain rises plumb beside the unit to its high point —
  // the pump head or the soffit, and below any service over the riser.
  const headLimit = Math.max(source.z, Math.min(source.z + source.pumpMaxLiftMm, voidUpper));
  let best: { foot: Point2D; top: number } | null = null;
  for (const [along, across] of RISER_FOOT_OFFSETS) {
    if (Math.hypot(along, across) > settings.liftMaxHorizontalMm + 1e-6) continue;
    const foot = footAt(along, across);
    if (insideObstacle(foot, environment, defaultRadius)) continue;
    const top = clearRiserTop(foot, source.z, headLimit, defaultRadius, environment);
    if (top === null) continue;
    // Prefer the nearest foot unless another one climbs meaningfully higher.
    if (!best || top > best.top + 10) best = { foot, top };
  }
  const chosen = best ?? { foot: gravityFoot, top: source.z };
  return {
    source,
    exposed,
    pumped,
    headTopZ: Math.max(source.z, chosen.top),
    stubEnd: chosen.foot,
    stubLength: distance(source.point, chosen.foot),
  };
}

function classLower(environment: CondensateEnvironment, exposed: boolean, radius: number, routing: PipeRoutingSettings): number {
  return exposed ? routing.floorLimitMm + radius : environment.envelope.voidFloorMm + radius;
}

function sinkLowerZ(sink: CondensateSink, lower: number): number {
  return Math.max(lower, sink.terminalZ + sink.minimumDropMm);
}

function joinDropMm(settings: CondensateDesignSettings, mainOd = DEFAULT_NOMINAL.outerDiameterMm, branchOd = DEFAULT_NOMINAL.outerDiameterMm): number {
  return mainOd / 2 + branchOd / 2 + settings.joinSocketAllowanceMm;
}

/** Inserts a routed branch into the network. */
function insertBranch(
  net: NetBuilder,
  plan: UnitPlan,
  route: { points: Point2D[]; target: RouteTarget; wallCrossings: Array<{ wallId: string; point: Point2D }>; lengthMm: number; cost: number },
  settings: CondensateDesignSettings,
  obstacles: RouterBox[],
  services: readonly RouterServiceLine[],
): void {
  const { source } = plan;
  const portId = net.add({ kind: 'port', point: source.point, down: null, edge: 'stub', unitId: source.unitId });
  const stubId = net.add({ kind: 'stub', point: plan.stubEnd, down: null, edge: 'lift', unitId: source.unitId });
  const liftTopId = net.add({ kind: 'lift-top', point: plan.stubEnd, down: null, edge: 'run', unitId: source.unitId });
  net.nodes.get(portId)!.down = stubId;
  net.nodes.get(stubId)!.down = liftTopId;
  const points = [...route.points];
  // The router starts at the stub end; drop that duplicate vertex.
  if (points.length && distance(points[0]!, plan.stubEnd) < 0.6) points.shift();

  let joinId: string;
  let lastEdge: NetEdgeKind = 'run';
  if (route.target.kind === 'sink') {
    joinId = net.dropTopId;
    if (net.hasInflow()) lastEdge = 'join';
  } else {
    const target = route.target;
    const up = net.nodes.get(target.edgeId)!;
    const down = net.nodes.get(up.down!)!;
    const flow = normalize(sub(down.point, up.point));
    let junctionPoint = target.point;
    // 45° wye lead-in: enter the main in the direction of flow.
    const last = points[points.length - 1];
    const previous = points.length >= 2 ? points[points.length - 2] : plan.stubEnd;
    if (last && previous) {
      const approach = distance(previous, last);
      const downstreamRoom = distance(target.point, down.point) - settings.junctionSpacingMm / 2;
      const leadIn = Math.min(LEAD_IN_MM, approach / 2, downstreamRoom);
      const arrival = normalize(sub(last, previous));
      if (leadIn >= 60 && Math.abs(dot(arrival, flow)) < 0.01) {
        const bend = sub(last, scale(arrival, leadIn));
        const entry = add(target.point, scale(flow, leadIn));
        const blocked = obstacles.some((box) => {
          const mid = { x: (bend.x + entry.x) / 2, y: (bend.y + entry.y) / 2 };
          return mid.x > box.minX && mid.x < box.maxX && mid.y > box.minY && mid.y < box.maxY;
        })
          // The shifted junction must not sit inside another service's footprint either.
          || services.some((service) => distance(service.a, service.b) > 1
            && pointToSegmentDistance(entry, service.a, service.b) < service.halfWidthMm);
        if (!blocked) {
          points[points.length - 1] = bend;
          points.push(entry);
          junctionPoint = entry;
        }
      }
    }
    joinId = net.split(target.edgeId, junctionPoint, 'junction');
    lastEdge = 'join';
  }
  // Vertices of the branch run.
  let cursor = liftTopId;
  const lastIndex = points.length - 1;
  points.forEach((point, index) => {
    if (index === lastIndex) return;
    const id = net.add({ kind: 'vertex', point, down: null, edge: 'run' });
    net.nodes.get(cursor)!.down = id;
    cursor = id;
  });
  if (lastEdge === 'join') {
    const endPoint = points[lastIndex] ?? plan.stubEnd;
    const branchEnd = net.add({ kind: 'branch-end', point: endPoint, down: joinId, edge: 'join' });
    net.nodes.get(cursor)!.down = branchEnd;
    net.nodes.get(cursor)!.edge = 'run';
  } else {
    net.nodes.get(cursor)!.down = joinId;
    net.nodes.get(cursor)!.edge = 'run';
  }
  net.units.push({ plan, portId, stubId, liftTopId, routeLengthMm: route.lengthMm + plan.stubLength, routeCost: route.cost });
  net.wallCrossings.push(...route.wallCrossings);
  net.totalCost += route.cost;
}

// ---------------------------------------------------------------------------
// Profile construction
// ---------------------------------------------------------------------------

interface ProfileInputs {
  settings: CondensateDesignSettings;
  environment: CondensateEnvironment;
  routing: PipeRoutingSettings;
  exposed: boolean;
  /**
   * The "main 100 mm below gravity outlets" rule is applied first; when the
   * ceiling void cannot satisfy it the planner relaxes it (branches still
   * enter from the top with a continuous fall) and reports an advisory.
   */
  relaxMainBelowPorts?: boolean;
  sizes: Map<string, CondensatePipeSize>;
  upstreamUnits: Map<string, string[]>;
  lifts: Map<string, number>;
  slopes: Map<string, number>;
  defaultSlope: number;
}

function upstreamUnitsByNode(net: NetBuilder): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const unit of net.units) {
    let cursor: string | null = unit.portId;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const set = result.get(cursor) ?? new Set<string>();
      set.add(unit.plan.source.unitId);
      result.set(cursor, set);
      cursor = net.nodes.get(cursor)?.down ?? null;
    }
  }
  return new Map([...result].map(([id, set]) => [id, [...set].sort()]));
}

function edgeLength(net: NetBuilder, node: NetNode): number {
  if (!node.down) return 0;
  if (node.edge !== 'run' && node.edge !== 'stub') return 0;
  return distance(node.point, net.nodes.get(node.down)!.point);
}

function buildProfileNodes(net: NetBuilder, inputs: ProfileInputs): ProfileNode[] {
  const { settings, environment, sizes, upstreamUnits, lifts, slopes } = inputs;
  const unitByPort = new Map(net.units.map((unit) => [unit.portId, unit]));
  const unitByStub = new Map(net.units.map((unit) => [unit.stubId, unit]));
  const unitByLiftTop = new Map(net.units.map((unit) => [unit.liftTopId, unit]));
  const gravityPortZ = new Map(net.units.filter((unit) => !unit.plan.pumped || (lifts.get(unit.plan.source.unitId) ?? 0) <= 0)
    .map((unit) => [unit.plan.source.unitId, unit.plan.source.z]));
  const nodes: ProfileNode[] = [];
  for (const node of net.nodes.values()) {
    const size = sizes.get(node.id) ?? DEFAULT_NOMINAL;
    const radius = radiusOf(size, settings);
    const lower = classLower(environment, inputs.exposed, radius, inputs.routing);
    const upperVoid = environment.envelope.voidTopMm - radius;
    const slope = (slopes.get(node.id) ?? inputs.defaultSlope) / 100;
    let w = 0;
    let upper = Number.POSITIVE_INFINITY;
    let lowerBound = Number.NEGATIVE_INFINITY;
    let upperReason: string | undefined;
    let lowerReason: string | undefined;
    switch (node.kind) {
      case 'port': {
        const unit = unitByPort.get(node.id)!;
        upper = unit.plan.source.z;
        upperReason = `drain outlet of ${unit.plan.source.label}`;
        break;
      }
      case 'stub':
      case 'lift-top': {
        const unit = unitByStub.get(node.id) ?? unitByLiftTop.get(node.id)!;
        if (node.kind === 'lift-top') {
          upper = unit.plan.pumped ? upperVoid : unit.plan.source.z;
          upperReason = unit.plan.pumped ? 'soffit above the pump riser' : `drain outlet of ${unit.plan.source.label}`;
        }
        break;
      }
      case 'root':
        upper = net.sink.terminalZ;
        lowerBound = net.sink.terminalZ;
        upperReason = `${net.sink.label} termination level`;
        lowerReason = `${net.sink.label} termination level`;
        break;
      default:
        upper = upperVoid;
        lowerBound = lower;
        upperReason = 'ceiling void soffit';
        lowerReason = inputs.exposed ? 'floor clearance' : 'ceiling void (top of ceiling tiles)';
    }
    if (node.kind === 'junction' && !inputs.relaxMainBelowPorts) {
      const units = upstreamUnits.get(node.id) ?? [];
      const gravityPorts = units.map((id) => gravityPortZ.get(id)).filter((z): z is number => z !== undefined);
      if (units.length >= 2 && gravityPorts.length) {
        const limit = Math.min(...gravityPorts) - settings.mainBelowPortsMm;
        if (limit < upper) {
          upper = limit;
          upperReason = `collective main ${settings.mainBelowPortsMm} mm below the drain outlets`;
        }
      }
    }
    if (node.upper !== undefined && node.upper < upper) {
      upper = node.upper;
      upperReason = node.upperReason;
    }
    if (node.lower !== undefined && node.lower > lowerBound) {
      lowerBound = node.lower;
      lowerReason = node.lowerReason;
    }
    switch (node.edge) {
      case 'stub': {
        const unit = unitByPort.get(node.id)!;
        const lifted = unit.plan.pumped && (lifts.get(unit.plan.source.unitId) ?? 0) > 0;
        w = lifted ? 0 : slope * edgeLength(net, node);
        break;
      }
      case 'lift': {
        const unit = unitByStub.get(node.id)!;
        w = -(unit.plan.pumped ? lifts.get(unit.plan.source.unitId) ?? 0 : 0);
        break;
      }
      case 'run':
        w = slope * edgeLength(net, node);
        break;
      case 'join': {
        const down = node.down ? net.nodes.get(node.down) : null;
        const mainSize = down ? sizes.get(down.id) ?? DEFAULT_NOMINAL : DEFAULT_NOMINAL;
        w = joinDropMm(settings, mainSize.outerDiameterMm, size.outerDiameterMm);
        break;
      }
      case 'drop':
        w = net.sink.minimumDropMm;
        break;
      default:
        w = 0;
    }
    nodes.push({
      id: node.id,
      down: node.down,
      w,
      upper,
      lower: lowerBound,
      ...(upperReason ? { upperReason } : {}),
      ...(lowerReason ? { lowerReason } : {}),
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function sizeNetwork(net: NetBuilder, settings: CondensateDesignSettings, upstreamUnits: Map<string, string[]>): Map<string, CondensatePipeSize> {
  const unitById = new Map(net.units.map((unit) => [unit.plan.source.unitId, unit.plan.source]));
  const sizes = new Map<string, CondensatePipeSize>();
  // Leaves → root so each pipe knows the largest pipe feeding it.
  const order = topologicalLeavesFirst(net);
  for (const id of order) {
    const node = net.nodes.get(id)!;
    const units = (upstreamUnits.get(id) ?? []).map((unitId) => unitById.get(unitId)).filter((unit): unit is IndoorDrainPort => Boolean(unit));
    const feeding = net.upstreamOf(id).map((upId) => sizes.get(upId)?.outerDiameterMm ?? 0);
    const selection = selectCondensatePipeSize({
      upstreamCapacityKw: units.reduce((sum, unit) => sum + unit.capacityKw, 0),
      largestOutletOuterDiameterMm: Math.max(0, ...units.map((unit) => unit.outletOuterDiameterMm)),
      upstreamUnitCount: units.length,
      slopePercent: settings.minSlopePercent,
      minimumOuterDiameterMm: Math.max(0, ...feeding),
    }, settings);
    sizes.set(node.id, selection.size);
  }
  return sizes;
}

function topologicalLeavesFirst(net: NetBuilder): string[] {
  const children = new Map<string, string[]>();
  for (const node of net.nodes.values()) {
    if (!node.down) continue;
    const list = children.get(node.down) ?? [];
    list.push(node.id);
    children.set(node.down, list);
  }
  const order: string[] = [];
  const visit = (id: string, guard: Set<string>) => {
    if (guard.has(id)) return;
    guard.add(id);
    for (const child of (children.get(id) ?? []).sort()) visit(child, guard);
    order.push(id);
  };
  visit(net.rootId, new Set());
  return order;
}

// ---------------------------------------------------------------------------
// Crossings with other services
// ---------------------------------------------------------------------------

interface CrossingWindow {
  upId: string;
  downId: string;
  /** The edge as detected; splits never change these, so t stays meaningful. */
  a: Point2D;
  b: Point2D;
  t1: number;
  t2: number;
  point: Point2D;
  /** Every service segment inside the window (a gas/liquid pair crosses as one). */
  services: ServiceSegment[];
  zMin: number;
  zMax: number;
  requiredMm: number;
  condensateRadiusMm: number;
}

/** Overlapping windows on one edge become one window: one pass-below / pass-above decision. */
function mergeCrossingWindows(windows: CrossingWindow[]): CrossingWindow[] {
  const byEdge = new Map<string, CrossingWindow[]>();
  for (const window of windows) {
    const list = byEdge.get(window.upId) ?? [];
    list.push(window);
    byEdge.set(window.upId, list);
  }
  const merged: CrossingWindow[] = [];
  for (const list of byEdge.values()) {
    list.sort((left, right) => left.t1 - right.t1);
    let current: CrossingWindow | null = null;
    for (const window of list) {
      if (current && window.t1 <= current.t2 + 1e-6) {
        const tighter: CrossingWindow = window.requiredMm > current.requiredMm ? window : current;
        const base: CrossingWindow = current;
        current = {
          ...base,
          t2: Math.max(current.t2, window.t2),
          point: tighter.point,
          services: [...current.services, ...window.services],
          zMin: Math.min(current.zMin, window.zMin),
          zMax: Math.max(current.zMax, window.zMax),
          requiredMm: Math.max(current.requiredMm, window.requiredMm),
        };
      } else {
        if (current) merged.push(current);
        current = { ...window };
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}

function planDistanceAt(a: Point2D, b: Point2D, t: number, c: Point2D, d: Point2D): number {
  return pointToSegmentDistance({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, c, d);
}

function findCrossingWindows(
  net: NetBuilder,
  services: readonly ServiceSegment[],
  sizes: Map<string, CondensatePipeSize>,
  settings: CondensateDesignSettings,
  unitPorts: ReadonlyMap<string, Point2D>,
): CrossingWindow[] {
  // A unit's drain and its OWN refrigerant stubs share the manufacturer's
  // connection zone; coordination clearances start outside it.
  const inOwnConnectionZone = (service: ServiceSegment, point: Point2D) => service.connectedUnitIds.some((unitId) => {
    const port = unitPorts.get(unitId);
    return port !== undefined && distance(port, point) <= UNIT_CONNECTION_ZONE_MM;
  });
  const windows: CrossingWindow[] = [];
  for (const node of net.nodes.values()) {
    if (node.edge !== 'run' || !node.down) continue;
    const down = net.nodes.get(node.down)!;
    const a = node.point;
    const b = down.point;
    if (distance(a, b) < 1) continue;
    const radius = radiusOf(sizes.get(node.id) ?? DEFAULT_NOMINAL, settings);
    for (const service of services) {
      const required = radius + service.radiusMm + settings.refrigerantClearanceMm;
      const c = { x: service.a.x, y: service.a.y };
      const d = { x: service.b.x, y: service.b.y };
      // Convex in t: ternary search for the closest station, then bisect the window edges.
      let lo = 0;
      let hi = 1;
      for (let iteration = 0; iteration < 60; iteration += 1) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (planDistanceAt(a, b, m1, c, d) <= planDistanceAt(a, b, m2, c, d)) hi = m2; else lo = m1;
      }
      const tMin = (lo + hi) / 2;
      if (planDistanceAt(a, b, tMin, c, d) > required) continue;
      if (inOwnConnectionZone(service, { x: a.x + (b.x - a.x) * tMin, y: a.y + (b.y - a.y) * tMin })) continue;
      const edge = (from: number, to: number) => {
        if (planDistanceAt(a, b, to, c, d) <= required) return to;
        let inside = from;
        let outside = to;
        for (let iteration = 0; iteration < 40; iteration += 1) {
          const mid = (inside + outside) / 2;
          if (planDistanceAt(a, b, mid, c, d) <= required) inside = mid; else outside = mid;
        }
        return outside;
      };
      const t1 = edge(tMin, 0);
      const t2 = edge(tMin, 1);
      const zAt = (t: number) => {
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const { t: u } = closestOnSegment(p, c, d);
        return service.a.z + (service.b.z - service.a.z) * u;
      };
      const vertical = distance(c, d) < 1;
      const zs = vertical ? [service.a.z, service.b.z] : [zAt(t1), zAt(tMin), zAt(t2)];
      windows.push({
        upId: node.id,
        downId: down.id,
        a: { ...a },
        b: { ...b },
        t1,
        t2,
        point: { x: a.x + (b.x - a.x) * tMin, y: a.y + (b.y - a.y) * tMin },
        services: [service],
        zMin: Math.min(...zs),
        zMax: Math.max(...zs),
        requiredMm: required,
        condensateRadiusMm: radius,
      });
    }
  }
  return mergeCrossingWindows(windows);
}

// ---------------------------------------------------------------------------
// Solve one network
// ---------------------------------------------------------------------------

interface NetworkSolveResult {
  solution: ProfileSolution;
  slopes: Map<string, number>;
  lifts: Map<string, number>;
  mainSlope: number;
}

function solveNetwork(net: NetBuilder, base: Omit<ProfileInputs, 'slopes' | 'lifts' | 'defaultSlope'>): NetworkSolveResult | { failure: ProfileSolution } {
  const { settings } = base;
  const maxLifts = new Map(net.units.map((unit) => [unit.plan.source.unitId, unit.plan.pumped ? Math.max(0, unit.plan.headTopZ - unit.plan.source.z) : 0]));
  const build = (lifts: Map<string, number>, slopes: Map<string, number>) => (slope: number) =>
    buildProfileNodes(net, { ...base, lifts, slopes, defaultSlope: slope });
  const minSlope = settings.minSlopePercent;
  // Gravity first: a drain pump is only relied on by the units that need it.
  let allowed = new Map(maxLifts);
  let search = settings.pumpPolicy === 'always'
    ? null
    : maxFeasibleSlope(build(new Map(net.units.map((unit) => [unit.plan.source.unitId, 0])), new Map()), minSlope, settings.preferredSlopePercent);
  if (search) {
    allowed = new Map(net.units.map((unit) => [unit.plan.source.unitId, 0]));
  } else {
    const permissive = solveProfile(build(maxLifts, new Map())(minSlope));
    if (!permissive.feasible) return { failure: permissive };
    if (settings.pumpPolicy !== 'always') {
      const byNeed = net.units
        .filter((unit) => (maxLifts.get(unit.plan.source.unitId) ?? 0) > 0)
        .map((unit) => ({ id: unit.plan.source.unitId, need: (permissive.zLow.get(unit.liftTopId) ?? 0) - unit.plan.source.z }))
        .sort((a, b) => a.need - b.need || a.id.localeCompare(b.id));
      for (const { id } of byNeed) {
        const trial = new Map(allowed);
        trial.set(id, 0);
        if (solveProfile(build(trial, new Map())(minSlope)).feasible) allowed = trial;
      }
    }
    search = maxFeasibleSlope(build(allowed, new Map()), minSlope, settings.preferredSlopePercent);
    if (!search) return { failure: permissive };
  }
  const mainSlope = search.slopePercent;
  // Minimal pump lifts at the chosen fall.
  const lifts = new Map<string, number>();
  for (const unit of net.units) {
    const id = unit.plan.source.unitId;
    const max = allowed.get(id) ?? 0;
    if (!unit.plan.pumped || max <= 0) { lifts.set(id, 0); continue; }
    if (settings.pumpPolicy === 'always') { lifts.set(id, max); continue; }
    const needed = (search.solution.zLow.get(unit.liftTopId) ?? unit.plan.source.z) - unit.plan.source.z;
    const lift = needed <= 1e-6 ? 0 : Math.min(max, Math.ceil((needed + settings.liftMarginMm) / LIFT_STEP_MM) * LIFT_STEP_MM);
    lifts.set(id, lift);
  }
  let solution = solveProfile(build(lifts, new Map())(mainSlope));
  if (!solution.feasible) {
    // Rounding pushed a lift past the head; fall back to the full head.
    for (const [id, max] of allowed) if (max > 0) lifts.set(id, max);
    solution = solveProfile(build(lifts, new Map())(mainSlope));
  }
  // Steeper unit branches where they have spare head, without lowering the main.
  const slopes = new Map<string, number>();
  const upstream = base.upstreamUnits;
  for (const unit of [...net.units].sort((a, b) => a.plan.source.unitId.localeCompare(b.plan.source.unitId))) {
    const unitId = unit.plan.source.unitId;
    const chain: string[] = [];
    let cursor: string | null = unit.portId;
    while (cursor) {
      const node: NetNode = net.nodes.get(cursor)!;
      if ((upstream.get(cursor) ?? []).length !== 1 || node.kind === 'drop-top' || node.kind === 'root') break;
      chain.push(cursor);
      cursor = node.down;
    }
    const exit = cursor;
    const sloped = chain.filter((id) => {
      const node = net.nodes.get(id)!;
      return node.edge === 'run' || (node.edge === 'stub' && (lifts.get(unitId) ?? 0) <= 0);
    });
    const chainLength = sloped.reduce((sum, id) => sum + edgeLength(net, net.nodes.get(id)!), 0);
    if (!exit || chainLength < 1 || mainSlope >= settings.preferredSlopePercent - 1e-6) continue;
    const before = solution.zHigh.get(exit)!;
    const last = chain[chain.length - 1]!;
    const lastNode = net.nodes.get(last)!;
    const lastJoin = lastNode.edge === 'join' ? joinDropMm(settings) : 0;
    const spare = (solution.zHigh.get(last)! - lastJoin) - before;
    if (spare <= 1) continue;
    const candidate = Math.min(settings.preferredSlopePercent, mainSlope + (spare / chainLength) * 100);
    const trial = new Map(slopes);
    for (const id of sloped) trial.set(id, candidate);
    const trialSolution = solveProfile(build(lifts, trial)(mainSlope));
    if (trialSolution.feasible && Math.abs((trialSolution.zHigh.get(exit) ?? 0) - before) <= 0.5) {
      for (const id of sloped) slopes.set(id, candidate);
      solution = trialSolution;
    }
  }
  return { solution, slopes, lifts, mainSlope };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function planCondensateNetwork(scene: HvacElement[], options: CondensatePlanOptions): CondensateNetworkPlan {
  const routing = resolvePipeRoutingSettings({ ...getActivePipeRoutingSettings(), ...(options.routingSettings ?? {}) });
  const previousRouting = getActivePipeRoutingSettings();
  // Refrigerant lane geometry reads the active routing singleton.
  setActivePipeRoutingSettings(routing);
  try {
    return planWithRouting(scene, options, routing);
  } finally {
    setActivePipeRoutingSettings(previousRouting);
  }
}

function planWithRouting(scene: HvacElement[], options: CondensatePlanOptions, routing: PipeRoutingSettings): CondensateNetworkPlan {
  const settings = options.settings;
  const idFactory = options.idFactory ?? defaultIdFactory();
  const progress = options.onProgress ?? (() => undefined);
  const environment = buildCondensateEnvironment(scene, { ...options, routingSettings: routing });
  const issues: string[] = [];
  const perUnit: CondensateUnitResult[] = environment.skipped.map((skip) => ({
    unitId: skip.unitId,
    label: scene.find((element) => element.id === skip.unitId)?.label ?? skip.unitId,
    gullyId: null,
    status: 'skipped',
    lengthMm: 0,
    fallUsedMm: 0,
    headMarginMm: 0,
    liftMm: 0,
    reason: skip.reason,
  }));
  const plan: CondensateNetworkPlan = {
    environment,
    envelope: environment.envelope,
    networks: [],
    perUnit,
    hopProposals: [],
    unresolvedPaths: [],
    issues,
  };
  if (!environment.sinks.length) {
    issues.push('Place at least one condensate termination (floor gully, stack connection or external discharge).');
    return plan;
  }
  if (!environment.sources.length) {
    issues.push('No indoor units with a drain outlet are in scope.');
    return plan;
  }

  const defaultRadius = radiusOf(DEFAULT_NOMINAL, settings);
  const router = buildRouterContext(environment, defaultRadius);
  const costs = {
    bendPenaltyMm: settings.bendPenaltyMm,
    wallPenaltyMm: settings.wallPenetrationPenaltyMm,
    crossingPenaltyMm: settings.refrigerantCrossingPenaltyMm,
    corridorBonusRatio: settings.corridorBonusRatio,
    overlapPenaltyRatio: 2,
    junctionPenaltyMm: settings.junctionSpacingMm,
  };
  const minSlope = settings.minSlopePercent / 100;
  const unitPlans = environment.sources.map((source) => makeUnitPlan(source, environment, defaultRadius));

  // ---- 1. Candidate terminations per unit --------------------------------
  const candidates = new Map<string, CandidateRoute[]>();
  unitPlans.forEach((unitPlan, index) => {
    progress({ stage: 'Routing units to terminations', completed: index, total: unitPlans.length });
    const ranked = [...environment.sinks]
      .sort((a, b) => (Math.abs(a.point.x - unitPlan.stubEnd.x) + Math.abs(a.point.y - unitPlan.stubEnd.y))
        - (Math.abs(b.point.x - unitPlan.stubEnd.x) + Math.abs(b.point.y - unitPlan.stubEnd.y)) || a.gullyId.localeCompare(b.gullyId))
      .slice(0, settings.gullyCandidateCount);
    const list: CandidateRoute[] = [];
    const lower = classLower(environment, unitPlan.exposed, defaultRadius, routing);
    for (const sink of ranked) {
      const route = routeCondensateBranch({
        start: unitPlan.stubEnd,
        startHeading: unitPlan.source.direction,
        sink: sink.point,
        treeSegments: [],
        obstacles: router.obstaclesFor(unitPlan.source.unitId, sink.gullyId),
        walls: router.walls,
        services: router.services,
        costs,
      });
      if (!route) continue;
      const length = route.lengthMm + unitPlan.stubLength;
      const need = sinkLowerZ(sink, lower) + minSlope * length;
      const feasibleGravity = unitPlan.source.z >= need - 1e-6;
      const feasiblePumped = unitPlan.pumped && unitPlan.headTopZ >= need - 1e-6;
      list.push({
        sink,
        points: route.points,
        lengthMm: length,
        cost: route.cost + (feasibleGravity ? 0 : feasiblePumped ? PUMP_ASSIGNMENT_PENALTY_MM : INFEASIBLE_PENALTY),
        feasibleGravity,
        feasiblePumped,
        shortfallMm: Math.max(0, need - unitPlan.headTopZ),
      });
    }
    list.sort((a, b) => a.cost - b.cost || a.sink.gullyId.localeCompare(b.sink.gullyId));
    candidates.set(unitPlan.source.unitId, list);
  });

  // ---- 2. Assignment (greedy by regret, capacity-aware) -------------------
  const remainingCapacity = new Map(environment.sinks.map((sink) => [sink.gullyId, sink.maxConnectedCapacityKw ?? Number.POSITIVE_INFINITY]));
  const regret = (unitId: string) => {
    const list = candidates.get(unitId) ?? [];
    return list.length >= 2 ? list[1]!.cost - list[0]!.cost : Number.POSITIVE_INFINITY;
  };
  const assignment = new Map<string, CandidateRoute>();
  const order = [...unitPlans].sort((a, b) => regret(b.source.unitId) - regret(a.source.unitId) || a.source.unitId.localeCompare(b.source.unitId));
  for (const unitPlan of order) {
    const list = candidates.get(unitPlan.source.unitId) ?? [];
    const choice = list.find((candidate) => (candidate.feasibleGravity || candidate.feasiblePumped)
      && (remainingCapacity.get(candidate.sink.gullyId) ?? 0) >= unitPlan.source.capacityKw);
    if (!choice) {
      const best = list[0];
      plan.perUnit.push({
        unitId: unitPlan.source.unitId,
        label: unitPlan.source.label,
        gullyId: best?.sink.gullyId ?? null,
        status: 'infeasible',
        lengthMm: best?.lengthMm ?? 0,
        fallUsedMm: 0,
        headMarginMm: 0,
        liftMm: 0,
        ...(best ? { shortfallMm: Math.round(best.shortfallMm) } : {}),
        reason: !best
          ? 'no plan route to any termination'
          : best.feasibleGravity || best.feasiblePumped
            ? 'termination capacity limit reached'
            : `lacks ${Math.round(best.shortfallMm)} mm of fall to ${best.sink.label}${unitPlan.pumped ? ' even with the drain pump' : unitPlan.source.hasDrainPump ? '' : ' (no drain pump)'}`,
      });
      if (best) plan.unresolvedPaths.push({ unitId: unitPlan.source.unitId, points: [unitPlan.source.point, ...best.points], shortfallMm: best.shortfallMm });
      continue;
    }
    assignment.set(unitPlan.source.unitId, choice);
    remainingCapacity.set(choice.sink.gullyId, (remainingCapacity.get(choice.sink.gullyId) ?? 0) - unitPlan.source.capacityKw);
  }

  // ---- 3. Trees per termination and envelope class ------------------------
  const groups = new Map<string, UnitPlan[]>();
  for (const unitPlan of unitPlans) {
    const choice = assignment.get(unitPlan.source.unitId);
    if (!choice) continue;
    const key = `${choice.sink.gullyId}|${unitPlan.exposed ? 'exposed' : 'void'}`;
    const list = groups.get(key) ?? [];
    list.push(unitPlan);
    groups.set(key, list);
  }
  const groupKeys = [...groups.keys()].sort();
  groupKeys.forEach((key, groupIndex) => {
    progress({ stage: 'Growing drainage trees', completed: groupIndex, total: groupKeys.length });
    const members = groups.get(key)!;
    const sink = assignment.get(members[0]!.source.unitId)!.sink;
    const exposed = members[0]!.exposed;
    const lengthOf = (unitPlan: UnitPlan) => assignment.get(unitPlan.source.unitId)!.lengthMm;
    const farthestFirst = [...members].sort((a, b) => lengthOf(b) - lengthOf(a) || a.source.unitId.localeCompare(b.source.unitId));
    const orders: UnitPlan[][] = [farthestFirst];
    if (farthestFirst.length > 2) {
      orders.push([farthestFirst[1]!, farthestFirst[0]!, ...farthestFirst.slice(2)]);
      orders.push([...farthestFirst].reverse());
    }
    const networkId = idFactory('cdn');
    let best: { net: NetBuilder; failed: Map<string, { points: Point2D[]; shortfallMm: number | null; reason: string }> } | null = null;
    for (const unitOrder of orders) {
      const attempt = growTree(networkId, sink, unitOrder, exposed);
      if (!best
        || attempt.net.units.length > best.net.units.length
        || (attempt.net.units.length === best.net.units.length && attempt.net.totalCost < best.net.totalCost - 1e-6)) {
        best = attempt;
      }
    }
    if (!best) return;
    for (const [unitId, failure] of best.failed) {
      const source = members.find((member) => member.source.unitId === unitId)!.source;
      plan.perUnit.push({
        unitId,
        label: source.label,
        gullyId: sink.gullyId,
        status: 'infeasible',
        lengthMm: 0,
        fallUsedMm: 0,
        headMarginMm: 0,
        liftMm: 0,
        ...(failure.shortfallMm !== null ? { shortfallMm: Math.round(failure.shortfallMm) } : {}),
        reason: failure.reason,
      });
      plan.unresolvedPaths.push({ unitId, points: failure.points, shortfallMm: failure.shortfallMm });
    }
    if (!best.net.units.length) return;
    finishNetwork(best.net, exposed);
  });

  plan.perUnit.sort((a, b) => a.label.localeCompare(b.label) || a.unitId.localeCompare(b.unitId));
  const connected = plan.perUnit.filter((unit) => unit.status === 'gravity' || unit.status === 'pumped').length;
  if (connected < environment.sources.length) {
    issues.push(`${environment.sources.length - connected} of ${environment.sources.length} indoor unit drains could not be connected.`);
  }
  progress({ stage: 'Done', completed: 1, total: 1 });
  return plan;

  // -------------------------------------------------------------------------

  function growTree(networkId: string, sink: CondensateSink, unitOrder: UnitPlan[], exposed: boolean) {
    const net = new NetBuilder(networkId, sink);
    const failed = new Map<string, { points: Point2D[]; shortfallMm: number | null; reason: string }>();
    for (const unitPlan of unitOrder) {
      const sizes = new Map<string, CondensatePipeSize>();
      const upstream = upstreamUnitsByNode(net);
      const lower = classLower(environment, exposed, defaultRadius, routing);
      const lows = net.units.length
        ? solveProfile(buildProfileNodes(net, {
          settings, environment, routing, exposed, sizes, upstreamUnits: upstream,
          lifts: new Map(net.units.map((unit) => [unit.plan.source.unitId, unit.plan.pumped ? unit.plan.headTopZ - unit.plan.source.z : 0])),
          slopes: new Map(), defaultSlope: settings.minSlopePercent,
        })).zLow
        : new Map<string, number>();
      const join = joinDropMm(settings);
      const acceptTarget = (target: RouteTarget, pathLength: number) => {
        const available = unitPlan.headTopZ - minSlope * (pathLength + unitPlan.stubLength);
        if (target.kind === 'sink') {
          const needed = sinkLowerZ(sink, lower) + (net.hasInflow() ? join : 0);
          return available >= needed - 1e-6;
        }
        const up = net.nodes.get(target.edgeId)!;
        const down = net.nodes.get(up.down!)!;
        const remaining = distance(target.point, down.point);
        const zLowAtTarget = Math.max(lower, (lows.get(down.id) ?? lower) + minSlope * remaining);
        return available - join >= zLowAtTarget - 1e-6;
      };
      const route = routeCondensateBranch({
        start: unitPlan.stubEnd,
        startHeading: unitPlan.source.direction,
        sink: sink.point,
        treeSegments: net.treeSegments(settings),
        obstacles: router.obstaclesFor(unitPlan.source.unitId, sink.gullyId),
        walls: router.walls,
        services: router.services,
        costs,
        acceptTarget,
      });
      if (!route || !route.accepted) {
        const shortfall = route
          ? Math.max(0, sinkLowerZ(sink, lower) - (unitPlan.headTopZ - minSlope * (route.lengthMm + unitPlan.stubLength)))
          : null;
        failed.set(unitPlan.source.unitId, {
          points: route ? [unitPlan.source.point, ...route.points] : [unitPlan.source.point],
          shortfallMm: shortfall,
          reason: route ? `cannot fall into the ${sink.label} network${shortfall ? ` (short by ~${Math.round(shortfall)} mm)` : ''}` : 'no plan route into the network',
        });
        continue;
      }
      insertBranch(net, unitPlan, route, settings, router.obstaclesFor(unitPlan.source.unitId, sink.gullyId), router.services);
    }
    return { net, failed };
  }

  function finishNetwork(net: NetBuilder, exposed: boolean) {
    const upstreamUnits = upstreamUnitsByNode(net);
    const sizes = sizeNetwork(net, settings, upstreamUnits);
    const base: Omit<ProfileInputs, 'slopes' | 'lifts' | 'defaultSlope'> = { settings, environment, routing, exposed, sizes, upstreamUnits };
    let solved = solveNetwork(net, base);
    if ('failure' in solved && settings.mainBelowPortsMm > 0) {
      const relaxed = solveNetwork(net, { ...base, relaxMainBelowPorts: true });
      if (!('failure' in relaxed)) {
        base.relaxMainBelowPorts = true;
        solved = relaxed;
        issues.push(`${net.sink.label}: the ceiling void is too shallow to keep the collective main ${settings.mainBelowPortsMm} mm below the gravity drain outlets; it runs as high as the fall allows and every branch still enters from the top.`);
      }
    }
    // Remove units that make the network infeasible (their fall is reported).
    const guard = new Set<string>();
    while ('failure' in solved && net.units.length) {
      const diagnosis = solved.failure.diagnosis;
      const binding = diagnosis ? net.nodes.get(diagnosis.bindingNodeId) : undefined;
      // A unit port binds directly; otherwise blame the unit with the least
      // head among those draining through the binding point.
      const through = binding ? upstreamUnitsByNode(net).get(binding.id) ?? [] : [];
      const weakest = net.units
        .filter((unit) => through.includes(unit.plan.source.unitId))
        .sort((a, b) => a.plan.headTopZ - b.plan.headTopZ || a.plan.source.unitId.localeCompare(b.plan.source.unitId))[0];
      const culprit = net.units.find((unit) => unit.plan.source.unitId === binding?.unitId)
        ?? weakest
        ?? net.units[net.units.length - 1]!;
      const unitId = culprit.plan.source.unitId;
      if (guard.has(unitId)) break;
      guard.add(unitId);
      plan.perUnit.push({
        unitId,
        label: culprit.plan.source.label,
        gullyId: net.sink.gullyId,
        status: 'infeasible',
        lengthMm: culprit.routeLengthMm,
        fallUsedMm: 0,
        headMarginMm: 0,
        liftMm: 0,
        ...(diagnosis ? { shortfallMm: Math.round(diagnosis.shortfallMm) } : {}),
        reason: diagnosis ? `lacks ${Math.round(diagnosis.shortfallMm)} mm of fall (${diagnosis.lowerReason ?? 'network level'})` : 'network infeasible',
      });
      removeUnit(net, unitId);
      const refreshed = upstreamUnitsByNode(net);
      base.upstreamUnits = refreshed;
      base.sizes = sizeNetwork(net, settings, refreshed);
      solved = solveNetwork(net, base);
    }
    if ('failure' in solved || !net.units.length) return;

    // Refrigerant crossings: hold each window below, else above, else propose a hop.
    const crossings: CondensateCrossing[] = [];
    // Far end of each edge first: a split always lands between the edge's up node
    // and the windows already inserted further downstream.
    const unitPorts = new Map(net.units.map((unit) => [unit.plan.source.unitId, unit.plan.source.point]));
    const windows = findCrossingWindows(net, environment.services, base.sizes, settings, unitPorts)
      .sort((a, b) => a.upId.localeCompare(b.upId) || b.t1 - a.t1);
    const initial = solved.solution;
    for (const window of windows) {
      const up = net.nodes.get(window.upId);
      if (!up?.down) continue;
      const { a, b } = window;
      const p1 = { x: a.x + (b.x - a.x) * window.t1, y: a.y + (b.y - a.y) * window.t1 };
      const p2 = { x: a.x + (b.x - a.x) * window.t2, y: a.y + (b.y - a.y) * window.t2 };
      const elementIds = [...new Set(window.services.map((service) => service.elementId))].sort();
      const key = `${elementIds.join('+')}@${Math.round(window.point.x / 50)},${Math.round(window.point.y / 50)}`;
      const first = net.split(up.id, p1, 'crossing');
      const second = distance(p1, p2) > 1 ? net.split(first, p2, 'crossing') : first;
      const ids = first === second ? [first] : [first, second];
      const currentZ = (() => {
        const zUp = initial.zHigh.get(up.id) ?? 0;
        const zDown = initial.zHigh.get(window.downId) ?? zUp;
        return zUp + (zDown - zUp) * ((window.t1 + window.t2) / 2);
      })();
      const serviceLabel = elementIds.length > 1 ? `refrigerant runs ${elementIds.join(', ')}` : `refrigerant ${elementIds[0]}`;
      const isDrain = window.services.every((service) => service.service === 'drain');
      const below = window.zMin - window.requiredMm;
      const above = window.zMax + window.requiredMm;
      const tryBound = (bound: { upper?: number; lower?: number; reason: string }) => {
        for (const id of ids) {
          const node = net.nodes.get(id)!;
          node.upper = bound.upper;
          node.lower = bound.lower;
          node.upperReason = bound.upper !== undefined ? bound.reason : undefined;
          node.lowerReason = bound.lower !== undefined ? bound.reason : undefined;
          node.crossingKey = key;
        }
        base.upstreamUnits = upstreamUnitsByNode(net);
        const attempt = solveNetwork(net, base);
        if ('failure' in attempt) return false;
        solved = attempt;
        return true;
      };
      let relation: CondensateCrossing['relation'];
      const preferAbove = currentZ >= above - 1e-6;
      if (!preferAbove && tryBound({ upper: below, reason: `below ${serviceLabel}` })) relation = 'below';
      else if (tryBound({ lower: above, reason: `above ${serviceLabel}` })) relation = 'above';
      else if (tryBound({ upper: below, reason: `below ${serviceLabel}` })) relation = 'below';
      else {
        tryBound({ reason: '' });
        for (const id of ids) {
          const node = net.nodes.get(id)!;
          delete node.upper;
          delete node.lower;
        }
        base.upstreamUnits = upstreamUnitsByNode(net);
        const reset = solveNetwork(net, base);
        if (!('failure' in reset)) solved = reset;
        relation = isDrain ? 'unresolved' : 'hop';
      }
      const zHere = (() => {
        const zs = ids.map((id) => (solved as NetworkSolveResult).solution.zHigh.get(id) ?? currentZ);
        return zs.reduce((sum, z) => sum + z, 0) / zs.length;
      })();
      crossings.push({
        key,
        serviceElementId: elementIds[0]!,
        serviceElementIds: elementIds,
        point: window.point,
        relation,
        condensateZ: zHere,
        serviceZMin: window.zMin,
        serviceZMax: window.zMax,
        requiredClearanceMm: window.requiredMm,
        networkId: net.networkId,
      });
      if (relation === 'hop') {
        // One hop per refrigerant line in the window; each clears the drain by its own radius.
        for (const elementId of elementIds) {
          const lines = window.services.filter((service) => service.elementId === elementId);
          const serviceRadius = Math.max(...lines.map((service) => service.radiusMm));
          const requiredCentrelineZ = zHere + window.condensateRadiusMm + serviceRadius + settings.refrigerantClearanceMm;
          // The hop sits on THIS line: project the window point onto it (a pair is ~60 mm apart).
          const onLine = lines
            .map((service) => closestOnSegment(window.point, service.a, service.b).point)
            .sort((left, right) => distance(left, window.point) - distance(right, window.point))[0] ?? window.point;
          const proposal: RefrigerantHopProposal = {
            key: `${elementId}@${Math.round(window.point.x / 50)},${Math.round(window.point.y / 50)}`,
            refrigerantElementId: elementId,
            point: { x: onLine.x, y: onLine.y },
            networkId: net.networkId,
            condensateZ: zHere,
            requiredCentrelineZ,
            halfWindowMm: window.requiredMm,
            withinSoffit: requiredCentrelineZ + serviceRadius <= environment.envelope.soffitMm,
          };
          plan.hopProposals.push(proposal);
          if (!proposal.withinSoffit) {
            issues.push(`Condensate crosses refrigerant ${elementId} with no room to pass: the refrigerant cannot hop over within the soffit.`);
          }
        }
      }
    }

    // Write the solved profile back onto the nodes.
    // `tryBound` only ever stores feasible solves, so this is a solved network.
    const final = solved as NetworkSolveResult;
    // Head margin = how far each point sits above the lowest profile that still
    // meets the MINIMUM fall — i.e. the spare head after the design uses its
    // steeper fall, not the (zero) slack against the chosen fall.
    const atMinimum = solveProfile(buildProfileNodes(net, {
      ...base, lifts: final.lifts, slopes: new Map(), defaultSlope: settings.minSlopePercent,
    }));
    for (const node of net.nodes.values()) {
      node.z = final.solution.zHigh.get(node.id) ?? 0;
      node.slackMm = Math.max(0, node.z - (atMinimum.zLow.get(node.id) ?? node.z));
    }
    const slopes = new Map<string, number>();
    for (const node of net.nodes.values()) {
      if (node.edge === 'run' || node.edge === 'stub') slopes.set(node.id, final.slopes.get(node.id) ?? final.mainSlope);
    }
    const solvedUnits: SolvedUnit[] = net.units.map((unit) => {
      const lift = final.lifts.get(unit.plan.source.unitId) ?? 0;
      const pumped = unit.plan.pumped && lift > 0;
      const root = net.nodes.get(net.dropTopId)!;
      const top = net.nodes.get(pumped ? unit.liftTopId : unit.portId)!;
      plan.perUnit.push({
        unitId: unit.plan.source.unitId,
        label: unit.plan.source.label,
        gullyId: net.sink.gullyId,
        status: pumped ? 'pumped' : 'gravity',
        lengthMm: unit.routeLengthMm,
        fallUsedMm: Math.max(0, top.z - root.z),
        headMarginMm: Math.max(0, net.nodes.get(unit.liftTopId)!.slackMm),
        liftMm: Math.round(lift),
      });
      return {
        source: unit.plan.source,
        portId: unit.portId,
        stubId: unit.stubId,
        liftTopId: unit.liftTopId,
        pumped,
        liftMm: lift,
        trap: settings.trapNegativePressureUnits && unit.plan.source.negativePressure && !pumped,
        routeLengthMm: unit.routeLengthMm,
      };
    });
    plan.networks.push({
      networkId: net.networkId,
      sink: net.sink,
      exposed,
      nodes: net.nodes,
      rootId: net.rootId,
      dropTopId: net.dropTopId,
      units: solvedUnits,
      slopes,
      sizes: base.sizes,
      upstreamUnits: base.upstreamUnits,
      mainSlopePercent: final.mainSlope,
      wallCrossings: net.wallCrossings,
      crossings,
      feasible: true,
    });
  }

  function removeUnit(net: NetBuilder, unitId: string) {
    const unit = net.units.find((candidate) => candidate.plan.source.unitId === unitId);
    if (!unit) return;
    const upstream = upstreamUnitsByNode(net);
    // Delete the nodes only this unit drains through.
    for (const [id, units] of upstream) {
      if (units.length === 1 && units[0] === unitId) net.nodes.delete(id);
    }
    // Merge junctions left with a single inflow back into plain vertices.
    for (const node of [...net.nodes.values()]) {
      if (node.kind !== 'junction') continue;
      const inflow = net.upstreamOf(node.id);
      if (inflow.length === 1) {
        const upNode = net.nodes.get(inflow[0]!)!;
        if (upNode.edge === 'join') {
          upNode.edge = 'run';
          upNode.kind = 'vertex';
        }
        node.kind = 'vertex';
      }
    }
    // A drop top left with a single branch-end inflow becomes a plain run end.
    for (const id of net.upstreamOf(net.dropTopId)) {
      const node = net.nodes.get(id)!;
      if (net.upstreamOf(net.dropTopId).length === 1 && node.edge === 'join') {
        node.edge = 'run';
        node.kind = 'vertex';
      }
    }
    net.units = net.units.filter((candidate) => candidate.plan.source.unitId !== unitId);
  }
}

export { buildCondensateEnvironment };
