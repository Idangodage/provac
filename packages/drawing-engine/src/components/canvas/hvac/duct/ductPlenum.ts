/**
 * Plenum boxes at the end of a run (on a unit's collar, or at the end of a
 * trunk) and the round spigots taken off them, usually feeding flexible
 * runouts to the terminals (SMACNA Fig. 2-15).
 *
 * The box fills the last `lengthMm` of the run's last (level) leg: the path's
 * end point is the centre of its far face. It is centred on the leg axis and
 * shares the duct's flat bottom. Spigots sit on its left, right or end face,
 * half way up the box, with spin-in or conical collars (Figs 2-6, 3-8).
 * Construction follows the rectangular duct tables at the box's section
 * (project practice; SMACNA sets no separate plenum schedule at this size).
 */
import type { Point2D } from '../../../../types';

import type { TapAttachment } from './ductBranches';
import { ductLegs, type DuctLegGeometry } from './ductGeometry';
import type { DuctDesignSettings } from './ductSettings';
import type { DuctLeg, DuctPlenumEnd, DuctRunSpec, DuctSpigotFace, DuctSpigotStart } from './ductTypes';

/** Clear distance from a spigot to a plenum edge, and between spigots (mm). Practice. */
export const SPIGOT_EDGE_MARGIN_MM = 50;

export interface DuctPlenumGeometry {
  widthMm: number;
  heightMm: number;
  lengthMm: number;
  /** Centres of the back face (where the duct enters) and the far face, in plan. */
  back: Point2D;
  end: Point2D;
  /** Run direction and its left normal. */
  direction: Point2D;
  normal: Point2D;
  /** The box's clear bottom (the duct's). */
  bottomZ: number;
  leg: DuctLegGeometry;
}

export function plenumGeometry(spec: DuctRunSpec): DuctPlenumGeometry | null {
  if (spec.end.kind !== 'plenum') return null;
  const legs = ductLegs(spec);
  const leg = legs[legs.length - 1];
  if (!leg || leg.vertical) return null;
  const end = { x: leg.end.x, y: leg.end.y };
  const length = Math.min(spec.end.lengthMm, leg.lengthMm);
  return {
    widthMm: spec.end.widthMm,
    heightMm: spec.end.heightMm,
    lengthMm: length,
    back: { x: end.x - leg.direction.x * length, y: end.y - leg.direction.y * length },
    end,
    direction: leg.direction,
    normal: { x: -leg.direction.y, y: leg.direction.x },
    bottomZ: leg.end.z,
    leg,
  };
}

/** Where a spigot sits on its face, in the face's own frame: `u` across the face, `v` up from the box bottom. */
export function spigotFacePosition(plenum: Pick<DuctPlenumGeometry, 'widthMm' | 'heightMm' | 'lengthMm'>, start: Pick<DuctSpigotStart, 'face' | 'alongMm' | 'acrossMm'>): { u: number; v: number; faceWidthMm: number } {
  const v = plenum.heightMm / 2;
  if (start.face === 'end') return { u: start.acrossMm + plenum.widthMm / 2, v, faceWidthMm: plenum.widthMm };
  return { u: start.alongMm, v, faceWidthMm: plenum.lengthMm };
}

/**
 * The spigot as a take-off: its wall point on the face, the direction the
 * branch leaves in, the collar and its opening. Shaped like a side take-off so
 * the planner, follow and 3D reuse the take-off pieces.
 */
