/**
 * Branch geometry: where a take-off leaves its parent run, and where each
 * outlet of an end split sits. Every outlet depends only on the parent and
 * its own branch size, so adding the second branch of a split never moves the
 * first one.
 *
 * Plan frame of a parent leg: `d` = leg direction, `n` = (−d.y, d.x); side +1
 * leaves along +n. Branches share the parent's clear bottom (flat bottom).
 */
import type { Point2D } from '../../../../types';

import { resolveVaneType, shoeLeadInMm, transitionSlopeMm, vaneCountOnDiagonal, vaneSectionsFor, type DuctVaneSpec } from './ductFittingRules';
import { add, dot, ductLegs, radiusElbowGeometry, scale, sub, type DuctLegGeometry, type ElbowPlanGeometry } from './ductGeometry';
import { roundMainLeavingDirection, roundMainTapGeometry, wyeLegLengthMm } from './ductRoundFittings';
import type { DuctDesignSettings } from './ductSettings';
import {
  isRoundLeg,
  isRoundMainTapStyle,
  isRoundTapStyle,
  splitAngleOf,
  type DuctLeg,
  type DuctRunSpec,
  type DuctSide,
  type DuctSplitAngle,
  type DuctSplitStyle,
  type DuctTapStyle,
} from './ductTypes';

/** Shoe (45° entry) lead-in: L = W/4, 102 mm minimum (SMACNA Fig. 2-6). */
export { shoeLeadInMm };

type SplitSettings = Pick<DuctDesignSettings, 'elbowNeckMm' | 'elbowCentrelineRatio' | 'vaneType' | 'transitionTaperDeg'>;

/** A divided-flow Y's legs are at least this wide; a narrower share is a bullhead tee's job (practice, SMACNA Fig. 2-5). */
export const DIVIDED_FLOW_MIN_LEG_MM = 100;

/**
 * The width of a divided-flow Y's leg on `side`: its share of the inlet's
 * width (mm, whole), the two adding up to the inlet's.
 */
export function dividedFlowLegWidthMm(inletWidthMm: number, share: number, side: DuctSide): number {
  const plus = Math.min(inletWidthMm - 1, Math.max(1, Math.round(inletWidthMm * share)));
  return side === 1 ? plus : inletWidthMm - plus;
}

/**
 * A divided-flow Y's leg, in the fitting's frame (along the inlet, across to
 * the leg's side): its section (its share of the inlet's width, the inlet's
 * height), its radius elbow (R/W at least 1 on its own width, as SMACNA Fig.
 * 2-5 shows it), and the transition inside the fitting that takes it to its
 * outlet's size (flat on the bottom, at the design taper). `alongMm` and
 * `acrossMm`: where the outlet's flange is, from the inlet's centre.
 */
export function dividedFlowLeg(
  inlet: DuctLeg, outlet: DuctLeg, share: number, side: DuctSide, angleDeg: DuctSplitAngle, settings: SplitSettings,
): { leg: DuctLeg; offsetMm: number; radiusMm: number; setbackMm: number; transitionMm: number; alongMm: number; acrossMm: number } {
  const width = dividedFlowLegWidthMm(inlet.widthMm, share, side);
  const leg: DuctLeg = { widthMm: width, heightMm: inlet.heightMm };
  const offsetMm = side * (inlet.widthMm / 2 - width / 2);
  const radiusMm = Math.max(1, settings.elbowCentrelineRatio) * width;
  const setbackMm = angleDeg === 45 ? radiusMm * Math.tan(Math.PI / 8) : radiusMm;
  const transitionMm = sameSize(leg, outlet) ? 0 : 2 * settings.elbowNeckMm + transitionSlopeMm(leg, outlet, settings.transitionTaperDeg);
  // The elbow's corner past the neck, then its leg out of the turn: its outlet neck and the transition on its new line.
  const neck = settings.elbowNeckMm;
  const run = setbackMm + neck + transitionMm;
  const c = Math.SQRT1_2;
  return angleDeg === 45
    ? { leg, offsetMm, radiusMm, setbackMm, transitionMm, alongMm: neck + setbackMm + run * c, acrossMm: offsetMm + side * run * c }
    : { leg, offsetMm, radiusMm, setbackMm, transitionMm, alongMm: neck + setbackMm, acrossMm: offsetMm + side * run };
}

