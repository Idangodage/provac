/**
 * Sizing a duct straight by dragging its grips.
 *
 * A straight offers grips at its two ends (its length: the far end grows it
 * downstream, the near end upstream), on its two sides (its width, both faces
 * moving, the centreline kept) and on its top (its depth, its bottom kept at
 * its level); a riser offers its two ends (its height); a flexible runout, its
 * start (its length). A drag along a grip asks a value, snapped (lengths to
 * 10 mm; sections to 50 mm, a round duct's to the stocked diameters; Alt:
 * 1 mm) or typed, and the edit that makes it is the card's own (leg-length,
 * leg-section, runout-length).
 *
 * A value the rules do not allow stops the drag at the nearest value they do,
 * and says why: the edit refused, or a rule the drawing did not break before
 * (a fitting without its length, a take-off that no longer fits, a clash, the
 * duct's top through the soffit). Advisories (a velocity over its limit, an
 * aspect over 4:1) are said, not enforced.
 *
 * A small piece slides along its duct by a grip of its own, made the same way:
 * a take-off along its main, an accessory (a volume damper, an access door, a
 * sound attenuator) or a transition along its straight (tap-station,
 * inline-move, transition-move), to 10 mm with a magnetic stop at the middle
 * of its straight, stopped at the last place the rules allow (a fitting, a
 * take-off, a wall in the way).
 *
 * The result is shaped as a move plan, so the move session previews, reads it
 * out and stores it as it does a move (one undo step).
 */
import type { HvacElement } from '../../../../types';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { ductLegs } from '../duct/ductGeometry';
import { INLINE_TITLES, MIN_STRAIGHT_MM, applyDuctSegmentEdit, transitionStretch, type DuctSegmentEdit } from '../duct/ductSegmentEdits';
import { ductSegmentFigures, type DuctFigureStatus } from '../duct/ductSegmentFigures';
import { sectionLabel } from '../duct/ductSegments';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { IMPERIAL_RECT_STEP_MM, ductRoundSizesMm, nearestStep, onStep } from '../duct/ductSizeCatalog';
import { getDuctSupportPlan, resolveSoffitZ } from '../duct/ductSupports';
import { isDuctElement, isRoundLeg, readDuctRunSpec, roundLeg, type DuctLeg, type DuctRunSpec } from '../duct/ductTypes';
import { findDuctClashes } from '../duct/ductVolumes';
import type { CriteriaRoom } from '../duct/unitCriteria';
import { listNetworkPipeLanes } from '../networkPipeClearance';

import { ZERO3, type Vec3 } from './ductElasticMove';
import type { HvacMoveOutcome, HvacMovePlan } from './hvacMoveModel';

export type DuctResizeGripKind = 'length-start' | 'length-end' | 'width' | 'depth' | 'runout' | 'slide';

/** The piece a slide grip moves along its duct. */
export interface DuctSlide {
  piece: 'takeoff' | 'inline' | 'transition';
  /** An accessory's id. */
  id?: string;
  /** A transition's vertex (where it starts). */
  node?: number;
  /** Where its place is measured from (model mm): the main's leg start, its own leg's start, its straight's start. */
  origin: Vec3;
  /** Places a drag is drawn to, magnetically (the middle of its straight). */
  stops: number[];
}

export interface DuctResizeGrip {
  kind: DuctResizeGripKind;
  runId: string;
  /** The straight (a riser; a flexible runout: its leg). */
  legIndex: number;
  /** The segment it sizes ("leg:2", "end:flex"). */
  key: string;
  /** A width grip's face: +1 the straight's left (looking downstream), −1 its right. */
  side?: 1 | -1;
  /** Where it sits (model mm, z up). */
  point: Vec3;
  /** A width grip: the centreline point its face is measured from (a narrow duct's grips can sit further out). */
  base?: Vec3;
  /** The way that makes the value larger (unit). */
  axis: Vec3;
  /** Value change per mm the grip travels along `axis` (2 for a width: both faces move). */
  rate: number;
  /** The value now (mm): a length, a width, a depth (a round duct's: its diameter), a runout's length. */
  value: number;
  /** A round duct: its width and depth are its diameter. */
  round: boolean;
  /** A slide grip: the piece it moves along its duct (its value: the piece's place, mm from `slide.origin`). */
  slide?: DuctSlide;
}

/** Snapping steps (mm). */
export const RESIZE_LENGTH_STEP_MM = 10;
/** A slid piece is tried this often on its way (mm): it stops at the first place the rules refuse, never jumping a fitting. */
const SLIDE_PROBE_MM = 25;
export const RESIZE_SECTION_STEP_MM = 50;

