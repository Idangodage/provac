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
import { findObstacleAwareOrthogonalRoute } from '../obstacleAwareOrthogonalRoute';
import { isRefrigerantPipeElementType } from '../refrigerantPipePairModel';

import { listAirPorts, type DuctAirPort } from './ductAirPorts';
import {
  ALL_FLEX_REACH_MM,
  RUNOUT_TARGETS_MM,
  addRunObstacles,
  boxToLocal,
  branchStubMm,
  cardinal,
  dirToLocal,
  dot,
  flexFit,
  flexOk,
  footprintCorners,
  newBuild,
  obstaclesFor,
  roundUp,
  segmentHitsBox,
  simplifyCollinear,
  spigotVariants,
  stretchBlocked,
  sub,
  toLocal,
  toWorld,
  type AutoDuctIssue,
  type Build,
  type Frame,
  type ServiceCtx,
  type TerminalCtx,
} from './ductAutoContext';
import { spigotOrigin, splitOrigin, tapOrigin } from './ductBranchTargets';
import { legNormal } from './ductBranches';
import { buildDuctRunDraft, buildDuctRunDraftElement, type DuctDraftOrigin, type DuctDraftPoint } from './ductDraft';
import { energyPricePerPa, priceDuctPlans, type DuctCostBreakdown } from './ductEconomics';
import { planDuctRunSpec, type DuctFabricationPlan } from './ductFabricationPlanner';
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
  velocityMs,
  velocityPressurePa,
  type FanSpeed,
} from './ductSizing';
import { getDuctSupportPlan, resolveSoffitZ } from './ductSupports';
import { linkSizingBasis, sizeDuctSystem, type DuctSystemSizingReport } from './ductSystemSizing';
import { isDuctTerminalElement, listTerminalPorts, readDuctTerminalSpec } from './ductTerminals';
import {
  isDuctElement,
  readDuctRunSpec,
  roundLeg,
  type DuctLeg,
  type DuctService,
  type DuctSide,
  type DuctSpigotFace,
  type DuctSplitStyle,
  type DuctSystemSizing,
} from './ductTypes';
import { boxesOverlap, ductBoxesOf, findDuctClashes, terminalBoxOf } from './ductVolumes';
import { designFromRuns, withReplaced, type ServiceDesign } from './optimizer/designTree';
import { optimiseService, verifyRuns, type ServiceOption, type TreeFailure } from './optimizer/ductOptimizer';
import { explainBlockedCollar, explainNoCleanDesign } from './optimizer/failureMessages';
import { cutsFromErrors, cutsFromFailures } from './optimizer/routerCuts';
import { buildRoutingGraph } from './optimizer/routingGraph';
import { SizingModel, type ShapeMode } from './optimizer/sizingModel';
import { emptyCuts, GROUPED_MAX_TERMINALS, groupTerminals, layerMemoWorthKeeping, newLayerMemo, routeTrees, type LayerMemo } from './optimizer/steinerArborescence';

export type { AutoDuctIssue, AutoDuctIssueCode } from './ductAutoContext';

export type AutoDuctLayoutChoice = 'auto' | 'plenum' | 'trunk';
export type AutoDuctLayoutKind = 'plenum' | 'trunk-straight' | 'trunk-l' | 'trunk-split' | 'tree';

export const AUTO_DUCT_LAYOUT_LABELS: Record<AutoDuctLayoutKind, string> = {
  plenum: 'Plenum + runouts',
  'trunk-straight': 'Straight trunk + branches',
  'trunk-l': 'Trunk with one turn + branches',
  'trunk-split': 'Split trunk + branches',
  tree: 'Optimised tree + branches',
};

/** Trunk shape: rectangular, round, or the optimiser's choice per stretch (branches are round either way). */
export type AutoDuctShape = ShapeMode;
export const AUTO_DUCT_SHAPE_LABELS: Record<AutoDuctShape, string> = { rect: 'Rectangular', round: 'Round', optimal: 'Optimal' };

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
  /** Trunk shape (default: the optimiser chooses). */
  shape?: AutoDuctShape;
  /** The drawing's walls: the ducts stay clear of them (a duct through a wall needs a sleeve and a reason). */
  walls?: ReadonlyArray<AutoDuctWall>;
  /** Size by constant friction at these bases (per service); absent or null = the life-cycle optimum. */
  sizing?: AutoDuctSizingBases | null;
  /** Airflow per terminal set in the card (m³/h; null = an equal share), written to the terminals with the runs. */
  terminalAirflows?: Readonly<Record<string, number | null>>;
}

/** Constant-friction bases by service. */
export type AutoDuctSizingBases = Partial<Record<DuctService, DuctSystemSizing>>;

/** A terminal's design airflow as the card sets it (an absent entry leaves the terminal's own). */
export function terminalWithAirflow(element: HvacElement, airflows: Readonly<Record<string, number | null>> | undefined): HvacElement {
  const spec = readDuctTerminalSpec(element);
  if (!spec || !airflows || !Object.prototype.hasOwnProperty.call(airflows, element.id)) return element;
  const value = airflows[element.id];
  const next = value !== null && value !== undefined && value > 0 ? value : null;
  if ((spec.designAirflowM3h ?? null) === next) return element;
  return { ...element, properties: { ...element.properties, terminal: { ...spec, designAirflowM3h: next } } };
}

/** A wall as the auto layout sees it: its centre line and thickness (mm). */
export interface AutoDuctWall {
  id: string;
  startPoint: Point2D;
  endPoint: Point2D;
  thickness?: number;
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
  label: string;
  /** Verified first cost (currency). */
  cost: number;
  espPa: number;
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
  trunkSections: Array<{ widthMm: number; heightMm: number; diameterMm?: number; airflowM3h: number }>;
  plans: DuctFabricationPlan[];
  /** Pressure along each terminal's path; the index path is what the fan must deliver. */
  pressure: ServicePressure | null;
  issues: AutoDuctIssue[];
  candidates: AutoDuctCandidateReport[];
  /** What the layout was built from, its trunk shape and its verified first cost. */
  label: string;
  shape: AutoDuctShape;
  cost: DuctCostBreakdown | null;
  /** Terminals whose plenum-box spigot the design turns, as they will be (applied with the runs). */
  terminalUpdates: HvacElement[];
  /** Sized by constant friction: every section, what set it, and the basis. */
  sizingReport?: DuctSystemSizingReport | null;
}

/** One whole design (every service), verified and priced. */
export interface AutoDuctDesign {
  key: string;
  label: string;
  services: AutoDuctServiceResult[];
  runs: HvacElement[];
  /** Terminals whose spigot the design turns, as they will be. */
  terminalUpdates: HvacElement[];
  /** Verified first cost, by item (currency). */
  cost: DuctCostBreakdown;
  firstCost: number;
  /** Supply + return index paths (Pa). */
  requiredEspPa: number;
  /** Present worth of the fan energy the pressure costs, and first cost + that. */
  energyCost: number;
  lifeCycleCost: number;
  errors: number;
  warnings: number;
  /** The sizing model's own life-cycle figure for the design (the certificate compares it). */
  modelLifeCycleCost: number;
}

