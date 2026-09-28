/**
 * Starting a branch run: the draft origin for a take-off on a run's side or
 * for one outlet of a split at a run's end, and what the cursor is over. Used
 * by the duct tool, the scripted debug handle and the tests, so all of them
 * start branches from exactly the same geometry the planner checks.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { legNormal, splitOutlet, tapAttachment } from './ductBranches';
import type { DuctDraftOrigin } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { resolveSectionConstruction } from './ductGauge';
import { add, dot, ductLegs, scale, sub } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import { plenumGeometry, spigotAttachment } from './ductPlenum';
import type { DuctDesignSettings } from './ductSettings';
import {
  isDuctElement,
  isRoundLeg,
  isRoundMainTapStyle,
  readDuctRunSpec,
  roundLeg,
  type DuctLeg,
  type DuctRunSpec,
  type DuctSide,
  type DuctSpigotFace,
  type DuctSplitStyle,
  type DuctTapStyle,
} from './ductTypes';

function parentSheetMm(spec: DuctRunSpec, section: DuctLeg, settings: DuctDesignSettings): number {
  return resolveSectionConstruction({
    widthMm: section.widthMm, heightMm: section.heightMm, service: spec.service, construction: spec.construction,
    settings, pressureClassPa: spec.pressureClassPa, jointSystem: spec.jointSystem, gaugeOverrideMm: spec.gaugeOverrideMm,
  }).sheetThicknessMm ?? 1;
}

/**
 * A branch may not be taller than its parent (flat bottom, shared); a round
 * branch stays round, and a round main takes round branches only.
 */
export function clampBranchSection(branch: DuctLeg, parentSection: DuctLeg): DuctLeg {
  if (isRoundLeg(parentSection)) {
    const wanted = isRoundLeg(branch) ? branch.diameterMm! : Math.min(branch.widthMm, branch.heightMm);
    return roundLeg(Math.min(wanted, parentSection.diameterMm!));
  }
  if (isRoundLeg(branch)) return roundLeg(Math.min(branch.diameterMm!, parentSection.heightMm));
  return { widthMm: branch.widthMm, heightMm: Math.min(branch.heightMm, parentSection.heightMm) };
}

/** The split style a run's end takes: a round main splits by a wye, a rectangular run by a Y or bullhead. */
export function splitStyleFor(lastSection: DuctLeg, requested: DuctSplitStyle): DuctSplitStyle {
  if (isRoundLeg(lastSection)) return 'wye';
  return requested === 'wye' ? 'y' : requested;
}

export function tapOrigin(
  parent: HvacElement,
  settings: DuctDesignSettings,
  request: { legIndex: number; stationMm: number; side: DuctSide; style: DuctTapStyle; vcd: boolean },
  branch: DuctLeg,
): DuctDraftOrigin | null {
  const spec = readDuctRunSpec(parent);
  const section = spec?.legs[request.legIndex];
  if (!spec || !section) return null;
  const attachment = tapAttachment(spec, request, branch, parentSheetMm(spec, section, settings), settings);
  if (!attachment) return null;
  return {
    kind: 'tap', parentRunId: parent.id, legIndex: request.legIndex, stationMm: request.stationMm, side: request.side,
    style: request.style, vcd: request.vcd, point: attachment.wallPoint, direction: attachment.direction,
    bottomZ: attachment.bottomZ, service: spec.service, parentHeightMm: section.heightMm,
  };
}

export function splitOrigin(
  parent: HvacElement,
  settings: DuctDesignSettings,
  request: { side: DuctSide; style: DuctSplitStyle; vcd: boolean },
  branch: DuctLeg,
): DuctDraftOrigin | null {
  const spec = readDuctRunSpec(parent);
  if (!spec) return null;
  const last = spec.legs[spec.legs.length - 1]!;
  const style = spec.end.kind === 'split' ? spec.end.style : splitStyleFor(last, request.style);
  const outlet = splitOutlet(spec, style, request.side, branch, parentSheetMm(spec, last, settings), settings);
  if (!outlet) return null;
  return {
    kind: 'split', parentRunId: parent.id, side: request.side, style, vcd: request.vcd,
    point: outlet.point, direction: outlet.direction, bottomZ: outlet.bottomZ, service: spec.service, parentHeightMm: last.heightMm,
  };
}