function sameSize(a: DuctLeg, b: DuctLeg): boolean {
  return Math.abs(a.widthMm - b.widthMm) < 0.5 && Math.abs(a.heightMm - b.heightMm) < 0.5 && (a.diameterMm === undefined) === (b.diameterMm === undefined);
}

export function legNormal(direction: Point2D): Point2D {
  return { x: -direction.y, y: direction.x };
}

export interface TapAttachment {
  parentLeg: DuctLegGeometry;
  parentSection: DuctLeg;
  /** Centre of the branch opening on the parent's outside wall. */
  wallPoint: Point2D;
  /** Direction the branch leaves in (unit, square to the parent). */
  direction: Point2D;
  parentDirection: Point2D;
  /** Clear bottom level, shared with the parent. */
  bottomZ: number;
  leadInMm: number;
  /** Take-off collar length along the branch (the shoe needs room for its 45° lead-in). */
  collarLengthMm: number;
  /** Round collars: the opening diameter cut in the parent (the cone mouth for a conical tap). */
  openingDiameterMm: number | null;
  /** Station range of the opening on the parent leg (lead-in included). */
  openingFromMm: number;
  openingToMm: number;
  /** A round main: the cylinder the collar is cut to (its saddle), for drawing the collar on the curved wall. */
  roundMain?: RoundMainCylinder;
}

/** A round main at a tap: its axis at the tap station and its outside (clear Ø + sheet). */
export interface RoundMainCylinder {
  diameterMm: number;
  sheetMm: number;
  /** The main's axis at the tap station (plan) and its height. */
  axisPoint: Point2D;
  axisZ: number;
}

export function tapAttachment(
  parent: DuctRunSpec,
  tap: { legIndex: number; stationMm: number; side: DuctSide; style: DuctTapStyle },
  branch: DuctLeg,
  parentSheetMm: number,
  settings: Pick<DuctDesignSettings, 'tapCollarMm' | 'conicalFlareMm'>,
): TapAttachment | null {
  const leg = ductLegs(parent)[tap.legIndex];
  const section = parent.legs[tap.legIndex];
  if (!leg || !section) return null;
  const n = legNormal(leg.direction);
  const along = add(leg.start, scale(leg.direction, tap.stationMm));
  const wallPoint = add(along, scale(n, tap.side * (section.widthMm / 2 + parentSheetMm)));
  if (isRoundLeg(section)) {
    // A round main (SMACNA Fig. 3-4 / 3-5): the branch is centred on the main's axis. A style
    // meant for a rectangular wall is drawn as a 90° tap; the planner reports the mismatch.
    const style = isRoundMainTapStyle(tap.style) ? tap.style : 'round-tee';
    const d = branch.diameterMm ?? branch.widthMm;
    const geometry = roundMainTapGeometry(style, d, settings);
    return {
      parentLeg: leg, parentSection: section, wallPoint,
      direction: roundMainLeavingDirection(geometry.angleDeg, scale(n, tap.side), leg.direction),
      parentDirection: leg.direction,
      bottomZ: leg.start.z + (section.heightMm - branch.heightMm) / 2,
      leadInMm: 0,
      collarLengthMm: geometry.collarLengthMm,
      openingDiameterMm: geometry.openingMm,
      openingFromMm: tap.stationMm - geometry.windowHalfMm,
      openingToMm: tap.stationMm + geometry.windowHalfMm,
      roundMain: { diameterMm: section.diameterMm!, sheetMm: parentSheetMm, axisPoint: along, axisZ: leg.start.z + section.heightMm / 2 },
    };
  }
  const leadInMm = tap.style === 'shoe-45' ? shoeLeadInMm(branch.widthMm) : 0;
  if (isRoundTapStyle(tap.style)) {
    // Round collar off the rectangular wall (SMACNA Fig. 2-6): spin-in at the branch
    // diameter, or a cone whose mouth is wider (D1 ≥ D2).
    const opening = tap.style === 'conical' ? branch.widthMm + settings.conicalFlareMm : branch.widthMm;
    return {
      parentLeg: leg, parentSection: section, wallPoint, direction: scale(n, tap.side), parentDirection: leg.direction,
      bottomZ: leg.start.z, leadInMm: 0,
      collarLengthMm: tap.style === 'conical' ? Math.max(settings.tapCollarMm, settings.conicalFlareMm + 100) : settings.tapCollarMm,
      openingDiameterMm: opening,
      openingFromMm: tap.stationMm - opening / 2,
      openingToMm: tap.stationMm + opening / 2,
    };
  }
  return {
    parentLeg: leg,
    parentSection: section,
    wallPoint,
    direction: scale(n, tap.side),
    parentDirection: leg.direction,
    bottomZ: leg.start.z,
    leadInMm,
    collarLengthMm: Math.max(settings.tapCollarMm, leadInMm + 50),
    openingDiameterMm: null,
    openingFromMm: tap.stationMm - branch.widthMm / 2 - leadInMm,
    openingToMm: tap.stationMm + branch.widthMm / 2,
  };
}

