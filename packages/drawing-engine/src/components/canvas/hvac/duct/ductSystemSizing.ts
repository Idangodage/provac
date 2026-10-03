/**
 * Constant-friction sizing of a duct system as it is laid out (the equal-
 * friction method, ASHRAE Handbook—Fundamentals ch. 21): every section of the
 * runs off one collar is sized at one friction rate, for the airflow it
 * carries (the terminals downstream of it), under a velocity limit by part
 * (trunk, branch, runout: noise). The friction rate and the main's velocity
 * at the system airflow are linked: the designer sets either, the other
 * follows (D = √(4Q/πV), R = friction of Ø D at Q).
 *
 * The route stays. Rectangular sections keep their height and take the
 * narrowest width (the height rises only past the aspect limit, or where a
 * fitting needs it); round sections take the smallest stock size, never under
 * the terminal's neck. The fittings must still join — a take-off fits its
 * main, a split's outlets fit the run before it, nothing grows downstream —
 * and where a rule binds the upstream section is raised and the report says
 * why. Reducers are placed again between the take-off windows, clear of the
 * elbows (a width change under the reducer step is carried on); branches are
 * re-anchored on their main's wall as resized, their ends staying on their
 * terminals. Locked runs, plenum boxes and collar-and-damper stubs before a
 * runout keep their sizes. The planner then judges the result, as for any
 * other run.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { listNetworkPipeLanes } from '../networkPipeClearance';

import { findAirPort } from './ductAirPorts';
import { branchStubMm, type AutoDuctIssue } from './ductAutoContext';
import { planDuctRunSpec, type DuctFabricationPlan } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec, reanchorKeepingEnd, startAnchor } from './ductFollow';
import { ductBranchesOf, ductParentOf } from './ductNetwork';
import { systemPressure, type ServicePressure } from './ductPressure';
import { maxRoundBranchMm } from './ductRoundFittings';
import type { DuctDesignSettings } from './ductSettings';
import {
  frictionPaPerM,
  neckVelocityMs,
  readUnitAirData,
  shareAirflow,
  sizeRectangular,
  sizeRound,
  velocityMs,
  withinLimits,
  type DuctSizingLimits,
  type FanSpeed,
} from './ductSizing';
import { resolveSoffitZ } from './ductSupports';
import { readDuctTerminalSpec } from './ductTerminals';
import {
  isRoundLeg,
  isRoundMainTapStyle,
  readDuctRunSpec,
  roundLeg,
  type DuctLeg,
  type DuctPoint3,
  type DuctRunSpec,
  type DuctService,
  type DuctSystemSizing,
  type DuctTapStart,
  type DuctTapStyle,
} from './ductTypes';
import { findDuctClashes } from './ductVolumes';
import { areaOf, geometryModel, legLabel, sameLeg, type SizingModel } from './optimizer/sizingModel';

// ---- The basis: main velocity ⇄ friction rate ----

const MIN_DIAMETER_MM = 20;
const MAX_DIAMETER_MM = 5000;

const roundTo = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Round duct diameter that carries `airflowM3h` at `velocity` (mm). */
export function diameterAtVelocityMm(airflowM3h: number, velocity: number): number {
  return 1000 * Math.sqrt((4 * (airflowM3h / 3600)) / (Math.PI * velocity));
}

/** Friction rate of the round duct that carries the airflow at that velocity (Pa/m). */
export function frictionAtVelocity(airflowM3h: number, velocity: number): number {
  if (airflowM3h <= 0 || velocity <= 0) return 0;
  return frictionPaPerM(roundLeg(diameterAtVelocityMm(airflowM3h, velocity)), airflowM3h);
}

/** Velocity in the round duct that carries the airflow at that friction rate (m/s): bisection on the diameter. */
export function velocityAtFriction(airflowM3h: number, friction: number): number {
  if (airflowM3h <= 0 || friction <= 0) return 0;
  let low = MIN_DIAMETER_MM;
  let high = MAX_DIAMETER_MM;
  for (let step = 0; step < 80; step += 1) {
    const middle = Math.sqrt(low * high);
    if (frictionPaPerM(roundLeg(middle), airflowM3h) > friction) low = middle;
    else high = middle;
  }
  return velocityMs(roundLeg(Math.sqrt(low * high)), airflowM3h);
}

/** The basis with its linked value recomputed from the one that drives, at the system airflow. */
export function linkSizingBasis(basis: DuctSystemSizing, airflowM3h: number | null): DuctSystemSizing {
  if (!airflowM3h || airflowM3h <= 0) return basis;
  return basis.drive === 'velocity'
    ? { ...basis, frictionPaPerM: roundTo(frictionAtVelocity(airflowM3h, basis.mainVelocityMs), 3) }
    : { ...basis, mainVelocityMs: roundTo(velocityAtFriction(airflowM3h, basis.frictionPaPerM), 2) };
}

/** A new basis from the project settings: their friction rate drives, their velocity caps are the limits. */
export function defaultSizingBasis(
  settings: Pick<DuctDesignSettings, 'autoFrictionSupplyPaPerM' | 'autoFrictionReturnPaPerM' | 'autoMaxVelocityTrunkMs' | 'autoMaxVelocityBranchMs' | 'autoMaxVelocityRunoutMs'>,
  service: DuctService,
  airflowM3h: number | null,
  fanSpeed: FanSpeed = 'hi',
): DuctSystemSizing {
  return linkSizingBasis({
    method: 'constant-friction',
    drive: 'friction',
    mainVelocityMs: settings.autoMaxVelocityTrunkMs,
    frictionPaPerM: service === 'return' ? settings.autoFrictionReturnPaPerM : settings.autoFrictionSupplyPaPerM,
    maxVelocity: { trunk: settings.autoMaxVelocityTrunkMs, branch: settings.autoMaxVelocityBranchMs, runout: settings.autoMaxVelocityRunoutMs },
    fanSpeed,
    airflowM3h: null,
  }, airflowM3h);
}

export type DuctSizingPart = 'trunk' | 'branch' | 'runout';

export function basisLimits(basis: Pick<DuctSystemSizing, 'frictionPaPerM' | 'maxVelocity'>, part: DuctSizingPart): DuctSizingLimits {
  return { frictionPaPerM: basis.frictionPaPerM, maxVelocityMs: basis.maxVelocity[part] };
}

export type DuctAirflowSource = 'entered' | 'unit' | 'manufacturer';

