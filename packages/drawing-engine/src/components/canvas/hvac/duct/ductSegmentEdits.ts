/**
 * The edits a segment's card applies, as pure functions of the drawing. Each
 * returns every element it changes, exactly as it will be stored: the run;
 * the take-offs whose fitting follows a main's new shape (keeping the angle
 * their branch leaves at); and every branch re-anchored on its parent's new
 * wall with its end kept on its terminal; a take-off a new fitting would
 * overlap slides along its leg, just clear of it. So one command (one undo)
 * carries the whole change, and the card previews exactly what it will
 * apply. The planner derives everything else (transitions, square-to-rounds,
 * joints).
 */
import type { HvacElement, Point2D } from '../../../../types';

import { findAirPort, type DuctAirPort } from './ductAirPorts';
import { branchTurns, errorCodes, noNewErrors, reaimBranch } from './ductBranchReaim';
import { tapAttachment } from './ductBranches';
import { accessDoorFor, inlineAccessoryLengthMm, planDuctRunSpec } from './ductFabricationPlanner';
import { branchAnchor, ductRunElementWithSpec, reanchorBranchesKeepingEnds, startAnchor } from './ductFollow';
import { runSectionSheetMm } from './ductGauge';
import { cross, dot, ductLegs } from './ductGeometry';
import { ductBranchesOf, ductParentOf, type DuctBranchRef } from './ductNetwork';
import { maxRoundBranchMm } from './ductRoundFittings';
import { rectangularEquivalents, roundEquivalents, sameSectionSize } from './ductSectionEquivalents';
import { sectionLabel, TAKEOFF_TITLES } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { TERMINAL_TAG_PATTERN, terminalLabel, terminalTypeTag, typicalTerminalSpec, type DuctTerminalKind } from './ductTerminalCatalog';
import { findTerminalPort, nextTerminalTag, readDuctTerminalSpec, terminalEnvelope } from './ductTerminals';
import {
  DUCT_ATTENUATOR_LENGTHS_MM,
  isRoundLeg,
  nextInlineId,
  readDuctRunSpec,
  roundLeg,
  type DuctInlineAccessory,
  type DuctInlineKind,
  type DuctLeg,
  type DuctNodeOverride,
  type DuctPoint3,
  type DuctRunSpec,
  type DuctSplitStyle,
  type DuctTapStyle,
} from './ductTypes';

export type DuctSegmentEdit =
  /**
   * Legs of a run take new sections; `wholeBranches`: a branch made round by a main's new shape is round all along;
   * `splitStyle`: the split ending a last leg that changes shape (else a wye on a round run, a Y — or a bullhead
   * where the Y's outlets do not fit — on a rectangular one; where its outlets cannot turn to the new split, the
   * split stays as it is behind a transition); `keepSplit`: the split stays as it is, behind a transition, whatever
   * its outlets could do.
   */
  | {
    kind: 'leg-section'; runId: string; sections: ReadonlyArray<{ leg: number; section: DuctLeg }>; wholeBranches?: boolean; splitStyle?: DuctSplitStyle;
    keepSplit?: boolean;
  }
  /** A node's fitting choices (null = the project's). */
  | { kind: 'node'; runId: string; node: number; override: DuctNodeOverride | null }
  /** A branch's take-off fitting, and its first leg with it (a round collar takes a round branch). */
  | { kind: 'tap'; runId: string; style: DuctTapStyle; firstLeg?: DuctLeg }
  /** The volume damper after a take-off, or the flexible connector at the unit. */
  | { kind: 'start'; runId: string; vcd?: boolean; connector?: boolean }
  | { kind: 'split'; runId: string; style: DuctSplitStyle }
  /** A fire damper at a wall crossing (null = as the project's policy says). */
  | { kind: 'fire-damper'; runId: string; key: string; fireDamper: boolean | null; byPolicy: boolean }
  | { kind: 'end'; runId: string; end: 'end-cap' | 'open' }
  /** The runout to the terminal the run ends on: flexible, or rigid (spiral duct, dropping onto the spigot's axis). */
  | { kind: 'runout'; runId: string; flex: boolean }
  /** The terminal a run ends on: another face of its service, another neck (its runout follows), its design airflow. */
  | { kind: 'terminal'; terminalId: string; face?: DuctTerminalKind; neckMm?: number; airflowM3h?: number | null }
  /** A take-off moved along its main leg (mm from the leg's start); its branch keeps its end. */
  | { kind: 'tap-station'; runId: string; stationMm: number }
  /** A flexible runout of a given length: the rigid duct before it runs on or stops short. */
  | { kind: 'runout-length'; runId: string; flexMm: number }
  /** An accessory moved along its leg (its centre, mm from the leg's start), or an access door of another size. */
  | { kind: 'inline-move'; runId: string; id: string; stationMm: number }
  | { kind: 'inline-door'; runId: string; id: string; doorMm: number }
  /** An accessory set into a leg's straight, at the clear spot nearest `stationMm` (along the leg). */
  | { kind: 'inline-add'; runId: string; accessory: Omit<DuctInlineAccessory, 'id'> }
  | { kind: 'inline-remove'; runId: string; id: string }
  /** A sound attenuator's catalogue length. */
  | { kind: 'inline-length'; runId: string; id: string; lengthMm: number };

export interface DuctSegmentEditResult {
  /** Every element the edit changes, as it will be stored (empty when refused). */
  updates: HvacElement[];
  /** What else changes, in the designer's words ("The take-off to SAD-2 becomes a conical tee"). */
  notes: string[];
  /** Why it cannot be made. */
  refused?: string;
  /** The undo step's name. */
  action: string;
}

const refuse = (refused: string): DuctSegmentEditResult => ({ updates: [], notes: [], refused, action: '' });

/** Round sizes a branch may take when a main turns round (the stock, else the usual spiral sizes). */
const DEFAULT_STOCK = [100, 125, 150, 160, 200, 250, 300, 315, 355, 400, 450, 500];

/**
 * The take-off fitting on a main that changes shape, leaving at the same
 * angle: rectangular → round main: shoe → conical tee, straight / spin-in →
 * 90° tee, conical → conical tee; round → rectangular: tee → spin-in,
 * conical tee → conical collar where the main is high enough for its cone
 * (Ø + flare + 20, as the sizing takes it) else a spin-in. A 45° lateral has
 * no square counterpart: it becomes a spin-in and its branch turns with it
 * (re-aimed, ductBranchReaim).
 */
export function tapStyleForMain(
  style: DuctTapStyle,
  roundMain: boolean,
  main: DuctLeg,
  branchDiameterMm: number,
  settings: Pick<DuctDesignSettings, 'conicalFlareMm'>,
): { style: DuctTapStyle } | { refused: string } {
  if (roundMain) {
    if (style === 'shoe-45' || style === 'conical') return { style: 'round-conical' };
    if (style === 'straight' || style === 'spin-in') return { style: 'round-tee' };
    return { style };
  }
  if (style === 'round-tee') return { style: 'spin-in' };
  if (style === 'round-conical') return { style: branchDiameterMm + settings.conicalFlareMm + 20 <= main.heightMm + 0.5 ? 'conical' : 'spin-in' };
  if (style === 'round-lateral') return { style: 'spin-in' };
  return { style };
}

/** The round section a rectangular branch takes off a round main: its equal-friction size, at most ⅔ of the main (S3.4). */
export function roundBranchFor(branch: DuctLeg, mainDiameterMm: number, stockMm: readonly number[]): DuctLeg {
  if (isRoundLeg(branch)) return branch;
  const stock = stockMm.length ? stockMm : DEFAULT_STOCK;
  const cap = maxRoundBranchMm(mainDiameterMm);
  const wanted = roundEquivalents(branch, stock).atOrAbove?.diameterMm ?? Math.min(branch.widthMm, branch.heightMm);
  const fitting = [...stock].sort((a, b) => b - a).find((size) => size <= Math.min(wanted, cap) + 0.5);
  return roundLeg(fitting ?? Math.min(wanted, cap));
}

function labelOf(element: HvacElement, spec: DuctRunSpec, scene: readonly HvacElement[]): string {
  const what = spec.start.kind === 'split-branch' ? 'The split\'s outlet' : 'The take-off';
  if (spec.end.kind === 'terminal') {
    const terminalId = spec.end.terminalId;
    const terminal = scene.find((candidate) => candidate.id === terminalId);
    if (terminal) return `${what} to ${terminal.label || (readDuctTerminalSpec(terminal)?.kind ?? 'a terminal')}`;
  }
  return spec.start.kind === 'split-branch' ? `The split's ${spec.start.side === 1 ? 'left' : 'right'} outlet` : 'The take-off';
}

/** Whether the run ends on a flexible runout (its last leg is the runout's, not the run's). */
function flexTail(spec: DuctRunSpec): boolean {
  return spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 2;
}

