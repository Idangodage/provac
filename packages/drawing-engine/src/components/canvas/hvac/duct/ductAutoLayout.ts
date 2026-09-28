/**
 * Duct auto layout: from a ducted unit and the diffusers / grilles it serves,
 * the whole duct system as ordinary runs — routed, sized for the airflow and
 * connected the way it is installed:
 *
 *  - Plenum + runouts: a short duct off the collar into a plenum box, one round
 *    spigot (spin-in + damper) per terminal, then rigid round and a flexible
 *    runout (SMACNA Fig. 2-15). Offered for a compact group.
 *  - Trunk + branches: a rectangular trunk off the collar (straight, turned
 *    once, or split both ways), reduced along its length as take-offs leave
 *    it, a spin-in + damper take-off per terminal, rigid round, then flex.
 *
 * Every candidate is built as real runs, planned by the fabrication planner
 * and clash-checked; the cheapest without errors wins. The layout is worked in
 * the collar's own frame (x along its normal, y across), so the orthogonal
 * router's cardinal directions follow the unit whatever its rotation.
 *
 * Sizing is the equal-friction method with velocity caps (ductSizing.ts);
 * the design values are project settings labelled practice.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { isCondensatePipe } from '../condensate/condensateTypes';
import { listNetworkPipeLanes } from '../networkPipeClearance';
import { findObstacleAwareOrthogonalRoute, type OrthogonalRouteObstacle } from '../obstacleAwareOrthogonalRoute';
import { isRefrigerantPipeElementType } from '../refrigerantPipePairModel';

import { listAirPorts, type DuctAirPort } from './ductAirPorts';
import { spigotOrigin, splitOrigin, tapOrigin } from './ductBranchTargets';
import { legNormal } from './ductBranches';
import { buildDuctRunDraft, buildDuctRunDraftElement, type DuctDraftOrigin, type DuctDraftPoint } from './ductDraft';
import { planDuctRunSpec, type DuctFabricationPlan } from './ductFabricationPlanner';
import { flexCurve } from './ductFlex';
import { ductRunElementWithSpec } from './ductFollow';
import { ductBranchesOf } from './ductNetwork';
import { checkSpigotFit } from './ductPlenum';
import { systemPressure, type ServicePressure } from './ductPressure';
import { SMACNA_TABLE_3_1 } from './ductRoundRules';
import type { DuctDesignSettings } from './ductSettings';
import {
  equivalentDiameterMm,
  neckForAirflow,
  neckVelocityMs,
  readUnitAirData,
  shareAirflow,
  sizeRectangular,
  sizeRound,
  sizingLimits,
  type FanSpeed,
} from './ductSizing';
import { resolveSoffitZ } from './ductSupports';
import { isDuctTerminalElement, listTerminalPorts, readDuctTerminalSpec, type DuctTerminalSpec } from './ductTerminals';
import {
  isDuctElement,
  readDuctRunSpec,
  roundLeg,
  type DuctLeg,
  type DuctService,
  type DuctSide,
  type DuctSpigotFace,
  type DuctSplitStyle,
} from './ductTypes';
import { findDuctClashes, terminalBoxOf } from './ductVolumes';

export type AutoDuctLayoutChoice = 'auto' | 'plenum' | 'trunk';
export type AutoDuctLayoutKind = 'plenum' | 'trunk-straight' | 'trunk-l' | 'trunk-split';

export const AUTO_DUCT_LAYOUT_LABELS: Record<AutoDuctLayoutKind, string> = {
  plenum: 'Plenum + runouts',
  'trunk-straight': 'Straight trunk + branches',
  'trunk-l': 'Trunk with one turn + branches',
  'trunk-split': 'Split trunk + branches',
};

export interface AutoDuctRequest {
  unitId: string;
  /** Diffusers and grilles to serve (either service). */
  terminalIds: readonly string[];
  fanSpeed: FanSpeed;
  /** Airflow for a unit without data (m³/h). */
  airflowM3h?: number | null;
  layout: AutoDuctLayoutChoice;
  services: { supply: boolean; return: boolean };
  /** Replace the duct already on a collar (the run and its branches). */
  rebuildExisting: boolean;
}

export type AutoDuctIssueCode =
  | 'DU_AUTO_NO_DATA'
  | 'DU_AUTO_NO_PORT'
  | 'DU_AUTO_OCCUPIED'
  | 'DU_AUTO_CONNECTED'
  | 'DU_AUTO_AIRFLOW'
  | 'DU_AUTO_VOID'
  | 'DU_AUTO_NO_LAYOUT'
  | 'DU_AUTO_WALL'
  | 'DU_AUTO_ESP'
  | 'DU_TERMINAL_VELOCITY';

export interface AutoDuctIssue {
  code: AutoDuctIssueCode | string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  service?: DuctService;
  point?: Point2D;
}

export interface AutoDuctTerminalReport {
  terminalId: string;
  label: string;
  airflowM3h: number;
  fixed: boolean;
  neckMm: number;
  neckVelocityMs: number;
  branchDiameterMm: number;
  runId: string | null;
}

export interface AutoDuctCandidateReport {
  layout: AutoDuctLayoutKind;
  cost: number;
  errors: number;
  warnings: number;
}

export interface AutoDuctServiceResult {
  service: DuctService;
  layout: AutoDuctLayoutKind | null;
  airflowM3h: number;
  runs: HvacElement[];
  /** Existing runs on the collar this layout replaces. */
  removeIds: string[];
  terminals: AutoDuctTerminalReport[];
  /** Trunk / plenum sections, first to last. */
  trunkSections: Array<{ widthMm: number; heightMm: number; airflowM3h: number }>;
  plans: DuctFabricationPlan[];
  /** Pressure along each terminal's path; the index path is what the fan must deliver. */
  pressure: ServicePressure | null;
  issues: AutoDuctIssue[];
  candidates: AutoDuctCandidateReport[];
}

export interface AutoDuctResult {
  unitId: string;
  unitLabel: string;
  fanSpeed: FanSpeed;
  airflowM3h: number | null;
  /** Where the airflow came from: typed in, the unit's own Airflow field, or its manufacturer data. */
  airflowSource: 'entered' | 'unit' | 'manufacturer' | null;
  maxEspPa: number | null;
  /** Supply + return index paths (Pa). */
  requiredEspPa: number | null;
  services: AutoDuctServiceResult[];
  runs: HvacElement[];
  removeIds: string[];
  issues: AutoDuctIssue[];
}

// ---- Local frame ----

interface Frame { origin: Point2D; n: Point2D; t: Point2D }

const dot = (a: Point2D, b: Point2D) => a.x * b.x + a.y * b.y;
const sub = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
const toLocal = (frame: Frame, point: Point2D): Point2D => {
  const d = sub(point, frame.origin);
  return { x: dot(d, frame.n), y: dot(d, frame.t) };
};
const toWorld = (frame: Frame, point: Point2D): Point2D => ({
  x: frame.origin.x + frame.n.x * point.x + frame.t.x * point.y,
  y: frame.origin.y + frame.n.y * point.x + frame.t.y * point.y,
});
const dirToLocal = (frame: Frame, direction: Point2D): Point2D => ({ x: dot(direction, frame.n), y: dot(direction, frame.t) });
const dirToWorld = (frame: Frame, direction: Point2D): Point2D => ({
  x: frame.n.x * direction.x + frame.t.x * direction.y,
  y: frame.n.y * direction.x + frame.t.y * direction.y,
});
const cardinal = (direction: Point2D): Point2D => (Math.abs(direction.x) >= Math.abs(direction.y)
  ? { x: Math.sign(direction.x) || 1, y: 0 } : { x: 0, y: Math.sign(direction.y) || 1 });
const roundUp = (value: number, step = 50) => Math.ceil(value / step - 1e-9) * step;

function boxToLocal(frame: Frame, corners: readonly Point2D[], padMm: number, id?: string): OrthogonalRouteObstacle {
  const local = corners.map((corner) => toLocal(frame, corner));
  return {
    ...(id ? { id } : {}),
    minX: Math.min(...local.map((p) => p.x)) - padMm, maxX: Math.max(...local.map((p) => p.x)) + padMm,
    minY: Math.min(...local.map((p) => p.y)) - padMm, maxY: Math.max(...local.map((p) => p.y)) + padMm,
  };
}