/** A round branch off a spigot on the parent's plenum. */
export function spigotOrigin(
  parent: HvacElement,
  settings: DuctDesignSettings,
  request: { face: DuctSpigotFace; alongMm: number; acrossMm: number; style: Extract<DuctTapStyle, 'spin-in' | 'conical'>; vcd: boolean },
  branch: DuctLeg,
): DuctDraftOrigin | null {
  const spec = readDuctRunSpec(parent);
  if (!spec || spec.end.kind !== 'plenum') return null;
  const box = { widthMm: spec.end.widthMm, heightMm: spec.end.heightMm };
  const attachment = spigotAttachment(spec, request, branch, parentSheetMm(spec, box, settings), settings);
  if (!attachment) return null;
  return {
    kind: 'spigot', parentRunId: parent.id, face: request.face, alongMm: request.alongMm, acrossMm: request.acrossMm,
    style: request.style, vcd: request.vcd, point: attachment.wallPoint, direction: attachment.direction,
    bottomZ: attachment.bottomZ, service: spec.service,
  };
}

export type DuctBranchTarget =
  | { kind: 'tap'; parent: HvacElement; spec: DuctRunSpec; legIndex: number; stationMm: number; side: DuctSide; marker: [Point2D, Point2D] }
  | { kind: 'split'; parent: HvacElement; spec: DuctRunSpec; side: DuctSide; marker: [Point2D, Point2D] }
  | { kind: 'spigot'; parent: HvacElement; spec: DuctRunSpec; face: DuctSpigotFace; alongMm: number; acrossMm: number; marker: [Point2D, Point2D] };

/** Tolerance around the run end in which a click starts a split (mm). */
const SPLIT_ZONE_MM = 250;

/**
 * What a click at `point` would branch from: a free side of a run's open or
 * capped end (a split), else the side wall of one of its straight sections
 * (a take-off).
 */