/** The legs a run's size applies to: every leg but a flexible runout's. */
export function rigidLegIndices(spec: DuctRunSpec): number[] {
  const count = spec.legs.length - (flexTail(spec) ? 1 : 0);
  return Array.from({ length: Math.max(0, count) }, (_, index) => index);
}

const STATION_STEP_MM = 10;

/**
 * Take-offs a changed run's new fittings would overlap slide along their leg,
 * just clear of them (and of each other): the planner's own rule (each
 * window, with its margin, within the leg's straight part, none overlapping).
 * Where a leg has no room for them all, they stay and the planner reports it.
 */
function makeRoomForTaps(scene: readonly HvacElement[], changed: Map<string, HvacElement>, settings: DuctDesignSettings, notes: string[]): void {
  const withChanges = () => scene.map((element) => changed.get(element.id) ?? element);
  for (const [runId, element] of [...changed]) {
    const spec = readDuctRunSpec(element);
    if (!spec || spec.legacy) continue;
    const taps = ductBranchesOf(runId, withChanges()).filter((branch) => branch.start.kind === 'tap');
    if (taps.length === 0) continue;
    const plan = planDuctRunSpec(runId, spec, { settings, scene: withChanges() });
    const legsWithClash = new Set(plan.issues.filter((issue) => issue.code === 'DU_TAP_CLASH' && issue.legIndex !== undefined).map((issue) => issue.legIndex!));
    if (legsWithClash.size === 0) continue;
    const legs = ductLegs(spec);
    const legStart = legs.map((_, index) => legs.slice(0, index).reduce((total, leg) => total + leg.lengthMm, 0));
    for (const legIndex of legsWithClash) {
      const straight = plan.pieces.filter((piece) => piece.legIndex === legIndex && (piece.kind === 'straight' || piece.kind === 'fire-damper'));
      if (straight.length === 0) continue;
      const zoneFrom = Math.min(...straight.map((piece) => piece.stationStartMm)) - legStart[legIndex]!;
      const zoneTo = Math.max(...straight.map((piece) => piece.stationEndMm)) - legStart[legIndex]!;
      const sheet = runSectionSheetMm(spec, spec.legs[legIndex]!, settings);
      const windows = taps.filter((branch) => branch.start.kind === 'tap' && branch.start.legIndex === legIndex).flatMap((branch) => {
        const start = branch.spec.start as Extract<DuctRunSpec['start'], { kind: 'tap' }>;
        const attachment = tapAttachment(spec, start, branch.spec.legs[0]!, sheet, settings);
        return attachment ? [{ branch, start, from: attachment.openingFromMm - settings.tapWindowMarginMm, to: attachment.openingToMm + settings.tapWindowMarginMm }] : [];
      }).sort((a, b) => a.from - b.from);
      // Push each clear of the start fittings and the one before it; then, from the far end, clear of the end fittings.
      const shifts = windows.map(() => 0);
      let cursor = zoneFrom;
      windows.forEach((window, index) => {
        shifts[index] = Math.max(0, cursor - window.from);
        cursor = window.to + shifts[index]!;
      });
      let limit = zoneTo;
      for (let index = windows.length - 1; index >= 0; index -= 1) {
        const end = windows[index]!.to + shifts[index]!;
        if (end > limit) shifts[index] = shifts[index]! - (end - limit);
        limit = windows[index]!.from + shifts[index]!;
      }
      if (windows.length === 0 || windows[0]!.from + shifts[0]! < zoneFrom - 0.5) continue;
      windows.forEach((window, index) => {
        const shift = shifts[index]!;
        if (Math.abs(shift) < 0.5) return;
        // Whole steps, rounded away from the fitting it clears.
        const rounded = shift > 0 ? Math.ceil(shift / STATION_STEP_MM) * STATION_STEP_MM : Math.floor(shift / STATION_STEP_MM) * STATION_STEP_MM;
        const current = changed.get(window.branch.element.id) ?? window.branch.element;
        const branchSpec = readDuctRunSpec(current)!;
        if (branchSpec.start.kind !== 'tap') return;
        changed.set(current.id, ductRunElementWithSpec(current, { ...branchSpec, start: { ...branchSpec.start, stationMm: window.start.stationMm + rounded } }));
        notes.push(`${labelOf(current, branchSpec, scene)} slides ${Math.abs(rounded)} mm ${rounded > 0 ? 'on' : 'back'} along the main, clear of its fittings`);
      });
    }
  }
}

/** The scene with `changed` in place, take-offs clear of new fittings, then every branch re-anchored keeping its end. */
function settle(scene: readonly HvacElement[], changed: Map<string, HvacElement>, settings: DuctDesignSettings, notes: string[] = []): HvacElement[] {
  makeRoomForTaps(scene, changed, settings, notes);
  const withChanges = scene.map((element) => changed.get(element.id) ?? element);
  const followers = reanchorBranchesKeepingEnds(withChanges, changed, settings);
  const merged = new Map(changed);
  for (const follower of followers) merged.set(follower.id, follower);
  return [...merged.values()];
}

/**
 * Branches of `parentId` whose fitting now leaves at another angle turn with it
 * (re-aimed: start on the new fitting, rejoining their route), in `changed`.
 * The reason when one cannot.
 */
function reaimTurningBranches(scene: readonly HvacElement[], settings: DuctDesignSettings, parentId: string, changed: Map<string, HvacElement>, notes: string[]): string | null {
  const withChanges = scene.map((element) => changed.get(element.id) ?? element);
  const parent = changed.get(parentId) ?? scene.find((element) => element.id === parentId);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  if (!parent || !parentSpec) return null;
  for (const branch of ductBranchesOf(parentId, withChanges)) {
    if (!branchTurns(parentSpec, branch.spec, settings)) continue;
    const aimed = reaimBranch(withChanges, settings, parent, parentSpec, branch.element, branch.spec);
    const label = labelOf(branch.element, branch.spec, scene);
    if (!aimed) return `${label}: no route lets it leave at its new angle and keep its end (redraw its first leg)`;
    changed.set(branch.element.id, ductRunElementWithSpec(branch.element, aimed.spec));
    for (const element of aimed.subBranches) changed.set(element.id, element);
    notes.push(`${label}: ${aimed.note}`);
  }
  return null;
}

/** A split's outlet branch in the split's new shape: round off a wye, rectangular (within the run's height, and for a Y half its width) off a Y or bullhead. */
function outletSection(first: DuctLeg, main: DuctLeg, round: boolean, outlets: number, settings: DuctDesignSettings): DuctLeg | null {
  if (round) {
    if (isRoundLeg(first)) return first;
    const stock = settings.autoRoundSizesMm.length ? settings.autoRoundSizesMm : DEFAULT_STOCK;
    const wanted = roundEquivalents(first, stock).atOrAbove?.diameterMm ?? Math.min(first.widthMm, first.heightMm);
    const fitting = [...stock].sort((a, b) => b - a).find((size) => size <= Math.min(wanted, main.diameterMm ?? main.widthMm) + 0.5);
    return roundLeg(fitting ?? wanted);
  }
  if (!isRoundLeg(first)) return first;
  const rects = rectangularEquivalents(first.diameterMm!, { maxHeightMm: main.heightMm, maxAspect: settings.aspectRatioAdvisory });
  return rects.find((leg) => leg.widthMm <= main.widthMm / Math.max(1, outlets) + 0.5) ?? rects[0] ?? null;
}

/** A take-off on a main leg that changes shape: its fitting follows (and a rectangular branch off a main made round, its first leg); the reason when it cannot. */
function tapOnNewMain(
  scene: readonly HvacElement[], settings: DuctDesignSettings, branch: DuctBranchRef, section: DuctLeg, wholeBranches: boolean | undefined, notes: string[],
): HvacElement | string {
  if (branch.start.kind !== 'tap') return '';
  const label = labelOf(branch.element, branch.spec, scene);
  let branchLegs = branch.spec.legs;
  const first = branchLegs[0]!;
  if (isRoundLeg(section) && !isRoundLeg(first)) {
    const round = roundBranchFor(first, section.diameterMm!, settings.autoRoundSizesMm);
    const tail = flexTail(branch.spec) ? branchLegs.length - 1 : branchLegs.length;
    branchLegs = branchLegs.map((leg, index) => (index === 0 || (wholeBranches && index < tail && !isRoundLeg(leg)) ? round : leg));
    notes.push(`${label}: its ${wholeBranches ? 'duct' : 'first leg'} becomes ${sectionLabel(round)} (was ${sectionLabel(first)})`);
  }
  const mapped = tapStyleForMain(branch.start.style, isRoundLeg(section), section, branchLegs[0]!.diameterMm ?? branchLegs[0]!.heightMm, settings);
  if ('refused' in mapped) return `${label}: ${mapped.refused}.`;
  if (mapped.style !== branch.start.style) notes.push(`${label} becomes a ${TAKEOFF_TITLES[mapped.style].toLowerCase().replace(/ \(y\)$/, '')}`);
  return ductRunElementWithSpec(branch.element, { ...branch.spec, legs: branchLegs, start: { ...branch.start, style: mapped.style } });
}