/** The system airflow a basis means for a unit: typed, else the unit's Airflow field, else its data at the fan speed. */
export function basisAirflowM3h(
  unit: Pick<HvacElement, 'properties'> | undefined,
  basis: Pick<DuctSystemSizing, 'airflowM3h' | 'fanSpeed'>,
): { airflowM3h: number | null; source: DuctAirflowSource | null } {
  if (basis.airflowM3h && basis.airflowM3h > 0) return { airflowM3h: basis.airflowM3h, source: 'entered' };
  if (!unit) return { airflowM3h: null, source: null };
  const lps = unit.properties.airflowLps;
  if (typeof lps === 'number' && Number.isFinite(lps) && lps > 0) return { airflowM3h: lps * 3.6, source: 'unit' };
  const data = readUnitAirData(unit).airflowM3h?.[basis.fanSpeed] ?? null;
  return { airflowM3h: data, source: data ? 'manufacturer' : null };
}

// ---- The report ----

/** What fixed a section's size. */
export type DuctSectionSetBy =
  | 'friction' | 'velocity' | 'capped' | 'neck' | 'minimum' | 'aspect'
  | 'take-off' | 'split' | 'downstream' | 'carried' | 'no-flow' | 'locked' | 'runout' | 'drawn';

export const DUCT_SECTION_SET_BY_LABELS: Record<DuctSectionSetBy, string> = {
  friction: 'friction rate',
  velocity: 'velocity limit',
  capped: 'largest in the void',
  neck: "terminal's neck",
  minimum: 'smallest (square)',
  aspect: 'aspect limit',
  'take-off': 'take-off fit',
  split: 'split fit',
  downstream: 'section downstream',
  carried: 'carried on',
  'no-flow': 'no airflow',
  locked: 'locked',
  runout: 'runout stub',
  drawn: 'as drawn',
};

export interface DuctSizedSection {
  runId: string;
  /** Main, a branch, or the terminal the run serves. */
  runLabel: string;
  /** Stretch of the run it covers (mm from the run's start, take-off to take-off). */
  fromMm: number;
  toMm: number;
  airflowM3h: number;
  part: DuctSizingPart;
  section: DuctLeg;
  velocityMs: number;
  frictionPaPerM: number;
  setBy: DuctSectionSetBy;
  note?: string;
}

export interface DuctSystemTerminalReport {
  terminalId: string;
  label: string;
  airflowM3h: number;
  /** Set on the terminal (true) or an equal share (false). */
  fixed: boolean;
  neckMm: number;
  neckVelocityMs: number;
  runId: string;
  /** Pressure its damper throttles to balance (Pa). */
  throttlePa: number | null;
}

export interface DuctSystemSizingReport {
  service: DuctService;
  rootRunId: string;
  unitId: string | null;
  /** The basis as linked at the system airflow. */
  basis: DuctSystemSizing;
  airflowM3h: number | null;
  airflowSource: DuctAirflowSource | null;
  /** What the terminals add up to (m³/h). */
  terminalsAirflowM3h: number;
  sections: DuctSizedSection[];
  terminals: DuctSystemTerminalReport[];
  plans: DuctFabricationPlan[];
  pressure: ServicePressure | null;
  maxEspPa: number | null;
  issues: AutoDuctIssue[];
  errors: number;
  warnings: number;
  /** Runs whose sizes or geometry changed. */
  changedRunIds: string[];
}

export interface DuctSystemSizingInput {
  basis: DuctSystemSizing;
  /** Airflow per terminal (m³/h): a number sets it, null clears it (an equal share); absent = as the terminal has it. */
  terminalAirflows?: Readonly<Record<string, number | null>>;
  /** Plan, clash-check and price the pressure of the result (default true). */
  verify?: boolean;
  /** Change nothing: report the sections as drawn, their airflow, velocity and friction (the basis only links). */
  measure?: boolean;
}

export interface DuctSystemSizingResult {
  /** Every run of the system as sized (the unchanged ones as they were). */
  runs: HvacElement[];
  /** Terminals whose design airflow changed. */
  terminals: HvacElement[];
  report: DuctSystemSizingReport;
}

// ---- The system as laid out ----

interface Segment {
  from: number;
  to: number;
  airflow: number;
  terminals: number;
  part: 'trunk' | 'branch';
  section: DuctLeg;
  setBy: DuctSectionSetBy;
  note?: string;
}

interface RunNode {
  id: string;
  element: HvacElement;
  spec: DuctRunSpec;
  parent: RunNode | null;
  children: RunNode[];
  terminal: { element: HvacElement; label: string; neckMm: number } | null;
  flexTail: boolean;
  /** Rigid vertices (the path less a runout's terminal end) and the station at each (mm). */
  rigid: DuctPoint3[];
  stations: number[];
  total: number;
  fixed: 'locked' | 'stub' | 'drawn' | null;
  /** The collar's own section up to a first turn (a root that turned at the collar first), kept. */
  head: { end: number; section: DuctLeg } | null;
  airflow: number;
  served: number;
  /** Take-offs off its side, in station order (old geometry). */
  taps: Array<{ child: RunNode; station: number }>;
  segments: Segment[];
  /** Take-off styles changed to fit (child id → style). */
  styles: Map<string, DuctTapStyle>;
}

const STEP_MM = 50;
const ceilStep = (value: number) => Math.ceil(value / STEP_MM - 1e-9) * STEP_MM;

function length3(a: DuctPoint3, b: DuctPoint3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function unit3(a: DuctPoint3, b: DuctPoint3): DuctPoint3 {
  const length = length3(a, b) || 1;
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length };
}

function isLevel(a: DuctPoint3, b: DuctPoint3): boolean {
  return Math.abs(b.z - a.z) <= 0.5;
}

function stationsOf(points: readonly DuctPoint3[]): number[] {
  const out = [0];
  for (let index = 1; index < points.length; index += 1) out.push(out[index - 1]! + length3(points[index - 1]!, points[index]!));
  return out;
}

/** Plan point of a take-off on its parent (centreline), from its leg and station. */
function tapPoint(spec: DuctRunSpec, start: Pick<DuctTapStart, 'legIndex' | 'stationMm'>): Point2D | null {
  const a = spec.path[start.legIndex];
  const b = spec.path[start.legIndex + 1];
  if (!a || !b) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + ((b.x - a.x) / length) * start.stationMm, y: a.y + ((b.y - a.y) / length) * start.stationMm };
}

/** The level leg of a polyline nearest a plan point, and the distance along it. */
function locateOn(points: readonly DuctPoint3[], point: Point2D): { leg: number; along: number; station: number } | null {
  const stations = stationsOf(points);
  let best: { leg: number; along: number; station: number; distance: number } | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    if (!isLevel(a, b)) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    const t = Math.max(0, Math.min(length, (point.x - a.x) * ux + (point.y - a.y) * uy));
    const distance = Math.hypot(a.x + ux * t - point.x, a.y + uy * t - point.y);
    if (!best || distance < best.distance - 1e-6) best = { leg: index - 1, along: t, station: stations[index - 1]! + t, distance };
  }
  return best;
}