export interface SplitOutlet {
  side: DuctSide;
  /** Where the branch run starts (the outlet's flange face). */
  point: Point2D;
  direction: Point2D;
  bottomZ: number;
}

export interface SplitBranchGeometry {
  side: DuctSide;
  /** The outlet's section: the branch run's first. */
  section: DuctLeg;
  /** The leg's section inside the fitting: a divided-flow Y's share of the inlet; else the outlet's. */
  leg: DuctLeg;
  /** A divided-flow Y: the transition inside the fitting from its leg to its outlet (flat bottom), else null. */
  transition: { from: DuctLeg; to: DuctLeg; start: Point2D; end: Point2D; lengthMm: number; slopeMm: number } | null;
  outlet: SplitOutlet;
  /** Y split: this branch's radius elbow. */
  elbow: ElbowPlanGeometry | null;
  /** Bullhead: turning vanes guiding this outlet (SMACNA Fig. 2-5 Type 2, vanes per Fig. 2-3). */
  vaneCount: number;
  vanes: { spec: DuctVaneSpec; lengthMm: number; sections: number } | null;
}

export interface SplitFittingGeometry {
  style: DuctSplitStyle;
  /** The outlets' leaving angle: a Y junction's 45°, a Y split's 90° (a wye's legs leave at 45°, a bullhead's at 90°). */
  angleDeg?: DuctSplitAngle;
  /** A divided-flow Y: the +1 side's share of the air (its leg's share of the inlet); null for any other split. */
  share: number | null;
  /** A divided-flow Y's splitter blade on the plan: from the inlet's end along its axis, where the legs part. */
  splitter: { from: Point2D; to: Point2D } | null;
  origin: Point2D;
  direction: Point2D;
  normal: Point2D;
  parentSection: DuctLeg;
  bottomZ: number;
  /** Bullhead body depth along the parent axis. */
  depthMm: number;
  neckMm: number;
  branches: SplitBranchGeometry[];
  cappedSides: DuctSide[];
}

function parentEnd(parent: DuctRunSpec): { leg: DuctLegGeometry; section: DuctLeg } | null {
  const legs = ductLegs(parent);
  const leg = legs[legs.length - 1];
  const section = parent.legs[parent.legs.length - 1];
  return leg && section ? { leg, section } : null;
}