/** The step a section snaps to (mm): 50 mm, or 2 in for the inch series. */
export function resizeSectionStepMm(settings: Pick<DuctDesignSettings, 'sizeSeries'>): number {
  return settings.sizeSeries === 'imperial' ? IMPERIAL_RECT_STEP_MM : RESIZE_SECTION_STEP_MM;
}
/** What a value may be (mm): the card's own limits. */
const LIMITS: Record<'length' | 'width' | 'depth' | 'diameter' | 'runout' | 'slide', [number, number]> = {
  length: [MIN_STRAIGHT_MM, 60000], width: [50, 4000], depth: [50, 2000], diameter: [75, 2000], runout: [300, 3000], slide: [0, 60000],
};

function limitsOf(grip: Pick<DuctResizeGrip, 'kind' | 'round'>): [number, number] {
  if (grip.kind === 'slide') return LIMITS.slide;
  if (grip.kind === 'runout') return LIMITS.runout;
  if (grip.kind === 'width' || grip.kind === 'depth') return grip.round ? LIMITS.diameter : LIMITS[grip.kind];
  return LIMITS.length;
}

const clamp = (value: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, value));

/** The value a raw one snaps to: lengths to 10 mm, sections to 50 mm or 2 in (a round duct's to a stocked size); `fine`: 1 mm. */
export function snapResizeValue(grip: Pick<DuctResizeGrip, 'kind' | 'round'>, raw: number, settings: Pick<DuctDesignSettings, 'autoRoundSizesMm' | 'sizeSeries'>, fine = false): number {
  const limits = limitsOf(grip);
  if (fine) return clamp(Math.round(raw), limits);
  if (grip.kind === 'width' || grip.kind === 'depth') {
    if (grip.round) {
      const stock = ductRoundSizesMm(settings).filter((size) => size >= limits[0] && size <= limits[1]);
      if (stock.length) return stock.reduce((best, size) => (Math.abs(size - raw) < Math.abs(best - raw) ? size : best));
    }
    return clamp(nearestStep(raw, resizeSectionStepMm(settings)), limits);
  }
  return clamp(Math.round(raw / RESIZE_LENGTH_STEP_MM) * RESIZE_LENGTH_STEP_MM, limits);
}

function sectionOf(leg: DuctLeg): { width: number; depth: number } {
  return { width: leg.diameterMm ?? leg.widthMm, depth: leg.diameterMm ?? leg.heightMm };
}

function flexTailOf(spec: DuctRunSpec): boolean {
  return spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 2;
}

/** A flexible runout's length now (mm), as planned. */
function runoutLength(element: HvacElement, scene: readonly HvacElement[], settings: DuctDesignSettings): number | null {
  return getDuctRunPlan(element, scene, settings)?.pieces.find((piece) => piece.kind === 'flex')?.lengthMm ?? null;
}