function footprintCorners(element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'rotation'>): Point2D[] {
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx! * element.width) / 2;
    const y = (sy! * element.depth) / 2;
    return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
  });
}

function segmentHitsBox(a: Point2D, b: Point2D, box: OrthogonalRouteObstacle): boolean {
  // Axis-aligned segments only (the layout is orthogonal in the local frame).
  if (Math.abs(a.y - b.y) < 1e-6) {
    return a.y > box.minY && a.y < box.maxY && Math.max(a.x, b.x) > box.minX && Math.min(a.x, b.x) < box.maxX;
  }
  return a.x > box.minX && a.x < box.maxX && Math.max(a.y, b.y) > box.minY && Math.min(a.y, b.y) < box.maxY;
}

// ---- Context ----

interface TerminalCtx {
  element: HvacElement;
  spec: DuctTerminalSpec;
  port: DuctAirPort;
  /** Lip and outward normal in the local frame. */
  lip: Point2D;
  normal: Point2D;
  airflowM3h: number;
  fixed: boolean;
  neck: number;
  branch: number;
}

interface ServiceCtx {
  service: DuctService;
  unitId: string;
  frame: Frame;
  port: DuctAirPort;
  bottomZ: number;
  terminals: TerminalCtx[];
  airflowM3h: number;
  baseScene: HvacElement[];
  settings: DuctDesignSettings;
  /** Obstacles in the local frame, unpadded; routes pad them by their own half width. */
  obstacles: Array<OrthogonalRouteObstacle & { zMin: number; zMax: number }>;
  maxHeightMm: number;
  construction: DuctDesignSettings['defaultConstruction'];
  ids: () => string;
}

/** The candidate under construction: its own trunk and branches become obstacles for the branches routed after them. */
interface Build {
  extra: Array<OrthogonalRouteObstacle & { zMin: number; zMax: number }>;
  notes: AutoDuctIssue[];
}

function newBuild(): Build {
  return { extra: [], notes: [] };
}

/** A run's legs as boxes in the local frame (half its width either side). */
function addRunObstacles(ctx: ServiceCtx, build: Build, run: HvacElement): void {
  const spec = readDuctRunSpec(run);
  if (!spec) return;
  spec.legs.forEach((leg, index) => {
    const a = spec.path[index]!;
    const b = spec.path[index + 1]!;
    const half = (leg.diameterMm ?? leg.widthMm) / 2 + spec.insulationThicknessMm;
    build.extra.push({
      ...boxToLocal(ctx.frame, [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], half, run.id),
      zMin: Math.min(a.z, b.z), zMax: Math.max(a.z, b.z) + (leg.diameterMm ?? leg.heightMm),
    });
  });
}

interface Candidate {
  layout: AutoDuctLayoutKind;
  runs: HvacElement[];
  notes: AutoDuctIssue[];
  /** Trunk legs crossing equipment (other units, terminal boxes), which the duct clash check does not cover. */
  obstacleHits: number;
  /** Extra cost for a compromise (a shortened fan outlet). */
  penalty?: number;
  terminalRuns: Map<string, string>;
  trunkSections: Array<{ widthMm: number; heightMm: number; airflowM3h: number }>;
}

// ---- Branches (shared by every layout) ----

/** Collar + damper at the start of a round branch (spin-in). */
function branchStubMm(settings: DuctDesignSettings): number {
  return settings.tapCollarMm + settings.vcdLengthMm;
}

/** How far a flexible runout may reach from the collar stub before rigid duct is needed (mm, practice). */
const ALL_FLEX_REACH_MM = 1300;
/** Where the rigid branch stops short of the terminal spigot: the runout's length (mm, practice). */
const RUNOUT_TARGETS_MM = [800, 600, 1000];

/**
 * The flexible runout from a collar stub (leaving along `out`, local) into the
 * terminal's spigot, curved as the planner will draw it: its tightest bend and length.
 */
function flexFit(ctx: ServiceCtx, stubEnd: Point2D, out: Point2D, stubBottomZ: number, terminal: TerminalCtx): { radiusMm: number; lengthMm: number } {
  const start = toWorld(ctx.frame, stubEnd);
  const direction = dirToWorld(ctx.frame, out);
  const curve = flexCurve(
    { ...start, z: stubBottomZ + terminal.neck / 2 }, { ...direction, z: 0 },
    terminal.port.lip, { x: -terminal.port.normal.x, y: -terminal.port.normal.y, z: 0 },
  );
  return { radiusMm: curve.minBendRadiusMm, lengthMm: curve.lengthMm };
}

function flexOk(fit: { radiusMm: number; lengthMm: number }, terminal: TerminalCtx, settings: DuctDesignSettings): boolean {
  return fit.radiusMm >= terminal.neck * 1.05 && fit.lengthMm <= settings.flexMaxLengthMm;
}

function obstaclesFor(ctx: ServiceCtx, padMm: number, zMin: number, zMax: number, exclude: ReadonlySet<string> = new Set(), build?: Build): OrthogonalRouteObstacle[] {
  return [...ctx.obstacles, ...(build?.extra ?? [])]
    .filter((box) => !(box.id && exclude.has(box.id)) && box.zMax > zMin && box.zMin < zMax)
    .map((box) => ({ ...(box.id ? { id: box.id } : {}), minX: box.minX - padMm, minY: box.minY - padMm, maxX: box.maxX + padMm, maxY: box.maxY + padMm }));
}

/**
 * The branch's points after its origin and its leg sections: all flex when the
 * terminal is close, else rigid round routed round the obstacles to a point a
 * runout's length in front of the spigot, then the flexible runout.
 */
/** Whether a straight stretch of round duct (local frame, at `bottomZ`) runs into an obstacle. */
function stretchBlocked(ctx: ServiceCtx, a: Point2D, b: Point2D, diameterMm: number, bottomZ: number, exclude: ReadonlySet<string>): boolean {
  const boxes = obstaclesFor(ctx, diameterMm / 2 + 50, bottomZ, bottomZ + diameterMm, exclude);
  return boxes.some((box) => segmentHitsBox(a, b, box));
}

/** Drops vertices where the path goes straight on. */
function simplifyCollinear(points: Point2D[]): Point2D[] {
  const out: Point2D[] = [];
  for (const point of points) {
    if (out.length && Math.hypot(point.x - out[out.length - 1]!.x, point.y - out[out.length - 1]!.y) < 1) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      if (Math.abs(cross) < 1e-3 && (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) > 0) out.pop();
    }
    out.push(point);
  }
  return out;
}

