/**
 * What a condensate piece's card offers, and what each choice would do.
 *
 * Every option is one edit of the drain's network, solved again by the planner
 * along its routes — the micro-editing session the drain handles use — so what
 * is previewed is exactly what is applied, ids kept:
 *  - a run one or two catalogue sizes up, or back to its automatic size;
 *  - the network's design fall (the minimum it may fall at, raised);
 *  - a run kept at or below a level; a pumped unit's riser height;
 *  - a leg moved sideways; a branch's wye slid along its main;
 *  - a bend added at a leg's middle, or taken out;
 *  - a rodding eye or an air vent added, or taken out;
 *  - a termination's kind, its trap or its inlet level (the network solved
 *    again round the changed termination).
 * Each evaluation is the engine's verdict and its line ("Fall 1:50 · margin
 * 120 mm"), or its reason for refusing; the change in the network's head
 * margin; and the drainage checks it would newly fail.
 *
 * PURE: elements in, options and evaluations out (cached per drawing and edit).
 */
import type { HvacElement, Point2D } from '../../../../types';
import type { SegmentEvaluationLike, SegmentOptionLike } from '../segments/segmentProvider';

import {
  createCondensateEditSession,
  isUnitBranchSpec,
  type CondensateEdit,
  type CondensateEditContext,
  type CondensateEditStatus,
  type CondensateFittingEdit,
} from './condensateEditing';
import { condensateSessionFor } from './condensatePieceFigures';
import { condensatePieceMidpoint, condensatePieceSpan, type CondensatePiece, type CondensateRun } from './condensatePieces';
import { getCondensatePipeSystem } from './condensatePipeCatalog';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { fixedPrefixLength, insertRouteVertex, offsetRouteLeg, removeRouteVertex, slideWyeRoutes, wyeSlideFor, type PlanRoute } from './condensateRouteOps';
import { formatFallRatio } from './condensateSettings';
import {
  getCondensateOwnership,
  readCondensateGullySpec,
  type CondensateTerminalTrap,
  type CondensateTerminationKind,
} from './condensateTypes';
import { validateCondensateNetwork } from './condensateValidation';

export type CondensateOptionGroup =
  | 'size' | 'fall' | 'level-cap' | 'lift' | 'offset' | 'wye' | 'add-bend' | 'remove-bend' | 'eye' | 'vent'
  | 'termination' | 'trap' | 'inlet';

/** A network edit with its plan routes as plain lists (an option is compared and cached by its edit). */
export interface CondensateNetworkEdit extends Omit<CondensateEdit, 'routes'> {
  routes?: Array<[string, PlanRoute]>;
}

export type CondensatePieceEdit =
  | { kind: 'network'; networkId: string; edit: CondensateNetworkEdit }
  | { kind: 'gully'; networkId: string; gullyId: string; properties: Record<string, unknown> };

export type CondensateOptionGlyph = 'size-up' | 'size' | 'fall' | 'level' | 'lift' | 'offset' | 'wye' | 'add-bend' | 'remove-bend'
  | 'eye' | 'vent' | 'gully' | 'trap' | 'auto';

export interface CondensateSegmentOption extends SegmentOptionLike {
  group: CondensateOptionGroup;
  glyph: CondensateOptionGlyph;
  edit: CondensatePieceEdit;
}

export interface CondensateOptionEvaluation extends SegmentEvaluationLike {
  status: CondensateEditStatus;
  /** The engine's own line: the network's fall and head margin, or why it cannot. */
  verdict: string;
  /** The network's least head margin after it (mm), and its change. */
  marginMm: number | null;
  deltaMarginMm: number | null;
}

// ---------------------------------------------------------------------------------------------------- evaluating