export interface AutoDuctCertificate {
  /** Every tree was searched exactly (router within its terminal limit) and every size set is the catalogue optimum. */
  exact: boolean;
  trees: number;
  realised: number;
  solveMs: number;
  /** Of which: the tree router, and sizing + building + verifying the candidates (ms). */
  routerMs: number;
  sizingMs: number;
  /** Verified life-cycle cost of the chosen design over the model's (%), the geometry the realiser settled. */
  modelGapPct: number | null;
  /** Routing rounds the feasibility loop took after the first, and the unbuildable choices it ruled out. */
  rounds: number;
  cuts: number;
  /** More terminals than the exact search takes: routed in groups (exact within each group and between them). */
  grouped: boolean;
  /** The time budget ran out while the router still rated a failed tree cheaper than the best clean one. */
  timeLimited: boolean;
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
  /** Terminals the shown design turns the spigot of, as they will be (applied with the runs, one undo). */
  terminalUpdates: HvacElement[];
  issues: AutoDuctIssue[];
  /** Every verified design, the cost–pressure frontier's picks and the one shown. */
  designs: AutoDuctDesign[];
  picks: { cheapest: number; lifeCycle: number; quietest: number } | null;
  selected: number;
  /** Currency per pascal of fan pressure (present worth of the energy). */
  pricePerPa: number;
  currency: string;
  certificate: AutoDuctCertificate | null;
  /** Issues that hold whichever design is shown. */
  baseIssues: AutoDuctIssue[];
  /** Services with nothing to optimise (no collar, occupied, …), shown with every design. */
  staticServices: AutoDuctServiceResult[];
  /** The constant-friction bases the designs are sized at (linked at the system airflow); null = life-cycle optimum. */
  sizing: AutoDuctSizingBases | null;
  /** Terminals whose design airflow the card set, as they will be (applied with the runs, one undo). */
  terminalAirflowUpdates: HvacElement[];
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
  /** Terminal sides used by this seed; its tree and checks use the same ports. */
  terminals?: TerminalCtx[];
  terminalUpdates?: HvacElement[];
}

// ---- Branches (shared by every layout) ----