/** The edit a grip's value asks; `scope` 'size': a section given to every straight of the run of the same size. */
export function ductResizeEdit(scene: readonly HvacElement[], grip: DuctResizeGrip, value: number, scope: 'leg' | 'size' = 'leg'): DuctSegmentEdit | null {
  if (grip.kind === 'length-start' || grip.kind === 'length-end') {
    return { kind: 'leg-length', runId: grip.runId, legIndex: grip.legIndex, lengthMm: value, grow: grip.kind === 'length-start' ? 'start' : 'end' };
  }
  if (grip.slide) {
    if (grip.slide.piece === 'takeoff') return { kind: 'tap-station', runId: grip.runId, stationMm: value };
    if (grip.slide.piece === 'inline') return grip.slide.id ? { kind: 'inline-move', runId: grip.runId, id: grip.slide.id, stationMm: value, exact: true } : null;
    return grip.slide.node !== undefined ? { kind: 'transition-move', runId: grip.runId, node: grip.slide.node, alongMm: value } : null;
  }
  if (grip.kind === 'runout') return { kind: 'runout-length', runId: grip.runId, flexMm: value };
  const element = scene.find((candidate) => candidate.id === grip.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  const leg = spec?.legs[grip.legIndex];
  if (!spec || !leg) return null;
  const section: DuctLeg = isRoundLeg(leg)
    ? roundLeg(value)
    : grip.kind === 'width' ? { widthMm: value, heightMm: leg.heightMm } : { widthMm: leg.widthMm, heightMm: value };
  const label = sectionLabel(leg);
  const tail = flexTailOf(spec) ? spec.legs.length - 1 : spec.legs.length;
  const legs = scope === 'size'
    ? spec.legs.flatMap((candidate, index) => (index < tail && sectionLabel(candidate) === label ? [index] : []))
    : [grip.legIndex];
  return { kind: 'leg-section', runId: grip.runId, sections: legs.map((index) => ({ leg: index, section })) };
}

/** Whether an edit at `value` is made (not refused): the grip can move that way at all. */
function moves(scene: readonly HvacElement[], settings: DuctDesignSettings, grip: DuctResizeGrip, value: number): boolean {
  const edit = ductResizeEdit(scene, grip, value);
  return Boolean(edit) && !applyDuctSegmentEdit(scene, settings, edit!).refused;
}

/**
 * The middle of the clear straight (between its fittings) a place on a run's
 * leg lies on, mm from the leg's start: where a slid piece is drawn to. None
 * when the plan has no straight there.
 */
function clearMiddle(scene: readonly HvacElement[], settings: DuctDesignSettings, element: HvacElement, legIndex: number, station: number): number[] {
  const spec = readDuctRunSpec(element);
  const leg = spec ? ductLegs(spec)[legIndex] : undefined;
  const plan = getDuctRunPlan(element, scene, settings);
  if (!leg || !plan) return [];
  const along = (point: { x: number; y: number }) => (point.x - leg.start.x) * leg.direction.x + (point.y - leg.start.y) * leg.direction.y;
  const stretches: Array<[number, number]> = [];
  for (const piece of plan.pieces) {
    if (piece.legIndex !== legIndex || piece.kind !== 'straight') continue;
    const from = Math.min(along(piece.start), along(piece.end));
    const to = Math.max(along(piece.start), along(piece.end));
    const last = stretches[stretches.length - 1];
    if (last && Math.abs(from - last[1]) < 0.5) last[1] = to;
    else stretches.push([from, to]);
  }
  if (!stretches.length) return [];
  const nearest = stretches.reduce((best, stretch) => {
    const gap = (s: [number, number]) => (station < s[0] ? s[0] - station : station > s[1] ? station - s[1] : 0);
    return gap(stretch) < gap(best) ? stretch : best;
  });
  return [Math.round((nearest[0] + nearest[1]) / 2)];
}

/**
 * The slide grip of a piece ("start:takeoff", "inline:i1", "transition:2"): on
 * the main's wall where a branch leaves it, on an accessory's centre, where a
 * transition starts; along its duct. Null: the piece cannot slide (a riser's,
 * a locked main's); undefined: the key is not a piece that slides.
 */
function slideGrip(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, spec: DuctRunSpec, key: string): DuctResizeGrip | null | undefined {
  const legs = ductLegs(spec);
  const along = (leg: ReturnType<typeof ductLegs>[number], section: DuctLeg, value: number): Vec3 => ({
    x: leg.start.x + leg.direction.x * value, y: leg.start.y + leg.direction.y * value, z: leg.start.z + (section.diameterMm ?? section.heightMm) / 2,
  });
  if (key === 'start:takeoff') {
    const start = spec.start;
    if (start.kind !== 'tap') return null;
    const parent = scene.find((candidate) => candidate.id === start.parentRunId);
    const parentSpec = parent ? readDuctRunSpec(parent) : null;
    const leg = parentSpec ? ductLegs(parentSpec)[start.legIndex] : undefined;
    const section = parentSpec?.legs[start.legIndex];
    if (!parentSpec || !leg || !section || leg.vertical || leg.sloped) return null;
    // On the main's wall, where the branch leaves it.
    const out = (section.diameterMm ?? section.widthMm) / 2 + parentSpec.insulationThicknessMm;
    const wall = (value: number): Vec3 => {
      const centre = along(leg, section, value);
      return { x: centre.x - leg.direction.y * start.side * out, y: centre.y + leg.direction.x * start.side * out, z: centre.z };
    };
    return {
      kind: 'slide', runId, legIndex: 0, key, point: wall(start.stationMm), axis: { x: leg.direction.x, y: leg.direction.y, z: 0 }, rate: 1,
      value: start.stationMm, round: isRoundLeg(section),
      slide: { piece: 'takeoff', origin: wall(0), stops: parent ? clearMiddle(scene, settings, parent, start.legIndex, start.stationMm) : [] },
    };
  }
  const inline = /^inline:(.+)$/.exec(key);
  if (inline) {
    const item = spec.inline?.find((candidate) => candidate.id === inline[1]);
    const leg = item ? legs[item.legIndex] : undefined;
    const section = item ? spec.legs[item.legIndex] : undefined;
    if (!item || !leg || !section || leg.vertical || leg.sloped) return null;
    const element = scene.find((candidate) => candidate.id === runId);
    return {
      kind: 'slide', runId, legIndex: item.legIndex, key, point: along(leg, section, item.stationMm), axis: { x: leg.direction.x, y: leg.direction.y, z: 0 }, rate: 1,
      value: item.stationMm, round: isRoundLeg(section),
      slide: { piece: 'inline', id: item.id, origin: along(leg, section, 0), stops: element ? clearMiddle(scene, settings, element, item.legIndex, item.stationMm) : [] },
    };
  }
  const transition = /^transition:(\d+)$/.exec(key);
  if (transition) {
    const node = Number(transition[1]);
    const stretch = transitionStretch(scene, spec, node);
    const leg = legs[node];
    if (!stretch || !leg) return null;
    const from = spec.path[stretch.lo]!;
    const at = (value: number): Vec3 => ({
      x: from.x + leg.direction.x * value, y: from.y + leg.direction.y * value, z: from.z + (stretch.after.diameterMm ?? stretch.after.heightMm) / 2,
    });
    return {
      kind: 'slide', runId, legIndex: node, key, point: at(stretch.atMm), axis: { x: leg.direction.x, y: leg.direction.y, z: 0 }, rate: 1,
      value: Math.round(stretch.atMm * 10) / 10, round: isRoundLeg(stretch.after), slide: { piece: 'transition', node, origin: at(0), stops: [] },
    };
  }
  return undefined;
}

/**
 * The grips of a run's segment ("leg:2", "end:flex"): those that can move at
 * least one way (an end held at a collar, a take-off's wall or a spigot has
 * none). A locked or old run has none. `probe` false: every grip the segment
 * has, without trying which can move (where a grip being dragged now sits).
 */
export function ductResizeGrips(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, key: string, options: { probe?: boolean } = {}): DuctResizeGrip[] {
  const element = scene.find((candidate) => candidate.id === runId);
  const spec = element && isDuctElement(element) ? readDuctRunSpec(element) : null;
  if (!element || !spec || spec.legacy || spec.locked) return [];
  const legs = ductLegs(spec);
  const insulation = spec.insulationThicknessMm;
  const grips: DuctResizeGrip[] = [];
  const both = (grip: DuctResizeGrip, step: number) => options.probe === false
    || moves(scene, settings, grip, grip.value + step) || moves(scene, settings, grip, grip.value - step);

  // A piece sliding along its duct (its take-off, an accessory, a transition).
  const slide = slideGrip(scene, settings, runId, spec, key);
  if (slide !== undefined) return slide && both(slide, RESIZE_LENGTH_STEP_MM) ? [slide] : [];

  if (key === 'end:flex') {
    const n = spec.path.length;
    if (!flexTailOf(spec) || n < 3) return [];
    const q = spec.path[n - 3]!;
    const p = spec.path[n - 2]!;
    const run = Math.hypot(p.x - q.x, p.y - q.y);
    const length = runoutLength(element, scene, settings);
    if (run < 1 || length === null) return [];
    const { depth } = sectionOf(spec.legs[n - 3]!);
    const grip: DuctResizeGrip = {
      kind: 'runout', runId, legIndex: n - 2, key, point: { x: p.x, y: p.y, z: p.z + depth / 2 },
      // Back up the straight before it: the rigid duct stops short, the runout grows.
      axis: { x: -(p.x - q.x) / run, y: -(p.y - q.y) / run, z: 0 }, rate: 1, value: length, round: true,
    };
    return both(grip, RESIZE_LENGTH_STEP_MM) ? [grip] : [];
  }

  const match = /^leg:(\d+)$/.exec(key);
  const index = match ? Number(match[1]) : -1;
  const geometry = legs[index];
  const section = spec.legs[index];
  if (!geometry || !section || geometry.sloped || (flexTailOf(spec) && index === spec.legs.length - 1)) return [];
  const round = isRoundLeg(section);
  const { width, depth } = sectionOf(section);

  if (geometry.vertical) {
    // A riser (or a drop): its height, from either end.
    const up = { x: 0, y: 0, z: geometry.vertical };
    const ends: DuctResizeGrip[] = [
      { kind: 'length-end', runId, legIndex: index, key, point: { x: geometry.end.x, y: geometry.end.y, z: geometry.endCentreZ }, axis: up, rate: 1, value: geometry.lengthMm, round },
      { kind: 'length-start', runId, legIndex: index, key, point: { x: geometry.start.x, y: geometry.start.y, z: geometry.startCentreZ }, axis: { x: 0, y: 0, z: -geometry.vertical }, rate: 1, value: geometry.lengthMm, round },
    ];
    return ends.filter((grip) => both(grip, RESIZE_LENGTH_STEP_MM));
  }

  const d = geometry.direction;
  const centreZ = geometry.start.z + depth / 2;
  const left = { x: -d.y, y: d.x };
  const middle = { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 };
  const ends: DuctResizeGrip[] = [
    { kind: 'length-end', runId, legIndex: index, key, point: { x: geometry.end.x, y: geometry.end.y, z: centreZ }, axis: { x: d.x, y: d.y, z: 0 }, rate: 1, value: geometry.lengthMm, round },
    { kind: 'length-start', runId, legIndex: index, key, point: { x: geometry.start.x, y: geometry.start.y, z: centreZ }, axis: { x: -d.x, y: -d.y, z: 0 }, rate: 1, value: geometry.lengthMm, round },
  ];
  grips.push(...ends.filter((grip) => both(grip, RESIZE_LENGTH_STEP_MM)));
  for (const side of [1, -1] as const) {
    const reach = width / 2 + insulation;
    grips.push({
      kind: 'width', runId, legIndex: index, key, side, rate: 2, value: width, round, base: { x: middle.x, y: middle.y, z: centreZ },
      point: { x: middle.x + left.x * side * reach, y: middle.y + left.y * side * reach, z: centreZ },
      axis: { x: left.x * side, y: left.y * side, z: 0 },
    });
  }
  grips.push({
    kind: 'depth', runId, legIndex: index, key, rate: 1, value: depth, round,
    point: { x: middle.x, y: middle.y, z: geometry.start.z + depth + insulation }, axis: { x: 0, y: 0, z: 1 },
  });
  return grips;
}

// ---- Planning a value ----

export interface DuctResizeFigures {
  /** The segment's air at the value made. */
  velocityMs: number;
  velocityLimitMs: number;
  velocityStatus: DuctFigureStatus;
  frictionPaPerM: number;
  frictionLimitPaPerM: number;
  frictionStatus: DuctFigureStatus;
  /** A rectangular section's width ÷ depth (null: round, or a length). */
  aspect: number | null;
  /** The fan's index pressure, before and at the value made (Pa). */
  indexPa: { from: number | null; to: number | null };
}

export interface DuctResizeOutcome {
  grip: DuctResizeGrip;
  scope: 'leg' | 'size';
  /** The value before, asked and made (mm). */
  from: number;
  asked: number;
  made: number;
  /** "Straight 2", "Riser 3", "The runout to SAD-1". */
  subject: string;
  /** A width or depth: the section before and at the value made ("250×250" → "300×250"). */
  sections: { from: string; to: string } | null;
  figures: DuctResizeFigures | null;
  /** A slid transition numbered anew (off or back onto an elbow): its key now. */
  refocus?: { runId: string; key: string };
}

/** A resize, shaped as a move plan (the session previews, reads out and stores it as one). */
export type DuctResizePlan = HvacMovePlan & { resize: DuctResizeOutcome };

interface Evaluation {
  ok: boolean;
  /** Why the value is not allowed. */
  reason: string | null;
  updates: HvacElement[];
  notes: string[];
  action: string;
  refocus?: { runId: string; key: string };
}

/** "The take-off to SAD-2", "The volume damper", "The transition". */
function slideSubject(slide: DuctSlide, spec: DuctRunSpec | null, terminal: HvacElement | undefined): string {
  if (slide.piece === 'takeoff') return terminal?.label ? `The take-off to ${terminal.label}` : 'The take-off';
  if (slide.piece === 'inline') {
    const item = spec?.inline?.find((candidate) => candidate.id === slide.id);
    return item ? `The ${INLINE_TITLES[item.kind].toLowerCase()}` : 'The accessory';
  }
  return 'The transition';
}

const formatMm = (value: number) => `${Math.round(value).toLocaleString('en-GB')} mm`;
/** A sentence as a clause after "stops at …:" (an ordinary first word lower-case, not a mark like "S-002"; no full stop). */
const asClause = (text: string) => text.replace(/^(A |[A-Z][a-z])/, (start: string) => `${start[0]!.toLowerCase()}${start.slice(1)}`).replace(/\.$/, '');

function replaced(scene: readonly HvacElement[], updates: readonly HvacElement[]): HvacElement[] {
  const byId = new Map(updates.map((element) => [element.id, element]));
  return scene.map((element) => byId.get(element.id) ?? element);
}

/** A run's error codes as the canvas checks it (its plan and its supports), with their messages. */
function runErrors(scene: readonly HvacElement[], id: string, settings: DuctDesignSettings): Array<{ code: string; message: string }> {
  const element = scene.find((candidate) => candidate.id === id);
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  if (!plan) return [];
  return [...plan.issues, ...getDuctSupportPlan(plan, scene, settings).issues]
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ code: issue.code, message: issue.message }));
}