function sectionAt(node: RunNode, station: number): DuctLeg {
  let low = 1;
  let high = node.stations.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (station <= node.stations[middle]! + 1e-6) high = middle;
    else low = middle + 1;
  }
  return node.spec.legs[Math.max(0, low - 1)]!;
}

/** Specs equal to within float noise (so an unchanged run is left as it is). */
function specsClose(a: DuctRunSpec, b: DuctRunSpec): boolean {
  if (a.path.length !== b.path.length || a.legs.length !== b.legs.length) return false;
  if (a.path.some((point, index) => length3(point, b.path[index]!) > 0.01)) return false;
  if (a.legs.some((leg, index) => !sameLeg(leg, b.legs[index]!))) return false;
  if (JSON.stringify(a.nodeOverrides) !== JSON.stringify(b.nodeOverrides) || JSON.stringify(a.sizing ?? null) !== JSON.stringify(b.sizing ?? null)) return false;
  if (a.start.kind === 'tap' && b.start.kind === 'tap') {
    return a.start.legIndex === b.start.legIndex && Math.abs(a.start.stationMm - b.start.stationMm) < 0.01 && a.start.style === b.start.style;
  }
  return JSON.stringify(a.start) === JSON.stringify(b.start);
}

function emptyReport(rootRunId: string, basis: DuctSystemSizing, service: DuctService, message: string): DuctSystemSizingResult {
  return {
    runs: [],
    terminals: [],
    report: {
      service, rootRunId, unitId: null, basis, airflowM3h: null, airflowSource: null, terminalsAirflowM3h: 0, sections: [], terminals: [], plans: [],
      pressure: null, maxEspPa: null, issues: [{ code: 'DU_SIZE_SYSTEM', severity: 'error', service, message }], errors: 1, warnings: 0, changedRunIds: [],
    },
  };
}

/**
 * Size the duct system whose run off the unit's collar is `rootRunId` by
 * constant friction at `input.basis`. Pure: returns the runs as sized, the
 * terminals whose airflow changed and the report; the scene is untouched.
 */