/** Radius ratios an elbow is tightened through to fit legs the edit left too short (then turning vanes, on a 90° turn). */
const FIT_RATIOS = [1.25, 1, 0.75] as const;

/**
 * Elbows of `runId` (in `changed`) whose legs the edit left too short — a round
 * run made rectangular takes wider elbows: each at either end of such a leg
 * takes the largest radius ratio that lets the leg fit (and breaks no rule the
 * run did not break before), else square with turning vanes where it turns
 * 90°. Notes say which.
 */
function fitElbows(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, changed: Map<string, HvacElement>, before: Map<string, number>, notes: string[]): void {
  const withChanges = () => scene.map((element) => changed.get(element.id) ?? element);
  let spec = readDuctRunSpec(changed.get(runId)!)!;
  let plan = planDuctRunSpec(runId, spec, { settings, scene: withChanges() });
  if ((errorCodes(plan).get('DU_LEG_TOO_SHORT') ?? 0) <= (before.get('DU_LEG_TOO_SHORT') ?? 0)) return;
  const short = [...new Set(plan.issues.filter((issue) => issue.code === 'DU_LEG_TOO_SHORT' && issue.legIndex !== undefined).map((issue) => issue.legIndex!))];
  for (const legIndex of short) {
    for (const node of [legIndex, legIndex + 1]) {
      const piece = plan.pieces.find((candidate) => candidate.kind === 'elbow' && candidate.nodeIndex === node);
      const elbow = piece?.elbow;
      if (!elbow || elbow.style === 'square-vaned' || !plan.issues.some((issue) => issue.code === 'DU_LEG_TOO_SHORT' && issue.legIndex === legIndex)) continue;
      const override = spec.nodeOverrides[String(node)] ?? {};
      const ratioNow = (elbow.inPlaneMm ?? piece!.widthMm) > 0 ? elbow.centrelineRadiusMm / (elbow.inPlaneMm ?? piece!.widthMm) : 1.5;
      const tries: DuctNodeOverride[] = [
        ...FIT_RATIOS.filter((ratio) => ratio < ratioNow - 0.01).map((ratio) => ({ ...override, ...(elbow.style === 'gored' ? {} : { elbowStyle: 'radius' as const }), centrelineRatio: ratio })),
        ...(elbow.style !== 'gored' && Math.abs(elbow.angleDeg - 90) < 1 ? [{ ...override, elbowStyle: 'square-vaned' as const, centrelineRatio: undefined }] : []),
      ];
      for (const attempt of tries) {
        const cleaned = Object.fromEntries(Object.entries(attempt).filter(([, value]) => value !== undefined)) as DuctNodeOverride;
        const next: DuctRunSpec = { ...spec, nodeOverrides: { ...spec.nodeOverrides, [String(node)]: cleaned } };
        const nextPlan = planDuctRunSpec(runId, next, { settings, scene: withChanges() });
        const counts = errorCodes(nextPlan);
        if (nextPlan.issues.some((issue) => issue.code === 'DU_LEG_TOO_SHORT' && issue.legIndex === legIndex)) continue;
        // Tighter, but within the rules: no error the run did not have, bar the legs still too short elsewhere.
        if (![...counts].every(([code, count]) => code === 'DU_LEG_TOO_SHORT' || count <= (before.get(code) ?? 0))) continue;
        spec = next;
        plan = nextPlan;
        changed.set(runId, ductRunElementWithSpec(changed.get(runId)!, next));
        notes.push(attempt.elbowStyle === 'square-vaned'
          ? `The elbow at node ${node} is square with turning vanes, to fit its legs`
          : `The elbow at node ${node} takes ${elbow.style === 'gored' ? 'R/D' : 'R/W'} ${attempt.centrelineRatio} to fit its legs`);
        break;
      }
    }
  }
}

/** The neck kept before a split (mm): at least this, lengthened in these steps; the leg before it keeps at least this. */
const NECK_MIN_MM = 150;
const NECK_STEP_MM = 50;
const NECK_LEAVE_MM = 150;

/**
 * A last leg that changes shape while its split stays as it is: the leg is cut
 * by a straight-through vertex, the part before it in the new section and a
 * neck of the old one into the split — the planner lays the transition between
 * them at the vertex. The neck is the shortest (in 50 mm steps) that plans
 * with no new error. Take-offs and accessories on the neck move onto it;
 * the split and its outlets do not change.
 */
function keepSplitBehindTransition(
  scene: readonly HvacElement[], settings: DuctDesignSettings, element: HvacElement, spec: DuctRunSpec, legs: DuctLeg[], legSet: ReadonlySet<number>,
  edit: Extract<DuctSegmentEdit, { kind: 'leg-section' }>, action: string,
): DuctSegmentEditResult {
  if (spec.end.kind !== 'split') return refuse('The run does not end in a split.');
  const last = spec.legs.length - 1;
  const geometry = ductLegs(spec)[last];
  const a = spec.path[last];
  const b = spec.path[last + 1];
  if (!geometry || !a || !b || geometry.vertical || geometry.sloped) return refuse('The split ends a leg that is not level: redraw its last leg.');
  const oldSection = spec.legs[last]!;
  const newSection = legs[last]!;
  const splitName = spec.end.style === 'wye' ? 'wye' : spec.end.style === 'y' ? 'Y split' : 'bullhead tee';
  const transitionName = isRoundLeg(oldSection) ? 'square-to-round' : 'round-to-square';
  const before = errorCodes(planDuctRunSpec(element.id, spec, { settings, scene }));
  const taps = ductBranchesOf(element.id, scene).filter((branch) => branch.start.kind === 'tap');
  // Node overrides past the cut move one on (none sit there on a split-ended run, but keep them whole).
  const nodeOverrides = Object.fromEntries(Object.entries(spec.nodeOverrides).map(([key, value]) => [Number(key) > last ? String(Number(key) + 1) : key, value]));
  for (let neck = NECK_MIN_MM; neck <= geometry.lengthMm - NECK_LEAVE_MM; neck += NECK_STEP_MM) {
    const cut = geometry.lengthMm - neck;
    const vertex = at({ x: a.x + geometry.direction.x * cut, y: a.y + geometry.direction.y * cut }, a.z);
    let next: DuctRunSpec = {
      ...spec, path: [...spec.path.slice(0, last + 1), vertex, ...spec.path.slice(last + 1)], legs: [...legs.slice(0, last), newSection, oldSection], nodeOverrides,
    };
    if (next.inline?.length) {
      next = { ...next, inline: next.inline.map((item) => (item.legIndex === last && item.stationMm > cut ? { ...item, legIndex: last + 1, stationMm: item.stationMm - cut } : item)) };
    }
    const notes: string[] = [];
    const changed = new Map<string, HvacElement>([[element.id, ductRunElementWithSpec(element, next)]]);
    let refusal: string | null = null;
    for (const branch of taps) {
      if (branch.start.kind !== 'tap') continue;
      const start = branch.start;
      if (start.legIndex === last && start.stationMm > cut) {
        changed.set(branch.element.id, ductRunElementWithSpec(branch.element, { ...branch.spec, start: { ...start, legIndex: last + 1, stationMm: start.stationMm - cut } }));
        continue;
      }
      if (!legSet.has(start.legIndex) || isRoundLeg(spec.legs[start.legIndex]) === isRoundLeg(legs[start.legIndex])) continue;
      const mapped = tapOnNewMain(scene, settings, branch, legs[start.legIndex]!, edit.wholeBranches, notes);
      if (typeof mapped === 'string') {
        refusal = mapped;
        break;
      }
      changed.set(mapped.id, mapped);
    }
    if (refusal) return refuse(refusal);
    const turned = reaimTurningBranches(scene, settings, element.id, changed, notes);
    if (turned) return refuse(`${turned}.`);
    fitElbows(scene, settings, element.id, changed, before, notes);
    const plan = planDuctRunSpec(element.id, readDuctRunSpec(changed.get(element.id)!)!, { settings, scene: scene.map((candidate) => changed.get(candidate.id) ?? candidate) });
    if (!noNewErrors(before, errorCodes(plan))) continue;
    notes.unshift(`The ${splitName} stays as it is: the duct turns back to ${sectionLabel(oldSection)} through a ${transitionName} ${Math.round(neck)} mm before it`);
    return { updates: settle(scene, changed, settings, notes), notes, action };
  }
  return refuse(`No room before the ${splitName} for a ${transitionName}: its last leg is too short (${Math.round(geometry.lengthMm)} mm).`);
}