function branchPath(
  ctx: ServiceCtx,
  origin: Extract<DuctDraftOrigin, { point: Point2D; direction: Point2D; bottomZ: number }>,
  terminal: TerminalCtx,
  build: Build,
): { points: DuctDraftPoint[]; legSizes: DuctLeg[] } {
  const { frame, settings } = ctx;
  const stub = branchStubMm(settings);
  const start = toLocal(frame, origin.point);
  const out = cardinal(dirToLocal(frame, origin.direction));
  const z = origin.bottomZ;
  const lipWorld = { x: terminal.port.lip.x, y: terminal.port.lip.y, z: terminal.port.lip.z - terminal.neck / 2 };
  const neckLeg = roundLeg(terminal.neck);
  const branchLeg = roundLeg(terminal.branch);
  const stubEnd = { x: start.x + out.x * stub, y: start.y + out.y * stub };
  const reachToLip = Math.hypot(terminal.lip.x - stubEnd.x, terminal.lip.y - stubEnd.y);
  const inFront = dot(sub(stubEnd, terminal.lip), terminal.normal) > terminal.neck;
  const allFlex = (): { points: DuctDraftPoint[]; legSizes: DuctLeg[] } => {
    if (terminal.branch !== terminal.neck) {
      build.notes.push({
        code: 'DU_AUTO_RUNOUT', severity: 'info', service: ctx.service, point: { x: terminal.port.lip.x, y: terminal.port.lip.y },
        message: `${terminal.element.label || 'Terminal'}: the runout stays at the Ø${terminal.neck} neck (Ø${terminal.branch} would suit ${Math.round(terminal.airflowM3h)} m³/h); a larger neck would be quieter.`,
      });
    }
    const stubWorld = toWorld(frame, stubEnd);
    return { points: [{ ...stubWorld, z }, lipWorld], legSizes: [neckLeg, neckLeg] };
  };
  const fit = flexFit(ctx, stubEnd, out, z, terminal);
  if (inFront && reachToLip <= ALL_FLEX_REACH_MM && flexOk(fit, terminal, settings)) return allFlex();
  const ratio = SMACNA_TABLE_3_1[settings.roundVelocityBand]?.ratio ?? 1.5;
  // Elbow setback: its centreline radius plus the flange neck.
  const radius = ratio * terminal.branch + settings.elbowNeckMm;
  const zTop = z + terminal.branch;
  const obstacles = obstaclesFor(ctx, terminal.branch / 2 + 50, z, zTop, new Set([terminal.element.id]), build);
  let route: Point2D[] | null = null;
  let reduce = terminal.branch !== terminal.neck;
  for (const withReducer of reduce ? [true, false] : [false]) {
    // A larger branch needs a straight before the flex for its reducer.
    const endStraight = withReducer ? 700 : 150;
    for (const reach of RUNOUT_TARGETS_MM) {
      const end = { x: terminal.lip.x + terminal.normal.x * reach, y: terminal.lip.y + terminal.normal.y * reach };
      // From the end of the collar + damper, clear of the parent's wall.
      const found = findObstacleAwareOrthogonalRoute({
        start: stubEnd, startDirection: out, end, endDirection: terminal.normal,
        startStraightMm: settings.elbowNeckMm, endStraightMm: endStraight, bendRadiusMm: radius,
        obstacles, clearanceMm: 0, bendPenaltyMm: 1500,
      });
      if (found) { route = simplifyCollinear([start, ...found.points]); break; }
    }
    if (route) { reduce = withReducer; break; }
  }
  if (!route && fit.lengthMm <= settings.flexMaxLengthMm) return allFlex();
  if (!route) {
    // No clear route: square off the stub, then straight along the spigot's axis (the checks will report it).
    const end = { x: terminal.lip.x + terminal.normal.x * RUNOUT_TARGETS_MM[0]!, y: terminal.lip.y + terminal.normal.y * RUNOUT_TARGETS_MM[0]! };
    const corner = terminal.normal.x !== 0 ? { x: stubEnd.x, y: end.y } : { x: end.x, y: stubEnd.y };
    route = simplifyCollinear([start, stubEnd, corner, end]);
    reduce = false;
  }
  const rigid = route.slice(1);
  const legSizes: DuctLeg[] = rigid.map(() => branchLeg);
  // A larger rigid branch reduces to the spigot size before the flex (a round reducer).
  if (!reduce) legSizes.fill(neckLeg);
  if (reduce && rigid.length >= 1) {
    const last = rigid[rigid.length - 1]!;
    const before = route[route.length - 2]!;
    const length = Math.hypot(last.x - before.x, last.y - before.y);
    if (length >= 700) {
      const k = (length - 400) / length;
      rigid.splice(rigid.length - 1, 0, { x: before.x + (last.x - before.x) * k, y: before.y + (last.y - before.y) * k });
      legSizes.splice(legSizes.length - 1, 1, branchLeg, neckLeg);
    } else {
      legSizes[legSizes.length - 1] = neckLeg;
    }
  }
  return {
    points: [...rigid.map((point) => ({ ...toWorld(frame, point), z })), lipWorld],
    legSizes: [...legSizes, neckLeg],
  };
}

type PlacedOrigin = Extract<DuctDraftOrigin, { point: Point2D; direction: Point2D; bottomZ: number }>;

function placed(origin: DuctDraftOrigin | null): PlacedOrigin | null {
  return origin && origin.kind !== 'port' && origin.kind !== 'free' ? origin : null;
}

/** A branch from the origin `makeOrigin` gives for its first section (a spigot's height depends on it). */
function buildBranch(ctx: ServiceCtx, makeOrigin: (first: DuctLeg) => DuctDraftOrigin | null, terminal: TerminalCtx, scene: HvacElement[], build: Build): HvacElement | null {
  let origin = placed(makeOrigin(roundLeg(terminal.branch)));
  if (!origin) return null;
  const notes = build.notes.length;
  let path = branchPath(ctx, origin, terminal, build);
  const first = path.legSizes[0]!;
  if ((first.diameterMm ?? first.widthMm) !== terminal.branch) {
    const again = placed(makeOrigin(first));
    if (again) {
      build.notes.length = notes;
      origin = again;
      path = branchPath(ctx, origin, terminal, build);
    }
  }
  const branch = buildDuctRunDraft({
    origin, points: path.points, legSizes: path.legSizes,
    construction: ctx.construction,
    end: { kind: 'terminal', terminalId: terminal.element.id, portId: terminal.port.portId, flex: true },
  }, ctx.ids(), scene).element;
  addRunObstacles(ctx, build, branch);
  return branch;
}

// ---- Plenum + runouts ----

const PLENUM_NECK_MM = 400;
const PLENUM_MAX_TERMINALS = 4;
const PLENUM_MAX_REACH_MM = 4000;