export function spigotAttachment(
  parent: DuctRunSpec,
  start: Pick<DuctSpigotStart, 'face' | 'alongMm' | 'acrossMm' | 'style'>,
  branch: DuctLeg,
  parentSheetMm: number,
  settings: Pick<DuctDesignSettings, 'tapCollarMm' | 'conicalFlareMm'>,
): TapAttachment | null {
  const plenum = plenumGeometry(parent);
  if (!plenum) return null;
  const { direction: d, normal: n } = plenum;
  const diameter = branch.diameterMm ?? branch.widthMm;
  let wallPoint: Point2D;
  let out: Point2D;
  if (start.face === 'end') {
    wallPoint = { x: plenum.end.x + n.x * start.acrossMm + d.x * parentSheetMm, y: plenum.end.y + n.y * start.acrossMm + d.y * parentSheetMm };
    out = d;
  } else {
    const side = start.face === 'left' ? 1 : -1;
    const reach = side * (plenum.widthMm / 2 + parentSheetMm);
    wallPoint = { x: plenum.back.x + d.x * start.alongMm + n.x * reach, y: plenum.back.y + d.y * start.alongMm + n.y * reach };
    out = { x: n.x * side, y: n.y * side };
  }
  const opening = start.style === 'conical' ? diameter + settings.conicalFlareMm : diameter;
  // The branch's clear bottom: its centre half way up the box.
  const bottomZ = plenum.bottomZ + plenum.heightMm / 2 - diameter / 2;
  const station = plenum.leg.lengthMm - plenum.lengthMm + (start.face === 'end' ? plenum.lengthMm : start.alongMm);
  return {
    parentLeg: plenum.leg,
    parentSection: { widthMm: plenum.widthMm, heightMm: plenum.heightMm },
    wallPoint,
    direction: out,
    parentDirection: d,
    bottomZ,
    leadInMm: 0,
    collarLengthMm: start.style === 'conical' ? Math.max(settings.tapCollarMm, settings.conicalFlareMm + 100) : settings.tapCollarMm,
    openingDiameterMm: opening,
    openingFromMm: station - opening / 2,
    openingToMm: station + opening / 2,
  };
}

export interface SpigotFitIssue {
  code: 'DU_SPIGOT_CLASH' | 'DU_PLENUM_SIZE';
  message: string;
  branchId: string;
}

/** Every spigot fits its face with a margin, and no two on a face come closer than the margin. */
export function checkSpigotFit(
  plenum: Pick<DuctPlenumGeometry, 'widthMm' | 'heightMm' | 'lengthMm'>,
  spigots: ReadonlyArray<{ branchId: string; face: DuctSpigotFace; alongMm: number; acrossMm: number; openingMm: number }>,
): SpigotFitIssue[] {
  const issues: SpigotFitIssue[] = [];
  const margin = SPIGOT_EDGE_MARGIN_MM;
  for (const spigot of spigots) {
    const { u, v, faceWidthMm } = spigotFacePosition(plenum, spigot);
    const r = spigot.openingMm / 2;
    if (u - r < margin - 0.5 || u + r > faceWidthMm - margin + 0.5 || v - r < margin - 0.5 || v + r > plenum.heightMm - margin + 0.5) {
      issues.push({ code: 'DU_PLENUM_SIZE', branchId: spigot.branchId,
        message: `A Ø${Math.round(spigot.openingMm)} spigot does not fit the plenum's ${spigot.face} face with ${margin} mm to its edges (practice); enlarge the plenum.` });
    }
  }
  for (let i = 0; i < spigots.length; i += 1) {
    for (let j = i + 1; j < spigots.length; j += 1) {
      const a = spigots[i]!;
      const b = spigots[j]!;
      if (a.face !== b.face) continue;
      const gap = Math.abs(spigotFacePosition(plenum, a).u - spigotFacePosition(plenum, b).u) - (a.openingMm + b.openingMm) / 2;
      if (gap < margin - 0.5) {
        issues.push({ code: 'DU_SPIGOT_CLASH', branchId: b.branchId,
          message: `Two spigots on the plenum's ${a.face} face are ${Math.max(0, Math.round(gap))} mm apart; keep ${margin} mm (practice).` });
      }
    }
  }
  return issues;
}

/**
 * The plenum a run gets by default (practice): 200 mm wider than the duct,
 * tall enough for the largest spigot with 50 mm above and below, 500 mm long.
 */
export function defaultPlenumSize(duct: DuctLeg, largestSpigotMm = 250): Omit<DuctPlenumEnd, 'kind'> {
  return {
    widthMm: Math.round(duct.widthMm + 200),
    heightMm: Math.round(Math.max(duct.heightMm, largestSpigotMm + 2 * SPIGOT_EDGE_MARGIN_MM)),
    lengthMm: 500,
  };
}