function editLegSection(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'leg-section' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.legacy) return refuse('An old straight duct stub: redraw it as a duct run to change its size.');
  if (spec.locked) return refuse('The run is locked: unlock it to change its size.');
  const allowed = new Set(rigidLegIndices(spec));
  const clean = (section: DuctLeg): DuctLeg => (isRoundLeg(section) ? roundLeg(section.diameterMm!) : { widthMm: section.widthMm, heightMm: section.heightMm });
  const bySection = new Map(edit.sections.filter((entry) => allowed.has(entry.leg)).map((entry) => [entry.leg, clean(entry.section)]));
  const legSet = new Set(bySection.keys());
  if (legSet.size === 0) return refuse('That part of the run has no section of its own.');
  const legs = spec.legs.map((leg, index) => bySection.get(index) ?? leg);
  const lastRigid = Math.max(...allowed);
  const sizes = [...new Set([...bySection.values()].map(sectionLabel))];
  const what = legSet.size === allowed.size && allowed.size > 1 ? 'run' : legSet.size > 1 ? `${legSet.size} legs` : `leg ${[...legSet][0]! + 1}`;
  const action = `Duct ${what}: ${sizes.length === 1 ? sizes[0] : sizes.join(', ')}`;
  const splitChanges = spec.end.kind === 'split' && legSet.has(lastRigid) && isRoundLeg(spec.legs[lastRigid]) !== isRoundLeg(legs[lastRigid]);
  if (splitChanges && edit.keepSplit) return keepSplitBehindTransition(scene, settings, element, spec, legs, legSet, edit, action);
  const converted = convertSections(scene, settings, element, spec, legs, legSet, lastRigid, edit, action);
  // A split whose outlets cannot take the new fitting (no route turns them) stays as it is, behind a transition
  // (unless a split style was asked for).
  if (!converted.refused || !splitChanges || edit.splitStyle) return converted;
  const kept = keepSplitBehindTransition(scene, settings, element, spec, legs, legSet, edit, action);
  return kept.refused ? converted : kept;
}

/** The legs' new sections with the fittings following: a split's style and its outlets, take-offs, branches that turn, elbows that must fit. */
function convertSections(
  scene: readonly HvacElement[], settings: DuctDesignSettings, element: HvacElement, spec: DuctRunSpec, legs: DuctLeg[], legSet: ReadonlySet<number>, lastRigid: number,
  edit: Extract<DuctSegmentEdit, { kind: 'leg-section' }>, action: string,
): DuctSegmentEditResult {
  const notes: string[] = [];
  let end = spec.end;
  // A split at the end of a last leg that changes shape: a wye on a round run; a Y (a bullhead where the Y's
  // outlets would not fit side by side) on a rectangular one. Its outlets take the new shape and turn with it.
  const outletChanges: Array<{ element: HvacElement; spec: DuctRunSpec }> = [];
  if (end.kind === 'split' && legSet.has(lastRigid) && isRoundLeg(spec.legs[lastRigid]) !== isRoundLeg(legs[lastRigid])) {
    const round = isRoundLeg(legs[lastRigid]);
    const main = legs[lastRigid]!;
    const outlets = ductBranchesOf(element.id, scene).filter((branch) => branch.start.kind === 'split-branch');
    let style: DuctSplitStyle = round ? 'wye' : edit.splitStyle && edit.splitStyle !== 'wye' ? edit.splitStyle : 'y';
    for (const outlet of outlets) {
      const section = outletSection(outlet.spec.legs[0]!, main, round, outlets.length, settings);
      if (!section) return refuse(`${labelOf(outlet.element, outlet.spec, scene)}: no ${round ? 'round' : 'rectangular'} outlet of its friction fits the run.`);
      if (!round && style === 'y' && section.widthMm > main.widthMm / Math.max(1, outlets.length) + 0.5 && !edit.splitStyle) style = 'bullhead';
      const tail = flexTail(outlet.spec) ? outlet.spec.legs.length - 1 : outlet.spec.legs.length;
      const branchLegs = outlet.spec.legs.map((leg, index) => (index === 0 || (edit.wholeBranches && index < tail && isRoundLeg(leg) !== round) ? section : leg));
      if (sectionLabel(section) !== sectionLabel(outlet.spec.legs[0]!)) {
        notes.push(`${labelOf(outlet.element, outlet.spec, scene)}: its first leg becomes ${sectionLabel(section)} (was ${sectionLabel(outlet.spec.legs[0]!)})`);
      }
      outletChanges.push({ element: outlet.element, spec: { ...outlet.spec, legs: branchLegs } });
    }
    end = { kind: 'split', style };
    notes.push(`The split becomes a ${style === 'wye' ? 'wye' : style === 'y' ? 'Y split' : 'bullhead tee'}`);
  }
  const changed = new Map<string, HvacElement>([[element.id, ductRunElementWithSpec(element, { ...spec, legs, end })]]);
  for (const outlet of outletChanges) changed.set(outlet.element.id, ductRunElementWithSpec(outlet.element, outlet.spec));
  for (const branch of ductBranchesOf(element.id, scene)) {
    if (branch.start.kind !== 'tap' || !legSet.has(branch.start.legIndex)) continue;
    if (isRoundLeg(spec.legs[branch.start.legIndex]) === isRoundLeg(legs[branch.start.legIndex])) continue;
    const mapped = tapOnNewMain(scene, settings, branch, legs[branch.start.legIndex]!, edit.wholeBranches, notes);
    if (typeof mapped === 'string') return refuse(mapped);
    changed.set(mapped.id, mapped);
  }
  // Branches whose fitting now leaves at another angle (a lateral off a main made rectangular, a split's outlets) turn with it.
  const turned = reaimTurningBranches(scene, settings, element.id, changed, notes);
  if (turned) return refuse(`${turned}.`);
  fitElbows(scene, settings, element.id, changed, errorCodes(planDuctRunSpec(element.id, spec, { settings, scene })), notes);
  return { updates: settle(scene, changed, settings, notes), notes, action };
}

function editNode(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'node' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.locked) return refuse('The run is locked: unlock it to change its fittings.');
  const nodeOverrides = { ...spec.nodeOverrides };
  const cleaned = edit.override
    ? Object.fromEntries(Object.entries(edit.override).filter(([, value]) => value !== undefined)) as DuctNodeOverride
    : {};
  if (Object.keys(cleaned).length === 0) delete nodeOverrides[String(edit.node)];
  else nodeOverrides[String(edit.node)] = cleaned;
  const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, nodeOverrides })]]);
  const notes: string[] = [];
  return { updates: settle(scene, changed, settings, notes), notes, action: `Duct fitting at node ${edit.node}` };
}

function editTap(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'tap' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.start.kind !== 'tap') return refuse('This run does not start on a take-off.');
  if (spec.locked) return refuse('The run is locked: unlock it to change its take-off.');
  const parent = ductParentOf(spec, scene);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  if (!parent || !parentSpec) return refuse('The run this branch was taken off is missing.');
  const legs = edit.firstLeg ? [edit.firstLeg, ...spec.legs.slice(1)] : spec.legs;
  let next: DuctRunSpec = { ...spec, legs, start: { ...spec.start, style: edit.style } };
  const notes = edit.firstLeg && sectionLabel(edit.firstLeg) !== sectionLabel(spec.legs[0]!)
    ? [`Its first leg becomes ${sectionLabel(edit.firstLeg)} (was ${sectionLabel(spec.legs[0]!)})`] : [];
  const changed = new Map<string, HvacElement>();
  // A fitting that leaves at another angle (a lateral ↔ a 90° tee): the branch turns with it, keeping its end.
  if (branchTurns(parentSpec, next, settings)) {
    const aimed = reaimBranch(scene, settings, parent, parentSpec, element, next);
    if (!aimed) return refuse('No route lets the branch leave at the new angle and keep its end: redraw its first leg.');
    next = aimed.spec;
    for (const sub of aimed.subBranches) changed.set(sub.id, sub);
    notes.push(`The branch turns with it: ${aimed.note}`);
  }
  changed.set(element.id, ductRunElementWithSpec(element, next));
  return { updates: settle(scene, changed, settings, notes), notes, action: `Duct take-off: ${TAKEOFF_TITLES[edit.style]}` };
}