function plenumCandidate(ctx: ServiceCtx): Candidate | null {
  const { terminals, port, settings, frame } = ctx;
  if (terminals.length > PLENUM_MAX_TERMINALS) return null;
  const biggest = Math.max(...terminals.map((terminal) => terminal.branch));
  const collar: DuctLeg = { widthMm: port.widthMm, heightMm: port.heightMm };
  // A box with room for the spigots (practice sizes, see defaultPlenumSize): two a face once there are three or more.
  const pitch = biggest + 100;
  const perFace = terminals.length >= 3 ? 2 : 1;
  const width = roundUp(Math.max(port.widthMm + 200, perFace * pitch + 100));
  const height = roundUp(Math.max(port.heightMm, biggest + 100));
  const length = roundUp(Math.max(500, perFace * pitch + 100));
  if (height > ctx.maxHeightMm) return null;
  const back = PLENUM_NECK_MM;
  const endX = back + length;
  if (terminals.some((terminal) => Math.hypot(terminal.lip.x - endX, terminal.lip.y) > PLENUM_MAX_REACH_MM)) return null;
  const stub = branchStubMm(settings);
  const margin = 50;
  type Spigot = { terminal: TerminalCtx; face: DuctSpigotFace; alongMm: number; acrossMm: number };
  const spigots: Spigot[] = [];
  // Where on a face a spigot for this terminal would go, and how well its runout would sit.
  const option = (terminal: TerminalCtx, face: DuctSpigotFace) => {
    const r = terminal.branch / 2;
    const taken = spigots.filter((spigot) => spigot.face === face);
    if (taken.length >= 2) return null;
    const spanFrom = margin + r;
    const spanTo = (face === 'end' ? width : length) - margin - r;
    let at = face === 'end'
      ? Math.min(Math.max(terminal.lip.y + width / 2, spanFrom), spanTo)
      : Math.min(Math.max(terminal.lip.x - back, spanFrom), spanTo);
    for (const other of taken) {
      const otherAt = face === 'end' ? other.acrossMm + width / 2 : other.alongMm;
      const gap = (other.terminal.branch + terminal.branch) / 2 + margin;
      if (Math.abs(at - otherAt) < gap) at = at >= otherAt ? otherAt + gap : otherAt - gap;
    }
    if (at < spanFrom - 1e-6 || at > spanTo + 1e-6) return null;
    const stubEnd = face === 'end' ? { x: endX + stub, y: at - width / 2 }
      : { x: back + at, y: (face === 'left' ? 1 : -1) * (width / 2 + stub) };
    const out = face === 'end' ? { x: 1, y: 0 } : { x: 0, y: face === 'left' ? 1 : -1 };
    const fit = flexFit(ctx, stubEnd, out, ctx.bottomZ + height / 2 - terminal.neck / 2, terminal);
    const front = { x: terminal.lip.x + terminal.normal.x * RUNOUT_TARGETS_MM[0]!, y: terminal.lip.y + terminal.normal.y * RUNOUT_TARGETS_MM[0]! };
    const wall = { x: stubEnd.x - out.x * stub, y: stubEnd.y - out.y * stub };
    // The collar + damper are not routed: a stub into a pipe or a unit rules the face out.
    const blocked = stretchBlocked(ctx, wall, stubEnd, terminal.branch, ctx.bottomZ + height / 2 - terminal.branch / 2, new Set([terminal.element.id, ctx.unitId]));
    const score = (blocked ? 20000 : 0) + (flexOk(fit, terminal, settings) ? fit.lengthMm : 3000 + Math.abs(front.x - stubEnd.x) + Math.abs(front.y - stubEnd.y));
    return { spigot: { terminal, face, alongMm: face === 'end' ? 0 : at, acrossMm: face === 'end' ? at - width / 2 : 0 }, score };
  };
  for (const terminal of [...terminals].sort((a, b) => Math.hypot(b.lip.x - endX, b.lip.y) - Math.hypot(a.lip.x - endX, a.lip.y))) {
    const options = (['end', 'left', 'right'] as const).map((face) => option(terminal, face)).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (!options.length) return null;
    spigots.push(options.sort((a, b) => a.score - b.score)[0]!.spigot);
  }
  const endPoint = toWorld(frame, { x: PLENUM_NECK_MM + length, y: 0 });
  const plenum = buildDuctRunDraftElement({
    port, points: [{ ...endPoint, z: ctx.bottomZ }], legSizes: [collar], construction: ctx.construction,
    end: { kind: 'plenum', widthMm: width, heightMm: height, lengthMm: length },
  }, ctx.ids());
  const fit = checkSpigotFit({ widthMm: width, heightMm: height, lengthMm: length },
    spigots.map((spigot) => ({ branchId: spigot.terminal.element.id, face: spigot.face, alongMm: spigot.alongMm, acrossMm: spigot.acrossMm, openingMm: spigot.terminal.branch })));
  if (fit.some((issue) => issue.code === 'DU_SPIGOT_CLASH')) return null;
  const scene = [...ctx.baseScene, plenum];
  const runs: HvacElement[] = [plenum];
  const terminalRuns = new Map<string, string>();
  const build = newBuild();
  addRunObstacles(ctx, build, plenum);
  // The plenum box itself.
  build.extra.push({ ...boxToLocal(frame, [toWorld(frame, { x: PLENUM_NECK_MM, y: -width / 2 }), toWorld(frame, { x: PLENUM_NECK_MM + length, y: width / 2 })], 0, plenum.id), zMin: ctx.bottomZ, zMax: ctx.bottomZ + height });
  for (const spigot of spigots) {
    const branch = buildBranch(ctx, (first) => spigotOrigin(plenum, settings, { face: spigot.face, alongMm: spigot.alongMm, acrossMm: spigot.acrossMm, style: 'spin-in', vcd: true }, first), spigot.terminal, scene, build);
    if (!branch) return null;
    runs.push(branch);
    terminalRuns.set(spigot.terminal.element.id, branch.id);
  }
  return { layout: 'plenum', runs, terminalRuns, notes: build.notes, obstacleHits: 0, trunkSections: [{ widthMm: width, heightMm: height, airflowM3h: ctx.airflowM3h }] };
}

// ---- Trunks ----

interface TapPlan { terminal: TerminalCtx; legIndex: number; station: number; side: DuctSide }

interface TrunkRunPlan {
  /** Vertices in the local frame; the first is the run's start. */
  vertices: Point2D[];
  /** Length at the start of leg 0 where no take-off may go (exit straight, split outlet). */
  startClearMm: number;
  terminals: TerminalCtx[];
}

function tapWindowMm(terminal: TerminalCtx, settings: DuctDesignSettings): number {
  return terminal.branch + 2 * settings.tapWindowMarginMm;
}

/**
 * Take-off stations on a trunk polyline: each terminal's projection on the
 * leg nearest to it, kept clear of the start, the elbows and the end, and
 * spaced by their windows. The last leg is trimmed to just past its last tap.
 */
function placeTaps(
  plan: TrunkRunPlan,
  widthMm: number,
  settings: DuctDesignSettings,
  stubBlocked: (wall: Point2D, end: Point2D, terminal: TerminalCtx) => boolean = () => false,
): { taps: TapPlan[]; vertices: Point2D[] } | null {
  const { vertices } = plan;
  const legs = vertices.slice(1).map((end, index) => {
    const start = vertices[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    return { start, direction: { x: (end.x - start.x) / length, y: (end.y - start.y) / length }, length };
  });
  const setback = settings.elbowCentrelineRatio * widthMm + settings.elbowNeckMm + 50;
  const lastIndex = legs.length - 1;
  const intervals = legs.map((leg, index) => ({
    from: index === 0 ? plan.startClearMm : setback,
    to: index === lastIndex ? Number.POSITIVE_INFINITY : leg.length - setback,
  }));
  const taps: TapPlan[] = [];
  for (const terminal of plan.terminals) {
    // Aim at a point a runout's length in front of the spigot, so the branch meets it square.
    const front = { x: terminal.lip.x + terminal.normal.x * RUNOUT_TARGETS_MM[0]!, y: terminal.lip.y + terminal.normal.y * RUNOUT_TARGETS_MM[0]! };
    let best: { tap: TapPlan; cost: number } | null = null;
    legs.forEach((leg, legIndex) => {
      const { from, to } = intervals[legIndex]!;
      if (to - from < tapWindowMm(terminal, settings)) return;
      const along = dot(sub(front, leg.start), leg.direction);
      const station = Math.min(Math.max(along, from + tapWindowMm(terminal, settings) / 2), to - tapWindowMm(terminal, settings) / 2);
      const point = { x: leg.start.x + leg.direction.x * station, y: leg.start.y + leg.direction.y * station };
      const across = dot(sub(terminal.lip, point), legNormal(leg.direction));
      // A spigot facing away from the trunk needs the branch to go round it.
      const facing = dot(terminal.normal, legNormal(leg.direction)) * Math.sign(across || 1) < 0 ? 0 : 1500;
      const side = across >= 0 ? 1 : -1;
      const normal = legNormal(leg.direction);
      const wall = { x: point.x + normal.x * side * (widthMm / 2), y: point.y + normal.y * side * (widthMm / 2) };
      const stubEnd = { x: wall.x + normal.x * side * branchStubMm(settings), y: wall.y + normal.y * side * branchStubMm(settings) };
      const blocked = stubBlocked(wall, stubEnd, terminal) ? 20000 : 0;
      const cost = Math.abs(along - station) + Math.abs(across) + facing + blocked;
      if (!best || cost < best.cost) best = { tap: { terminal, legIndex, station, side: across >= 0 ? 1 : -1 }, cost };
    });
    if (!best) return null;
    taps.push((best as { tap: TapPlan }).tap);
  }
  // Space the windows along each leg (either wall counts: the joints between them do).
  // Take-offs that would overlap are spread evenly about where they want to be,
  // so opposite take-offs each move a little rather than one moving a lot.
  const gapOf = (first: TapPlan, second: TapPlan) => (tapWindowMm(first.terminal, settings) + tapWindowMm(second.terminal, settings)) / 2 + 100;
  const layout = (group: TapPlan[], desired: number[]) => {
    const offsets = [0];
    for (let index = 1; index < group.length; index += 1) offsets.push(offsets[index - 1]! + gapOf(group[index - 1]!, group[index]!));
    const shift = desired.reduce((total, value) => total + value, 0) / desired.length - offsets.reduce((total, value) => total + value, 0) / offsets.length;
    return offsets.map((offset) => offset + shift);
  };
  for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
    const onLeg = taps.filter((tap) => tap.legIndex === legIndex).sort((a, b) => a.station - b.station);
    const clusters: Array<{ taps: TapPlan[]; desired: number[] }> = [];
    for (const tap of onLeg) {
      clusters.push({ taps: [tap], desired: [tap.station] });
      while (clusters.length >= 2) {
        const last = clusters[clusters.length - 1]!;
        const previous = clusters[clusters.length - 2]!;
        const previousAt = layout(previous.taps, previous.desired);
        const lastAt = layout(last.taps, last.desired);
        if (lastAt[0]! - previousAt[previousAt.length - 1]! >= gapOf(previous.taps[previous.taps.length - 1]!, last.taps[0]!) - 1e-6) break;
        clusters.splice(clusters.length - 2, 2, { taps: [...previous.taps, ...last.taps], desired: [...previous.desired, ...last.desired] });
      }
    }
    const { from, to } = intervals[legIndex]!;
    for (const cluster of clusters) {
      let positions = layout(cluster.taps, cluster.desired);
      const low = from + tapWindowMm(cluster.taps[0]!.terminal, settings) / 2 - positions[0]!;
      if (low > 0) positions = positions.map((position) => position + low);
      if (Number.isFinite(to)) {
        const high = positions[positions.length - 1]! + tapWindowMm(cluster.taps[cluster.taps.length - 1]!.terminal, settings) / 2 - to;
        if (high > 0) positions = positions.map((position) => position - high);
      }
      cluster.taps.forEach((tap, index) => { tap.station = positions[index]!; });
    }
    if (onLeg.some((tap) => tap.station - tapWindowMm(tap.terminal, settings) / 2 < from - 1
      || (Number.isFinite(to) && tap.station + tapWindowMm(tap.terminal, settings) / 2 > to + 1))) return null;
  }
  // Trim the open last leg to just past its last take-off (end cap clearance).
  const lastTaps = taps.filter((tap) => tap.legIndex === lastIndex);
  const lastLeg = legs[lastIndex]!;
  const reach = lastTaps.length
    ? Math.max(...lastTaps.map((tap) => tap.station + tapWindowMm(tap.terminal, settings) / 2)) + 250
    : intervals[lastIndex]!.from + 300;
  const trimmed = [...vertices];
  trimmed[trimmed.length - 1] = { x: lastLeg.start.x + lastLeg.direction.x * reach, y: lastLeg.start.y + lastLeg.direction.y * reach };
  return { taps, vertices: trimmed };
}