/** The undo step an option makes, named for what it does. */
function actionOf(option: CondensateSegmentOption): string {
  switch (option.group) {
    case 'size': return option.id === 'size:auto' ? 'Drain size back to automatic' : `Drain size ${option.title}`;
    case 'fall': return option.id === 'fall:auto' ? 'Drain fall back to the project\'s' : `Drain fall ${option.title}`;
    case 'level-cap': return option.id === 'level-cap:auto' ? 'Drain level limit removed' : 'Drain level limit';
    case 'lift': return option.id === 'lift:auto' ? 'Riser height automatic' : `Riser height ${option.title.replace(/ mm$/, '')} mm`;
    case 'offset': return 'Move drain leg';
    case 'wye': return 'Slide drain wye';
    case 'add-bend': return 'Add drain bend';
    case 'remove-bend': return 'Remove drain bend';
    case 'eye': return option.id === 'eye:remove' ? 'Remove rodding eye' : 'Add rodding eye';
    case 'vent': return option.id === 'vent:remove' ? 'Remove air vent' : 'Add air vent';
    case 'termination': return `Termination: ${option.title}`;
    case 'trap': return `Termination trap: ${option.title}`;
    case 'inlet': return 'Termination level';
    default: return option.title;
  }
}

const EVALUATION_CACHE = new WeakMap<readonly HvacElement[], Map<string, CondensateOptionEvaluation>>();
const ISSUE_CACHE = new WeakMap<readonly HvacElement[], Set<string>>();

const issueKey = (issue: { code: string; entityId?: string }) => `${issue.code}|${issue.entityId ?? ''}`;

function issuesBefore(scene: readonly HvacElement[], context: CondensateEditContext): Set<string> {
  let keys = ISSUE_CACHE.get(scene);
  if (!keys) {
    keys = new Set(validateCondensateNetwork(scene, { settings: context.settings, routingSettings: context.routingSettings }).issues
      .filter((issue) => issue.level === 'error' || issue.level === 'warning').map(issueKey));
    ISSUE_CACHE.set(scene, keys);
  }
  return keys;
}

const leastMargin = (units: ReadonlyArray<{ headMarginMm: number }> | undefined) => (units?.length ? Math.min(...units.map((unit) => unit.headMarginMm)) : null);