export function findBranchTarget(
  point: Point2D,
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  thresholdMm: number,
  /** `branchShape`: the tool's branch shape; a rectangular run's split takes rectangular branches, a round main's wye round ones. */
  options: { splits?: boolean; branchShape?: 'rect' | 'round' } = {},
): DuctBranchTarget | null {
  let best: { target: DuctBranchTarget; distance: number } | null = null;
  const offer = (target: DuctBranchTarget, distance: number) => {
    if (!best || distance < best.distance) best = { target, distance };
  };
  for (const parent of scene) {
    if (!isDuctElement(parent)) continue;
    const spec = readDuctRunSpec(parent);
    // Round runs take branches too: taps off a round main and a wye at its end (SMACNA Fig. 3-4 / 3-5).
    if (!spec || spec.legacy) continue;
    const legs = ductLegs(spec);
    const lastLeg = legs[legs.length - 1];
    const lastSection = spec.legs[spec.legs.length - 1];
    if (!lastLeg || !lastSection) continue;

    const splitShapeFits = options.branchShape === undefined || (options.branchShape === 'round') === isRoundLeg(lastSection);
    if (options.splits !== false && splitShapeFits && !lastLeg.vertical && (spec.end.kind === 'end-cap' || spec.end.kind === 'open' || spec.end.kind === 'split')) {
      const end = { x: lastLeg.end.x, y: lastLeg.end.y };
      const n = legNormal(lastLeg.direction);
      const offset = sub(point, end);
      const along = dot(offset, lastLeg.direction);
      const across = dot(offset, n);
      if (along > -SPLIT_ZONE_MM && along < SPLIT_ZONE_MM && Math.abs(across) <= lastSection.widthMm / 2 + thresholdMm) {
        const side: DuctSide = across >= 0 ? 1 : -1;
        const taken = ductBranchesOf(parent.id, scene).some((branch) => branch.start.kind === 'split-branch' && branch.start.side === side);
        if (!taken) {
          const wall = add(end, scale(n, side * lastSection.widthMm / 2));
          offer({ kind: 'split', parent, spec, side, marker: [end, add(wall, scale(lastLeg.direction, 1))] }, Math.max(0, Math.abs(along) - 1));
        }
      }
    }

    // A plenum's faces: a spigot on its left, right or end face.
    const plenum = plenumGeometry(spec);
    if (plenum) {
      const offset = sub(point, plenum.back);
      const along = dot(offset, plenum.direction);
      const across = dot(offset, plenum.normal);
      const sideGap = Math.abs(across) - plenum.widthMm / 2;
      if (along > 0 && along < plenum.lengthMm && sideGap > -plenum.widthMm / 4 && sideGap < thresholdMm) {
        const face: DuctSpigotFace = across >= 0 ? 'left' : 'right';
        const alongMm = Math.round(along / 10) * 10;
        const wall = add(add(plenum.back, scale(plenum.direction, alongMm)), scale(plenum.normal, (face === 'left' ? 1 : -1) * plenum.widthMm / 2));
        offer({ kind: 'spigot', parent, spec, face, alongMm, acrossMm: 0, marker: [sub(wall, scale(plenum.direction, 100)), add(wall, scale(plenum.direction, 100))] }, Math.abs(sideGap));
      }
      const endGap = along - plenum.lengthMm;
      if (endGap > -plenum.lengthMm / 4 && endGap < thresholdMm && Math.abs(across) < plenum.widthMm / 2) {
        const acrossMm = Math.round(across / 10) * 10;
        const wall = add(plenum.end, scale(plenum.normal, acrossMm));
        offer({ kind: 'spigot', parent, spec, face: 'end', alongMm: 0, acrossMm, marker: [sub(wall, scale(plenum.normal, 100)), add(wall, scale(plenum.normal, 100))] }, Math.abs(endGap));
      }
    }

    const plan = getDuctRunPlan(parent, scene, settings);
    if (!plan) continue;
    let legStart = 0;
    const legStartStation = legs.map((leg) => {
      const start = legStart;
      legStart += leg.lengthMm;
      return start;
    });
    for (const piece of plan.pieces) {
      if (piece.kind !== 'straight' || piece.vertical) continue; // take-offs sit on level straights
      const leg = legs[piece.legIndex]!;
      const section = spec.legs[piece.legIndex]!;
      const n = legNormal(leg.direction);
      const offset = sub(point, leg.start);
      const station = dot(offset, leg.direction);
      const across = dot(offset, n);
      const from = piece.stationStartMm - legStartStation[piece.legIndex]!;
      const to = piece.stationEndMm - legStartStation[piece.legIndex]!;
      if (station < from || station > to) continue;
      const gap = Math.abs(across) - section.widthMm / 2;
      if (gap < -section.widthMm / 2 + 1 || gap > thresholdMm) continue;
      const side: DuctSide = across >= 0 ? 1 : -1;
      const stationMm = Math.round(station / 10) * 10;
      const wall = add(add(leg.start, scale(leg.direction, stationMm)), scale(n, side * section.widthMm / 2));
      offer({
        kind: 'tap', parent, spec, legIndex: piece.legIndex, stationMm, side,
        marker: [sub(wall, scale(leg.direction, 150)), add(wall, scale(leg.direction, 150))],
      }, Math.abs(gap) + SPLIT_ZONE_MM);
    }
  }
  return (best as { target: DuctBranchTarget } | null)?.target ?? null;
}

/** How far back from an open start a re-attach looks for a parent wall (mm). */
export const REATTACH_REACH_MM = 1500;

export interface DuctReattachTarget {
  parent: HvacElement;
  legIndex: number;
  stationMm: number;
  side: DuctSide;
  /** The run with its start moved onto the parent wall and made a take-off. */
  spec: DuctRunSpec;
  /** Where the start lands on the parent wall. */
  wallPoint: Point2D;
}

/** Runs that hang (directly or not) off `rootId`: re-attaching onto them would make a loop. */
function descendantsOf(rootId: string, scene: readonly HvacElement[]): Set<string> {
  const found = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    for (const branch of ductBranchesOf(queue.shift()!, scene)) {
      if (found.has(branch.element.id)) continue;
      found.add(branch.element.id);
      queue.push(branch.element.id);
    }
  }
  return found;
}