/** A run's highest outside top (insulation included), mm. */
function runTop(spec: DuctRunSpec): number {
  let top = Number.NEGATIVE_INFINITY;
  spec.legs.forEach((leg, index) => {
    const height = leg.diameterMm ?? leg.heightMm;
    for (const point of [spec.path[index], spec.path[index + 1]]) if (point) top = Math.max(top, point.z + height + 2 * spec.insulationThicknessMm);
  });
  return top;
}

const CLASH_OTHER: Record<string, string> = { duct: 'the duct run', terminal: 'the air terminal', equipment: 'the equipment', pipe: 'the pipe' };

/**
 * A grip dragged: plans the value asked (snapped or typed) and, where the
 * rules do not allow it, the nearest value between the start and it that they
 * do. Evaluations are kept, so a drag moving on step by step costs one each.
 */
export class DuctResizeSolver {
  private readonly evaluations = new Map<string, Evaluation>();
  private readonly baseErrors = new Map<string, Map<string, number>>();
  private baseClashes: Set<string> | null = null;
  private readonly figuresFrom: number | null;
  readonly subject: string;

  constructor(
    private readonly scene: readonly HvacElement[],
    private readonly settings: DuctDesignSettings,
    readonly grip: DuctResizeGrip,
    private readonly options: { soffitMm?: number | null; rooms?: ReadonlyArray<CriteriaRoom> } = {},
  ) {
    const element = scene.find((candidate) => candidate.id === grip.runId);
    const spec = element ? readDuctRunSpec(element) : null;
    const geometry = spec ? ductLegs(spec)[grip.legIndex] : undefined;
    const terminal = spec?.end.kind === 'terminal' ? scene.find((candidate) => candidate.id === (spec.end as { terminalId: string }).terminalId) : undefined;
    this.subject = grip.slide
      ? slideSubject(grip.slide, spec, terminal)
      : grip.kind === 'runout'
        ? `The runout to ${terminal?.label || 'its terminal'}`
        : `${geometry?.vertical ? 'Riser' : 'Straight'} ${grip.legIndex + 1}`;
    this.figuresFrom = grip.slide ? null : ductSegmentFigures(scene, settings, grip.runId, grip.key, options.rooms)?.system?.indexPa ?? null;
  }