/** What an option would do to the drawing (cached per drawing and edit). */
export function evaluateCondensateOption(scene: readonly HvacElement[], option: CondensateSegmentOption, context: CondensateEditContext): CondensateOptionEvaluation {
  let byOption = EVALUATION_CACHE.get(scene);
  if (!byOption) {
    byOption = new Map();
    EVALUATION_CACHE.set(scene, byOption);
  }
  const cacheKey = `${option.id}|${JSON.stringify(option.edit)}`;
  const cached = byOption.get(cacheKey);
  if (cached) return cached;
  const refused = (message: string, status: CondensateEditStatus = 'invalid'): CondensateOptionEvaluation => ({
    optionId: option.id, refused: message, updates: [], action: actionOf(option), notes: [], newIssues: [], status, verdict: message, marginMm: null, deltaMarginMm: null,
  });
  let evaluation: CondensateOptionEvaluation;
  if (option.disabledReason) evaluation = refused(option.disabledReason);
  else {
    try {
      evaluation = solveOption(scene, option, context, refused);
    } catch (error) {
      evaluation = refused(`The network could not be solved: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  byOption.set(cacheKey, evaluation);
  return evaluation;
}

function solveOption(scene: readonly HvacElement[], option: CondensateSegmentOption, context: CondensateEditContext,
  refused: (message: string, status?: CondensateEditStatus) => CondensateOptionEvaluation): CondensateOptionEvaluation {
  const edit = option.edit;
  const session = condensateSessionFor(scene, edit.networkId, context);
  if (!session) return refused('This drain is no longer part of a generated network.');
  const before = leastMargin(session.solve({}, { markEdited: false }).generation?.perUnit);
  let result;
  let gullyUpdate: HvacElement | null = null;
  if (edit.kind === 'gully') {
    const gully = scene.find((candidate) => candidate.id === edit.gullyId);
    if (!gully) return refused('The termination is no longer in the drawing.');
    gullyUpdate = { ...gully, properties: { ...gully.properties, ...edit.properties } };
    const changed = scene.map((candidate) => (candidate.id === gully.id ? gullyUpdate! : candidate));
    const around = createCondensateEditSession(changed, edit.networkId, context);
    if (!around) return refused('This drain is no longer part of a generated network.');
    result = around.solve({}, { markEdited: false });
  } else {
    const { routes, ...rest } = edit.edit;
    result = session.solve({ ...rest, ...(routes ? { routes: new Map(routes) } : {}) });
  }
  if (!result.ok) return refused(result.message, result.status);
  const updates = gullyUpdate ? [gullyUpdate, ...result.updates] : result.updates;
  const removed = new Set(result.removeIds);
  const replaced = new Map(updates.map((element) => [element.id, element]));
  const after = [...scene.filter((element) => !removed.has(element.id)).map((element) => replaced.get(element.id) ?? element), ...result.add];
  const had = issuesBefore(scene, context);
  const newIssues = validateCondensateNetwork(after, { settings: context.settings, routingSettings: context.routingSettings }).issues
    .filter((issue) => (issue.level === 'error' || issue.level === 'warning') && !had.has(issueKey(issue)))
    .map((issue) => ({ severity: issue.level, code: issue.code, message: issue.message }));
  const margin = leastMargin(result.generation?.perUnit);
  return {
    optionId: option.id, updates, add: result.add, removeIds: result.removeIds, action: actionOf(option), notes: [], newIssues,
    status: result.status, verdict: result.message, marginMm: margin, deltaMarginMm: margin !== null && before !== null ? margin - before : null,
  };
}

// ---------------------------------------------------------------------------------------------------- the options

/** Falls offered for the network (%). */
export const FALL_STEPS_PERCENT = [1, 1.25, 1.5, 2, 2.5];
/** Riser heights offered (mm), up to the pump's head. */
const LIFT_STEPS_MM = [300, 450, 600, 750, 900];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const planDistance = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);

/** The route segment a leg lies on: the one whose ends are its plan ends (the model's tidied route). */
function legSegment(route: PlanRoute, piece: CondensatePiece): number | null {
  let best: { index: number; error: number } | null = null;
  for (let index = 0; index < route.length - 1; index += 1) {
    const error = planDistance(route[index]!, piece.from) + planDistance(route[index + 1]!, piece.to);
    if (!best || error < best.error) best = { index, error };
  }
  return best && best.error < 20 ? best.index : null;
}

/** A pipe's own fitting edits, as stored (the session replaces a pipe's list whole). */
function storedFittingEdits(element: HvacElement): CondensateFittingEdit[] {
  return Array.isArray(element.properties.fittingEdits) ? (element.properties.fittingEdits as CondensateFittingEdit[]) : [];
}

/** A piece's options. `routes` are the network's plan routes, as its edit session reads them. */
export function condensatePieceOptions(
  scene: readonly HvacElement[],
  element: HvacElement,
  run: CondensateRun,
  piece: CondensatePiece,
  context: CondensateEditContext,
): CondensateSegmentOption[] {
  const networkId = getCondensateOwnership(element)?.networkId;
  if (!networkId) return [];
  const session = condensateSessionFor(scene, networkId, context);
  const route = session?.model.routes.get(element.id);
  const spec = run.spec;
  const options: CondensateSegmentOption[] = [];
  const locked = spec.locked ? { disabledReason: 'This run is locked. Unlock it to change its network.' } : {};
  const network = (edit: CondensateNetworkEdit): CondensatePieceEdit => ({ kind: 'network', networkId, edit });
  const prefix = fixedPrefixLength(isUnitBranchSpec(spec));
  const stretch = piece.kind === 'leg' || piece.kind === 'connection' || piece.kind === 'riser' || piece.kind === 'bend' || piece.kind === 'end';

  // ---- Size: up the catalogue, or back to automatic.
  if (stretch) {
    const system = getCondensatePipeSystem(spec.pipeSystem);
    const floor = finite(element.properties.minOuterDiameterMm) ? element.properties.minOuterDiameterMm : null;
    options.push({
      id: `size:${spec.nominalSize}`, group: 'size', glyph: 'size', title: `CD ${spec.nominalSize}`, detail: `${system.label} · its size now`,
      edit: network({}), current: true,
    });
    for (const size of system.sizes.filter((candidate) => candidate.outerDiameterMm > spec.outerDiameterMm + 0.5).slice(0, 2)) {
      options.push({
        id: `size:${size.nominalSize}`, group: 'size', glyph: 'size-up', title: `CD ${size.nominalSize}`,
        detail: `Ø${size.outerDiameterMm} · bore ${size.innerDiameterMm} mm · this run, and what follows it never smaller`,
        edit: network({ minOuterDiameterMm: { [element.id]: size.outerDiameterMm } }), ...locked,
      });
    }
    if (floor !== null) {
      options.push({
        id: 'size:auto', group: 'size', glyph: 'auto', title: 'Automatic size', detail: 'the smallest size its flow and its units allow',
        edit: network({ minOuterDiameterMm: { [element.id]: null } }), ...locked,
      });
    }
  }

  // ---- A leg: the network's fall, a level it keeps under, sideways, a bend, a rodding eye, an air vent.
  if (piece.kind === 'leg') {
    const stored = scene.map((candidate) => candidate.properties.condensateNetwork && getCondensateOwnership(candidate)?.networkId === networkId
      ? candidate.properties.designFallPercent : undefined).find(finite);
    for (const fall of FALL_STEPS_PERCENT) {
      const current = finite(stored) ? Math.abs(stored - fall) < 1e-6 : false;
      options.push({
        id: `fall:${fall}`, group: 'fall', glyph: 'fall', title: `${fall} %`,
        detail: `${formatFallRatio(fall)} at least · the whole network`, edit: network({ fallPercent: fall }), ...(current ? { current: true } : {}), ...locked,
      });
    }
    if (finite(stored)) {
      options.push({ id: 'fall:auto', group: 'fall', glyph: 'auto', title: 'Project fall', detail: 'the drainage settings\' falls', edit: network({ fallPercent: null }), ...locked });
    }
    const top = Math.max(...run.nodes.map((node) => node.z));
    for (const drop of [50, 100, 200]) {
      options.push({
        id: `level-cap:${drop}`, group: 'level-cap', glyph: 'level', title: `−${drop}`,
        detail: `the run kept ${drop} mm lower (at or below ${Math.round(top - drop)} mm)`, edit: network({ levelCapMm: { [element.id]: Math.round(top - drop) } }), ...locked,
      });
    }
    if (finite(element.properties.levelCapMm)) {
      options.push({ id: 'level-cap:auto', group: 'level-cap', glyph: 'auto', title: 'No level limit', detail: 'as high as its fall allows', edit: network({ levelCapMm: { [element.id]: null } }), ...locked });
    }
    const segment = route ? legSegment(route, piece) : null;
    if (route && segment !== null && segment >= prefix - 1) {
      const a = route[segment]!;
      const b = route[segment + 1]!;
      const length = planDistance(a, b);
      if (length > 1) {
        const across = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
        for (const shift of [-200, -100, 100, 200]) {
          const way = screenWay({ x: across.x * Math.sign(shift), y: across.y * Math.sign(shift) });
          options.push({
            id: `offset:${shift}`, group: 'offset', glyph: 'offset', title: `${way.arrow} ${Math.abs(shift)}`, detail: `${Math.abs(shift)} mm ${way.words}`,
            edit: network({ routes: [[element.id, offsetRouteLeg(route, segment, { x: across.x * shift, y: across.y * shift }, prefix)]] }), ...locked,
          });
        }
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        options.push({
          id: 'add-bend', group: 'add-bend', glyph: 'add-bend', title: 'A bend at its middle', detail: 'to drag the leg round something',
          edit: network({ routes: [[element.id, insertRouteVertex(route, segment, middle, prefix)]] }), ...locked,
        });
      }
    }
    const middle = condensatePieceMidpoint(piece);
    options.push({
      id: 'eye:add', group: 'eye', glyph: 'eye', title: 'A rodding eye here', detail: 'access to clear the run',
      edit: network({ fittingEdits: { [element.id]: [...storedFittingEdits(element), { action: 'add', kind: 'cleanout', point: { x: middle.x, y: middle.y } }] } }), ...locked,
    });
    if (spec.segmentRole === 'main' && piece.ordinal === 1 && !spec.fittings.some((fitting) => fitting.kind === 'air-vent')) {
      const head = run.nodes[0]!;
      options.push({
        id: 'vent:add', group: 'vent', glyph: 'vent', title: 'An air vent at its head', detail: 'lets a pumped main drain freely',
        edit: network({ fittingEdits: { [element.id]: [...storedFittingEdits(element), { action: 'add', kind: 'air-vent', point: { x: head.x, y: head.y } }] } }), ...locked,
      });
    }
  }

  // ---- A bend: taken out.
  if (piece.kind === 'bend' && route && piece.point) {
    const index = route.findIndex((point) => planDistance(point, piece.point!) < 2);
    if (index >= 0) {
      const removable = index >= prefix && index < route.length - 1;
      options.push({
        id: 'remove-bend', group: 'remove-bend', glyph: 'remove-bend', title: 'Take this bend out', detail: 'its two legs made one',
        edit: network({ routes: [[element.id, removeRouteVertex(route, index, prefix)]] }),
        ...(removable ? locked : { disabledReason: 'This corner belongs to the unit connection or the joint; move those with their own handles.' }),
      });
    }
  }

  // ---- A riser: its height.
  if (piece.kind === 'riser' && spec.drainStart?.unitId) {
    const unitId = spec.drainStart.unitId;
    const unit = scene.find((candidate) => candidate.id === unitId);
    const head = unit ? getIndoorUnitDrainPort(unit, context.settings)?.pumpMaxLiftMm ?? context.settings.defaultPumpMaxLiftMm : context.settings.defaultPumpMaxLiftMm;
    for (const lift of LIFT_STEPS_MM.filter((value) => value <= head)) {
      options.push({
        id: `lift:${lift}`, group: 'lift', glyph: 'lift', title: `${lift}`, detail: `at most ${lift} mm up (the pump raises ${Math.round(head)} mm)`,
        edit: network({ liftLimitMm: { [unitId]: lift } }), ...(Math.abs(piece.lengthMm - lift) < 1 ? { current: true } : {}), ...locked,
      });
    }
    if (finite(element.properties.riserLiftLimitMm)) {
      options.push({ id: 'lift:auto', group: 'lift', glyph: 'auto', title: 'Automatic', detail: 'as high as the fall needs', edit: network({ liftLimitMm: { [unitId]: null } }), ...locked });
    }
  }

  // ---- How it ends: a wye slid along its main.
  if (piece.kind === 'end' && piece.fittings.some((fitting) => fitting.kind === 'wye') && session) {
    const slide = wyeSlideFor(element, session.model.pipes, session.model.routes);
    if (slide) {
      const [p, q] = slide.line;
      const length = planDistance(p, q);
      const direction = length > 1 ? { x: (q.x - p.x) / length, y: (q.y - p.y) / length } : null;
      for (const shift of [-300, -150, 150, 300]) {
        if (!direction) break;
        const routes = slideWyeRoutes(session.model, element.id, shift, prefix);
        const way = screenWay({ x: direction.x * Math.sign(shift), y: direction.y * Math.sign(shift) });
        options.push({
          id: `wye:${shift}`, group: 'wye', glyph: 'wye', title: `${way.arrow} ${Math.abs(shift)}`, detail: `${Math.abs(shift)} mm ${shift > 0 ? 'downstream' : 'upstream'} along its main`,
          edit: network({ routes: routes ? [...routes] : [] }),
          ...(routes ? locked : { disabledReason: `The main has no room to slide the wye ${Math.abs(shift)} mm that way.` }),
        });
      }
    }
  }

  // ---- A fitting: taken out.
  if ((piece.kind === 'eye' || piece.kind === 'vent') && piece.point) {
    const kind = piece.kind === 'eye' ? 'cleanout' : 'air-vent';
    options.push({
      id: `${piece.kind}:remove`, group: piece.kind, glyph: piece.kind, title: piece.kind === 'eye' ? 'Take this rodding eye out' : 'Take this air vent out',
      detail: 'the run stays as it is', edit: network({ fittingEdits: { [element.id]: [...storedFittingEdits(element), { action: 'remove', kind, point: { x: piece.point.x, y: piece.point.y } }] } }), ...locked,
    });
  }

  // ---- A termination: its kind, its trap; its inlet level is the Edit tab's own field.
  if (piece.kind === 'termination' && spec.drainEnd?.gullyId) {
    const gullyId = spec.drainEnd.gullyId;
    const gully = scene.find((candidate) => candidate.id === gullyId);
    if (gully) {
      const now = readCondensateGullySpec(gully);
      const gullyEdit = (properties: Record<string, unknown>): CondensatePieceEdit => ({ kind: 'gully', networkId, gullyId, properties });
      for (const kind of ['floor-gully', 'stack-connection', 'external-discharge'] as const) {
        options.push({
          id: `termination:${kind}`, group: 'termination', glyph: 'gully', title: TERMINATION_TITLE[kind], detail: TERMINATION_DETAIL[kind],
          edit: gullyEdit({ terminationKind: kind, inletElevationMm: kind === now.terminationKind ? now.inletElevationMm : DEFAULT_INLET_MM[kind], terminalTrap: kind === now.terminationKind ? now.terminalTrap : DEFAULT_TRAP[kind] }),
          ...(kind === now.terminationKind ? { current: true } : {}),
        });
      }
      for (const trap of ['tundish', 'hepvo', 'p-trap', 'none'] as const) {
        options.push({
          id: `trap:${trap}`, group: 'trap', glyph: 'trap', title: TRAP_TITLE[trap], detail: TRAP_DETAIL[trap], edit: gullyEdit({ terminalTrap: trap }),
          ...(trap === now.terminalTrap ? { current: true } : {}),
        });
      }
    }
  }
  return options;
}

const TERMINATION_TITLE: Record<CondensateTerminationKind, string> = { 'floor-gully': 'Floor gully', 'stack-connection': 'Stack connection', 'external-discharge': 'Wall outlet' };
const TERMINATION_DETAIL: Record<CondensateTerminationKind, string> = {
  'floor-gully': 'a drop to a gully or floor drain, through an air break',
  'stack-connection': 'into a waste stack, from above',
  'external-discharge': 'out through the wall',
};
const DEFAULT_INLET_MM: Record<CondensateTerminationKind, number> = { 'floor-gully': 50, 'stack-connection': 2300, 'external-discharge': 2350 };
const DEFAULT_TRAP: Record<CondensateTerminationKind, CondensateTerminalTrap> = { 'floor-gully': 'tundish', 'stack-connection': 'hepvo', 'external-discharge': 'none' };
const TRAP_TITLE: Record<CondensateTerminalTrap, string> = { tundish: 'Tundish', hepvo: 'Waterless valve', 'p-trap': 'P-trap', none: 'No trap' };
const TRAP_DETAIL: Record<CondensateTerminalTrap, string> = {
  tundish: 'a visible air break above the receptor',
  hepvo: 'a self-sealing valve (HepVO): no water seal to dry out',
  'p-trap': 'a water seal at the termination',
  none: 'an open discharge',
};

/** A typed value of a piece's own (the card's Edit tab): a fall, a level limit, a riser height, an offset, an inlet level. */
export function condensateValueOption(
  element: HvacElement,
  run: CondensateRun,
  piece: CondensatePiece,
  value: { kind: 'fall'; percent: number } | { kind: 'level-cap'; levelMm: number } | { kind: 'lift'; liftMm: number }
    | { kind: 'inlet'; levelMm: number },
): CondensateSegmentOption | null {
  const networkId = getCondensateOwnership(element)?.networkId;
  if (!networkId) return null;
  const network = (edit: CondensateNetworkEdit): CondensatePieceEdit => ({ kind: 'network', networkId, edit });
  switch (value.kind) {
    case 'fall':
      return { id: `fall-custom:${value.percent}`, group: 'fall', glyph: 'fall', title: `${value.percent} %`, detail: `${formatFallRatio(value.percent)} at least · the whole network`,
        edit: network({ fallPercent: value.percent }) };
    case 'level-cap':
      return { id: `level-cap-custom:${value.levelMm}`, group: 'level-cap', glyph: 'level', title: `≤ ${value.levelMm} mm`, detail: 'a level limit of your own',
        edit: network({ levelCapMm: { [element.id]: value.levelMm } }) };
    case 'lift': {
      const unitId = run.spec.drainStart?.unitId;
      return unitId ? { id: `lift-custom:${value.liftMm}`, group: 'lift', glyph: 'lift', title: `${value.liftMm} mm`, detail: 'a riser height of your own',
        edit: network({ liftLimitMm: { [unitId]: value.liftMm } }) } : null;
    }
    case 'inlet': {
      const gullyId = run.spec.drainEnd?.gullyId;
      return gullyId ? { id: `inlet-custom:${value.levelMm}`, group: 'inlet', glyph: 'gully', title: `Inlet @ ${value.levelMm} mm`, detail: 'the termination\'s level, the network solved again round it',
        edit: { kind: 'gully', networkId, gullyId, properties: { inletElevationMm: value.levelMm } } } : null;
    }
    default:
      return null;
  }
}

/** A typed sideways offset of a leg. */
export function condensateOffsetOption(element: HvacElement, run: CondensateRun, piece: CondensatePiece, route: PlanRoute | undefined, shiftMm: number): CondensateSegmentOption | null {
  const networkId = getCondensateOwnership(element)?.networkId;
  const segment = route ? legSegment(route, piece) : null;
  if (!networkId || !route || segment === null || shiftMm === 0) return null;
  const a = route[segment]!;
  const b = route[segment + 1]!;
  const length = planDistance(a, b);
  if (length < 1) return null;
  const across = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const way = screenWay({ x: across.x * Math.sign(shiftMm), y: across.y * Math.sign(shiftMm) });
  return {
    id: `offset-custom:${shiftMm}`, group: 'offset', glyph: 'offset', title: `${way.arrow} ${Math.abs(shiftMm)} mm`, detail: 'an offset of your own',
    edit: { kind: 'network', networkId, edit: { routes: [[element.id, offsetRouteLeg(route, segment, { x: across.x * shiftMm, y: across.y * shiftMm }, fixedPrefixLength(isUnitBranchSpec(run.spec)))]] } },
  };
}

/** A plan direction as the screen shows it (plan y runs down the screen). */
export function screenWay(direction: { x: number; y: number }): { arrow: string; words: string } {
  if (Math.abs(direction.x) >= Math.abs(direction.y)) return direction.x >= 0 ? { arrow: '→', words: 'to the right' } : { arrow: '←', words: 'to the left' };
  return direction.y >= 0 ? { arrow: '↓', words: 'down the plan' } : { arrow: '↑', words: 'up the plan' };
}

/** The highest point of a stretch (mm): what a level limit is measured from. */
export function stretchTopMm(run: CondensateRun, piece: CondensatePiece): number {
  return Math.max(...condensatePieceSpan(run, piece).map((point) => point.z));
}