/**
 * The branch's points after its origin and its leg sections: all flex when the
 * terminal is close, else rigid round routed round the obstacles to a point a
 * runout's length in front of the spigot, then the flexible runout.
 */
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
  // The router reserves the straight flange neck separately; adding it to
  // the bend radius too would discard buildable corridors twice.
  const bendRadius = ratio * terminal.branch;
  const zTop = z + terminal.branch;
  const obstacles = obstaclesFor(ctx, terminal.branch / 2 + 50, z, zTop, new Set(), build);
  // The bend-aware router pads obstacles by its elbow setback as well. Leave
  // enough straight beyond the damper to escape the parent's padded wall;
  // starting at the damper itself can be inside that padding.
  const routeStart = { x: stubEnd.x + out.x * bendRadius, y: stubEnd.y + out.y * bendRadius };
  const clearExit = obstacles.every((box) => box.id === origin.parentRunId || !segmentHitsBox(stubEnd, routeStart, box));
  let route: Point2D[] | null = null;
  let reduce = terminal.branch !== terminal.neck;
  for (const withReducer of reduce ? [true, false] : [false]) {
    // A larger branch needs a straight before the flex for its reducer.
    const endStraight = withReducer ? 700 : 150;
    for (const reach of RUNOUT_TARGETS_MM) {
      const end = { x: terminal.lip.x + terminal.normal.x * reach, y: terminal.lip.y + terminal.normal.y * reach };
      // From the end of the collar + damper, clear of the parent's wall.
      const found = clearExit ? findObstacleAwareOrthogonalRoute({
        start: routeStart, startDirection: out, end, endDirection: terminal.normal,
        startStraightMm: settings.elbowNeckMm, endStraightMm: endStraight, bendRadiusMm: bendRadius,
        obstacles, clearanceMm: 0, bendPenaltyMm: 1500,
      }) : null;
      if (found) { route = simplifyCollinear([start, stubEnd, ...found.points]); break; }
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
  const choices = [terminal, ...(terminal.variants ?? []).filter((variant) => variant.spec.spigotSide !== terminal.spec.spigotSide)].slice(0, 3);
  let best: { run: HvacElement; terminal: TerminalCtx; notes: AutoDuctIssue[]; errors: number; warnings: number; length: number; pressure: number } | null = null;
  for (const choice of choices) {
    const trial: Build = { extra: build.extra, notes: [] };
    const run = buildBranchForSide(ctx, makeOrigin, choice, withReplaced(scene, [choice.element]), trial);
    if (!run) continue;
    const spec = readDuctRunSpec(run)!;
    const plan = planDuctRunSpec(run.id, spec, { settings: ctx.settings, scene: [...withReplaced(scene, [choice.element]), run] });
    const issues = [...plan.issues, ...trial.notes];
    const ownPlenum = terminalBoxOf(choice.element);
    const crossesOwnPlenum = ownPlenum && ductBoxesOf(plan).some(body => boxesOverlap(body, ownPlenum));
    const errors = issues.filter((issue) => issue.severity === 'error').length + (crossesOwnPlenum ? 1 : 0);
    const warnings = issues.filter((issue) => issue.severity === 'warning').length;
    // A valid placed spigot can still force a curled runout. Compare every
    // bounded side using actual fabricated length, including curved flex,
    // rather than stopping at the first side without a fabrication error.
    const length = plan.pieces.reduce((sum, piece) => sum + piece.lengthMm, 0);
    const pressure = systemPressure([plan], new Map([[choice.element.id, choice.airflowM3h]]), ctx.settings, ctx.service).indexPa;
    const better = !best || errors < best.errors || (errors === best.errors && (warnings < best.warnings
      || (warnings === best.warnings && (length < best.length - 0.5 || (Math.abs(length - best.length) <= 0.5 && pressure < best.pressure - 1e-6)))));
    if (better) best = { run, terminal: choice, notes: trial.notes, errors, warnings, length, pressure };
  }
  if (!best) return null;
  build.notes.push(...best.notes);
  (build.terminals ??= new Map()).set(terminal.element.id, best.terminal);
  addRunObstacles(ctx, build, best.run);
  return best.run;
}

function buildBranchForSide(ctx: ServiceCtx, makeOrigin: (first: DuctLeg) => DuctDraftOrigin | null, terminal: TerminalCtx, scene: HvacElement[], build: Build): HvacElement | null {
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
  return branch;
}

function candidateTerminalSides(ctx: ServiceCtx, build: Build): Pick<Candidate, 'terminals' | 'terminalUpdates'> {
  const terminals = ctx.terminals.map((terminal) => build.terminals?.get(terminal.element.id) ?? terminal);
  return { terminals, terminalUpdates: terminals.filter((terminal) => terminal.turnedTo !== undefined).map((terminal) => terminal.element) };
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
  return { layout: 'plenum', runs, terminalRuns, notes: build.notes, obstacleHits: 0, trunkSections: [{ widthMm: width, heightMm: height, airflowM3h: ctx.airflowM3h }], ...candidateTerminalSides(ctx, build) };
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
  alternateStations: (start: Point2D, direction: Point2D, terminal: TerminalCtx) => number[] = () => [],
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
      const bounded = (value: number) => Math.min(Math.max(value, from + tapWindowMm(terminal, settings) / 2), to - tapWindowMm(terminal, settings) / 2);
      const stations = [...new Set([bounded(along), ...alternateStations(leg.start, leg.direction, terminal).map(bounded)])];
      for (const station of stations) {
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
      }
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
    // Equal spacing can move a previously clear takeoff back behind its own
    // terminal. Translate the packed cluster within its neighbouring windows
    // to the nearest clear visibility event; preserve every internal gap.
    const leg = legs[legIndex]!;
    const normal = legNormal(leg.direction);
    const blockedAt = (tap: TapPlan, station: number) => {
      const wall = { x: leg.start.x + leg.direction.x * station + normal.x * tap.side * widthMm / 2,
        y: leg.start.y + leg.direction.y * station + normal.y * tap.side * widthMm / 2 };
      const end = { x: wall.x + normal.x * tap.side * branchStubMm(settings), y: wall.y + normal.y * tap.side * branchStubMm(settings) };
      return stubBlocked(wall, end, tap.terminal);
    };
    for (const cluster of clusters) {
      if (!cluster.taps.some(tap => blockedAt(tap, tap.station))) continue;
      const first = cluster.taps[0]!; const last = cluster.taps.at(-1)!;
      const previous = onLeg[onLeg.indexOf(first) - 1]; const next = onLeg[onLeg.indexOf(last) + 1];
      const low = Math.max(from + tapWindowMm(first.terminal, settings) / 2,
        previous ? previous.station + gapOf(previous, first) : -Infinity) - first.station;
      const high = Math.min(to - tapWindowMm(last.terminal, settings) / 2,
        next ? next.station - gapOf(last, next) : Infinity) - last.station;
      const shifts = [...new Set([0, ...cluster.taps.flatMap(tap => alternateStations(leg.start, leg.direction, tap.terminal).map(station => station - tap.station))])]
        .filter(shift => shift >= low - 1e-6 && shift <= high + 1e-6);
      let best = { shift: 0, cost: Infinity };
      for (const shift of shifts) {
        const blocked = cluster.taps.filter(tap => blockedAt(tap, tap.station + shift)).length;
        const cost = blocked * 20000 + Math.abs(shift) * cluster.taps.length;
        if (cost < best.cost) best = { shift, cost };
      }
      for (const tap of cluster.taps) tap.station += best.shift;
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
): ({ run: HvacElement; branches: HvacElement[]; terminalRuns: Map<string, string>; sections: Array<{ widthMm: number; heightMm: number; airflowM3h: number }>; hits: number; notes: AutoDuctIssue[] } & Pick<Candidate, 'terminals' | 'terminalUpdates'>) | null {
  const airflow = plan.terminals.reduce((total, terminal) => total + terminal.airflowM3h, 0);
  const bottomZ = origin && origin.kind !== 'port' && origin.kind !== 'free' ? origin.bottomZ : ctx.bottomZ;
  const stubBlocked = (wall: Point2D, stubEnd: Point2D, terminal: TerminalCtx) => {
    const ignored = new Set([ctx.unitId]);
    if (stretchBlocked(ctx, wall, stubEnd, terminal.branch, bottomZ, ignored)) return true;
    const delta = sub(stubEnd, wall);
    const length = Math.hypot(delta.x, delta.y) || 1;
    const out = { x: delta.x / length, y: delta.y / length };
    if (dot(sub(stubEnd, terminal.lip), terminal.normal) > terminal.neck
      && flexOk(flexFit(ctx, stubEnd, out, bottomZ, terminal), terminal, ctx.settings)) return false;
    const radius = (SMACNA_TABLE_3_1[ctx.settings.roundVelocityBand]?.ratio ?? 1.5) * terminal.branch + ctx.settings.elbowNeckMm;
    const routeStart = { x: stubEnd.x + out.x * radius, y: stubEnd.y + out.y * radius };
    return obstaclesFor(ctx, terminal.branch / 2 + 50 + radius, bottomZ, bottomZ + terminal.branch, ignored)
      .some(body => segmentHitsBox(stubEnd, routeStart, body));
  };
  // Takeoff stations are visibility events at solid boundaries. A terminal's
  // own plenum must remain an obstacle: a short stub aimed at its centre can
  // otherwise pierce the box before the route has room for its first elbow.
  const alternateStations = (start: Point2D, direction: Point2D, terminal: TerminalCtx) => {
    const radius = (SMACNA_TABLE_3_1[ctx.settings.roundVelocityBand]?.ratio ?? 1.5) * terminal.branch + ctx.settings.elbowNeckMm;
    const pad = terminal.branch / 2 + 51 + radius;
    return ctx.obstacles.filter(body => body.id !== ctx.unitId && body.zMax > bottomZ && body.zMin < bottomZ + terminal.branch)
      .flatMap(body => {
        const stations = [{ x: body.minX, y: body.minY }, { x: body.minX, y: body.maxY },
          { x: body.maxX, y: body.minY }, { x: body.maxX, y: body.maxY }].map(point => dot(sub(point, start), direction));
        return [Math.min(...stations) - pad, Math.max(...stations) + pad];
      });
  };
  const placed = end !== 'end-cap' ? { taps: [] as TapPlan[], vertices: plan.vertices } : placeTaps(plan, sizeRectangular(airflow, heightMm, sizingLimits(ctx.settings, ctx.service, 'trunk'), { minWidthMm: heightMm, maxHeightMm: heightMm }).widthMm, ctx.settings, stubBlocked, alternateStations);
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
  return { run, branches, terminalRuns, sections: sized.sections, hits: trunkObstacleHits(ctx, sized.vertices, sized.sections[0]!.widthMm, heightMm), notes: build.notes, ...candidateTerminalSides(ctx, build) };
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
    out.push({ layout, runs: [built.run, ...built.branches], terminalRuns: built.terminalRuns, notes: built.notes, obstacleHits: built.hits, trunkSections: built.sections, terminals: built.terminals, terminalUpdates: built.terminalUpdates });
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
  // A trunk can sit between two terminal rows, with their spigots facing it
  // from either side. The physical checks reject obstructed rows afterwards.
  const rows = [...new Set(lines.map((x) => roundUp(Math.max(x, earliest))))].slice(0, 4);
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
      if (ok) out.push({ layout: 'trunk-split', runs, terminalRuns, notes: build.notes, obstacleHits: hits, trunkSections: sections, ...candidateTerminalSides(ctx, build) });
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

/** A second, bounded set of seeds with symmetric spigots facing a shared cross-trunk. */
function facingTrunkCandidates(ctx: ServiceCtx): Candidate[] {
  if (!ctx.settings.autoChooseSpigotSide || ctx.terminals.length < 2) return [];
  const centres = ctx.terminals.map((terminal) => {
    const x = terminal.element.position.x + terminal.element.width / 2;
    const y = terminal.element.position.y + terminal.element.depth / 2;
    return toLocal(ctx.frame, { x, y }).x;
  });
  const row = (Math.min(...centres) + Math.max(...centres)) / 2;
  const terminals = ctx.terminals.map((terminal, index) => {
    const direction = centres[index]! < row ? 1 : -1;
    const side = terminal.variants?.find((variant) => variant.normal.x === direction);
    return side ? { ...side, variants: terminal.variants } : terminal;
  });
  const terminalUpdates = terminals.filter((terminal) => terminal.turnedTo !== undefined).map((terminal) => terminal.element);
  if (!terminalUpdates.length) return [];
  const alternate = { ...ctx, terminals, baseScene: withReplaced(ctx.baseScene, terminalUpdates) };
  return trunkCandidates(alternate);
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
  const { plans, issues, errors, warnings, pressure } = verifyRuns(ctx, candidate.runs, candidate.notes, candidate.terminalUpdates);
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
  // A pascal at the index terminal is worth about 50 mm of duct: the fan pays for it all the time.
  const cost = sheet + 0.6 * fittings + 0.8 * flex + 0.05 * pressure.indexPa + 100 * (errors + candidate.obstacleHits) + 2 * warnings + (candidate.penalty ?? 0);
  return { candidate, plans, pressure, errors: errors + candidate.obstacleHits, warnings, cost, issues };
}

// ---- Entry point ----

/** A run and every branch hanging off it (what replacing the run removes). */
export function removalTree(runId: string, scene: readonly HvacElement[]): string[] {
  const out = [runId];
  for (const branch of ductBranchesOf(runId, scene)) out.push(...removalTree(branch.element.id, scene));
  return out;
}

/** Tests and the debug handle: sees each service's context as it is built. */
let contextInspector: ((ctx: ServiceCtx) => void) | null = null;
export function inspectAutoDuctContexts(inspector: ((ctx: ServiceCtx) => void) | null): void {
  contextInspector = inspector;
}

/** Tests: sees each router call (its graph and what it returned). */
let routingInspector: ((entry: { ctx: ServiceCtx; shape: string; factor: number; graph: ReturnType<typeof buildRoutingGraph>; solution: ReturnType<typeof routeTrees>; ms: number }) => void) | null = null;
export function inspectAutoDuctRouting(inspector: typeof routingInspector): void {
  routingInspector = inspector;
}

/** Tests: sees every verified option of each service (router trees, seeds, the reference) before the shortlist. */
type OptionsInspector = (ctx: ServiceCtx, options: readonly ServiceOption[], failures: readonly TreeFailure[]) => void;
let optionsInspector: OptionsInspector | null = null;
export function inspectAutoDuctOptions(inspector: OptionsInspector | null): void {
  optionsInspector = inspector;
}

/** Extra fan pressure of a shortened fan-outlet straight (system effect; practice ≈ half the outlet velocity pressure). */
function fanOutletSystemEffectPa(port: DuctAirPort, airflowM3h: number): number {
  return 0.5 * velocityPressurePa(velocityMs({ widthMm: port.widthMm, heightMm: port.heightMm }, airflowM3h));
}

interface ServiceWork {
  ctx: ServiceCtx;
  base: AutoDuctServiceResult;
  options: ServiceOption[];
  terminals: TerminalCtx[];
}

/** Per terminal: its airflow, neck, the branch size the chosen design gave it and its run. */
function terminalReports(work: ServiceWork, option: ServiceOption): AutoDuctTerminalReport[] {
  const plans = new Map(option.plans.map((plan) => [plan.elementId, plan]));
  return work.terminals.map((terminal) => {
    const runId = option.terminalRuns.get(terminal.element.id) ?? null;
    const first = runId ? plans.get(runId)?.spec.legs[0] : undefined;
    return {
      terminalId: terminal.element.id, label: terminal.element.label || terminal.spec.kind, airflowM3h: Math.round(terminal.airflowM3h),
      fixed: terminal.fixed, neckMm: terminal.neck, neckVelocityMs: Math.round(neckVelocityMs(terminal.spec, terminal.airflowM3h) * 100) / 100,
      branchDiameterMm: first ? Math.round(first.diameterMm ?? first.widthMm) : terminal.branch, runId,
    };
  });
}

function serviceResultFor(work: ServiceWork, option: ServiceOption): AutoDuctServiceResult {
  return {
    ...work.base,
    layout: layoutKindOf(option.label),
    label: option.label,
    shape: option.shape,
    runs: option.runs,
    plans: option.plans,
    pressure: option.pressure,
    trunkSections: option.trunkSections,
    cost: option.cost,
    issues: [...work.base.issues, ...spigotNotes(work, option), ...option.issues],
    terminalUpdates: option.terminalUpdates,
    terminals: terminalReports(work, option),
    sizingReport: option.sizingReport ?? null,
    candidates: work.options.map((candidate) => ({
      layout: layoutKindOf(candidate.label), label: candidate.label, cost: Math.round(candidate.cost.total),
      espPa: Math.round(candidate.espPa * 10) / 10, errors: candidate.errors, warnings: candidate.warnings,
    })),
  };
}

/** One line per terminal whose spigot the option turns: which one, and from which side to which. */
function spigotNotes(work: ServiceWork, option: ServiceOption): AutoDuctIssue[] {
  return option.terminalUpdates.flatMap((element) => {
    const before = work.terminals.find((terminal) => terminal.element.id === element.id);
    const after = readDuctTerminalSpec(element);
    if (!before || !after) return [];
    return [{
      code: 'DU_AUTO_SPIGOT', severity: 'info' as const, service: work.ctx.service,
      message: `Spigot turned: ${element.label || before.spec.kind} ${before.spec.spigotSide} → ${after.spigotSide} (its duct reaches it that way).`,
    }];
  });
}

function layoutKindOf(label: string): AutoDuctLayoutKind {
  const found = (Object.entries(AUTO_DUCT_LAYOUT_LABELS) as Array<[AutoDuctLayoutKind, string]>).find(([, text]) => label.startsWith(text));
  return found ? found[0] : 'tree';
}

/** The options worth combining: clean ones (else the least bad), non-dominated on first cost and pressure, best life-cycle first. */
function shortlist(options: readonly ServiceOption[], pricePerPa: number, limit: number): ServiceOption[] {
  const fewest = Math.min(...options.map((option) => option.errors));
  const pool = options.filter((option) => option.errors === fewest);
  const front = pool.filter((option) => !pool.some((other) => other !== option
    && other.cost.total <= option.cost.total + 1e-6 && other.espPa <= option.espPa + 1e-6
    && (other.cost.total < option.cost.total - 1e-6 || other.espPa < option.espPa - 1e-6)));
  const unique = front.filter((option, index) => front.findIndex((other) => Math.abs(other.cost.total - option.cost.total) < 0.5 && Math.abs(other.espPa - option.espPa) < 0.05) === index);
  const best = unique.sort((a, b) => (a.cost.total + pricePerPa * a.espPa) - (b.cost.total + pricePerPa * b.espPa)).slice(0, limit);
  // The equal-friction reference always comes along (the card shows what the optimiser saves against it).
  const reference = options.find((option) => option.source === 'v1');
  return reference && !best.includes(reference) && limit > 1 ? [...best, reference] : best;
}

function addCosts(parts: readonly DuctCostBreakdown[]): DuctCostBreakdown {
  const out: DuctCostBreakdown = { sheet: 0, fabrication: 0, fittings: 0, install: 0, insulation: 0, flex: 0, dampers: 0, joints: 0, hangers: 0, total: 0 };
  for (const part of parts) for (const key of Object.keys(out) as Array<keyof DuctCostBreakdown>) out[key] += part[key];
  return out;
}

/** The result showing design `index`: its services, runs, pressure and the issues that go with them. */
export function selectAutoDuctDesign(result: AutoDuctResult, index: number): AutoDuctResult {
  const design = result.designs[index];
  if (!design) return result;
  const issues = [...result.baseIssues];
  if (result.maxEspPa !== null && design.requiredEspPa > result.maxEspPa) {
    issues.push({
      code: 'DU_AUTO_ESP', severity: 'warning',
      message: `The ducts need about ${Math.round(design.requiredEspPa)} Pa of external static pressure; ${result.unitLabel} gives at most ${result.maxEspPa} Pa. Enlarge the ducts or shorten the index run.`,
    });
  }
  return {
    ...result,
    selected: index,
    services: [...design.services, ...result.staticServices],
    runs: design.runs,
    terminalUpdates: design.terminalUpdates,
    requiredEspPa: design.requiredEspPa,
    issues,
  };
}

/** The trunk's sections first to last (one entry per change), from a constant-friction report. */
function trunkSectionsOf(report: DuctSystemSizingReport): AutoDuctServiceResult['trunkSections'] {
  const out: AutoDuctServiceResult['trunkSections'] = [];
  for (const section of report.sections) {
    if (section.runId !== report.rootRunId) continue;
    const last = out[out.length - 1];
    if (last && last.widthMm === section.section.widthMm && last.heightMm === section.section.heightMm && last.diameterMm === section.section.diameterMm) continue;
    out.push({ ...section.section, airflowM3h: section.airflowM3h });
  }
  return out;
}

/**
 * A verified option sized again by constant friction at `basis` (the route
 * kept), verified again exactly as the optimiser's own: plans, clashes, walls,
 * pressure, price.
 */
function constantFrictionOption(ctx: ServiceCtx, option: ServiceOption, basis: DuctSystemSizing, terminalAirflows: AutoDuctRequest['terminalAirflows']): ServiceOption {
  const root = option.runs.find((run) => readDuctRunSpec(run)?.start.kind === 'unit-port');
  if (!root) return option;
  const scene = [...withReplaced(ctx.baseScene, option.terminalUpdates), ...option.runs];
  const sized = sizeDuctSystem(scene, root.id, { basis, ...(terminalAirflows ? { terminalAirflows } : {}), verify: false }, ctx.settings);
  const byId = new Map(sized.runs.map((run) => [run.id, run]));
  const runs = option.runs.map((run) => byId.get(run.id) ?? run);
  // The design's own notes stay; the sizing's go with them (the planner's are found again).
  const notes = [...option.issues.filter((issue) => !issue.runId), ...sized.report.issues.filter((issue) => issue.code.startsWith('DU_SIZE_'))];
  const verified = verifyRuns(ctx, runs, notes, option.terminalUpdates);
  const cost = priceDuctPlans(verified.plans, ctx.settings, verified.hangers, verified.straps);
  cost.total += option.design?.penalty ?? 0;
  const report: DuctSystemSizingReport = {
    ...sized.report,
    pressure: verified.pressure,
    terminals: sized.report.terminals.map((terminal) => ({ ...terminal, throttlePa: Math.round(verified.pressure.throttlePa[terminal.terminalId] ?? 0) })),
    issues: verified.issues, errors: verified.errors, warnings: verified.warnings,
  };
  return {
    ...option,
    key: `${option.key}|cf`,
    label: `${option.label.replace(/ \(equal friction\)$/, '')} · constant friction`,
    runs, plans: verified.plans, pressure: verified.pressure, espPa: verified.pressure.indexPa, cost,
    errors: verified.errors, warnings: verified.warnings, issues: verified.issues, trunkSections: trunkSectionsOf(report), sizingReport: report,
  };
}

/** The frontier's picks among designs: the fewest errors, within the fan if any are, then by each measure. */
export function pickAutoDuctDesigns(designs: readonly AutoDuctDesign[], maxEspPa: number | null): AutoDuctResult['picks'] {
  if (!designs.length) return null;
  const fewest = Math.min(...designs.map((design) => design.errors));
  const clean = designs.map((design, index) => ({ design, index })).filter(({ design }) => design.errors === fewest);
  const withinFan = clean.filter(({ design }) => maxEspPa === null || design.requiredEspPa <= maxEspPa + 1e-6);
  const pool = withinFan.length ? withinFan : clean;
  const by = (value: (design: AutoDuctDesign) => number, tie: (design: AutoDuctDesign) => number) => pool.reduce((best, entry) => {
    const a = value(entry.design);
    const b = value(best.design);
    return a < b - 1e-9 || (Math.abs(a - b) <= 1e-9 && tie(entry.design) < tie(best.design)) ? entry : best;
  }).index;
  return {
    cheapest: by((design) => design.firstCost, (design) => design.requiredEspPa),
    lifeCycle: by((design) => design.lifeCycleCost, (design) => design.firstCost),
    quietest: by((design) => design.requiredEspPa, (design) => design.firstCost),
  };
}

/** Issues a constant-friction report finds again (the rest of a service's issues stay). */
const REPORTED_AGAIN = new Set(['DU_AUTO_AIRFLOW', 'DU_TERMINAL_VELOCITY', 'DU_AUTO_ESP', 'DU_AUTO_NO_DATA']);

/** The bases linked at the result's system airflow, with its fan speed and typed airflow. */
export function linkedAutoDuctBases(result: Pick<AutoDuctResult, 'fanSpeed' | 'airflowM3h' | 'airflowSource'>, bases: AutoDuctSizingBases): AutoDuctSizingBases {
  const out: AutoDuctSizingBases = {};
  for (const service of ['supply', 'return'] as const) {
    const basis = bases[service];
    if (!basis) continue;
    out[service] = linkSizingBasis({
      ...basis, fanSpeed: result.fanSpeed, airflowM3h: result.airflowSource === 'entered' ? result.airflowM3h : null,
    }, result.airflowM3h);
  }
  return out;
}

/**
 * A preview design sized again by constant friction at `bases` (the routes
 * kept): each service's runs, plans, pressure, price and issues, from the
 * drawing the preview was made on. Pure.
 */
export function resizeAutoDuctDesign(
  result: AutoDuctResult,
  index: number,
  bases: AutoDuctSizingBases,
  terminalAirflows: AutoDuctRequest['terminalAirflows'],
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
): AutoDuctDesign {
  const design = result.designs[index]!;
  const removed = new Set(result.removeIds);
  const base = withReplaced(scene.filter((element) => !removed.has(element.id)), design.terminalUpdates);
  const linked = linkedAutoDuctBases(result, bases);
  let runs = [...design.runs];
  const services = design.services.map((service): AutoDuctServiceResult => {
    const basis = linked[service.service];
    const root = service.runs.find((run) => readDuctRunSpec(run)?.start.kind === 'unit-port');
    if (!basis || !root) return service;
    const sized = sizeDuctSystem([...base, ...runs], root.id, { basis, ...(terminalAirflows ? { terminalAirflows } : {}) }, settings);
    const byId = new Map(sized.runs.map((run) => [run.id, run]));
    runs = runs.map((run) => byId.get(run.id) ?? run);
    const report = sized.report;
    const after = [...base, ...runs];
    let hangers = 0;
    let straps = 0;
    for (const plan of report.plans) {
      for (const hanger of getDuctSupportPlan(plan, after, settings).hangers) {
        if (hanger.kind === 'strap') straps += 1;
        else hangers += 1;
      }
    }
    const firstLegs = new Map(report.plans.map((plan) => [plan.elementId, plan.spec.legs[0]]));
    return {
      ...service,
      label: service.label.includes('constant friction') ? service.label : `${service.label.replace(/ \(equal friction\)$/, '')} · constant friction`,
      runs: service.runs.map((run) => byId.get(run.id) ?? run),
      plans: report.plans,
      pressure: report.pressure,
      trunkSections: trunkSectionsOf(report),
      cost: priceDuctPlans(report.plans, settings, hangers, straps),
      issues: [...service.issues.filter((issue) => !issue.runId && !REPORTED_AGAIN.has(issue.code) && !issue.code.startsWith('DU_SIZE_')), ...report.issues],
      terminals: service.terminals.map((terminal) => {
        const sizedTerminal = report.terminals.find((entry) => entry.terminalId === terminal.terminalId);
        const first = terminal.runId ? firstLegs.get(terminal.runId) : undefined;
        return sizedTerminal ? {
          ...terminal, airflowM3h: sizedTerminal.airflowM3h, fixed: sizedTerminal.fixed, neckVelocityMs: sizedTerminal.neckVelocityMs,
          branchDiameterMm: first ? Math.round(first.diameterMm ?? first.widthMm) : terminal.branchDiameterMm,
        } : terminal;
      }),
      sizingReport: report,
    };
  });
  const cost = addCosts(services.flatMap((service) => (service.cost ? [service.cost] : [])));
  const requiredEspPa = services.reduce((sum, service) => sum + (service.pressure?.indexPa ?? 0), 0);
  const energyCost = result.pricePerPa * requiredEspPa;
  return {
    ...design,
    label: services.map((service) => service.label).join(' · '),
    services, runs, cost, firstCost: cost.total, requiredEspPa, energyCost, lifeCycleCost: cost.total + energyCost,
    errors: services.reduce((sum, service) => sum + (service.sizingReport?.errors ?? 0), 0),
    warnings: services.reduce((sum, service) => sum + (service.sizingReport?.warnings ?? 0), 0),
  };
}

/** The result with some designs replaced (by index), its picks found again and the shown one kept. */
export function withAutoDuctDesigns(result: AutoDuctResult, replaced: ReadonlyMap<number, AutoDuctDesign>, sizing: AutoDuctSizingBases, terminalAirflowUpdates: HvacElement[]): AutoDuctResult {
  const designs = result.designs.map((design, index) => replaced.get(index) ?? design);
  const next: AutoDuctResult = {
    ...result, designs, sizing: linkedAutoDuctBases(result, sizing), terminalAirflowUpdates,
    picks: pickAutoDuctDesigns(designs, result.maxEspPa),
    // A certificate's model gap compares the optimiser's own sizes, no longer shown.
    certificate: result.certificate ? { ...result.certificate, modelGapPct: null } : null,
  };
  return selectAutoDuctDesign(next, result.selected);
}

/** The store updates that turn terminals' spigots as a design has them (their terminal properties only). */
export function terminalSpigotUpdates(elements: readonly HvacElement[]): Array<{ id: string; updates: Partial<HvacElement> }> {
  return elements.map((element) => ({ id: element.id, updates: { properties: element.properties } }));
}

let generation = 0;
/** Routing rounds the feasibility loop may add to the first (each learns from what failed). */
const FEASIBILITY_ROUNDS = 10;
/** Time one router call may spend repairing conflicts between its runs (ms). */
const ROUTER_REPAIR_MS = 6000;
/** Terminals per group when there are more than the exact search takes (a row, or a run of one). */
const ROUTER_GROUP_SIZE = 4;

export function generateAutoDuct(scene: readonly HvacElement[], request: AutoDuctRequest, settings: DuctDesignSettings): AutoDuctResult {
  const started = Date.now();
  const unit = scene.find((element) => element.id === request.unitId);
  let counter = 0;
  // Unique across calls in the same millisecond (Auto route designs several units in a row).
  const stamp = `${Date.now().toString(36)}${(generation += 1).toString(36)}`;
  const ids = () => `duct-auto-${stamp}-${(counter += 1)}`;
  const shape: AutoDuctShape = request.shape ?? 'optimal';
  const result: AutoDuctResult = {
    unitId: request.unitId, unitLabel: unit?.label || unit?.modelLabel || 'Unit', fanSpeed: request.fanSpeed,
    airflowM3h: null, airflowSource: null, maxEspPa: null, requiredEspPa: null, services: [], runs: [], removeIds: [], terminalUpdates: [], issues: [],
    designs: [], picks: null, selected: 0, pricePerPa: 0, currency: settings.econCurrency, certificate: null, baseIssues: [], staticServices: [],
    sizing: null, terminalAirflowUpdates: [],
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
  result.pricePerPa = energyPricePerPa(airflow, settings);
  // Constant friction: each service's basis, linked at the system airflow (the typed one or the fan speed's).
  const bases: AutoDuctSizingBases = {};
  for (const service of ['supply', 'return'] as const) {
    const basis = request.sizing?.[service];
    if (basis) bases[service] = linkSizingBasis({ ...basis, fanSpeed: request.fanSpeed, airflowM3h: request.airflowM3h && request.airflowM3h > 0 ? request.airflowM3h : null }, airflow);
  }
  result.sizing = Object.keys(bases).length ? bases : null;
  const airflows = request.terminalAirflows;
  result.terminalAirflowUpdates = scene.filter((element) => request.terminalIds.includes(element.id) && isDuctTerminalElement(element))
    .map((element) => terminalWithAirflow(element, airflows)).filter((element) => !scene.includes(element));
  const ports = listAirPorts(scene).filter((port) => port.unitId === unit.id);
  const terminalPorts = listTerminalPorts(scene);
  const requested = scene.filter((element) => request.terminalIds.includes(element.id) && isDuctTerminalElement(element));
  let removed = new Set<string>();
  const work: ServiceWork[] = [];
  /** Runs the services optimised so far will most likely keep (their best life-cycle option): the next service avoids them. */
  const context: HvacElement[] = [];
  let trees = 0;
  let realised = 0;
  /** Every service's trees came from the exact router (within its terminal limit). */
  let exact = true;
  let routerMs = 0;
  let sizingMs = 0;
  /** Feasibility loop: routing rounds after the first, and cuts learnt from the exact checks. */
  let feasibilityRounds = 0;
  let cutsLearnt = 0;
  let grouped = false;
  let timeLimited = false;

  for (const service of ['supply', 'return'] as const) {
    if (!request.services[service]) continue;
    const group = requested.filter((element) => readDuctTerminalSpec(element)?.service === service);
    if (!group.length) continue;
    const serviceResult: AutoDuctServiceResult = {
      service, layout: null, airflowM3h: airflow, runs: [], removeIds: [], terminalUpdates: [], terminals: [], trunkSections: [], plans: [], pressure: null, issues: [], candidates: [],
      label: '', shape, cost: null,
    };
    const port = ports.find((candidate) => candidate.kind === service);
    if (!port) {
      serviceResult.issues.push({ code: 'DU_AUTO_NO_PORT', severity: 'error', service, message: `${result.unitLabel} has no ${service} collar.` });
      result.staticServices.push(serviceResult);
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
      result.staticServices.push(serviceResult);
      continue;
    }
    const removeIds = existing.flatMap((element) => removalTree(element.id, scene));
    serviceResult.removeIds = removeIds;
    removed = new Set([...removed, ...removeIds]);
    const baseScene = [...scene.filter((element) => !removed.has(element.id)), ...context];
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
    if (!free.length) {
      result.staticServices.push(serviceResult);
      continue;
    }
    const frame: Frame = { origin: { x: port.lip.x, y: port.lip.y }, n: port.normal, t: legNormal(port.normal) };
    const shares = shareAirflow(airflow, free.map((element) => ({ id: element.id, spec: readDuctTerminalSpec(terminalWithAirflow(element, airflows))! })));
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
      const placed: TerminalCtx = {
        element, spec, port: tport, lip: toLocal(frame, tport.lip), normal: cardinal(dirToLocal(frame, tport.normal)),
        airflowM3h: share.airflowM3h, fixed: share.fixed, neck, branch,
      };
      return [placed];
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
    // Walls, full height: a duct keeps its clearance off them like any other obstacle.
    for (const wall of request.walls ?? []) {
      obstacles.push({ ...boxToLocal(frame, [wall.startPoint, wall.endPoint], Math.max(1, wall.thickness ?? 100) / 2, wall.id), zMin: -1e6, zMax: 1e6 });
    }
    for (const lane of listNetworkPipeLanes([...baseScene])) {
      for (const segment of lane.segments) {
        obstacles.push({
          ...boxToLocal(frame, [segment.a, segment.b], lane.radiusMm, lane.elementId),
          zMin: Math.min(segment.a.z, segment.b.z) - lane.radiusMm, zMax: Math.max(segment.a.z, segment.b.z) + lane.radiusMm,
        });
      }
    }
    // The spigot sides the tree router may choose from: a symmetric face's sides with room in front (the
    // placed side otherwise).
    for (const terminal of terminals) terminal.variants = spigotVariants(frame, terminal, settings.autoChooseSpigotSide, obstacles);
    const ctx: ServiceCtx = {
      service, unitId: unit.id, frame, port, bottomZ, terminals, airflowM3h: total, baseScene, settings, obstacles, maxHeightMm,
      ...(request.walls?.length ? { walls: request.walls } : {}),
      construction: settings.defaultConstruction, ids,
    };
    contextInspector?.(ctx);
    // Candidate trees: the v1 layouts (plenum, trunks), then sized exactly and verified.
    const candidates: Candidate[] = [];
    if (request.layout !== 'trunk') {
      const plenum = plenumCandidate(ctx);
      if (plenum) candidates.push(plenum);
    }
    if (request.layout !== 'plenum') candidates.push(...trunkCandidates(ctx), ...facingTrunkCandidates(ctx));
    // The obstacle-aware router can find routes that the legacy rectangular
    // layouts cannot seed (including round mains in a shallow ceiling void).
    if (!candidates.length && request.layout === 'plenum') {
      serviceResult.issues.push({ code: 'DU_AUTO_NO_LAYOUT', severity: 'error', service,
        message: 'No plenum layout fits these terminals (at most four, two per face, within about 4 m); try Trunk.' });
      result.staticServices.push(serviceResult);
      continue;
    }
    const seeds: ServiceDesign[] = [];
    for (const candidate of candidates) {
      const design = designFromRuns(candidate.terminals ? { ...ctx, terminals: candidate.terminals } : ctx, candidate.runs, AUTO_DUCT_LAYOUT_LABELS[candidate.layout], exitLengthMm(port), 0, candidate.notes);
      if (!design) continue;
      design.kind = candidate.layout;
      if (candidate.penalty) design.pressurePenaltyPa = fanOutletSystemEffectPa(port, total);
      seeds.push(design);
    }
    // The tree router's own trees, at two prices of fan pressure (the sizing then prices it exactly).
    // Optimal routes with each shape's catalogue too, so it never does worse than either alone.
    const routers: Array<{ shape: 'rect' | 'round'; model: SizingModel; graph: ReturnType<typeof buildRoutingGraph>; turnOutletMm: number }> = [];
    // Past the exact limit the terminals are routed in groups (exact within each, not over every tree).
    const groups = terminals.length > settings.autoExactTerminals ? groupTerminals(terminals, ROUTER_GROUP_SIZE) : undefined;
    if (groups) { grouped = true; exact = false; }
    if (request.layout !== 'plenum' && terminals.length <= GROUPED_MAX_TERMINALS) {
      const routerStarted = Date.now();
      for (const routeShape of shape === 'optimal' ? (['rect', 'round'] as const) : [shape === 'rect' ? 'rect' as const : 'round' as const]) {
        const model = new SizingModel(ctx, routeShape, airflow);
        // The straight off the collar must hold the connector, the collar transition and a take-off window.
        const collar: DuctLeg = { widthMm: port.widthMm, heightMm: port.heightMm };
        const connector = settings.flexibleConnectorAtUnit ? settings.connectorFabricMm + 2 * settings.connectorMetalMm : 0;
        const trunkOptions = model.trunkOptions(total);
        const transitions = trunkOptions.map((leg) => model.transitionLengthMm(collar, leg).lengthMm);
        const minOutletMm = connector + (transitions.length ? Math.min(...transitions) : 0) + 300;
        // Turning at the root's end also needs the elbow's setback past the transition.
        const turnOutletMm = connector + (trunkOptions.length
          ? Math.min(...trunkOptions.map((leg, index) => transitions[index]! + model.elbowSetbackMm(leg) + settings.elbowNeckMm)) : 0) + 50;
        routers.push({ shape: routeShape, model, graph: buildRoutingGraph(ctx, model, exitLengthMm(port), minOutletMm, turnOutletMm), turnOutletMm });
      }
      routerMs += Date.now() - routerStarted;
    } else {
      exact = false;
    }
    // One routing round: every router at both prices of pressure, with what earlier rounds forbade.
    const cutsByRouter = new Map(routers.map((router) => [router.shape, emptyCuts()]));
    // Per router and price: the last solve's layers, reused where a round's cuts leave them unchanged.
    const memos = new Map<string, LayerMemo>();
    // One routing round: every router at the given prices of fan pressure (× the life-cycle price), with
    // what earlier rounds forbade.
    const routeRound = (factors: readonly number[], only: ReadonlySet<'rect' | 'round'>, deadline: number): ServiceDesign[] => {
      const routerStarted = Date.now();
      const out: ServiceDesign[] = [];
      for (const router of routers) {
        if (!only.has(router.shape)) continue;
        for (const factor of factors) {
          const memoKey = `${router.shape}:${factor}`;
          if (!memos.has(memoKey) && layerMemoWorthKeeping(router.graph, terminals.length, groups)) memos.set(memoKey, newLayerMemo());
          const solution = routeTrees(ctx, router.model, router.graph, {
            lambda: factor * router.model.pricePerPa, label: AUTO_DUCT_LAYOUT_LABELS.tree, fanOutletMm: exitLengthMm(port),
            shortOutletPenaltyPa: fanOutletSystemEffectPa(port, total), maxTerminals: settings.autoExactTerminals,
            rootTurnMinMm: router.turnOutletMm, cuts: cutsByRouter.get(router.shape)!, ...(memos.has(memoKey) ? { memo: memos.get(memoKey)! } : {}), ...(groups ? { groups } : {}),
            // Conflict repairs stop at the time budget, and after a few seconds in any one call.
            deadline: Math.min(deadline, Date.now() + ROUTER_REPAIR_MS),
          });
          routingInspector?.({ ctx, shape: router.shape, factor, graph: router.graph, solution, ms: solution ? Math.round(solution.seconds * 1000) : -1 });
          if (solution) out.push(...solution.designs.map((design) => ({ ...design, router: router.shape })));
        }
      }
      routerMs += Date.now() - routerStarted;
      return out;
    };
    // Size, build and verify: Optimal with the mixed catalogue and each shape's own, keeping every verified option.
    let options: ServiceOption[] = [];
    const failures: TreeFailure[] = [];
    const sizeTrees = (designs: readonly ServiceDesign[], shapes: readonly ShapeMode[]): { options: ServiceOption[]; failures: TreeFailure[]; failuresByShape: Map<ShapeMode, TreeFailure[]> } => {
      const sizingStarted = Date.now();
      const round = { options: [] as ServiceOption[], failures: [] as TreeFailure[], failuresByShape: new Map<ShapeMode, TreeFailure[]>() };
      for (const sizeShape of shapes) {
        // Each pure-shape pass must keep the pool that its standalone mode
        // searches. The verifier intentionally stops after a few clean trees;
        // trees from the other router must not crowd those options out.
        const pool = shape === 'optimal' && sizeShape !== 'optimal'
          ? designs.filter((design) => design.source === 'seed' || design.router === sizeShape)
          : designs;
        const optimised = optimiseService(ctx, pool, sizeShape, airflow, result.maxEspPa ?? 150);
        trees += optimised.frontiers;
        realised += optimised.realised;
        round.options.push(...optimised.options);
        round.failures.push(...optimised.failures);
        round.failuresByShape.set(sizeShape, optimised.failures);
      }
      sizingMs += Date.now() - sizingStarted;
      options.push(...round.options);
      failures.push(...round.failures);
      return round;
    };
    // Retain each pure catalogue's own bounded search before mixed sizing.
    // Its cuts and repair eligibility use its own node IDs and failures;
    // optional pressure-price variants use session time within the shared
    // overall unit deadline.
    const allShapes: readonly ShapeMode[] = shape === 'optimal' ? ['optimal', 'rect', 'round'] : [shape];
    const firstTrees: ServiceDesign[] = [];
    const searchedTrees: ServiceDesign[] = [];
    const routerCost = (design: ServiceDesign | undefined) => design?.modelCost ?? Number.POSITIVE_INFINITY;
    for (const router of routers) {
      const sessionStarted = Date.now();
      const deadline = started + settings.autoTimeBudgetMs;
      const only = new Set([router.shape]);
      const initial = routeRound([1], only, deadline);
      if (!initial.length && Date.now() > deadline) timeLimited = true;
      firstTrees.push(...initial);
      searchedTrees.push(...initial);
      let round = sizeTrees([...seeds, ...initial], [router.shape]);
      for (let pass = 1; pass <= FEASIBILITY_ROUNDS; pass += 1) {
        const own = (option: ServiceOption) => option.source === 'steiner' && option.design?.router === router.shape && option.shape === router.shape;
        const bestClean = Math.min(...options.filter((option) => own(option) && option.errors === 0).map((option) => routerCost(option.design)));
        const failedOptions = round.options.filter((option) => own(option) && option.errors > 0);
        const failedTrees = (round.failuresByShape.get(router.shape) ?? []).filter((failure) => failure.design.router === router.shape);
        const bestFailed = Math.min(...failedTrees.map((failure) => routerCost(failure.design)), ...failedOptions.map((option) => routerCost(option.design)));
        if (!(bestFailed < bestClean - 1e-6)) break;
        if (Date.now() > deadline) { timeLimited = true; break; }
        const cuts = cutsByRouter.get(router.shape)!;
        const learnt = cutsFromFailures(failedTrees, cuts) + cutsFromErrors(failedOptions, cuts, ctx);
        if (!learnt) break;
        feasibilityRounds += 1;
        cutsLearnt += learnt;
        const routed = routeRound([1], only, deadline);
        if (!routed.length) { if (Date.now() > deadline) timeLimited = true; break; }
        searchedTrees.push(...routed);
        round = sizeTrees(routed, [router.shape]);
      }
      if (Date.now() < deadline && Date.now() - sessionStarted < settings.autoTimeBudgetMs / 4) {
        const varied = routeRound([0.5, 2], only, deadline);
        searchedTrees.push(...varied);
        if (varied.length) sizeTrees(varied, [router.shape]);
      }
    }
    if (routers.length && !firstTrees.length) exact = false;
    if (!routers.length) sizeTrees(seeds, allShapes);
    else if (shape === 'optimal') sizeTrees([...seeds, ...searchedTrees], ['optimal']);
    if (shape !== 'round' && candidates.length) {
      // The reference: the v1 layout as it sizes it (equal friction, rectangular). A verified option like
      // any other, so the optimiser's choice is never worse than it.
      const best = candidates.map((candidate) => score(ctx, candidate)).sort((a, b) => a.errors - b.errors || a.cost - b.cost)[0]!;
      const verified = verifyRuns(ctx, best.candidate.runs, best.candidate.notes, best.candidate.terminalUpdates);
      options = [...options, {
        key: `v1:${best.candidate.layout}`, label: `${AUTO_DUCT_LAYOUT_LABELS[best.candidate.layout]} (equal friction)`, source: 'v1', shape: 'rect',
        runs: best.candidate.runs, plans: verified.plans, terminalRuns: best.candidate.terminalRuns, trunkSections: best.candidate.trunkSections,
        pressure: verified.pressure, espPa: verified.pressure.indexPa,
        cost: priceDuctPlans(verified.plans, settings, verified.hangers, verified.straps), errors: best.errors, warnings: best.warnings, issues: best.issues,
        modelCost: 0, modelPressurePa: verified.pressure.indexPa, exact: false, terminalUpdates: best.candidate.terminalUpdates ?? [],
      }];
    }
    // Constant friction: every verified route sized again at the designer's basis, and verified again.
    const basis = bases[service];
    if (basis) options = options.map((option) => constantFrictionOption(ctx, option, basis, airflows));
    // Nothing clean: why, from what failed most often across the trees tried.
    if (options.length && Math.min(...options.map((option) => option.errors)) > 0) {
      // No tree at all: first, whether something in front of the collar is why.
      const blocked = routers.length && !firstTrees.length ? explainBlockedCollar(ctx, routers[0]!.model) : null;
      serviceResult.issues.push(...(blocked ? [blocked] : []), ...explainNoCleanDesign(ctx, failures, options).slice(0, blocked ? 1 : 2));
    }
    if (!options.length) {
      serviceResult.issues.push({
        code: 'DU_AUTO_NO_LAYOUT', severity: 'error', service,
        message: shape === 'round'
          ? 'No buildable round layout for these terminals: the square-to-round off the collar and the round-main taps need more straight than the room gives. Try Optimal or Rectangular.'
          : 'No buildable layout for these terminals.',
      });
      result.staticServices.push(serviceResult);
      continue;
    }
    optionsInspector?.(ctx, options, failures);
    work.push({ ctx, base: serviceResult, options, terminals });
    const bestOption = shortlist(options, result.pricePerPa, 1)[0];
    if (bestOption) context.push(...bestOption.runs);
    result.removeIds.push(...removeIds);
  }

  if (!work.length && !result.staticServices.length) {
    result.issues.push({ code: 'DU_AUTO_NO_LAYOUT', severity: 'error', message: 'Select the diffusers and grilles this unit serves (supply to diffusers, return to grilles).' });
  }
  result.baseIssues = [...result.issues];
  // Whole designs: every combination of the services' shortlisted options, re-checked for clashes between them.
  let combos: ServiceOption[][] = [[]];
  for (const entry of work) combos = combos.flatMap((prefix) => shortlist(entry.options, result.pricePerPa, 5).map((option) => [...prefix, option]));
  if (!work.length) combos = [];
  const contextIds = new Set(context.map((run) => run.id));
  result.designs = combos.map((parts, index) => {
    const services = parts.map((option, k) => serviceResultFor(work[k]!, option));
    const runs = parts.flatMap((option) => option.runs);
    const terminalUpdates = parts.flatMap((option) => option.terminalUpdates);
    let errors = parts.reduce((sum, option) => sum + option.errors, 0);
    // A later service was checked against the earlier one's best option; another pairing is checked here.
    if (parts.length > 1 && parts.slice(0, -1).some((option) => option.runs.some((run) => !contextIds.has(run.id)))) {
      const ids = parts.map((option) => new Set(option.runs.map((run) => run.id)));
      const all = [...withReplaced(scene.filter((element) => !removed.has(element.id)), terminalUpdates), ...runs];
      for (const clash of findDuctClashes(all, settings, listNetworkPipeLanes(all))) {
        const a = ids.findIndex((set) => set.has(clash.ductId));
        const b = ids.findIndex((set) => set.has(clash.otherId));
        if (a >= 0 && b >= 0 && a !== b) errors += 1;
      }
    }
    const cost = addCosts(parts.map((option) => option.cost));
    const requiredEspPa = parts.reduce((sum, option) => sum + option.espPa, 0);
    const energyCost = result.pricePerPa * requiredEspPa;
    const modelLifeCycleCost = parts.reduce((sum, option) => sum + option.modelCost + result.pricePerPa * option.modelPressurePa, 0);
    return {
      key: `d${index}`, label: parts.map((option) => option.label).join(' · '), services, runs, terminalUpdates, cost, firstCost: cost.total,
      requiredEspPa, energyCost, lifeCycleCost: cost.total + energyCost, errors, warnings: parts.reduce((sum, option) => sum + option.warnings, 0),
      modelLifeCycleCost,
    };
  });
  if (result.designs.length) {
    result.picks = pickAutoDuctDesigns(result.designs, result.maxEspPa)!;
    const chosen = result.designs[result.picks.lifeCycle]!;
    // The model's gap means something only for the optimiser's own sizes.
    const modelled = !result.sizing && chosen.services.every((service) => service.label && !service.label.endsWith('(equal friction)'));
    result.certificate = {
      exact: exact && !timeLimited, trees, realised, solveMs: Date.now() - started, routerMs, sizingMs, rounds: feasibilityRounds, cuts: cutsLearnt,
      grouped, timeLimited,
      modelGapPct: modelled && chosen.modelLifeCycleCost > 0 ? Math.round(((chosen.lifeCycleCost - chosen.modelLifeCycleCost) / chosen.modelLifeCycleCost) * 1000) / 10 : null,
    };
    return selectAutoDuctDesign(result, result.picks.lifeCycle);
  }
  result.services = [...result.staticServices];
  return result;
}