  /** The plan for a value asked: made as asked, or stopped at the nearest value the rules allow (`fine`: on a 1 mm grid). */
  plan(asked: number, scope: 'leg' | 'size' = 'leg', fine = false): DuctResizePlan {
    const from = this.grip.value;
    if (Math.abs(asked - from) < 0.5) return this.build(from, asked, scope, null, null);
    // A slid piece moves continuously: the first place on its way the rules refuse stops it (it never jumps a fitting,
    // a take-off or a wall to a clear place beyond).
    if (this.grip.slide) {
      const step = Math.sign(asked - from) * SLIDE_PROBE_MM;
      let clear = from;
      for (let at = from + step; step > 0 ? at < asked - 0.5 : at > asked + 0.5; at += step) {
        const value = Math.round(at);
        const probe = this.evaluate(value, scope);
        if (!probe.ok) return this.stopBetween(clear, value, asked, scope, fine, probe);
        clear = value;
      }
    }
    const first = this.evaluate(asked, scope);
    if (first.ok) return this.build(asked, asked, scope, first, null);
    return this.stopBetween(from, asked, asked, scope, fine, first);
  }

  /** Stopped short: the furthest allowed value between `clear` (allowed) and `blocked`; the reason, the rule just past it. */
  private stopBetween(clear: number, blocked: number, asked: number, scope: 'leg' | 'size', fine: boolean, blocking: Evaluation): DuctResizePlan {
    let lo = clear;
    let hi = blocked;
    let best: Evaluation | null = Math.abs(clear - this.grip.value) < 0.5 ? null : this.evaluate(clear, scope);
    let limit = blocking;
    for (let step = 0; step < 16; step += 1) {
      const mid = this.between(lo, hi, fine);
      if (mid === null) break;
      const evaluation = this.evaluate(mid, scope);
      if (evaluation.ok) {
        lo = mid;
        best = evaluation;
      } else {
        hi = mid;
        limit = evaluation;
      }
    }
    return this.build(lo, asked, scope, best, limit.reason);
  }