/**
 * Sections along a trunk: each stretch carries the airflow of the take-offs
 * downstream of it. The width steps down (a reducer half way between two
 * take-offs) only when it falls by the reducer step.
 */
function sizeTrunk(
  ctx: ServiceCtx,
  vertices: Point2D[],
  taps: TapPlan[],
  heightMm: number,
  totalAirflow: number,
  minFirstWidthMm = 0,
): { vertices: Point2D[]; legSizes: DuctLeg[]; taps: TapPlan[]; sections: Array<{ widthMm: number; heightMm: number; airflowM3h: number }> } {
  const { settings } = ctx;
  const limits = sizingLimits(settings, ctx.service, 'trunk');
  const widthFor = (airflow: number) => sizeRectangular(Math.max(airflow, 1), heightMm, limits, { minWidthMm: heightMm, maxAspect: 4, maxHeightMm: heightMm }).widthMm;
  const legs = vertices.slice(1).map((end, index) => {
    const start = vertices[index]!;
    return { start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
  });
  const offsets = legs.reduce<number[]>((acc, leg, index) => [...acc, acc[index]! + leg.length], [0]);
  const at = (tap: TapPlan) => offsets[tap.legIndex]! + tap.station;
  const ordered = [...taps].sort((a, b) => at(a) - at(b));
  const taper = Math.tan((settings.transitionTaperDeg * Math.PI) / 180);
  let width = Math.max(widthFor(totalAirflow), minFirstWidthMm);
  let remaining = totalAirflow;
  const sections = [{ widthMm: width, heightMm, airflowM3h: totalAirflow }];
  const reducers: Array<{ distance: number; width: number }> = [];
  ordered.forEach((tap, index) => {
    remaining -= tap.terminal.airflowM3h;
    const next = ordered[index + 1];
    if (!next) return;
    const target = widthFor(remaining);
    if (width - target < settings.autoReducerStepMm) return;
    const mid = (at(tap) + at(next)) / 2;
    const transition = (width - target) / 2 / taper;
    // Keep the reducer off the take-off windows and off the elbows.
    const clearOfTaps = at(next) - at(tap) >= tapWindowMm(tap.terminal, settings) / 2 + tapWindowMm(next.terminal, settings) / 2 + transition + 100;
    const legIndex = offsets.findIndex((offset, k) => k < legs.length && mid >= offset && mid <= offsets[k + 1]!);
    const leg = legs[legIndex];
    const setback = settings.elbowCentrelineRatio * width + settings.elbowNeckMm;
    const onStraight = leg !== undefined && mid - offsets[legIndex]! > setback && offsets[legIndex + 1]! - mid > setback + transition;
    if (!clearOfTaps || !onStraight) return;
    reducers.push({ distance: mid, width: target });
    width = target;
    sections.push({ widthMm: target, heightMm, airflowM3h: remaining });
  });
  // Rebuild the polyline with the reducers as collinear vertices.
  const out: Point2D[] = [vertices[0]!];
  const legSizes: DuctLeg[] = [];
  let currentWidth = sections[0]!.widthMm;
  const newTaps: TapPlan[] = [];
  const legStartIndex: number[] = [];
  legs.forEach((leg, index) => {
    const direction = { x: (leg.end.x - leg.start.x) / leg.length, y: (leg.end.y - leg.start.y) / leg.length };
    legStartIndex.push(legSizes.length);
    for (const reducer of reducers.filter((r) => r.distance > offsets[index]! && r.distance < offsets[index + 1]!)) {
      const along = reducer.distance - offsets[index]!;
      out.push({ x: leg.start.x + direction.x * along, y: leg.start.y + direction.y * along });
      legSizes.push({ widthMm: currentWidth, heightMm });
      currentWidth = reducer.width;
    }
    out.push(leg.end);
    legSizes.push({ widthMm: currentWidth, heightMm });
  });
  // Re-express each take-off on the split legs.
  for (const tap of taps) {
    const distance = at(tap);
    let legIndex = legStartIndex[tap.legIndex]!;
    let start = offsets[tap.legIndex]!;
    for (const reducer of reducers) {
      if (reducer.distance > offsets[tap.legIndex]! && reducer.distance < distance) {
        legIndex += 1;
        start = reducer.distance;
      }
    }
    newTaps.push({ ...tap, legIndex, station: distance - start });
  }
  return { vertices: out, legSizes, taps: newTaps, sections };
}

function trunkObstacleHits(ctx: ServiceCtx, vertices: readonly Point2D[], widthMm: number, heightMm: number): number {
  const boxes = obstaclesFor(ctx, widthMm / 2 + 50, ctx.bottomZ, ctx.bottomZ + heightMm, new Set([ctx.unitId]));
  let hits = 0;
  for (let index = 1; index < vertices.length; index += 1) {
    for (const box of boxes) if (segmentHitsBox(vertices[index - 1]!, vertices[index]!, box)) hits += 1;
  }
  return hits;
}

function trunkHeight(ctx: ServiceCtx, terminals: readonly TerminalCtx[]): number {
  const biggest = Math.max(...terminals.map((terminal) => terminal.branch));
  // A spin-in fits the side wall: the trunk is at least the branch + 50 mm high.
  const minimum = roundUp(Math.max(ctx.port.heightMm, biggest + 50));
  const limits = sizingLimits(ctx.settings, ctx.service, 'trunk');
  const sized = sizeRectangular(ctx.airflowM3h, minimum, limits, { minWidthMm: minimum, maxAspect: 4, maxHeightMm: Math.max(minimum, ctx.maxHeightMm) });
  return sized.heightMm;
}

function exitLengthMm(port: DuctAirPort): number {
  // Fan outlet: about 2.5 equivalent diameters of straight duct before the first fitting (practice).
  return roundUp(Math.max(900, 2.5 * equivalentDiameterMm({ widthMm: port.widthMm, heightMm: port.heightMm })));
}

/** Builds one trunk run (and its take-off branches) from its plan; `origin` null = from the unit collar. */
function buildTrunkRun(
  ctx: ServiceCtx,
  plan: TrunkRunPlan,
  heightMm: number,
  origin: DuctDraftOrigin | null,
  scene: HvacElement[],
  end: 'end-cap' | DuctSplitStyle,
  build: Build,
  minFirstWidthMm = 0,
): { run: HvacElement; branches: HvacElement[]; terminalRuns: Map<string, string>; sections: Array<{ widthMm: number; heightMm: number; airflowM3h: number }>; hits: number; notes: AutoDuctIssue[] } | null {
  const airflow = plan.terminals.reduce((total, terminal) => total + terminal.airflowM3h, 0);
  const bottomZ = origin && origin.kind !== 'port' && origin.kind !== 'free' ? origin.bottomZ : ctx.bottomZ;
  const stubBlocked = (wall: Point2D, stubEnd: Point2D, terminal: TerminalCtx) => stretchBlocked(ctx, wall, stubEnd, terminal.branch, bottomZ, new Set([terminal.element.id, ctx.unitId]));
  const placed = end !== 'end-cap' ? { taps: [] as TapPlan[], vertices: plan.vertices } : placeTaps(plan, sizeRectangular(airflow, heightMm, sizingLimits(ctx.settings, ctx.service, 'trunk'), { minWidthMm: heightMm, maxHeightMm: heightMm }).widthMm, ctx.settings, stubBlocked);
  if (!placed) return null;
  const sized = sizeTrunk(ctx, placed.vertices, placed.taps, heightMm, airflow, minFirstWidthMm);
  const points = sized.vertices.slice(1).map((point) => ({ ...toWorld(ctx.frame, point), z: origin && origin.kind !== 'port' && origin.kind !== 'free' ? origin.bottomZ : ctx.bottomZ }));
  let run = buildDuctRunDraftElement({
    ...(origin ? { origin } : { port: ctx.port }), points, legSizes: sized.legSizes, construction: ctx.construction,
    end: 'end-cap',
  }, ctx.ids());
  if (end !== 'end-cap') run = ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, end: { kind: 'split', style: end } });
  const withRun = [...scene, run];
  addRunObstacles(ctx, build, run);
  const branches: HvacElement[] = [];
  const terminalRuns = new Map<string, string>();
  for (const tap of [...sized.taps].sort((a, b) => a.legIndex - b.legIndex || a.station - b.station)) {
    const branch = buildBranch(ctx, (first) => tapOrigin(run, ctx.settings, { legIndex: tap.legIndex, stationMm: tap.station, side: tap.side, style: 'spin-in', vcd: true }, first), tap.terminal, withRun, build);
    if (!branch) return null;
    branches.push(branch);
    terminalRuns.set(tap.terminal.element.id, branch.id);
  }
  return { run, branches, terminalRuns, sections: sized.sections, hits: trunkObstacleHits(ctx, sized.vertices, sized.sections[0]!.widthMm, heightMm), notes: build.notes };
}