/**
 * A run whose start is open (typically orphaned by a deleted parent) re-attaches
 * as a take-off on the nearest run wall behind its start: looking back along its
 * first leg, square to a straight section of another run, within `reachMm`.
 */
export function findReattachTarget(
  element: HvacElement,
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  options: { style: DuctTapStyle; vcd: boolean; reachMm?: number },
): DuctReattachTarget | null {
  const spec = readDuctRunSpec(element);
  if (!spec || spec.legacy || spec.start.kind !== 'open' || spec.path.length < 2) return null;
  const start = spec.path[0]!;
  const next = spec.path[1]!;
  const firstLength = Math.hypot(next.x - start.x, next.y - start.y);
  if (firstLength < 1) return null;
  const d = { x: (next.x - start.x) / firstLength, y: (next.y - start.y) / firstLength };
  const reach = options.reachMm ?? REATTACH_REACH_MM;
  const excluded = descendantsOf(element.id, scene);
  let best: { target: DuctReattachTarget; distance: number } | null = null;
  for (const parent of scene) {
    if (!isDuctElement(parent) || excluded.has(parent.id)) continue;
    const parentSpec = readDuctRunSpec(parent);
    if (!parentSpec || parentSpec.legacy) continue;
    const plan = getDuctRunPlan(parent, scene, settings);
    if (!plan) continue;
    const legs = ductLegs(parentSpec);
    let legStart = 0;
    const legStartStation = legs.map((leg) => {
      const value = legStart;
      legStart += leg.lengthMm;
      return value;
    });
    for (const piece of plan.pieces) {
      if (piece.kind !== 'straight' || piece.vertical) continue; // take-offs sit on level straights
      const leg = legs[piece.legIndex]!;
      if (Math.abs(dot(leg.direction, d)) > 0.01) continue;
      const n = legNormal(leg.direction);
      const side: DuctSide = dot(d, n) > 0 ? 1 : -1;
      const section = parentSpec.legs[piece.legIndex]!;
      // A round main takes a round branch by a round-main tap; a rectangular wall by its own styles.
      if (isRoundLeg(section) && !isRoundLeg(spec.legs[0])) continue;
      const style: DuctTapStyle = isRoundLeg(section)
        ? (isRoundMainTapStyle(options.style) ? options.style : 'round-conical')
        : (isRoundMainTapStyle(options.style) ? 'spin-in' : options.style);
      const sheet = parentSheetMm(parentSpec, section, settings);
      const offset = sub(start, leg.start);
      // Distance back along −d from the start to the parent's wall on that side.
      const back = side * dot(offset, n) - (section.widthMm / 2 + sheet);
      if (back < -section.widthMm || back > reach) continue;
      const station = Math.round(dot(offset, leg.direction) / 10) * 10;
      const from = piece.stationStartMm - legStartStation[piece.legIndex]!;
      const to = piece.stationEndMm - legStartStation[piece.legIndex]!;
      if (station < from || station > to) continue;
      const attachment = tapAttachment(parentSpec, { legIndex: piece.legIndex, stationMm: station, side, style },
        spec.legs[0]!, sheet, settings);
      if (!attachment) continue;
      const distance = Math.abs(back);
      if (best && distance >= best.distance) continue;
      // Keep the run's legs; move its start onto the wall and level it with the parent's bottom.
      const dz = attachment.bottomZ - start.z;
      const path = spec.path.map((point, index) => (index === 0
        ? { x: attachment.wallPoint.x, y: attachment.wallPoint.y, z: attachment.bottomZ }
        : { ...point, z: point.z + dz }));
      best = {
        distance,
        target: {
          parent, legIndex: piece.legIndex, stationMm: station, side, wallPoint: attachment.wallPoint,
          spec: {
            ...spec,
            service: parentSpec.service,
            path,
            start: { kind: 'tap', parentRunId: parent.id, legIndex: piece.legIndex, stationMm: station, side, style, vcd: options.vcd },
          },
        },
      };
    }
  }
  return best?.target ?? null;
}