  /** A value on the grip's grid strictly between `a` and `b` (near their middle), or null. */
  private between(a: number, b: number, fine: boolean): number | null {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const inside = (value: number) => value > lo + 0.5 && value < hi - 0.5;
    if (!fine && this.grip.round && (this.grip.kind === 'width' || this.grip.kind === 'depth')) {
      const stock = ductRoundSizesMm(this.settings).filter(inside);
      return stock.length ? stock[Math.floor(stock.length / 2)]! : null;
    }
    const step = fine ? 1 : this.grip.kind === 'width' || this.grip.kind === 'depth' ? resizeSectionStepMm(this.settings) : RESIZE_LENGTH_STEP_MM;
    const middle = Math.round((lo + hi) / 2 / step);
    for (const candidate of [middle, middle - 1, middle + 1].map((k) => onStep(k, step))) if (inside(candidate)) return candidate;
    return null;
  }

  private evaluate(value: number, scope: 'leg' | 'size'): Evaluation {
    const cacheKey = `${scope}|${value}`;
    const cached = this.evaluations.get(cacheKey);
    if (cached) return cached;
    const evaluation = this.evaluateFresh(value, scope);
    this.evaluations.set(cacheKey, evaluation);
    return evaluation;
  }

  private evaluateFresh(value: number, scope: 'leg' | 'size'): Evaluation {
    const { scene, settings, grip } = this;
    const edit = ductResizeEdit(scene, grip, value, scope);
    if (!edit) return { ok: false, reason: 'That part of the run cannot be sized.', updates: [], notes: [], action: '' };
    const result = applyDuctSegmentEdit(scene, settings, edit);
    if (result.refused) return { ok: false, reason: asClause(result.refused), updates: [], notes: [], action: '' };
    const next = replaced(scene, result.updates);
    const runs = result.updates.filter(isDuctElement);
    const made: Evaluation = {
      ok: true, reason: null, updates: result.updates, notes: result.notes, action: result.action, ...(result.refocus ? { refocus: result.refocus } : {}),
    };
    // A rule the drawing did not break before, on a run the edit changes or on the run a changed branch is taken off
    // (its take-off windows are planned on its main).
    const checked = new Set(runs.map((run) => run.id));
    for (const run of runs) {
      const start = readDuctRunSpec(run)?.start;
      if (start && (start.kind === 'tap' || start.kind === 'split-branch' || start.kind === 'spigot')) checked.add(start.parentRunId);
    }
    for (const id of checked) {
      const base = this.baseErrorsOf(id);
      const left = new Map(base);
      for (const error of runErrors(next, id, settings)) {
        const count = left.get(error.code) ?? 0;
        if (count > 0) {
          left.set(error.code, count - 1);
          continue;
        }
        return { ...made, ok: false, reason: asClause(error.message) };
      }
    }
    // A clash it would make.
    const ids = new Set(runs.map((run) => run.id));
    const clashes = this.clashesOf(next).filter((clash) => (ids.has(clash.ductId) || ids.has(clash.otherId)) && !this.baseClashesOf().has(clash.key));
    if (clashes.length) {
      const clash = clashes[0]!;
      const otherId = ids.has(clash.ductId) ? clash.otherId : clash.ductId;
      const other = next.find((element) => element.id === otherId);
      return { ...made, ok: false, reason: `it would clash with ${CLASH_OTHER[clash.kind] ?? 'something'}${other?.label ? ` ${other.label}` : ''}` };
    }
    // The duct's top through the soffit (a deeper or larger round section rises: its bottom stays).
    if (grip.kind === 'width' || grip.kind === 'depth') {
      const soffit = this.options.soffitMm ?? resolveSoffitZ(settings);
      for (const run of runs) {
        const spec = readDuctRunSpec(run);
        const before = scene.find((element) => element.id === run.id);
        const was = before ? readDuctRunSpec(before) : null;
        if (!spec || !was) continue;
        const top = runTop(spec);
        if (top > soffit + 0.5 && top > runTop(was) + 0.5) {
          return { ...made, ok: false, reason: `its top would reach ${formatMm(top)}, above the soffit at ${formatMm(soffit)}` };
        }
      }
    }
    return made;
  }