function branchGeometry(
  style: DuctSplitStyle,
  end: { leg: DuctLegGeometry; section: DuctLeg },
  side: DuctSide,
  branch: DuctLeg,
  parentSheetMm: number,
  settings: SplitSettings,
  angleDeg: DuctSplitAngle,
  share: number | null,
): SplitBranchGeometry {
  const origin = { x: end.leg.end.x, y: end.leg.end.y };
  const d = end.leg.direction;
  const n = legNormal(d);
  const out = scale(n, side);
  const neck = settings.elbowNeckMm;
  if (style === 'wye') {
    // Round wye (SMACNA Fig. 3-5): each leg leaves at 45°, 3A/2 to its outlet, centred on the main's axis.
    const direction = roundMainLeavingDirection(45, out, d);
    const point = add(origin, scale(direction, wyeLegLengthMm(end.section.widthMm)));
    return {
      side, section: branch, leg: branch, transition: null, elbow: null, vaneCount: 0, vanes: null,
      outlet: { side, point, direction, bottomZ: end.leg.end.z + (end.section.heightMm - branch.heightMm) / 2 },
    };
  }
  if (style === 'bullhead') {
    const point = add(add(origin, scale(d, neck + branch.widthMm / 2)), scale(n, side * (end.section.widthMm / 2 + parentSheetMm)));
    const spec = resolveVaneType(settings.vaneType, branch.heightMm);
    return {
      side, section: branch, leg: branch, transition: null, outlet: { side, point, direction: out, bottomZ: end.leg.end.z }, elbow: null,
      vaneCount: vaneCountOnDiagonal(branch.widthMm, spec),
      vanes: { spec, lengthMm: branch.heightMm, sections: vaneSectionsFor(branch.heightMm, spec) },
    };
  }
  const leaving = angleDeg === 45 ? roundMainLeavingDirection(45, out, d) : out;
  if (share !== null) {
    // Y (divided flow, SMACNA Fig. 2-5): the splitter gives this leg its share of the inlet, so it starts at the
    // inlet's velocity; it turns on its own radius elbow, then a transition inside the fitting takes it to its outlet.
    const shaped = dividedFlowLeg(end.section, branch, share, side, angleDeg, settings);
    const corner = add(add(origin, scale(n, shaped.offsetMm)), scale(d, neck + shaped.setbackMm));
    const elbow = radiusElbowGeometry(corner, d, leaving, shaped.radiusMm, neck);
    const point = add(elbow.endPoint, scale(leaving, shaped.transitionMm));
    return {
      side, section: branch, leg: shaped.leg, elbow, vaneCount: 0, vanes: null,
      transition: shaped.transitionMm > 0 ? {
        from: shaped.leg, to: branch, start: elbow.endPoint, end: point, lengthMm: shaped.transitionMm,
        slopeMm: shaped.transitionMm - 2 * settings.elbowNeckMm,
      } : null,
      outlet: { side, point, direction: leaving, bottomZ: end.leg.end.z },
    };
  }
  // Y as drawn before the splitter: this branch keeps its own width of the parent, flush with its side wall, and
  // turns onto its outlet on a radius elbow: 90° (outlets square to the run), or 45° (a Y junction, its legs as a wye's).
  const offset = side * (end.section.widthMm / 2 - branch.widthMm / 2);
  const radius = Math.max(0.5, settings.elbowCentrelineRatio) * branch.widthMm;
  const setback = angleDeg === 45 ? radius * Math.tan(Math.PI / 8) : radius;
  const corner = add(add(origin, scale(n, offset)), scale(d, neck + setback));
  const elbow = radiusElbowGeometry(corner, d, leaving, radius, neck);
  return { side, section: branch, leg: branch, transition: null, outlet: { side, point: elbow.endPoint, direction: leaving, bottomZ: end.leg.end.z }, elbow, vaneCount: 0, vanes: null };
}

/** A divided-flow Y's splitter share on a run's split end (null for any other split, or a Y drawn before it). */
export function splitShareOf(parent: DuctRunSpec, style: DuctSplitStyle): number | null {
  return style === 'y' && parent.end.kind === 'split' && parent.end.style === 'y' && parent.end.share !== undefined ? parent.end.share : null;
}

