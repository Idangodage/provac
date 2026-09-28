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

import { resolveVaneType, shoeLeadInMm, vaneCountOnDiagonal, vaneSectionsFor, type DuctVaneSpec } from './ductFittingRules';
import { add, ductLegs, radiusElbowGeometry, scale, type DuctLegGeometry, type ElbowPlanGeometry } from './ductGeometry';
import { roundMainLeavingDirection, roundMainTapGeometry, wyeLegLengthMm } from './ductRoundFittings';
import type { DuctDesignSettings } from './ductSettings';
import {
  isRoundLeg,
  isRoundMainTapStyle,
  isRoundTapStyle,
  type DuctLeg,
  type DuctRunSpec,
  type DuctSide,
  type DuctSplitStyle,
  type DuctTapStyle,
} from './ductTypes';

/** Shoe (45° entry) lead-in: L = W/4, 102 mm minimum (SMACNA Fig. 2-6). */
export { shoeLeadInMm };

type SplitSettings = Pick<DuctDesignSettings, 'elbowNeckMm' | 'elbowCentrelineRatio' | 'vaneType'>;

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
  section: DuctLeg;
  outlet: SplitOutlet;
  /** Y split: this branch's radius elbow. */
  elbow: ElbowPlanGeometry | null;
  /** Bullhead: turning vanes guiding this outlet (SMACNA Fig. 2-5 Type 2, vanes per Fig. 2-3). */
  vaneCount: number;
  vanes: { spec: DuctVaneSpec; lengthMm: number; sections: number } | null;
}

export interface SplitFittingGeometry {
  style: DuctSplitStyle;
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
      side, section: branch, elbow: null, vaneCount: 0, vanes: null,
      outlet: { side, point, direction, bottomZ: end.leg.end.z + (end.section.heightMm - branch.heightMm) / 2 },
    };
  }
  if (style === 'bullhead') {
    const point = add(add(origin, scale(d, neck + branch.widthMm / 2)), scale(n, side * (end.section.widthMm / 2 + parentSheetMm)));
    const spec = resolveVaneType(settings.vaneType, branch.heightMm);
    return {
      side, section: branch, outlet: { side, point, direction: out, bottomZ: end.leg.end.z }, elbow: null,
      vaneCount: vaneCountOnDiagonal(branch.widthMm, spec),
      vanes: { spec, lengthMm: branch.heightMm, sections: vaneSectionsFor(branch.heightMm, spec) },
    };
  }
  // Y (divided flow): this branch keeps its own width of the parent, flush with its side wall.
  const offset = side * (end.section.widthMm / 2 - branch.widthMm / 2);
  const radius = Math.max(0.5, settings.elbowCentrelineRatio) * branch.widthMm;
  const corner = add(add(origin, scale(n, offset)), scale(d, neck + radius));
  const elbow = radiusElbowGeometry(corner, d, out, radius, neck);
  return { side, section: branch, outlet: { side, point: elbow.endPoint, direction: out, bottomZ: end.leg.end.z }, elbow, vaneCount: 0, vanes: null };
}

export function splitOutlet(
  parent: DuctRunSpec,
  style: DuctSplitStyle,
  side: DuctSide,
  branch: DuctLeg,
  parentSheetMm: number,
  settings: SplitSettings,
): SplitOutlet | null {
  const end = parentEnd(parent);
  return end ? branchGeometry(style, end, side, branch, parentSheetMm, settings).outlet : null;
}

export function splitFitting(
  parent: DuctRunSpec,
  style: DuctSplitStyle,
  branches: Array<{ side: DuctSide; section: DuctLeg }>,
  parentSheetMm: number,
  settings: SplitSettings,
): SplitFittingGeometry | null {
  const end = parentEnd(parent);
  if (!end) return null;
  const present = ([1, -1] as const)
    .map((side) => branches.find((branch) => branch.side === side))
    .filter((branch): branch is { side: DuctSide; section: DuctLeg } => Boolean(branch));
  const widest = Math.max(0, ...present.map((branch) => branch.section.widthMm));
  // A wye reaches 3A/2 along each 45° leg: its depth along the main is that leg's run plus half the widest outlet.
  const depthMm = style === 'wye'
    ? wyeLegLengthMm(end.section.widthMm) * Math.SQRT1_2 + (widest > 0 ? widest : end.section.widthMm) / 2
    : settings.elbowNeckMm + (widest > 0 ? widest : end.section.widthMm / 2);
  return {
    style,
    origin: { x: end.leg.end.x, y: end.leg.end.y },
    direction: end.leg.direction,
    normal: legNormal(end.leg.direction),
    parentSection: end.section,
    bottomZ: end.leg.end.z,
    depthMm,
    neckMm: settings.elbowNeckMm,
    branches: present.map((branch) => branchGeometry(style, end, branch.side, branch.section, parentSheetMm, settings)),
    cappedSides: ([1, -1] as const).filter((side) => !present.some((branch) => branch.side === side)),
  };
}