  private baseErrorsOf(id: string): Map<string, number> {
    let counts = this.baseErrors.get(id);
    if (!counts) {
      counts = new Map();
      for (const error of runErrors(this.scene, id, this.settings)) counts.set(error.code, (counts.get(error.code) ?? 0) + 1);
      this.baseErrors.set(id, counts);
    }
    return counts;
  }

  private clashesOf(scene: readonly HvacElement[]): Array<{ ductId: string; otherId: string; kind: string; key: string }> {
    return findDuctClashes(scene, this.settings, listNetworkPipeLanes([...scene])).map((clash) => ({
      ductId: clash.ductId, otherId: clash.otherId, kind: clash.kind, key: `${clash.ductId}|${clash.otherId}|${clash.kind}`,
    }));
  }

  private baseClashesOf(): Set<string> {
    if (!this.baseClashes) this.baseClashes = new Set(this.clashesOf(this.scene).map((clash) => clash.key));
    return this.baseClashes;
  }

  private build(made: number, asked: number, scope: 'leg' | 'size', evaluation: Evaluation | null, stoppedBy: string | null): DuctResizePlan {
    const { grip, scene, settings } = this;
    const updates = evaluation?.updates ?? [];
    const next = replaced(scene, updates);
    // A slid accessory lands at the clear spot nearest the place asked: the readout says where it is.
    if (grip.slide && evaluation) made = this.slideValue(next, made);
    const outcomes = new Map<string, HvacMoveOutcome>(updates.map((element) => [element.id, { kind: element.id === grip.runId ? 'moved' : 'follows' }]));
    // The section before and as made (width and depth).
    let sections: DuctResizeOutcome['sections'] = null;
    if (grip.kind === 'width' || grip.kind === 'depth') {
      const before = readDuctRunSpec(scene.find((element) => element.id === grip.runId)!)?.legs[grip.legIndex];
      const afterElement = next.find((element) => element.id === grip.runId);
      const after = afterElement ? readDuctRunSpec(afterElement)?.legs[grip.legIndex] : undefined;
      if (before) sections = { from: sectionLabel(before), to: sectionLabel(after ?? before) };
    }
    // The segment's air and the fan at the value made (a slid piece changes neither).
    const figures = grip.slide ? null : this.figuresAt(next, made);
    const advisories: string[] = [];
    if (figures?.velocityStatus === 'over') {
      advisories.push(`${figures.velocityMs.toFixed(1)} m/s is over its limit of ${figures.velocityLimitMs.toFixed(1)} m/s`);
    }
    if (figures?.aspect && figures.aspect > settings.aspectRatioAdvisory + 1e-6) {
      advisories.push(`Its aspect is ${figures.aspect.toFixed(1)}:1, over the ${settings.aspectRatioAdvisory}:1 advisory`);
    }
    const what = grip.kind === 'width' || grip.kind === 'depth' ? `${sections?.to ?? ''}` : formatMm(made);
    return {
      requested: ZERO3, applied: ZERO3,
      fraction: Math.abs(asked - grip.value) < 0.5 ? 1 : (made - grip.value) / (asked - grip.value),
      limitedBy: stoppedBy ? { id: grip.runId, reason: `${this.subject} stops at ${what}: ${stoppedBy}` } : null,
      updated: updates, add: [], removeIds: [], outcomes,
      messages: advisories,
      infos: evaluation?.notes ?? [],
      label: evaluation?.action || `${this.subject} ${what}`,
      resize: {
        grip, scope, from: grip.value, asked, made, subject: this.subject, sections, figures, ...(evaluation?.refocus ? { refocus: evaluation.refocus } : {}),
      },
    };
  }