export function splitOutlet(
  parent: DuctRunSpec,
  style: DuctSplitStyle,
  side: DuctSide,
  branch: DuctLeg,
  parentSheetMm: number,
  settings: SplitSettings,
  angleDeg: DuctSplitAngle = splitAngleOf(parent.end),
): SplitOutlet | null {
  const end = parentEnd(parent);
  return end ? branchGeometry(style, end, side, branch, parentSheetMm, settings, angleDeg, splitShareOf(parent, style)).outlet : null;
}

export function splitFitting(
  parent: DuctRunSpec,
  style: DuctSplitStyle,
  branches: Array<{ side: DuctSide; section: DuctLeg }>,
  parentSheetMm: number,
  settings: SplitSettings,
  angleDeg: DuctSplitAngle = splitAngleOf(parent.end),
): SplitFittingGeometry | null {
  const end = parentEnd(parent);
  if (!end) return null;
  const present = ([1, -1] as const)
    .map((side) => branches.find((branch) => branch.side === side))
    .filter((branch): branch is { side: DuctSide; section: DuctLeg } => Boolean(branch));
  const widest = Math.max(0, ...present.map((branch) => branch.section.widthMm));
  const share = splitShareOf(parent, style);
  const geometries = present.map((branch) => branchGeometry(style, end, branch.side, branch.section, parentSheetMm, settings, angleDeg, share));
  const origin = { x: end.leg.end.x, y: end.leg.end.y };
  const d = end.leg.direction;
  const n = legNormal(d);
  /** How far along the main a face (centre `point`, square to `direction`, `half` wide) reaches. */
  const reach = (point: Point2D, direction: Point2D, half: number) => dot(sub(point, origin), d) + half * Math.abs(direction.x * d.y - direction.y * d.x);
  // A wye reaches 3A/2 along each 45° leg: its depth along the main is that leg's run plus half the widest outlet.
  // A Y junction reaches as far as its farthest outlet's outer corner; a divided-flow Y as far as its legs' elbows
  // and transitions reach (each to its outlet's flange).
  const depthMm = style === 'wye'
    ? wyeLegLengthMm(end.section.widthMm) * Math.SQRT1_2 + (widest > 0 ? widest : end.section.widthMm) / 2
    : style === 'y' && share !== null
      ? Math.max(settings.elbowNeckMm + end.section.widthMm / 2, ...geometries.flatMap((geometry) => [
        reach(geometry.elbow!.endPoint, geometry.outlet.direction, geometry.leg.widthMm / 2),
        reach(geometry.outlet.point, geometry.outlet.direction, geometry.section.widthMm / 2),
      ]))
      : style === 'y' && angleDeg === 45
        ? Math.max(settings.elbowNeckMm + end.section.widthMm / 2, ...geometries.map((geometry) =>
          (geometry.outlet.point.x - origin.x) * d.x + (geometry.outlet.point.y - origin.y) * d.y + (geometry.section.widthMm / 2) * Math.SQRT1_2))
        : settings.elbowNeckMm + (widest > 0 ? widest : end.section.widthMm / 2);
  // The splitter: where the legs share a wall, from the inlet's end over the elbows' necks.
  const splitterAt = share !== null ? end.section.widthMm / 2 - dividedFlowLegWidthMm(end.section.widthMm, share, 1) : 0;
  return {
    style,
    angleDeg: style === 'wye' ? 45 : style === 'y' ? angleDeg : 90,
    share,
    splitter: share !== null
      ? { from: add(origin, scale(n, splitterAt)), to: add(add(origin, scale(n, splitterAt)), scale(d, settings.elbowNeckMm)) }
      : null,
    origin,
    direction: end.leg.direction,
    normal: legNormal(end.leg.direction),
    parentSection: end.section,
    bottomZ: end.leg.end.z,
    depthMm,
    neckMm: settings.elbowNeckMm,
    branches: geometries,
    cappedSides: ([1, -1] as const).filter((side) => !present.some((branch) => branch.side === side)),
  };
}