export function sizeDuctSystem(
  scene: readonly HvacElement[],
  rootRunId: string,
  input: DuctSystemSizingInput,
  settings: DuctDesignSettings,
): DuctSystemSizingResult {
  const elementsById = new Map(scene.map((element) => [element.id, element]));
  const rootElement = elementsById.get(rootRunId);
  const rootSpec = rootElement ? readDuctRunSpec(rootElement) : null;
  if (!rootElement || !rootSpec || rootSpec.legacy) return emptyReport(rootRunId, input.basis, rootSpec?.service ?? 'supply', 'The duct run is not in the drawing.');
  const service = rootSpec.service;
  const model: SizingModel = geometryModel(settings, service, rootSpec.construction);
  const stubMm = branchStubMm(settings) + 200;
  const issues: AutoDuctIssue[] = [];
  const unitId = rootSpec.start.kind === 'unit-port' ? rootSpec.start.unitId : null;
  const unit = unitId ? elementsById.get(unitId) : undefined;

  // ---- The system: the root and every run hung off it ----
  const nodes: RunNode[] = [];
  const seen = new Set<string>();
  let cyclic = false;
  const collect = (element: HvacElement, spec: DuctRunSpec, parent: RunNode | null): RunNode => {
    seen.add(element.id);
    const flexTail = spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 3;
    const rigid = flexTail ? spec.path.slice(0, -1) : [...spec.path];
    const stations = stationsOf(rigid);
    const total = stations[stations.length - 1]!;
    let terminal: RunNode['terminal'] = null;
    if (spec.end.kind === 'terminal') {
      const terminalId = spec.end.terminalId;
      const terminalElement = elementsById.get(terminalId);
      const terminalSpec = terminalElement ? readDuctTerminalSpec(terminalElement) : null;
      if (terminalElement && terminalSpec) terminal = { element: terminalElement, label: terminalElement.label || terminalSpec.kind, neckMm: terminalSpec.neckDiameterMm };
    }
    const node: RunNode = {
      id: element.id, element, spec, parent, children: [], terminal, flexTail, rigid, stations, total,
      fixed: input.measure ? 'drawn' : spec.locked ? 'locked' : flexTail && rigid.length === 2 && total <= stubMm + 1 ? 'stub' : null,
      head: null, airflow: 0, served: 0, taps: [], segments: [], styles: new Map(),
    };
    nodes.push(node);
    for (const branch of ductBranchesOf(element.id, scene)) {
      if (branch.spec.legacy) continue;
      if (seen.has(branch.element.id)) { cyclic = true; continue; }
      node.children.push(collect(branch.element, branch.spec, node));
    }
    return node;
  };
  const root = collect(rootElement, rootSpec, null);
  if (cyclic) return emptyReport(rootRunId, input.basis, service, 'The duct network contains cyclic run connections. Repair the connections before sizing it.');

  // The collar's own section up to a first turn stays (the run turned at the collar before its transition).
  if (rootSpec.start.kind === 'unit-port' && !root.fixed) {
    const port = findAirPort(scene, rootSpec.start.unitId, rootSpec.start.portId);
    if (port) {
      const collar: DuctLeg = { widthMm: port.widthMm, heightMm: port.heightMm };
      const legs = root.rigid.length - 1;
      let count = 0;
      while (count < legs && sameLeg(rootSpec.legs[count]!, collar)) count += 1;
      const turns = (index: number) => {
        const a = unit3(root.rigid[index - 1]!, root.rigid[index]!);
        const b = unit3(root.rigid[index]!, root.rigid[index + 1]!);
        return a.x * b.x + a.y * b.y + a.z * b.z < 1 - 1e-9;
      };
      let turned = false;
      for (let index = 1; index < count; index += 1) if (turns(index)) turned = true;
      if (count > 0 && count < legs && turned) root.head = { end: root.stations[count]!, section: collar };
    }
  }

  // ---- Airflow: each terminal's design airflow, else an equal share of the system's ----
  const overrides = input.measure ? {} : input.terminalAirflows ?? {};
  const terminalNodes = nodes.filter((node) => node.terminal);
  const changedTerminals: HvacElement[] = [];
  const effective = terminalNodes.map((node) => {
    const element = node.terminal!.element;
    const spec = readDuctTerminalSpec(element)!;
    const own = spec.designAirflowM3h ?? null;
    const value = Object.prototype.hasOwnProperty.call(overrides, element.id) ? overrides[element.id] ?? null : own;
    const next = value !== null && value > 0 ? value : null;
    if ((next ?? 0) !== (own ?? 0)) {
      changedTerminals.push({ ...element, properties: { ...element.properties, terminal: { ...spec, designAirflowM3h: next } } });
    }
    return { id: element.id, spec: { designAirflowM3h: next } };
  });
  const air = basisAirflowM3h(unit, input.basis);
  const fixedTotal = effective.reduce((sum, entry) => sum + (entry.spec.designAirflowM3h ?? 0), 0);
  const systemAirflow = air.airflowM3h ?? (effective.every((entry) => entry.spec.designAirflowM3h) ? fixedTotal : null);
  if (!systemAirflow) issues.push({ code: 'DU_AUTO_NO_DATA', severity: 'error', service, message: 'The unit has no airflow data: enter the system airflow, or each terminal\'s.' });
  const shares = shareAirflow(systemAirflow ?? 0, effective);
  const flowOf = new Map(shares.map((share) => [share.terminalId, share]));
  const terminalsAirflow = shares.reduce((sum, share) => sum + share.airflowM3h, 0);
  if (systemAirflow && Math.abs(terminalsAirflow - systemAirflow) > systemAirflow * 0.1) {
    issues.push({ code: 'DU_AUTO_AIRFLOW', severity: 'warning', service, message: `The ${service} terminals add up to ${Math.round(terminalsAirflow)} m³/h, not the system's ${Math.round(systemAirflow)} m³/h.` });
  }
  const basis = linkSizingBasis(input.basis, systemAirflow);
  const stock = [...settings.autoRoundSizesMm].sort((a, b) => a - b);

  // ---- Sizes, bottom-up: children first (a take-off or a split needs its branches' sections) ----
  const firstSection = (node: RunNode): DuctLeg => (node.fixed ? node.spec.legs[0]! : node.segments[0]?.section ?? node.spec.legs[0]!);
  const voidHeight = (node: RunNode) => Math.max(0, resolveSoffitZ(settings) - (node.rigid[0]?.z ?? 0) - 2 * node.spec.insulationThicknessMm - 50);
  const smallestStock = (minimum: number) => stock.find((size) => size >= minimum - 0.5) ?? ceilStep(minimum);
  const rectAt = (flow: number, height: number, minWidth: number, limits: DuctSizingLimits, maxHeight: number) => sizeRectangular(flow, height, limits, {
    stepMm: STEP_MM, minWidthMm: minWidth, maxAspect: settings.aspectRatioAdvisory, maxHeightMm: Math.max(height, maxHeight),
  });

  const sizeNode = (node: RunNode): void => {
    for (const child of node.children) sizeNode(child);
    const own = node.terminal ? flowOf.get(node.terminal.element.id)?.airflowM3h ?? 0 : 0;
    node.airflow = own + node.children.reduce((sum, child) => sum + child.airflow, 0);
    node.served = (node.terminal ? 1 : 0) + node.children.reduce((sum, child) => sum + child.served, 0);
    node.taps = node.children.flatMap((child) => {
      const start = child.spec.start;
      if (start.kind !== 'tap') return [];
      const before = node.stations[Math.min(start.legIndex, node.stations.length - 1)] ?? 0;
      return [{ child, station: before + start.stationMm }];
    }).sort((a, b) => a.station - b.station);
    const endChildren = node.children.filter((child) => child.spec.start.kind !== 'tap');
    const endFlow = own + endChildren.reduce((sum, child) => sum + child.airflow, 0);
    const endServed = (node.terminal ? 1 : 0) + endChildren.reduce((sum, child) => sum + child.served, 0);
    const bounds = [0, ...node.taps.map((tap) => tap.station), node.total];
    const m = node.taps.length;
    const segments: Segment[] = [];
    // A suffix walk keeps long trunks linear in the number of take-offs.
    let airflow = endFlow;
    let served = endServed;
    for (let k = m; k >= 0; k -= 1) {
      if (k < m) {
        airflow += node.taps[k]!.child.airflow;
        served += node.taps[k]!.child.served;
      }
      segments.push({ from: bounds[k]!, to: bounds[k + 1]!, airflow, terminals: served, part: served >= 2 ? 'trunk' : 'branch', section: node.spec.legs[0]!, setBy: 'locked' });
    }
    segments.reverse();
    node.segments = segments;
    if (node.fixed) {
      for (const segment of segments) {
        segment.section = sectionAt(node, (segment.from + segment.to) / 2);
        segment.setBy = node.fixed === 'stub' ? 'runout' : node.fixed === 'drawn' ? 'drawn' : 'locked';
      }
      return;
    }

    // Where the sizes are free: past a kept collar stretch, before the step down to the neck.
    const neck = node.terminal ? roundLeg(node.terminal.neckMm) : null;
    const rigidLegs = node.rigid.length - 1;
    let tail = rigidLegs;
    if (neck) while (tail > 0 && sameLeg(node.spec.legs[tail - 1]!, neck)) tail -= 1;
    const varStart = node.head?.end ?? 0;
    const varEnd = tail > 0 ? node.stations[tail]! : node.total;
    const maxHeight = voidHeight(node);
    const minDiameter = neck?.diameterMm ?? 0;

    // ---- Each segment at the friction rate, under its velocity limit ----
    segments.forEach((segment) => {
      const mid = (segment.from + segment.to) / 2;
      const sample = sectionAt(node, varEnd - varStart > 2 ? Math.min(varEnd - 1, Math.max(varStart + 1, mid)) : mid);
      if (segment.airflow <= 0) {
        // Past the last take-off: it carries on as the section before it (set once that is final).
        segment.section = sample;
        segment.setBy = 'no-flow';
        return;
      }
      const limits = basisLimits(basis, segment.part);
      if (isRoundLeg(sample)) {
        const d = sizeRound(segment.airflow, limits, stock, { minimumMm: minDiameter });
        segment.section = roundLeg(d);
        if (!withinLimits(segment.section, segment.airflow, limits)) segment.setBy = 'capped';
        else {
          const smaller = stock.filter((size) => size < d - 0.5 && size >= minDiameter - 0.5).at(-1);
          segment.setBy = smaller === undefined ? (minDiameter > 0 && Math.abs(d - minDiameter) < 0.5 ? 'neck' : 'minimum')
            : frictionPaPerM(roundLeg(smaller), segment.airflow) > limits.frictionPaPerM * 1.001 ? 'friction' : 'velocity';
        }
        return;
      }
      const height = sample.heightMm;
      const minWidth = Math.min(height, sample.widthMm);
      const sized = rectAt(segment.airflow, height, minWidth, limits, maxHeight);
      segment.section = { widthMm: sized.widthMm, heightMm: sized.heightMm };
      if (sized.capped) segment.setBy = 'capped';
      else if (sized.heightMm > height + 0.5) segment.setBy = 'aspect';
      else if (sized.widthMm - STEP_MM < Math.max(STEP_MM, minWidth) - 0.5) segment.setBy = 'minimum';
      else segment.setBy = frictionPaPerM({ widthMm: sized.widthMm - STEP_MM, heightMm: sized.heightMm }, segment.airflow) > limits.frictionPaPerM * 1.001 ? 'friction' : 'velocity';
    });

    /** Raise segment k to at least the size a fitting needs (a rectangle's width re-sized at a raised height). */
    const raise = (k: number, need: { height?: number; width?: number; diameter?: number }, setBy: DuctSectionSetBy, note: string) => {
      const segment = segments[k]!;
      const current = segment.section;
      if (isRoundLeg(current)) {
        if (need.diameter !== undefined && current.diameterMm! < need.diameter - 0.5) {
          segment.section = roundLeg(smallestStock(need.diameter));
          segment.setBy = setBy;
          segment.note = note;
        }
        return;
      }
      let height = current.heightMm;
      let width = current.widthMm;
      if (need.height !== undefined && height < need.height - 0.5) {
        height = need.height;
        // Taller, it needs less width at the same friction.
        if (segment.airflow > 0) width = rectAt(segment.airflow, height, Math.min(height, current.widthMm), basisLimits(basis, segment.part), height).widthMm;
      }
      if (need.width !== undefined && width < need.width - 0.5) width = need.width;
      if (Math.abs(height - current.heightMm) > 0.5 || Math.abs(width - current.widthMm) > 0.5) {
        if (height > maxHeight + 0.5) issues.push({ code: 'DU_SIZE_VOID', severity: 'warning', service, runId: node.id, message: `${note}: ${Math.round(height)} mm high, over the ${Math.round(maxHeight)} mm the ceiling void gives.` });
        segment.section = { widthMm: width, heightMm: height };
        segment.setBy = setBy;
        segment.note = note;
      }
    };

    // ---- The end: the step down to the neck, a split's outlets ----
    const last = segments.length - 1;
    if (neck && !isRoundLeg(segments[last]!.section)) {
      // Rectangular to the round neck: the round top may rise at most 50 mm over the flat bottom.
      raise(last, { height: ceilStep(neck.diameterMm! - 50) }, 'neck', `the step down to the Ø${neck.diameterMm} neck`);
    }
    if (node.spec.end.kind === 'split') {
      const style = node.spec.end.style;
      const outlets = endChildren.filter((child) => child.spec.start.kind === 'split-branch').map(firstSection);
      if (outlets.length) {
        if (style === 'wye') raise(last, { diameter: Math.max(...outlets.map((outlet) => outlet.diameterMm ?? outlet.widthMm)) }, 'split', 'the wye\'s outlets');
        else {
          const width = style === 'y' ? outlets.reduce((sum, outlet) => sum + outlet.widthMm, 0) : Math.max(...outlets.map((outlet) => outlet.widthMm));
          raise(last, { height: Math.max(...outlets.map((outlet) => outlet.heightMm)), width }, 'split', style === 'y' ? 'the Y\'s outlets side by side' : 'the bullhead\'s outlets');
        }
      }
    }

    // ---- Take-offs: each fits the section it is cut in (the segment ending at it) ----
    node.taps.forEach((tap, j) => {
      const branch = firstSection(tap.child);
      const start = tap.child.spec.start as DuctTapStart;
      const main = segments[j]!.section;
      const label = tap.child.terminal?.label ?? 'a branch';
      if (isRoundLeg(main)) {
        if (isRoundLeg(branch)) raise(j, { diameter: (branch.diameterMm! * 3) / 2 }, 'take-off', `the take-off to ${label} (at most ⅔ of the main)`);
        return;
      }
      if (!isRoundLeg(branch)) {
        raise(j, { height: branch.heightMm }, 'take-off', `the take-off to ${label}`);
        return;
      }
      const d = branch.diameterMm!;
      if (start.style === 'conical' && d + settings.conicalFlareMm + 20 > main.heightMm + 0.5) {
        // A spin-in needs less height than a conical collar: it replaces it rather than the main rising further.
        node.styles.set(tap.child.id, 'spin-in');
        const fits = d + 50 <= main.heightMm + 0.5;
        issues.push({
          code: 'DU_SIZE_TAKEOFF', severity: 'info', service, runId: tap.child.id,
          message: `The take-off to ${label} becomes a spin-in: a conical one for Ø${d} needs a ${Math.round(d + settings.conicalFlareMm + 20)} mm high main${fits ? '' : `; the main rises to ${ceilStep(d + 50)} mm for the spin-in`}.`,
        });
        if (fits) return;
      }
      if (start.style === 'shoe-45' || start.style === 'straight' || isRoundMainTapStyle(start.style)) node.styles.set(tap.child.id, 'spin-in');
      raise(j, { height: ceilStep(d + 50) }, 'take-off', `the take-off to ${label} (Ø${d} + 50)`);
    });

    // ---- Nothing grows downstream (a flat bottom: the height never rises either) ----
    for (let k = last - 1; k >= 0; k -= 1) {
      const up = segments[k]!.section;
      const down = segments[k + 1]!.section;
      if (isRoundLeg(up) && isRoundLeg(down)) raise(k, { diameter: down.diameterMm! }, 'downstream', 'the section after it');
      else if (!isRoundLeg(up) && !isRoundLeg(down)) raise(k, { height: down.heightMm, width: down.widthMm }, 'downstream', 'the section after it');
      else if (!isRoundLeg(up)) raise(k, { height: ceilStep(down.diameterMm! - 50), width: down.diameterMm! }, 'downstream', 'the round section after it');
      else raise(k, { diameter: Math.max(down.widthMm, down.heightMm) }, 'downstream', 'the section after it');
    }
    for (let k = 1; k < segments.length; k += 1) if (segments[k]!.airflow <= 0) segments[k]!.section = segments[k - 1]!.section;
  };
  sizeNode(root);

  // A fixed run's take-offs must still fit it: said, not changed.
  for (const node of nodes) {
    if (node.fixed !== 'locked') continue;
    node.taps.forEach((tap) => {
      const main = sectionAt(node, tap.station);
      const branch = firstSection(tap.child);
      const fits = isRoundLeg(main)
        ? isRoundLeg(branch) && branch.diameterMm! <= maxRoundBranchMm(main.diameterMm!) + 0.5
        : isRoundLeg(branch) ? branch.diameterMm! + 50 <= main.heightMm + 0.5 : branch.heightMm <= main.heightMm + 0.5;
      if (!fits) {
        issues.push({ code: 'DU_SIZE_LOCKED', severity: 'warning', service, runId: node.id,
          message: `The take-off to ${tap.child.terminal?.label ?? 'a branch'} (${legLabel(branch)}) does not fit its locked main (${legLabel(main)}): unlock the main to resize it.` });
      }
    });
  }

  // ---- Geometry, top-down: re-anchor on the parent as rebuilt, then the reducers ----
  const newSpecs = new Map<string, DuctRunSpec>();
  const newStarts = new Map<string, DuctTapStart>();

  const rebuild = (node: RunNode, parentSpec: DuctRunSpec | null): void => {
    let spec = node.spec;
    let mapPoint: (point: Point2D, legIndex: number) => Point2D = (point) => point;
    if (node.parent && parentSpec) {
      const start = newStarts.get(node.id) ?? spec.start;
      const first = firstSection(node);
      const probe: DuctRunSpec = { ...spec, start, legs: [first, ...spec.legs.slice(1)] };
      const from = startAnchor(spec);
      const to = branchAnchor(parentSpec, probe, settings);
      if (from && to) {
        const moved = reanchorKeepingEnd({ ...spec, start }, from, to, branchStubMm(settings));
        spec = moved.spec;
        mapPoint = moved.mapPoint;
      } else {
        spec = { ...spec, start };
        issues.push({ code: 'DU_SIZE_ANCHOR', severity: 'warning', service, runId: node.id, message: `${node.terminal?.label ?? 'A branch'}: its take-off no longer fits on the main as resized.` });
      }
    }
    // Where each take-off's centre is now, on this run as re-anchored.
    const tapPoints = node.taps.map((tap) => {
      const start = tap.child.spec.start as DuctTapStart;
      const point = tapPoint(node.spec, start);
      return point ? mapPoint(point, start.legIndex) : null;
    });
    const rigidCount = spec.path.length - (node.flexTail ? 1 : 0);
    let rigid = spec.path.slice(0, rigidCount);
    let legs = spec.legs.slice(0, rigidCount - 1);
    let overrides = spec.nodeOverrides;

    if (!node.fixed) {
      const stations = stationsOf(rigid);
      const total = stations[stations.length - 1]!;
      const tapStations = tapPoints.map((point, j) => (point ? locateOn(rigid, point)?.station : undefined) ?? node.taps[j]!.station);
      const segments = node.segments;
      const sections = segments.map((segment) => segment.section);
      const biggest = [node.head?.section, ...sections].filter((leg): leg is DuctLeg => Boolean(leg))
        .reduce((best, leg) => (areaOf(leg) > areaOf(best) ? leg : best));
      // Elbows (their setback, neck and a margin either side) and risers take no reducer.
      const directions = rigid.slice(1).map((point, index) => unit3(rigid[index]!, point));
      const kept: number[] = [0];
      const forbidden: Array<[number, number]> = [];
      for (let index = 1; index < rigid.length - 1; index += 1) {
        const a = directions[index - 1]!;
        const b = directions[index]!;
        const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
        if (cos > 1 - 1e-9) continue;
        kept.push(index);
        const angle = Math.acos(cos);
        const plan = Math.abs(a.z) < 1e-6 && Math.abs(b.z) < 1e-6;
        const square = spec.nodeOverrides[String(index)]?.elbowStyle === 'square-vaned' && plan && !isRoundLeg(biggest);
        const radius = plan || isRoundLeg(biggest) ? model.elbowRadiusMm(biggest) : settings.elbowCentrelineRatio * biggest.heightMm;
        const reach = (square ? biggest.widthMm / 2 : radius * Math.tan(angle / 2)) + settings.elbowNeckMm + 25;
        forbidden.push([stations[index]! - reach, stations[index]! + reach]);
      }
      kept.push(rigid.length - 1);
      for (let index = 1; index < rigid.length; index += 1) {
        if (!isLevel(rigid[index - 1]!, rigid[index]!)) forbidden.push([stations[index - 1]!, stations[index]!]);
      }
      const free = (low: number, high: number): Array<[number, number]> => {
        let parts: Array<[number, number]> = high > low ? [[low, high]] : [];
        for (const [a, b] of forbidden) {
          parts = parts.flatMap(([x, y]): Array<[number, number]> => (b <= x || a >= y ? [[x, y]] : [
            ...(a > x ? [[x, a] as [number, number]] : []),
            ...(b < y ? [[b, y] as [number, number]] : []),
          ]));
        }
        return parts;
      };
      const styleOf = (j: number): DuctTapStyle => node.styles.get(node.taps[j]!.child.id) ?? (node.taps[j]!.child.spec.start as DuctTapStart).style;
      const halves = node.taps.map((tap, j) => model.tapWindowHalfMm(styleOf(j), firstSection(tap.child), sections[j]!));
      const start = spec.start;
      let startClear: number;
      if (!node.parent) {
        const port = start.kind === 'unit-port' ? findAirPort(scene, start.unitId, start.portId) : null;
        const collar: DuctLeg = port ? { widthMm: port.widthMm, heightMm: port.heightMm } : sections[0]!;
        const connector = settings.flexibleConnectorAtUnit ? settings.connectorFabricMm + 2 * settings.connectorMetalMm : 0;
        const transition = sameLeg(collar, sections[0]!) ? 0 : model.transitionLengthMm(collar, sections[0]!).lengthMm;
        startClear = (node.head ? node.head.end : connector) + transition + 50;
      } else {
        const style: DuctTapStyle = start.kind === 'tap' || start.kind === 'spigot' ? (newStarts.get(node.id)?.style ?? start.style) : 'spin-in';
        startClear = model.collarLengthMm(style, sections[0]!) + (start.kind === 'split-branch' ? 0 : settings.vcdLengthMm) + 100;
      }
      const end = spec.end;
      const endClear = end.kind === 'terminal' ? 450
        : end.kind === 'split' ? settings.elbowNeckMm + Math.max(biggest.widthMm, 250) + 50
          : end.kind === 'plenum' ? end.lengthMm + 100 : 100;

      // ---- Reducers: after a take-off where the flow drops, in a straight gap before the next ----
      const changes: Array<{ at: number; section: DuctLeg; length: number }> = [];
      let current = sections[0]!;
      if (node.head && !sameLeg(node.head.section, current)) changes.push({ at: node.head.end, section: current, length: 0 });
      for (let k = 0; k + 1 < segments.length; k += 1) {
        const target = sections[k + 1]!;
        const carry = (note: string) => {
          sections[k + 1] = current;
          segments[k + 1]!.section = current;
          if (segments[k + 1]!.airflow <= 0) return;
          segments[k + 1]!.setBy = 'carried';
          segments[k + 1]!.note = note;
        };
        if (sameLeg(current, target)) continue;
        if (!isRoundLeg(current) && !isRoundLeg(target) && Math.abs(current.heightMm - target.heightMm) < 0.5
          && current.widthMm - target.widthMm < settings.autoReducerStepMm - 0.5) {
          carry(`a ${Math.round(current.widthMm - target.widthMm)} mm step is under the reducer step (${settings.autoReducerStepMm} mm)`);
          continue;
        }
        const length = model.transitionLengthMm(current, target).lengthMm;
        const low = Math.max(startClear, tapStations[k]! + halves[k]!);
        const high = k + 1 < node.taps.length ? tapStations[k + 1]! - halves[k + 1]! : total - endClear;
        const gaps = free(low, high).filter(([a, b]) => b - a >= length + 20);
        if (!gaps.length) {
          carry('no straight between the take-offs for a reducer');
          continue;
        }
        const best = gaps.reduce((widest, gap) => (gap[1] - gap[0] > widest[1] - widest[0] ? gap : widest));
        changes.push({ at: (best[0] + best[1]) / 2 - length / 2, section: target, length });
        current = target;
      }
      // ---- The step down to the terminal's neck before its runout ----
      const neck = node.terminal ? roundLeg(node.terminal.neckMm) : null;
      if (neck && !sameLeg(current, neck)) {
        const length = model.transitionLengthMm(current, neck).lengthMm;
        const lastTap = node.taps.length ? tapStations[node.taps.length - 1]! + halves[node.taps.length - 1]! : startClear;
        const lastChange = changes.length ? changes[changes.length - 1]!.at + changes[changes.length - 1]!.length + 20 : 0;
        const preferred = total - Math.max(400, length + 100);
        const gaps = free(Math.max(lastTap, lastChange, startClear), total - 100).filter(([a, b]) => b - a >= length + 20);
        let at: number | null = null;
        if (gaps.some(([a, b]) => preferred >= a - 1e-6 && preferred + length + 20 <= b + 1e-6)) at = preferred;
        else {
          for (const [a, b] of [...gaps].reverse()) {
            const candidate = Math.min(preferred, b - length - 20);
            if (candidate >= a - 1e-6) { at = candidate; break; }
          }
        }
        if (at === null) {
          issues.push({ code: 'DU_SIZE_NECK', severity: 'warning', service, runId: node.id,
            message: `${node.terminal!.label}: no straight before the runout for the step from ${legLabel(current)} down to the Ø${neck.diameterMm} neck (${Math.round(length)} mm).` });
        } else changes.push({ at, section: neck, length });
      }
      changes.sort((a, b) => a.at - b.at);

      // ---- The new vertices: the ends, the bends, and one per change of section ----
      const vertices: Array<{ point: DuctPoint3; station: number; old: number | null }> = kept.map((index) => ({ point: rigid[index]!, station: stations[index]!, old: index }));
      for (const change of changes) {
        if (vertices.some((vertex) => Math.abs(vertex.station - change.at) < 1)) continue;
        const leg = vertices.findIndex((vertex, index) => index + 1 < vertices.length && change.at > vertex.station && change.at < vertices[index + 1]!.station);
        if (leg < 0) continue;
        const a = vertices[leg]!;
        const b = vertices[leg + 1]!;
        const t = (change.at - a.station) / (b.station - a.station);
        vertices.splice(leg + 1, 0, {
          point: { x: a.point.x + (b.point.x - a.point.x) * t, y: a.point.y + (b.point.y - a.point.y) * t, z: a.point.z + (b.point.z - a.point.z) * t },
          station: change.at, old: null,
        });
      }
      const initial = node.head ? node.head.section : sections[0]!;
      const sectionFrom = (station: number) => {
        let section = initial;
        for (const change of changes) if (change.at <= station + 1) section = change.section;
        return section;
      };
      rigid = vertices.map((vertex) => vertex.point);
      legs = vertices.slice(0, -1).map((vertex) => sectionFrom(vertex.station));
      const renumbered: Record<string, (typeof overrides)[string]> = {};
      vertices.forEach((vertex, index) => {
        if (vertex.old !== null && spec.nodeOverrides[String(vertex.old)]) renumbered[String(index)] = spec.nodeOverrides[String(vertex.old)]!;
      });
      if (node.flexTail && spec.nodeOverrides[String(rigidCount)]) renumbered[String(rigid.length)] = spec.nodeOverrides[String(rigidCount)]!;
      overrides = renumbered;
    }

    // Take-offs re-expressed on the new legs (a station from the start of the leg they sit on).
    node.taps.forEach((tap, j) => {
      const start = tap.child.spec.start as DuctTapStart;
      const point = tapPoints[j];
      const at = point ? locateOn(rigid, point) : null;
      newStarts.set(tap.child.id, {
        ...start,
        ...(at ? { legIndex: at.leg, stationMm: at.along } : {}),
        style: node.styles.get(tap.child.id) ?? start.style,
      });
    });
    const path = node.flexTail ? [...rigid, spec.path[spec.path.length - 1]!] : rigid;
    const allLegs = node.flexTail ? [...legs, spec.legs[spec.legs.length - 1]!] : legs;
    const next: DuctRunSpec = { ...spec, path, legs: allLegs, nodeOverrides: overrides };
    if (!node.parent && !input.measure) next.sizing = basis;
    newSpecs.set(node.id, next);
    for (const child of node.children) rebuild(child, next);
  };
  if (input.measure) {
    // Inspection must preserve even an unanchored or invalid drawing, so the
    // planner diagnoses the actual geometry instead of silently repairing it.
    for (const node of nodes) newSpecs.set(node.id, node.spec);
  } else rebuild(root, null);

  // ---- The runs as sized ----
  const changedRunIds: string[] = [];
  const runs = nodes.map((node) => {
    const spec = newSpecs.get(node.id)!;
    if (specsClose(spec, node.spec)) return node.element;
    changedRunIds.push(node.id);
    return ductRunElementWithSpec(node.element, spec);
  });

  // ---- The report ----
  const runLabel = (node: RunNode) => (!node.parent ? 'Main'
    : node.terminal ? `To ${node.terminal.label}`
      : node.spec.start.kind === 'split-branch' ? `Split outlet (${node.served})` : `Branch (${node.served})`);
  const reportSegments = (node: RunNode): Segment[] => {
    if (!node.fixed) return node.segments;
    // A locked or measured run may already have reducers between take-offs.
    // Intersect flow intervals with its drawn legs instead of sampling their
    // midpoint, which can hide an undersized section and its higher velocity.
    const measured: Segment[] = [];
    let legIndex = 0;
    for (const segment of node.segments) {
      while (legIndex + 1 < node.stations.length && node.stations[legIndex + 1]! <= segment.from + 1e-6) legIndex += 1;
      for (let index = legIndex; index < node.rigid.length - 1 && node.stations[index]! < segment.to - 1e-6; index += 1) {
        const from = Math.max(segment.from, node.stations[index]!);
        const to = Math.min(segment.to, node.stations[index + 1]!);
        if (to <= from + 1e-6) continue;
        const section = node.spec.legs[index]!;
        const previous = measured.at(-1);
        if (previous && Math.abs(previous.to - from) < 1e-6 && previous.airflow === segment.airflow
          && previous.part === segment.part && sameLeg(previous.section, section)) previous.to = to;
        else measured.push({ ...segment, from, to, section });
      }
    }
    return measured;
  };
  const sections: DuctSizedSection[] = nodes.flatMap((node) => reportSegments(node).map((segment) => ({
    runId: node.id, runLabel: runLabel(node), fromMm: Math.round(segment.from), toMm: Math.round(segment.to),
    airflowM3h: segment.airflow, part: node.fixed === 'stub' ? 'runout' as const : segment.part, section: segment.section,
    velocityMs: segment.airflow > 0 ? roundTo(velocityMs(segment.section, segment.airflow), 2) : 0,
    frictionPaPerM: segment.airflow > 0 ? roundTo(frictionPaPerM(segment.section, segment.airflow), 3) : 0,
    setBy: segment.setBy, ...(segment.note ? { note: segment.note } : {}),
  })));
  for (const node of nodes) {
    for (const segment of node.segments) {
      if (segment.setBy === 'capped') {
        issues.push({ code: 'DU_SIZE_CAPPED', severity: 'warning', service, runId: node.id,
          message: `${runLabel(node)}: even ${legLabel(segment.section)}, the largest within the aspect limit and the ceiling void, is over ${basis.frictionPaPerM.toFixed(2)} Pa/m or the velocity limit at ${Math.round(segment.airflow)} m³/h.` });
      }
    }
  }
  const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const terminals: DuctSystemTerminalReport[] = terminalNodes.map((node) => {
    const share = flowOf.get(node.terminal!.element.id)!;
    const neckVelocity = neckVelocityMs({ neckDiameterMm: node.terminal!.neckMm }, share.airflowM3h);
    if (neckVelocity > Math.min(neckCap, basis.maxVelocity.runout) + 1e-6) {
      issues.push({ code: 'DU_TERMINAL_VELOCITY', severity: 'warning', service, runId: node.id,
        message: `${node.terminal!.label}: ${neckVelocity.toFixed(1)} m/s in its Ø${node.terminal!.neckMm} neck and runout at ${Math.round(share.airflowM3h)} m³/h (limit ${Math.min(neckCap, basis.maxVelocity.runout)} m/s): a larger neck, or less airflow.` });
    }
    return {
      terminalId: node.terminal!.element.id, label: node.terminal!.label, airflowM3h: share.airflowM3h, fixed: share.fixed,
      neckMm: node.terminal!.neckMm, neckVelocityMs: roundTo(neckVelocity, 2), runId: node.id, throttlePa: null,
    };
  });
  const unitAir = unit ? readUnitAirData(unit) : null;
  const report: DuctSystemSizingReport = {
    service, rootRunId, unitId, basis, airflowM3h: systemAirflow, airflowSource: air.airflowM3h ? air.source : null, terminalsAirflowM3h: terminalsAirflow,
    sections, terminals, plans: [], pressure: null, maxEspPa: unitAir?.maxEspPa ?? null, issues, errors: 0, warnings: 0, changedRunIds,
  };
  if (input.verify !== false) {
    const replaced = new Map<string, HvacElement>([...runs, ...changedTerminals].map((element) => [element.id, element]));
    const nextScene = scene.map((element) => replaced.get(element.id) ?? element);
    const ids = new Set(nodes.map((node) => node.id));
    report.plans = nodes.map((node) => planDuctRunSpec(node.id, newSpecs.get(node.id)!, { settings, scene: nextScene }));
    for (const plan of report.plans) {
      for (const issue of plan.issues) {
        if (issue.severity === 'info') continue;
        issues.push({ code: issue.code, severity: issue.severity, message: issue.message, service, runId: plan.elementId, ...(issue.point ? { point: { x: issue.point.x, y: issue.point.y } } : {}) });
      }
    }
    for (const clash of findDuctClashes(nextScene, settings, listNetworkPipeLanes(nextScene))) {
      if (!ids.has(clash.ductId) && !ids.has(clash.otherId)) continue;
      issues.push({
        code: 'DU_CLASH', severity: 'error', service, point: { x: clash.point.x, y: clash.point.y }, runId: ids.has(clash.ductId) ? clash.ductId : clash.otherId,
        message: `${clash.mark} clashes with ${clash.kind === 'pipe' ? `a ${clash.service ?? 'pipe'}` : clash.kind === 'terminal' ? 'an air terminal' : 'another duct'}.`,
      });
    }
    report.pressure = systemPressure(report.plans, new Map(shares.map((share) => [share.terminalId, share.airflowM3h])), settings, service);
    for (const terminal of terminals) terminal.throttlePa = Math.round(report.pressure.throttlePa[terminal.terminalId] ?? 0);
    if (report.maxEspPa !== null && report.pressure.indexPa > report.maxEspPa) {
      issues.push({ code: 'DU_AUTO_ESP', severity: 'warning', service,
        message: `The ${service} ducts need about ${Math.round(report.pressure.indexPa)} Pa; ${unit?.label || 'the unit'} gives at most ${report.maxEspPa} Pa (supply and return together). Lower the friction rate or shorten the index run.` });
    }
  }
  report.errors = issues.filter((issue) => issue.severity === 'error').length;
  report.warnings = issues.filter((issue) => issue.severity === 'warning').length;
  return { runs, terminals: changedTerminals, report };
}

/** The run off a unit's collar for a service, if any. */
export function ductSystemRootOf(scene: readonly HvacElement[], unitId: string, service: DuctService): HvacElement | null {
  return scene.find((element) => {
    if (element.type !== 'duct') return false;
    const spec = readDuctRunSpec(element);
    return spec?.service === service && spec.start.kind === 'unit-port' && spec.start.unitId === unitId;
  }) ?? null;
}

/** The root run of the system a run belongs to (following parents up). */
export function ductSystemRootOfRun(scene: readonly HvacElement[], runId: string): HvacElement | null {
  let current = scene.find((element) => element.id === runId) ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const spec = readDuctRunSpec(current);
    if (!spec) return null;
    const start = spec.start;
    if (start.kind === 'unit-port') return current;
    if (start.kind !== 'tap' && start.kind !== 'split-branch' && start.kind !== 'spigot') return null;
    current = ductParentOf(spec, scene);
  }
  return null;
}