  /** Where a slid piece is in a planned drawing (a take-off's station, an accessory's centre along its leg). */
  private slideValue(next: readonly HvacElement[], fallback: number): number {
    const slide = this.grip.slide;
    const element = next.find((candidate) => candidate.id === this.grip.runId);
    const spec = element ? readDuctRunSpec(element) : null;
    if (!slide || !spec) return fallback;
    if (slide.piece === 'takeoff') return spec.start.kind === 'tap' ? spec.start.stationMm : fallback;
    if (slide.piece === 'inline') return spec.inline?.find((item) => item.id === slide.id)?.stationMm ?? fallback;
    return fallback;
  }

  private readonly figureCache = new Map<number, DuctResizeFigures | null>();

  private figuresAt(next: readonly HvacElement[], made: number): DuctResizeFigures | null {
    if (this.figureCache.has(made)) return this.figureCache.get(made)!;
    const { grip, settings } = this;
    const found = ductSegmentFigures(next, settings, grip.runId, grip.key, this.options.rooms);
    const element = next.find((candidate) => candidate.id === grip.runId);
    const leg = element ? readDuctRunSpec(element)?.legs[grip.legIndex] : undefined;
    const figures: DuctResizeFigures | null = found?.flow ? {
      velocityMs: found.flow.velocityMs.max,
      velocityLimitMs: found.flow.limits.velocityMs,
      velocityStatus: found.flow.velocityStatus,
      frictionPaPerM: found.flow.frictionPaPerM,
      frictionLimitPaPerM: found.flow.limits.frictionPaPerM,
      frictionStatus: found.flow.frictionStatus,
      aspect: leg && !isRoundLeg(leg) ? Math.max(leg.widthMm, leg.heightMm) / Math.max(1, Math.min(leg.widthMm, leg.heightMm)) : null,
      indexPa: { from: this.figuresFrom, to: found.system?.indexPa ?? null },
    } : null;
    this.figureCache.set(made, figures);
    return figures;
  }
}