function trunkCandidatesAt(ctx: ServiceCtx, exit: number): Candidate[] {
  const { terminals, settings } = ctx;
  const height = trunkHeight(ctx, terminals);
  if (height > ctx.maxHeightMm) return [];
  const width = sizeRectangular(ctx.airflowM3h, height, sizingLimits(settings, ctx.service, 'trunk'), { minWidthMm: height, maxHeightMm: height }).widthMm;
  const turnSetback = settings.elbowCentrelineRatio * width + settings.elbowNeckMm;
  const out: Candidate[] = [];
  const far = 1e5;
  const push = (layout: AutoDuctLayoutKind, built: ReturnType<typeof buildTrunkRun>) => {
    if (!built) return;
    out.push({ layout, runs: [built.run, ...built.branches], terminalRuns: built.terminalRuns, notes: built.notes, obstacleHits: built.hits, trunkSections: built.sections });
  };
  // Straight along the collar's normal.
  push('trunk-straight', buildTrunkRun(ctx, { vertices: [{ x: 0, y: 0 }, { x: far, y: 0 }], startClearMm: exit, terminals }, height, null, ctx.baseScene, 'end-cap', newBuild()));
  // One turn along the terminals' row: the trunk runs a branch's reach in
  // front of (or behind) the spigots, so each take-off meets its terminal square.
  const reach = branchStubMm(settings) + 1000;
  const lines: number[] = [];
  for (const terminal of terminals) {
    if (terminal.normal.x < -0.5) lines.push(terminal.lip.x - reach);
    else if (terminal.normal.x > 0.5) lines.push(terminal.lip.x + reach);
  }
  if (lines.length) lines.push(lines.reduce((total, value) => total + value, 0) / lines.length);
  const earliest = exit + turnSetback;
  const nearest = Math.min(...terminals.map((terminal) => terminal.lip.x));
  const rows = [...new Set(lines.map((x) => roundUp(Math.max(x, earliest))).filter((x) => x <= nearest - branchStubMm(settings) - 300 || terminals.every((terminal) => terminal.normal.x > 0.5)))].slice(0, 4);
  for (const row of rows) {
    for (const sign of [1, -1] as const) {
      if (!terminals.some((terminal) => Math.sign(terminal.lip.y) === sign)) continue;
      push('trunk-l', buildTrunkRun(ctx, { vertices: [{ x: 0, y: 0 }, { x: row, y: 0 }, { x: row, y: sign * far }], startClearMm: exit, terminals }, height, null, ctx.baseScene, 'end-cap', newBuild()));
    }
    // Split both ways at the row: a Y (or a bullhead tee, whose outlets sit tighter) off the main, a trunk each side.
    const left = terminals.filter((terminal) => terminal.lip.y >= 0);
    const right = terminals.filter((terminal) => terminal.lip.y < 0);
    if (!left.length || !right.length) continue;
    // A split divides the flow: its main is at least as wide as both outlets together.
    const sideWidth = (group: TerminalCtx[]) => sizeRectangular(group.reduce((total, terminal) => total + terminal.airflowM3h, 0), height,
      sizingLimits(settings, ctx.service, 'trunk'), { minWidthMm: height, maxHeightMm: height }).widthMm;
    const mainWidth = sideWidth(left) + sideWidth(right);
    for (const style of ['y', 'bullhead'] as const) {
      // The outlets sit ahead of the main's end: pull the main back so the outlet trunks run on the row.
      const trial = buildTrunkRun(ctx, { vertices: [{ x: 0, y: 0 }, { x: row, y: 0 }], startClearMm: exit, terminals }, height, null, ctx.baseScene, style, newBuild(), mainWidth);
      const trialOrigin = trial ? splitOrigin(trial.run, settings, { side: 1, style, vcd: false }, { widthMm: sideWidth(left), heightMm: height }) : null;
      const mainRow = trialOrigin && trialOrigin.kind === 'split' ? roundUp(row - (toLocal(ctx.frame, trialOrigin.point).x - row)) : row;
      // The split is the first fitting: it needs only the fan outlet straight before it.
      if (mainRow < exit) continue;
      const build = newBuild();
      const main = buildTrunkRun(ctx, { vertices: [{ x: 0, y: 0 }, { x: mainRow, y: 0 }], startClearMm: exit, terminals }, height, null, ctx.baseScene, style, build, mainWidth);
      if (!main) continue;
      const runs: HvacElement[] = [main.run];
      const terminalRuns = new Map<string, string>();
      const sections = [...main.sections];
      let hits = main.hits;
      let scene = [...ctx.baseScene, main.run];
      let ok = true;
      for (const [side, group] of [[1, left], [-1, right]] as const) {
        // No damper at the outlets: every take-off has its own, which is where the balancing is done.
        const origin = splitOrigin(main.run, settings, { side, style, vcd: false }, { widthMm: sideWidth(group), heightMm: height });
        if (!origin || origin.kind !== 'split') { ok = false; break; }
        const start = toLocal(ctx.frame, origin.point);
        const direction = cardinal(dirToLocal(ctx.frame, origin.direction));
        const built = buildTrunkRun(ctx, {
          vertices: [start, { x: start.x + direction.x * far, y: start.y + direction.y * far }], startClearMm: 150, terminals: [...group],
        }, height, origin, scene, 'end-cap', build);
        if (!built) { ok = false; break; }
        runs.push(built.run, ...built.branches);
        built.terminalRuns.forEach((value, key) => terminalRuns.set(key, value));
        sections.push(...built.sections);
        hits += built.hits;
        scene = [...scene, built.run];
      }
      if (ok) out.push({ layout: 'trunk-split', runs, terminalRuns, notes: build.notes, obstacleHits: hits, trunkSections: sections });
    }
  }
  return out;
}