function editStart(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'start' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.locked) return refuse('The run is locked.');
  const start = spec.start;
  if (edit.vcd !== undefined && (start.kind === 'tap' || start.kind === 'split-branch' || start.kind === 'spigot')) {
    const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, start: { ...start, vcd: edit.vcd } })]]);
    return { updates: settle(scene, changed, settings), notes: [], action: edit.vcd ? 'Volume damper added' : 'Volume damper removed' };
  }
  if (edit.connector !== undefined && start.kind === 'unit-port') {
    const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, start: { ...start, connector: edit.connector } })]]);
    return { updates: settle(scene, changed, settings), notes: [], action: edit.connector ? 'Flexible connector added' : 'Flexible connector removed' };
  }
  return refuse('This start has no such accessory.');
}

function editSplit(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'split' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.end.kind !== 'split') return refuse('The run does not end in a split.');
  if (spec.locked) return refuse('The run is locked.');
  const round = isRoundLeg(spec.legs[spec.legs.length - 1]);
  if ((edit.style === 'wye') !== round) return refuse(round ? 'A round run splits by a wye.' : 'A wye splits a round run.');
  const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, end: { kind: 'split', style: edit.style } })]]);
  return { updates: settle(scene, changed, settings), notes: [], action: `Duct split: ${edit.style === 'y' ? 'Y' : edit.style}` };
}

function editFireDamper(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'fire-damper' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  const { penetrations: _previous, ...rest } = spec;
  const overrides = { ...(spec.penetrations ?? {}) };
  if (edit.fireDamper === null || edit.fireDamper === edit.byPolicy) delete overrides[edit.key];
  else overrides[edit.key] = { fireDamper: edit.fireDamper };
  const next: DuctRunSpec = Object.keys(overrides).length ? { ...rest, penetrations: overrides } : rest;
  const changed = new Map([[element.id, ductRunElementWithSpec(element, next)]]);
  const on = edit.fireDamper ?? edit.byPolicy;
  return { updates: settle(scene, changed, settings), notes: [], action: on ? 'Fire damper in the wall' : 'No fire damper in the wall' };
}

function editEnd(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'end' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.end.kind !== 'end-cap' && spec.end.kind !== 'open') return refuse('The run ends on a fitting or a terminal.');
  const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, end: { kind: edit.end } })]]);
  return { updates: settle(scene, changed, settings), notes: [], action: edit.end === 'open' ? 'Duct end left open' : 'Duct end capped' };
}

const unitOf = (a: Point2D): Point2D => {
  const size = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / size, y: a.y / size };
};
const add2 = (a: Point2D, b: Point2D, k = 1): Point2D => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub2 = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
const at = (point: Point2D, z: number): DuctPoint3 => ({ x: point.x, y: point.y, z });

/** s·a + t·b = c, or null when a ∥ b. */
function solve2(a: Point2D, b: Point2D, c: Point2D): { s: number; t: number } | null {
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;
  return { s: (c.x * b.y - c.y * b.x) / det, t: (a.x * c.y - a.y * c.x) / det };
}

type TerminalEnd = Extract<DuctRunSpec['end'], { kind: 'terminal' }>;

/** Straights tried before the spigot for a rigid runout's drop (on its axis, at the run's level), shortest first (mm). */
const RIGID_APPROACH_MM = [150, 300, 500, 800, 1200];
/**
 * Straights tried between a jog onto the spigot's axis and what follows it,
 * longest first: jogging early leaves a straight on the axis that a flexible
 * runout can later take over (FLEX_RUNOUT_MM and its 300 mm behind it) (mm).
 */
const JOG_RUN_MM = [1100, 800, 500, 300];
/** Where a flexible runout leaves rigid duct that runs straight into the spigot: this far before it (the auto layout's first target; mm). */
const FLEX_RUNOUT_MM = 800;

/** The plan direction a run leaves its start in: its fitting's (a take-off's, a collar's), else its first leg's. */
function leavingDirection(scene: readonly HvacElement[], settings: DuctDesignSettings, spec: DuctRunSpec): Point2D | null {
  if (spec.start.kind === 'unit-port') return findAirPort(scene, spec.start.unitId, spec.start.portId)?.normal ?? null;
  const parent = ductParentOf(spec, scene);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  return (parentSpec ? branchAnchor(parentSpec, spec, settings)?.direction : null) ?? startAnchor(spec)?.direction ?? null;
}

/**
 * The run with a flexible runout: the rigid route kept to the top of its drop
 * onto the spigot (or to its last vertex), the flexible duct leaving about
 * FLEX_RUNOUT_MM before the spigot where a level leg heads straight at it —
 * long enough to bend gently onto the spigot, short as SMACNA S3.23 asks —
 * leaving room behind it for the fitting the leg starts at. With a scene, the
 * first of those that plans without a rule the run did not already break
 * (else the first).
 */
function withFlexRunout(
  spec: DuctRunSpec, end: TerminalEnd, neck: number, settings: DuctDesignSettings, check?: { scene: readonly HvacElement[]; runId: string },
): DuctRunSpec {
  const path = spec.path;
  const lip = path[path.length - 1]!;
  let keep = path.length - 2;
  const vertical = (index: number) => Math.hypot(path[index]!.x - path[index - 1]!.x, path[index]!.y - path[index - 1]!.y) < 1 && Math.abs(path[index]!.z - path[index - 1]!.z) > 1;
  const dropped = keep >= 1 && vertical(keep);
  if (dropped) keep -= 1;
  const room = (index: number) => (index === 0 ? settings.tapCollarMm + settings.vcdLengthMm + 150 : 300);
  /** Where on leg `index` (level, heading at the lip) the runout leaves; null to leave from the leg's end. */
  const leave = (index: number, upTo: (length: number) => number): DuctPoint3 | null => {
    const from = path[index]!;
    const to = path[index + 1]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length < 1 || Math.abs(to.z - from.z) > 1) return null;
    const d = unitOf(sub2(to, from));
    if (Math.abs(cross(sub2(lip, from), d)) > 1 || dot(sub2(lip, from), d) <= 0) return null;
    const station = Math.min(Math.max(dot(sub2(lip, from), d) - FLEX_RUNOUT_MM, room(index)), upTo(length));
    return station > 1 && station < length - 1 ? at(add2(from, d, station), from.z) : null;
  };
  const runout = roundLeg(neck);
  const overridesUpTo = (last: number) => Object.fromEntries(Object.entries(spec.nodeOverrides).filter(([node]) => Number(node) <= last));
  const cutAt = (index: number, point: DuctPoint3): DuctRunSpec => keepInlineOnLegs({
    ...spec, path: [...path.slice(0, index + 1), point, lip], legs: [...spec.legs.slice(0, index + 1), runout], nodeOverrides: overridesUpTo(index), end: { ...end, flex: true },
  }, (leg) => (leg <= index ? leg : null));
  const fromVertex = (index: number): DuctRunSpec => keepInlineOnLegs({
    ...spec, path: [...path.slice(0, index + 1), lip], legs: [...spec.legs.slice(0, index), runout], nodeOverrides: overridesUpTo(index - 1), end: { ...end, flex: true },
  }, (leg) => (leg < index ? leg : null));
  const candidates: DuctRunSpec[] = [];
  // The last leg itself, level into the spigot (300 mm of flexible duct at the least) …
  const into = !dropped ? leave(keep, (length) => length - 300) : null;
  if (into) candidates.push(cutAt(keep, into));
  // … the leg before the drop, heading along the spigot's axis …
  const before = keep >= 1 ? leave(keep - 1, (length) => length) : null;
  if (before) candidates.push(cutAt(keep - 1, before));
  // … else from the end of the rigid route, or the vertex before it on the same level.
  candidates.push(fromVertex(keep));
  if (keep >= 1 && Math.abs(path[keep - 1]!.z - path[keep]!.z) <= 1) candidates.push(fromVertex(keep - 1));
  if (!check || candidates.length === 1) return candidates[0]!;
  const baseline = errorCodes(planDuctRunSpec(check.runId, spec, { settings, scene: check.scene }));
  return candidates.find((candidate) => noNewErrors(baseline, errorCodes(planDuctRunSpec(check.runId, candidate, { settings, scene: check.scene })))) ?? candidates[0]!;
}

/**
 * The run with a rigid runout onto the spigot, arriving as the planner asks of
 * a rigid end: level, square to the spigot and on its axis, at its height.
 * Routes are tried with the fewest new fittings first — straight on (the
 * run's last leg already on the spigot's axis), one turn onto the axis, a jog
 * onto it (the last leg parallel to it) — each with the shortest straights
 * that plan without a rule the run did not already break. A spigot above or
 * below the run is reached by a drop on its axis: two elbows, or an offset
 * where the drop is short (the planner's choice). Why not, when none fits.
 */
