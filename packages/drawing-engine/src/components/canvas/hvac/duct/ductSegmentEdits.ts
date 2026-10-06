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
import type { HvacElement } from '../../../../types';

import { tapAttachment } from './ductBranches';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { ductRunElementWithSpec, reanchorBranchesKeepingEnds } from './ductFollow';
import { runSectionSheetMm } from './ductGauge';
import { ductLegs } from './ductGeometry';
import { ductBranchesOf, ductParentOf } from './ductNetwork';
import { maxRoundBranchMm } from './ductRoundFittings';
import { roundEquivalents } from './ductSectionEquivalents';
import { sectionLabel, TAKEOFF_TITLES } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { readDuctTerminalSpec } from './ductTerminals';
import {
  isRoundLeg,
  readDuctRunSpec,
  roundLeg,
  type DuctLeg,
  type DuctNodeOverride,
  type DuctRunSpec,
  type DuctSplitStyle,
  type DuctTapStyle,
} from './ductTypes';

export type DuctSegmentEdit =
  /** Legs of a run take new sections; `wholeBranches`: a branch made round by a main's new shape is round all along. */
  | { kind: 'leg-section'; runId: string; sections: ReadonlyArray<{ leg: number; section: DuctLeg }>; wholeBranches?: boolean }
  /** A node's fitting choices (null = the project's). */
  | { kind: 'node'; runId: string; node: number; override: DuctNodeOverride | null }
  /** A branch's take-off fitting, and its first leg with it (a round collar takes a round branch). */
  | { kind: 'tap'; runId: string; style: DuctTapStyle; firstLeg?: DuctLeg }
  /** The volume damper after a take-off, or the flexible connector at the unit. */
  | { kind: 'start'; runId: string; vcd?: boolean; connector?: boolean }
  | { kind: 'split'; runId: string; style: DuctSplitStyle }
  /** A fire damper at a wall crossing (null = as the project's policy says). */
  | { kind: 'fire-damper'; runId: string; key: string; fireDamper: boolean | null; byPolicy: boolean }
  | { kind: 'end'; runId: string; end: 'end-cap' | 'open' };

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
 * no square counterpart without turning its branch.
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
  if (style === 'round-lateral') return { refused: 'its 45° lateral leaves the main at 45°; a rectangular main takes square take-offs only (change it to a 90° tee first)' };
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
  if (spec.end.kind === 'terminal') {
    const terminalId = spec.end.terminalId;
    const terminal = scene.find((candidate) => candidate.id === terminalId);
    if (terminal) return `The take-off to ${terminal.label || (readDuctTerminalSpec(terminal)?.kind ?? 'a terminal')}`;
  }
  return `The take-off ${element.label ? `of ${element.label}` : ''}`.trim();
}

/** Whether the run ends on a flexible runout (its last leg is the runout's, not the run's). */
function flexTail(spec: DuctRunSpec): boolean {
  return spec.end.kind === 'terminal' && spec.end.flex && spec.path.length >= 3;
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
  const notes: string[] = [];
  let end = spec.end;
  const lastRigid = Math.max(...allowed);
  // A split at the end of a last leg that changes shape: a Y or bullhead on a rectangular run, a wye on a round one.
  if (end.kind === 'split' && legSet.has(lastRigid) && isRoundLeg(spec.legs[lastRigid]) !== isRoundLeg(legs[lastRigid])) {
    const outlets = ductBranchesOf(element.id, scene).filter((branch) => branch.start.kind === 'split-branch');
    if (outlets.length > 0) return refuse('The run ends in a split whose outlets leave at another angle in the other shape: change the split first.');
    end = { kind: 'split', style: isRoundLeg(legs[lastRigid]) ? 'wye' : 'y' };
  }
  const changed = new Map<string, HvacElement>([[element.id, ductRunElementWithSpec(element, { ...spec, legs, end })]]);
  const stock = settings.autoRoundSizesMm;
  for (const branch of ductBranchesOf(element.id, scene)) {
    if (branch.start.kind !== 'tap' || !legSet.has(branch.start.legIndex)) continue;
    const before = spec.legs[branch.start.legIndex]!;
    const section = legs[branch.start.legIndex]!;
    if (isRoundLeg(before) === isRoundLeg(section)) continue;
    const label = labelOf(branch.element, branch.spec, scene);
    let branchLegs = branch.spec.legs;
    const first = branchLegs[0]!;
    if (isRoundLeg(section) && !isRoundLeg(first)) {
      const round = roundBranchFor(first, section.diameterMm!, stock);
      const tail = flexTail(branch.spec) ? branchLegs.length - 1 : branchLegs.length;
      branchLegs = branchLegs.map((leg, index) => (index === 0 || (edit.wholeBranches && index < tail && !isRoundLeg(leg)) ? round : leg));
      notes.push(`${label}: its ${edit.wholeBranches ? 'duct' : 'first leg'} becomes ${sectionLabel(round)} (was ${sectionLabel(first)})`);
    }
    const mapped = tapStyleForMain(branch.start.style, isRoundLeg(section), section, branchLegs[0]!.diameterMm ?? branchLegs[0]!.heightMm, settings);
    if ('refused' in mapped) return refuse(`${label}: ${mapped.refused}.`);
    if (mapped.style !== branch.start.style) notes.push(`${label} becomes a ${TAKEOFF_TITLES[mapped.style].toLowerCase().replace(/ \(y\)$/, '')}`);
    changed.set(branch.element.id, ductRunElementWithSpec(branch.element, { ...branch.spec, legs: branchLegs, start: { ...branch.start, style: mapped.style } }));
  }
  const sizes = [...new Set([...bySection.values()].map(sectionLabel))];
  const what = legSet.size === allowed.size && allowed.size > 1 ? 'run' : legSet.size > 1 ? `${legSet.size} legs` : `leg ${[...legSet][0]! + 1}`;
  return { updates: settle(scene, changed, settings, notes), notes, action: `Duct ${what}: ${sizes.length === 1 ? sizes[0] : sizes.join(', ')}` };
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
  if ((spec.start.style === 'round-lateral') !== (edit.style === 'round-lateral')) {
    return refuse('The branch would leave the main at another angle: its route has to turn with it.');
  }
  const parent = ductParentOf(spec, scene);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  if (!parentSpec) return refuse('The run this branch was taken off is missing.');
  const legs = edit.firstLeg ? [edit.firstLeg, ...spec.legs.slice(1)] : spec.legs;
  const changed = new Map([[element.id, ductRunElementWithSpec(element, { ...spec, legs, start: { ...spec.start, style: edit.style } })]]);
  const notes = edit.firstLeg && sectionLabel(edit.firstLeg) !== sectionLabel(spec.legs[0]!)
    ? [`Its first leg becomes ${sectionLabel(edit.firstLeg)} (was ${sectionLabel(spec.legs[0]!)})`] : [];
  return { updates: settle(scene, changed, settings), notes, action: `Duct take-off: ${TAKEOFF_TITLES[edit.style]}` };
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
    default: return refuse('Unknown edit.');
  }
}