/** Shortest straight off the collar before a fitting when space is tight: connector + collar transition (mm, practice). */
const SHORT_FAN_OUTLET_MM = 600;

/**
 * Trunk layouts with the full fan-outlet straight, and — where the terminals
 * are close to the unit — with a shortened one, which costs a little fan
 * pressure (system effect) and is noted.
 */
function trunkCandidates(ctx: ServiceCtx): Candidate[] {
  const full = exitLengthMm(ctx.port);
  const out = trunkCandidatesAt(ctx, full);
  if (full > SHORT_FAN_OUTLET_MM) {
    for (const candidate of trunkCandidatesAt(ctx, SHORT_FAN_OUTLET_MM)) {
      candidate.penalty = (candidate.penalty ?? 0) + 3;
      candidate.notes.push({
        code: 'DU_AUTO_FAN_OUTLET', severity: 'info', service: ctx.service,
        message: `The straight off the fan is shortened to ${SHORT_FAN_OUTLET_MM} mm (about 2.5 duct diameters, ${full} mm, is recommended): expect a little system-effect loss at the fan.`,
      });
      out.push(candidate);
    }
  }
  return out;
}

// ---- Scoring ----

interface Scored {
  candidate: Candidate;
  plans: DuctFabricationPlan[];
  pressure: ServicePressure;
  errors: number;
  warnings: number;
  cost: number;
  issues: AutoDuctIssue[];
}

function score(ctx: ServiceCtx, candidate: Candidate): Scored {
  const scene = [...ctx.baseScene, ...candidate.runs];
  const plans = candidate.runs.map((run) => planDuctRunSpec(run.id, readDuctRunSpec(run)!, { settings: ctx.settings, scene }));
  const issues: AutoDuctIssue[] = [...candidate.notes];
  let errors = 0;
  let warnings = 0;
  for (const plan of plans) {
    for (const issue of plan.issues) {
      if (issue.severity === 'error') errors += 1;
      else if (issue.severity === 'warning') warnings += 1;
      else continue;
      issues.push({ code: issue.code, severity: issue.severity, message: issue.message, service: ctx.service, ...(issue.point ? { point: { x: issue.point.x, y: issue.point.y } } : {}) });
    }
  }
  const newIds = new Set(candidate.runs.map((run) => run.id));
  for (const clash of findDuctClashes(scene, ctx.settings, listNetworkPipeLanes(scene))) {
    if (!newIds.has(clash.ductId) && !newIds.has(clash.otherId)) continue;
    // A branch meeting its own trunk or terminal is by design; anything else is a clash.
    errors += 1;
    issues.push({ code: 'DU_CLASH', severity: 'error', message: `${clash.mark} clashes with ${clash.kind === 'pipe' ? `a ${clash.service ?? 'pipe'}` : clash.kind === 'terminal' ? 'an air terminal' : 'another duct'}.`, service: ctx.service, point: { x: clash.point.x, y: clash.point.y } });
  }
  let sheet = 0;
  let fittings = 0;
  let flex = 0;
  for (const plan of plans) {
    for (const piece of plan.pieces) {
      if (piece.kind === 'flex') { flex += piece.lengthMm / 1000; continue; }
      sheet += piece.sheetAreaM2;
      if (piece.kind === 'elbow' || piece.kind === 'transition' || piece.kind === 'takeoff' || piece.kind === 'offset' || piece.kind === 'split') fittings += 1;
    }
  }
  if (candidate.obstacleHits) {
    issues.push({ code: 'DU_CLASH', severity: 'error', service: ctx.service, message: `The trunk crosses ${candidate.obstacleHits} piece${candidate.obstacleHits === 1 ? '' : 's'} of equipment at duct level.` });
  }
  const pressure = systemPressure(plans, new Map(ctx.terminals.map((terminal) => [terminal.element.id, terminal.airflowM3h])), ctx.settings, ctx.service);
  // A pascal at the index terminal is worth about 50 mm of duct: the fan pays for it all the time.
  const cost = sheet + 0.6 * fittings + 0.8 * flex + 0.05 * pressure.indexPa + 100 * (errors + candidate.obstacleHits) + 2 * warnings + (candidate.penalty ?? 0);
  return { candidate, plans, pressure, errors: errors + candidate.obstacleHits, warnings, cost, issues };
}

// ---- Entry point ----

function removalTree(runId: string, scene: readonly HvacElement[]): string[] {
  const out = [runId];
  for (const branch of ductBranchesOf(runId, scene)) out.push(...removalTree(branch.element.id, scene));
  return out;
}