function withRigidRunout(
  scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, spec: DuctRunSpec, end: TerminalEnd, port: DuctAirPort, neck: number,
): DuctRunSpec | string {
  const runout = roundLeg(neck);
  const lip: DuctPoint3 = { x: port.lip.x, y: port.lip.y, z: port.lip.z - neck / 2 };
  const rigid = spec.path.slice(0, -1);
  const last = rigid[rigid.length - 1]!;
  const before = rigid.length >= 2 ? rigid[rigid.length - 2]! : null;
  if (before && Math.abs(last.z - before.z) > 1) return 'the run reaches its runout down a riser; draw the rigid runout by hand';
  const into = unitOf({ x: -port.normal.x, y: -port.normal.y });
  const e = before ? unitOf(sub2(last, before)) : leavingDirection(scene, settings, spec);
  if (!e) return 'the run has no direction to leave in';
  const base = before ? rigid.slice(0, -1) : rigid;
  const from = base[base.length - 1]!;
  const baseLegs = spec.legs.slice(0, base.length - 1);
  const lastSection = before ? spec.legs[rigid.length - 2]! : runout;
  const reduce = !sameSectionSize(lastSection, runout);
  const level = last.z;
  const drop = Math.abs(level - lip.z) > 1;
  const nodeOverrides = Object.fromEntries(Object.entries(spec.nodeOverrides).filter(([node]) => Number(node) < base.length));
  const baseline = errorCodes(planDuctRunSpec(runId, spec, { settings, scene }));
  const accept = (points: DuctPoint3[], legs: DuctLeg[]): DuctRunSpec | null => {
    // Every rigid leg keeps its start and heading (the last one runs on, or to a new corner): their accessories stay.
    const candidate: DuctRunSpec = keepInlineOnLegs({ ...spec, path: [...base, ...points], legs: [...baseLegs, ...legs], nodeOverrides, end: { ...end, flex: false } },
      (leg) => (before && leg <= base.length - 1 ? leg : null));
    return noNewErrors(baseline, errorCodes(planDuctRunSpec(runId, candidate, { settings, scene }))) ? candidate : null;
  };
  // From a point on the spigot's axis at the run's level: down (or up) to its height, then in; level: straight in.
  const approaches = drop ? RIGID_APPROACH_MM : [0];
  const tail = (approach: number) => {
    const a = add2(lip, port.normal, approach);
    return drop ? { a, points: [at(a, level), at(a, lip.z), lip], legs: [runout, runout, runout] } : { a, points: [lip], legs: [runout] };
  };
  const onAxis = (point: Point2D) => Math.abs(cross(sub2(point, lip), into)) < 1;
  const parallel = dot(e, into) > 0.9999;
  // 1. Straight on: the last leg already on the spigot's axis, heading into it (a reducer where it was larger).
  if (parallel && onAxis(last)) {
    for (const approach of approaches) {
      const { a, points, legs } = tail(approach);
      if (dot(sub2(a, reduce ? last : from), into) < 1) continue;
      const found = reduce ? accept([at(last, level), ...points], [lastSection, ...legs]) : accept(points, legs);
      if (found) return found;
    }
  }
  // 2. One turn: off the last leg's line onto the spigot's axis.
  const hit = !parallel ? solve2(e, into, sub2(lip, from)) : null;
  if (hit && hit.s > 1 && hit.t > 1) {
    const corner = at(add2(from, e, hit.s), level);
    for (const approach of approaches) {
      if (hit.t - approach < 1) break;
      const { points, legs } = tail(approach);
      const found = accept([corner, ...points], [lastSection, ...legs]);
      if (found) return found;
    }
  }
  // 3. A jog onto the axis: the last leg parallel to it, beside it.
  if (parallel && !onAxis(last)) {
    const r = sub2(lip, from);
    const along = dot(r, into);
    const beside = { x: r.x - into.x * along, y: r.y - into.y * along };
    for (const approach of approaches) {
      for (const straight of JOG_RUN_MM) {
        const { a, points, legs } = tail(approach);
        const j2 = add2(a, port.normal, straight);
        const j1 = sub2(j2, beside);
        if (dot(sub2(j1, from), e) < 1) continue;
        const found = accept([at(j1, level), at(j2, level), ...points], [lastSection, runout, ...legs]);
        if (found) return found;
      }
    }
  }
  return dot(e, into) < -1e-6 || (hit !== null && hit.t <= 1) ? 'its spigot faces away from the run (turn the terminal\'s spigot, or keep the runout flexible)'
    : 'no rigid route fits between the run and the spigot (keep the runout flexible, or move the terminal)';
}

/**
 * A runout made rigid or flexible. Rigid: spiral duct at the spigot's
 * diameter, arriving level, square to the spigot and on its axis
 * (withRigidRunout). Flexible: the rigid route kept to where the runout
 * leaves it (withFlexRunout).
 */
function editRunout(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'runout' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.end.kind !== 'terminal') return refuse('The run does not end on an air terminal.');
  if (spec.locked) return refuse('The run is locked.');
  const end = spec.end;
  if (end.flex === edit.flex) return refuse(edit.flex ? 'The runout is flexible already.' : 'The runout is rigid already.');
  const port = findTerminalPort(scene, end.terminalId, end.portId);
  if (!port) return refuse('Its terminal is missing.');
  const neck = port.diameterMm ?? spec.legs[spec.legs.length - 1]!.diameterMm ?? 200;
  let next: DuctRunSpec;
  if (edit.flex) {
    next = withFlexRunout(spec, end, neck, settings, { scene, runId: element.id });
  } else {
    const rigid = withRigidRunout(scene, settings, element.id, spec, end, port, neck);
    if (typeof rigid === 'string') return refuse(`No rigid runout here: ${rigid}.`);
    next = rigid;
  }
  const changed = new Map([[element.id, ductRunElementWithSpec(element, next)]]);
  const notes = edit.flex
    ? [`flexible duct from ${next.path.length >= 3 ? 'the rigid duct' : 'its take-off'} to the spigot`]
    : [`a rigid Ø${Math.round(neck)} runout, arriving square on the spigot's axis${next.path.some((point, index) => index > 0 && Math.abs(point.z - next.path[index - 1]!.z) > 1) ? ', dropping to its height' : ''}`];
  return { updates: settle(scene, changed, settings, notes), notes, action: edit.flex ? 'Flexible runout' : 'Rigid runout' };
}

/**
 * Another face or neck for the terminal a run ends on: its box resized about
 * its centre, its tag following its type, and the runs on its spigot
 * following it — the runout (its legs at the old neck, back from the spigot)
 * takes the new neck, a flexible one re-curves, a rigid one is re-made onto
 * the new spigot.
 */
function editTerminal(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'terminal' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.terminalId);
  const spec = element ? readDuctTerminalSpec(element) : null;
  if (!element || !spec) return refuse('The terminal is no longer in the drawing.');
  const kind = edit.face ?? spec.kind;
  const neck = edit.neckMm ?? spec.neckDiameterMm;
  const airflow = edit.airflowM3h !== undefined ? (edit.airflowM3h !== null && edit.airflowM3h > 0 ? Math.round(edit.airflowM3h) : null) : spec.designAirflowM3h ?? null;
  if (kind === spec.kind && neck === spec.neckDiameterMm) {
    // Its design airflow alone: the system's figures and sizing read it; nothing moves.
    if (airflow === (spec.designAirflowM3h ?? null)) return refuse('It is that already.');
    const updated: HvacElement = { ...element, properties: { ...element.properties, terminal: { ...spec, designAirflowM3h: airflow } } };
    return {
      updates: [updated], notes: [airflow ? `its design airflow ${airflow} m³/h` : 'an equal share of the system airflow'],
      action: `Terminal ${element.label}: ${airflow ? `${airflow} m³/h` : 'airflow shared'}`,
    };
  }
  const shaped = typicalTerminalSpec(kind, neck, {
    service: spec.service, mount: spec.mount, filter: spec.service === 'return' ? spec.filter ?? null : null,
    ...(spec.slots !== undefined ? { slots: spec.slots } : {}),
    ...(spec.kind === 'linear-slot' && kind === 'linear-slot' ? { lengthMm: spec.faceWidthMm } : {}),
  });
  const reshaped = { ...shaped, spigotSide: spec.spigotSide, designAirflowM3h: airflow };
  const oldTag = terminalTypeTag(spec);
  const retag = TERMINAL_TAG_PATTERN.exec(element.label.trim())?.[1] === oldTag && terminalTypeTag(reshaped) !== oldTag;
  const envelope = terminalEnvelope(reshaped);
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const moved: HvacElement = {
    ...element,
    position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    label: retag ? nextTerminalTag(scene, reshaped) : element.label,
    properties: { ...element.properties, terminal: reshaped },
  };
  const after = scene.map((candidate) => (candidate.id === element.id ? moved : candidate));
  const port = findTerminalPort(after, element.id);
  const changed = new Map<string, HvacElement>([[moved.id, moved]]);
  const notes: string[] = [];
  const oldNeck = roundLeg(spec.neckDiameterMm);
  for (const run of scene) {
    const runSpec = readDuctRunSpec(run);
    if (!port || !runSpec || runSpec.end.kind !== 'terminal' || runSpec.end.terminalId !== element.id) continue;
    const legs = [...runSpec.legs];
    if (neck !== spec.neckDiameterMm) {
      for (let index = legs.length - 1; index >= 0 && sameSectionSize(legs[index]!, oldNeck); index -= 1) legs[index] = roundLeg(neck);
    }
    let next: DuctRunSpec = { ...runSpec, legs, path: [...runSpec.path.slice(0, -1), { x: port.lip.x, y: port.lip.y, z: port.lip.z - neck / 2 }] };
    if (!runSpec.end.flex) {
      const rigid = withRigidRunout(after, settings, run.id, withFlexRunout(next, runSpec.end, neck, settings), runSpec.end, port, neck);
      if (typeof rigid === 'string') notes.push(`its rigid runout no longer meets the spigot: ${rigid}`);
      else next = rigid;
    }
    changed.set(run.id, ductRunElementWithSpec(run, next));
  }
  if (kind !== spec.kind) notes.unshift(`a ${terminalLabel(reshaped).toLowerCase()} (${envelope.widthMm} × ${envelope.depthMm}), on its centre; its runout follows the spigot`);
  if (neck !== spec.neckDiameterMm) notes.unshift(`its runout becomes Ø${neck}`);
  if (retag) notes.push(`it is tagged ${moved.label}`);
  return { updates: settle(scene, changed, settings, notes), notes, action: `Terminal ${element.label}: ${kind !== spec.kind ? terminalLabel(reshaped).toLowerCase() : `neck Ø${neck}`}` };
}

export const INLINE_TITLES: Record<DuctInlineKind, string> = { damper: 'Volume damper', 'access-door': 'Access door', attenuator: 'Sound attenuator' };

/**
 * A run's accessories on the legs it keeps after its path changed: `legOf`
 * maps an old leg to its new index, null where the leg went (and its
 * accessories with it).
 */
export function keepInlineOnLegs(spec: DuctRunSpec, legOf: (legIndex: number) => number | null): DuctRunSpec {
  if (!spec.inline?.length) return spec;
  const { inline, ...rest } = spec;
  const kept = inline.flatMap((item) => {
    const legIndex = legOf(item.legIndex);
    return legIndex === null ? [] : [{ ...item, legIndex }];
  });
  return kept.length ? { ...rest, inline: kept } : rest;
}

/** Where along its leg (mm from the leg's start) each of a run's legs starts along the run. */
function legStarts(spec: DuctRunSpec): number[] {
  const legs = ductLegs(spec);
  return legs.map((_, index) => legs.slice(0, index).reduce((total, leg) => total + leg.lengthMm, 0));
}

const INLINE_CLASH = 'DU_INLINE_CLASH';

/** Spots tried along a straight stretch for an accessory: this far apart at most (mm), and no more than this many per stretch. */
const PLACE_STEP_MM = 50;
const PLACE_MAX_STEPS = 60;

/**
 * The clear spot for an accessory nearest the station asked for: the planner's
 * own rule (on the leg's straight, clear of fittings, take-offs, walls and the
 * other accessories), tried at that station and then along the leg's straight
 * stretches (adjoining sections as one), nearest first; null when none is
 * clear.
 */
export function placeInlineAccessory(
  scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, spec: DuctRunSpec, accessory: DuctInlineAccessory,
): DuctInlineAccessory | null {
  const section = spec.legs[accessory.legIndex];
  if (!section) return null;
  const half = inlineAccessoryLengthMm(accessory, section, settings) / 2;
  const clashes = (candidate: DuctRunSpec) => planDuctRunSpec(runId, candidate, { settings, scene }).issues.filter((issue) => issue.code === INLINE_CLASH).length;
  const baseline = clashes(spec);
  const withItem = (stationMm: number): DuctRunSpec => ({ ...spec, inline: [...(spec.inline ?? []), { ...accessory, stationMm }] });
  // Candidate centres: as asked; then along each straight stretch of the leg (its sections end to end), every step or so.
  const start = legStarts(spec)[accessory.legIndex] ?? 0;
  const plan = planDuctRunSpec(runId, spec, { settings, scene });
  const stretches: Array<{ from: number; to: number }> = [];
  for (const piece of plan.pieces.filter((candidate) => candidate.legIndex === accessory.legIndex && candidate.kind === 'straight')) {
    const last = stretches[stretches.length - 1];
    if (last && Math.abs(piece.stationStartMm - start - last.to) < 0.5) last.to = piece.stationEndMm - start;
    else stretches.push({ from: piece.stationStartMm - start, to: piece.stationEndMm - start });
  }
  const candidates = [accessory.stationMm];
  for (const stretch of stretches) {
    const from = stretch.from + half + 20;
    const to = stretch.to - half - 20;
    if (to < from) continue;
    const step = Math.max(PLACE_STEP_MM, (to - from) / PLACE_MAX_STEPS);
    candidates.push(Math.min(Math.max(accessory.stationMm, from), to), to);
    for (let at = from; at < to; at += step) candidates.push(at);
  }
  const seen = new Set<number>();
  const ordered = candidates.map((value) => Math.round(value)).filter((value) => value >= half && !seen.has(value) && seen.add(value))
    .sort((a, b) => Math.abs(a - accessory.stationMm) - Math.abs(b - accessory.stationMm));
  for (const stationMm of ordered) {
    if (clashes(withItem(stationMm)) <= baseline) return { ...accessory, stationMm };
  }
  return null;
}

function editInline(
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  edit: Extract<DuctSegmentEdit, { kind: 'inline-add' | 'inline-remove' | 'inline-length' }>,
): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.legacy) return refuse('An old straight duct stub: redraw it as a duct run to add accessories to it.');
  if (spec.locked) return refuse('The run is locked: unlock it to change its accessories.');
  let inline = [...(spec.inline ?? [])];
  const notes: string[] = [];
  let action: string;
  if (edit.kind === 'inline-add') {
    const id = nextInlineId(spec.inline);
    let placed = placeInlineAccessory(scene, settings, element.id, spec, { ...edit.accessory, id });
    // An attenuator too long for any clear straight here: the longest shorter catalogue length that fits.
    if (!placed && edit.accessory.kind === 'attenuator') {
      const asked = edit.accessory.lengthMm ?? 900;
      for (const lengthMm of [...DUCT_ATTENUATOR_LENGTHS_MM].filter((length) => length < asked).sort((a, b) => b - a)) {
        placed = placeInlineAccessory(scene, settings, element.id, spec, { ...edit.accessory, id, lengthMm });
        if (placed) {
          notes.push(`a ${lengthMm} mm attenuator: the ${asked} mm one finds no clear straight here`);
          break;
        }
      }
    }
    if (!placed) return refuse(`No clear straight on this leg takes ${edit.accessory.kind === 'access-door' ? 'an' : 'a'} ${INLINE_TITLES[edit.accessory.kind].toLowerCase()} (fittings, take-offs or walls are in the way).`);
    if (Math.abs(placed.stationMm - edit.accessory.stationMm) > 1) notes.push(`placed ${Math.round(Math.abs(placed.stationMm - edit.accessory.stationMm))} mm ${placed.stationMm > edit.accessory.stationMm ? 'on' : 'back'}, clear of the fittings and take-offs`);
    inline.push(placed);
    action = `${INLINE_TITLES[placed.kind]} added`;
  } else {
    const item = inline.find((candidate) => candidate.id === edit.id);
    if (!item) return refuse('The accessory is no longer on the run.');
    if (edit.kind === 'inline-remove') {
      inline = inline.filter((candidate) => candidate.id !== edit.id);
      action = `${INLINE_TITLES[item.kind]} removed`;
    } else {
      if (item.kind !== 'attenuator') return refuse('Only a sound attenuator comes in lengths.');
      // Its new length, at the clear spot nearest where it is (a longer one may need to move off a fitting or take-off).
      const others: DuctRunSpec = { ...spec, inline: inline.filter((candidate) => candidate.id !== edit.id) };
      const placed = placeInlineAccessory(scene, settings, element.id, others, { ...item, lengthMm: edit.lengthMm });
      if (!placed) return refuse(`No clear straight on this leg takes a ${edit.lengthMm} mm attenuator (fittings, take-offs or walls are in the way).`);
      if (Math.abs(placed.stationMm - item.stationMm) > 1) notes.push(`moved ${Math.round(Math.abs(placed.stationMm - item.stationMm))} mm ${placed.stationMm > item.stationMm ? 'on' : 'back'}, clear of the fittings and take-offs`);
      inline = inline.map((candidate) => (candidate.id === edit.id ? placed : candidate));
      action = `Sound attenuator ${edit.lengthMm} mm`;
    }
  }
  const { inline: _previous, ...rest } = spec;
  const changed = new Map([[element.id, ductRunElementWithSpec(element, inline.length ? { ...rest, inline } : rest)]]);
  return { updates: settle(scene, changed, settings, notes), notes, action };
}