export function generateAutoDuct(scene: readonly HvacElement[], request: AutoDuctRequest, settings: DuctDesignSettings): AutoDuctResult {
  const unit = scene.find((element) => element.id === request.unitId);
  let counter = 0;
  const stamp = Date.now().toString(36);
  const ids = () => `duct-auto-${stamp}-${(counter += 1)}`;
  const result: AutoDuctResult = {
    unitId: request.unitId, unitLabel: unit?.label || unit?.modelLabel || 'Unit', fanSpeed: request.fanSpeed,
    airflowM3h: null, airflowSource: null, maxEspPa: null, requiredEspPa: null, services: [], runs: [], removeIds: [], issues: [],
  };
  if (!unit) {
    result.issues.push({ code: 'DU_AUTO_NO_PORT', severity: 'error', message: 'The unit is not in the drawing.' });
    return result;
  }
  const air = readUnitAirData(unit);
  // Typed in the card, else the unit's own Airflow field (L/s), else its data at the fan speed.
  const unitLps = typeof unit.properties.airflowLps === 'number' && unit.properties.airflowLps > 0 ? unit.properties.airflowLps : null;
  const airflow = request.airflowM3h && request.airflowM3h > 0 ? request.airflowM3h
    : unitLps ? unitLps * 3.6
      : air.airflowM3h?.[request.fanSpeed] ?? null;
  result.airflowM3h = airflow;
  result.airflowSource = request.airflowM3h && request.airflowM3h > 0 ? 'entered' : unitLps ? 'unit' : airflow ? 'manufacturer' : null;
  result.maxEspPa = air.maxEspPa;
  if (!airflow) {
    result.issues.push({ code: 'DU_AUTO_NO_DATA', severity: 'error', message: `${result.unitLabel} has no airflow data: enter its airflow to size the ducts.` });
    return result;
  }
  const ports = listAirPorts(scene).filter((port) => port.unitId === unit.id);
  const terminalPorts = listTerminalPorts(scene);
  const requested = scene.filter((element) => request.terminalIds.includes(element.id) && isDuctTerminalElement(element));
  let removed = new Set<string>();

  for (const service of ['supply', 'return'] as const) {
    if (!request.services[service]) continue;
    const group = requested.filter((element) => readDuctTerminalSpec(element)?.service === service);
    if (!group.length) continue;
    const serviceResult: AutoDuctServiceResult = {
      service, layout: null, airflowM3h: airflow, runs: [], removeIds: [], terminals: [], trunkSections: [], plans: [], pressure: null, issues: [], candidates: [],
    };
    result.services.push(serviceResult);
    const port = ports.find((candidate) => candidate.kind === service);
    if (!port) {
      serviceResult.issues.push({ code: 'DU_AUTO_NO_PORT', severity: 'error', service, message: `${result.unitLabel} has no ${service} collar.` });
      continue;
    }
    // The duct already on this collar: replaced (with its branches) or left alone.
    const existing = scene.filter((element) => {
      if (!isDuctElement(element)) return false;
      const start = readDuctRunSpec(element)?.start;
      return start?.kind === 'unit-port' && start.unitId === unit.id && start.portId === port.portId;
    });
    if (existing.length && !request.rebuildExisting) {
      serviceResult.issues.push({ code: 'DU_AUTO_OCCUPIED', severity: 'error', service, message: `The ${service} collar already has a duct; tick Rebuild existing to replace it.` });
      continue;
    }
    const removeIds = existing.flatMap((element) => removalTree(element.id, scene));
    serviceResult.removeIds = removeIds;
    removed = new Set([...removed, ...removeIds]);
    const baseScene = [...scene.filter((element) => !removed.has(element.id)), ...result.runs];
    // Terminals another duct already serves stay as they are.
    const servedBy = new Map<string, string>();
    for (const element of baseScene) {
      const end = isDuctElement(element) ? readDuctRunSpec(element)?.end : null;
      if (end?.kind === 'terminal') servedBy.set(end.terminalId, element.id);
    }
    const free = group.filter((element) => {
      if (!servedBy.has(element.id)) return true;
      serviceResult.issues.push({ code: 'DU_AUTO_CONNECTED', severity: 'warning', service, message: `${element.label || 'A terminal'} is already connected to another duct; it is left as it is.` });
      return false;
    });
    if (!free.length) continue;
    const frame: Frame = { origin: { x: port.lip.x, y: port.lip.y }, n: port.normal, t: legNormal(port.normal) };
    const shares = shareAirflow(airflow, free.map((element) => ({ id: element.id, spec: readDuctTerminalSpec(element)! })));
    const total = shares.reduce((sum, share) => sum + share.airflowM3h, 0);
    if (Math.abs(total - airflow) > airflow * 0.1) {
      serviceResult.issues.push({ code: 'DU_AUTO_AIRFLOW', severity: 'warning', service, message: `The ${service} terminals add up to ${Math.round(total)} m³/h, not the unit's ${Math.round(airflow)} m³/h.` });
    }
    const neckCap = service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
    const terminals: TerminalCtx[] = free.flatMap((element, index) => {
      const spec = readDuctTerminalSpec(element)!;
      const tport = terminalPorts.find((candidate) => candidate.unitId === element.id);
      if (!tport) return [];
      const share = shares[index]!;
      const neck = spec.neckDiameterMm;
      const velocity = neckVelocityMs(spec, share.airflowM3h);
      if (velocity > neckCap + 1e-6) {
        const better = neckForAirflow(share.airflowM3h, neckCap);
        serviceResult.issues.push({
          code: 'DU_TERMINAL_VELOCITY', severity: 'warning', service, point: { x: tport.lip.x, y: tport.lip.y },
          message: `${element.label || 'Terminal'}: ${velocity.toFixed(1)} m/s in its Ø${neck} neck at ${Math.round(share.airflowM3h)} m³/h (cap ${neckCap} m/s)${better ? `; a Ø${better} neck keeps it within` : '; use a larger terminal or split the airflow'}.`,
        });
      }
      const branch = sizeRound(share.airflowM3h, sizingLimits(settings, service, 'branch'), settings.autoRoundSizesMm, { minimumMm: neck });
      return [{
        element, spec, port: tport, lip: toLocal(frame, tport.lip), normal: cardinal(dirToLocal(frame, tport.normal)),
        airflowM3h: share.airflowM3h, fixed: share.fixed, neck, branch,
      }];
    });
    const bottomZ = port.lip.z - port.heightMm / 2;
    const insulation = settings.defaultConstruction === 'gi-nbr' ? (service === 'return' ? settings.nbrReturnThicknessMm : settings.nbrSupplyThicknessMm) : 0;
    const maxHeightMm = Math.max(0, resolveSoffitZ(settings) - bottomZ - 2 * insulation - 50);
    if (maxHeightMm < port.heightMm) {
      serviceResult.issues.push({ code: 'DU_AUTO_VOID', severity: 'warning', service, message: `Only ${Math.round(maxHeightMm)} mm between the duct's bottom and the soffit.` });
    }
    // Obstacles in the local frame, with their height bands.
    const obstacles: ServiceCtx['obstacles'] = [];
    for (const element of baseScene) {
      if (isDuctElement(element) || isRefrigerantPipeElementType(element.type) || isCondensatePipe(element)) continue;
      if (isDuctTerminalElement(element)) {
        const box = terminalBoxOf(element);
        if (box) obstacles.push({ ...boxToLocal(frame, footprintCorners(element), 0, element.id), zMin: box.bounds.minZ, zMax: box.bounds.maxZ });
        continue;
      }
      if (element.width <= 0 || element.depth <= 0) continue;
      obstacles.push({ ...boxToLocal(frame, footprintCorners(element), 0, element.id), zMin: element.elevation, zMax: element.elevation + Math.max(element.height, 1) });
    }
    for (const element of baseScene) {
      if (!isDuctElement(element)) continue;
      const spec = readDuctRunSpec(element);
      if (!spec || spec.legacy) continue;
      spec.legs.forEach((leg, index) => {
        const a = spec.path[index]!;
        const b = spec.path[index + 1]!;
        const half = (leg.diameterMm ?? leg.widthMm) / 2 + spec.insulationThicknessMm;
        const corners = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        const box = boxToLocal(frame, corners, half, element.id);
        obstacles.push({ ...box, zMin: Math.min(a.z, b.z), zMax: Math.max(a.z, b.z) + leg.heightMm });
      });
    }
    for (const lane of listNetworkPipeLanes([...baseScene])) {
      for (const segment of lane.segments) {
        obstacles.push({
          ...boxToLocal(frame, [segment.a, segment.b], lane.radiusMm, lane.elementId),
          zMin: Math.min(segment.a.z, segment.b.z) - lane.radiusMm, zMax: Math.max(segment.a.z, segment.b.z) + lane.radiusMm,
        });
      }
    }
    const ctx: ServiceCtx = {
      service, unitId: unit.id, frame, port, bottomZ, terminals, airflowM3h: total, baseScene, settings, obstacles, maxHeightMm,
      construction: settings.defaultConstruction, ids,
    };
    const candidates: Candidate[] = [];
    if (request.layout !== 'trunk') {
      const plenum = plenumCandidate(ctx);
      if (plenum) candidates.push(plenum);
    }
    if (request.layout !== 'plenum') candidates.push(...trunkCandidates(ctx));
    if (!candidates.length) {
      serviceResult.issues.push({ code: 'DU_AUTO_NO_LAYOUT', severity: 'error', service, message: request.layout === 'plenum'
        ? 'No plenum layout fits these terminals (at most four, two per face, within about 4 m); try Trunk.'
        : 'No duct layout could be built for these terminals.' });
      continue;
    }
    const scored = candidates.map((candidate) => score(ctx, candidate)).sort((a, b) => a.cost - b.cost);
    serviceResult.candidates = scored.map((entry) => ({ layout: entry.candidate.layout, cost: Math.round(entry.cost * 100) / 100, errors: entry.errors, warnings: entry.warnings }));
    const best = scored[0]!;
    serviceResult.layout = best.candidate.layout;
    serviceResult.runs = best.candidate.runs;
    serviceResult.plans = best.plans;
    serviceResult.pressure = best.pressure;
    serviceResult.trunkSections = best.candidate.trunkSections;
    serviceResult.issues.push(...best.issues);
    serviceResult.terminals = terminals.map((terminal) => ({
      terminalId: terminal.element.id, label: terminal.element.label || terminal.spec.kind, airflowM3h: Math.round(terminal.airflowM3h),
      fixed: terminal.fixed, neckMm: terminal.neck, neckVelocityMs: Math.round(neckVelocityMs(terminal.spec, terminal.airflowM3h) * 100) / 100,
      branchDiameterMm: terminal.branch, runId: best.candidate.terminalRuns.get(terminal.element.id) ?? null,
    }));
    result.runs.push(...best.candidate.runs);
    result.removeIds.push(...removeIds);
  }
  if (!result.services.length) {
    result.issues.push({ code: 'DU_AUTO_NO_LAYOUT', severity: 'error', message: 'Select the diffusers and grilles this unit serves (supply to diffusers, return to grilles).' });
  }
  const paths = result.services.map((service) => service.pressure).filter((pressure): pressure is ServicePressure => pressure !== null);
  if (paths.length) {
    result.requiredEspPa = paths.reduce((total, pressure) => total + pressure.indexPa, 0);
    if (result.maxEspPa !== null && result.requiredEspPa > result.maxEspPa) {
      result.issues.push({
        code: 'DU_AUTO_ESP', severity: 'warning',
        message: `The ducts need about ${Math.round(result.requiredEspPa)} Pa of external static pressure; ${result.unitLabel} gives at most ${result.maxEspPa} Pa. Enlarge the ducts or shorten the index run.`,
      });
    }
  }
  return result;
}