/** An accessory moved along its leg, or a door of the designer's size; the planner says if it no longer fits. */
function editInlineValue(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'inline-move' | 'inline-door' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.locked) return refuse('The run is locked: unlock it to change its accessories.');
  const item = spec.inline?.find((candidate) => candidate.id === edit.id);
  if (!item) return refuse('The accessory is no longer on the run.');
  const legLength = ductLegs(spec)[item.legIndex]?.lengthMm ?? 0;
  let next: DuctInlineAccessory;
  let action: string;
  const notes: string[] = [];
  if (edit.kind === 'inline-move') {
    const asked = Math.round(Math.max(0, Math.min(legLength, edit.stationMm)));
    if (Math.abs(asked - item.stationMm) < 0.5) return refuse('It is there already.');
    // The clear spot nearest the one asked (a fitting, a take-off or a wall may be in the way): an accessory on a clash is not laid.
    const others: DuctRunSpec = { ...spec, inline: (spec.inline ?? []).filter((candidate) => candidate.id !== edit.id) };
    const placed = placeInlineAccessory(scene, settings, element.id, others, { ...item, stationMm: asked });
    if (!placed) return refuse(`No clear straight on this leg takes the ${INLINE_TITLES[item.kind].toLowerCase()} there (fittings, take-offs or walls are in the way).`);
    if (Math.abs(placed.stationMm - item.stationMm) < 0.5) return refuse('It cannot go further that way: it sits as close to the fittings and take-offs as it can.');
    if (Math.abs(placed.stationMm - asked) > 1) notes.push(`placed ${Math.round(Math.abs(placed.stationMm - asked))} mm ${placed.stationMm > asked ? 'on' : 'back'} from there, clear of the fittings and take-offs`);
    next = placed;
    action = `${INLINE_TITLES[item.kind]} moved to ${Math.round(placed.stationMm)} mm along leg ${item.legIndex + 1}`;
  } else {
    if (item.kind !== 'access-door') return refuse('Only an access door has a door size.');
    const doorMm = Math.round(Math.max(100, Math.min(600, edit.doorMm)) / 10) * 10;
    const section = spec.legs[item.legIndex];
    if (doorMm === (section ? accessDoorFor(section, item.doorMm).sizeMm : item.doorMm)) return refuse('It is that size already.');
    next = { ...item, doorMm };
    action = `Access door ${doorMm}×${doorMm}`;
  }
  const inline = (spec.inline ?? []).map((candidate) => (candidate.id === edit.id ? next : candidate));
  const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, inline })]]);
  return { updates: settle(scene, changed, settings, notes), notes, action };
}

/** A take-off moved along its main leg: the branch's first leg slides with it, its end staying on its terminal. */
function editTapStation(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'tap-station' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.start.kind !== 'tap') return refuse('This run does not start on a take-off.');
  if (spec.locked) return refuse('The run is locked: unlock it to move its take-off.');
  const parent = ductParentOf(spec, scene);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  const leg = parentSpec ? ductLegs(parentSpec)[spec.start.legIndex] : undefined;
  if (!leg) return refuse('The run this branch was taken off is missing.');
  const stationMm = Math.round(Math.max(0, Math.min(leg.lengthMm, edit.stationMm)));
  const moved = stationMm - spec.start.stationMm;
  if (Math.abs(moved) < 0.5) return refuse('It is there already.');
  const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, start: { ...spec.start, stationMm } })]]);
  const notes = ['the branch slides with it, still ending where it did'];
  return { updates: settle(scene, changed, settings, notes), notes, action: `Take-off moved ${Math.round(Math.abs(moved))} mm ${moved > 0 ? 'on' : 'back'} along the main` };
}

/**
 * A flexible runout of the length asked: its start moves along the rigid
 * leg before it (that leg runs on or stops short), a few rounds against the
 * planner's own curve so the length comes out as asked; never closer to the
 * fitting the leg starts at than its joint needs.
 */
function editRunoutLength(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: Extract<DuctSegmentEdit, { kind: 'runout-length' }>): DuctSegmentEditResult {
  const element = scene.find((candidate) => candidate.id === edit.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  if (!element || !spec) return refuse('The run is no longer in the drawing.');
  if (spec.end.kind !== 'terminal' || !spec.end.flex) return refuse('The run does not end on a flexible runout.');
  if (spec.locked) return refuse('The run is locked.');
  const n = spec.path.length;
  if (n < 3) return refuse('The runout is flexible from its take-off: there is no rigid duct before it to run on or stop short.');
  const q = spec.path[n - 3]!;
  const p = spec.path[n - 2]!;
  if (Math.abs(p.z - q.z) > 1 || Math.hypot(p.x - q.x, p.y - q.y) < 1) return refuse('The rigid duct reaches the runout down a riser; move its end by hand.');
  const target = Math.max(300, Math.min(3000, edit.flexMm));
  const d = unitOf({ x: p.x - q.x, y: p.y - q.y });
  const lip = spec.path[n - 1]!;
  const now = Math.hypot(p.x - q.x, p.y - q.y);
  // The stub can be no shorter than its take-off's collar and damper (or than it is, which the planner already takes);
  // beyond a vertex, no shorter than an elbow's room. It runs on at most to 150 mm short of the spigot.
  const start = spec.start;
  const fittings = (start.kind === 'tap' ? settings.tapCollarMm : 0) + ('vcd' in start && start.vcd ? settings.vcdLengthMm : 0);
  const lo = Math.min(now, n - 3 === 0 ? fittings + 20 : 300);
  const hi = Math.max(lo, dot(sub2(lip, q), d) - 150);
  const lengthOf = (along: number) => {
    const plan = planDuctRunSpec(element.id, withStart(along), { settings, scene });
    return plan.pieces.find((piece) => piece.kind === 'flex')?.lengthMm ?? null;
  };
  function withStart(along: number): DuctRunSpec {
    return { ...spec!, path: [...spec!.path.slice(0, n - 2), at(add2(q, d, along), p.z), lip] };
  }
  // The runout shortens as the stub runs on: bisect for the length asked, within what the stub allows.
  const longest = lengthOf(lo);
  const shortest = lengthOf(hi);
  if (longest === null || shortest === null) return refuse('The runout cannot be made that length here.');
  const notes: string[] = [];
  let along: number;
  if (target >= longest) {
    along = lo;
    if (target - longest > 20) notes.push(`${Math.round(longest)} mm: as long as the rigid duct before it allows`);
  } else if (target <= shortest) {
    along = hi;
    if (shortest - target > 20) notes.push(`${Math.round(shortest)} mm: as short as the spigot allows`);
  } else {
    let a = lo;
    let b = hi;
    for (let round = 0; round < 16 && b - a > 1; round += 1) {
      const middle = (a + b) / 2;
      const length = lengthOf(middle) ?? target;
      if (length > target) a = middle;
      else b = middle;
    }
    along = (a + b) / 2;
  }
  const reached = lengthOf(along);
  if (Math.abs(along - now) < 0.5) return refuse('The runout is that length already, or cannot be made that length here.');
  const changed = new Map([[element.id, ductRunElementWithSpec(element, withStart(along))]]);
  return { updates: settle(scene, changed, settings, notes), notes, action: `Flexible runout ${Math.round(reached ?? target)} mm` };
}

/** Apply an edit to the drawing: every element it changes, or why it cannot be made. */
export function applyDuctSegmentEdit(scene: readonly HvacElement[], settings: DuctDesignSettings, edit: DuctSegmentEdit): DuctSegmentEditResult {
  switch (edit.kind) {
    case 'leg-section': return editLegSection(scene, settings, edit);
    case 'node': return editNode(scene, settings, edit);
    case 'tap': return editTap(scene, settings, edit);
    case 'start': return editStart(scene, settings, edit);
    case 'split': return editSplit(scene, settings, edit);
    case 'fire-damper': return editFireDamper(scene, settings, edit);
    case 'end': return editEnd(scene, settings, edit);
    case 'runout': return editRunout(scene, settings, edit);
    case 'terminal': return editTerminal(scene, settings, edit);
    case 'inline-add':
    case 'inline-remove':
    case 'inline-length': return editInline(scene, settings, edit);
    case 'inline-move':
    case 'inline-door': return editInlineValue(scene, settings, edit);
    case 'tap-station': return editTapStation(scene, settings, edit);
    case 'runout-length': return editRunoutLength(scene, settings, edit);
    default: return refuse('Unknown edit.');
  }
}
