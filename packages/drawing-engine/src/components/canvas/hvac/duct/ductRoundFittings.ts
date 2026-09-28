/**
 * Round-main fittings from SMACNA 1995 chapter 3: branches taken off a round
 * main (Fig. 3-4 "90° tees and laterals", Fig. 3-5 "Conical tees", pp. 3.11–
 * 3.12), the wye that splits a round main, and the round reducer after a tee
 * (Fig. 3-5 "conical tee and reducer": L2 = A − B, 102 mm minimum).
 * Transcribed in docs/hvac-duct-smacna-research.md ("Round branch fittings").
 *
 * Every take-off off a round main is a tap or saddle, so the S3.4 limit
 * applies: the branch is at most two thirds of the main's diameter.
 */
import type { Point2D } from '../../../../types';

import type { DuctRuleProvenance } from './ductSources';
import type { DuctRoundMainTapStyle } from './ductTypes';

const smacna = (reference: string): DuctRuleProvenance => ({ sourceId: 'smacna-1995', reference, verified: true });

export const ROUND_FITTING_RULES = {
  /** Standard spigot length (Fig. 3-4 note). */
  spigotMm: 51,
  /** A tee body is the branch diameter + 102 mm between its 51 mm spigots (Fig. 3-4, Fig. 3-5). */
  bodyExtraMm: 102,
  /** Conical tee: the cone is at least 152 mm long (L1) … */
  conicalMinLengthMm: 152,
  /** … and its mouth on the main is the branch diameter + 51 mm (Fig. 3-5). */
  conicalMouthExtraMm: 51,
  /** Reducer after a tee: L2 = A − B, 102 mm minimum (Fig. 3-5). */
  reducerMinMm: 102,
  /** Wye legs 3A/2 long (Fig. 3-5). */
  wyeLegRatio: 1.5,
  /** A lateral leaves the main at 45° (Fig. 3-4). */
  lateralAngleDeg: 45,
  /** Tap edges: screws on 101 mm centres (or stitch welds; Fig. 3-4). */
  tapFastenerSpacingMm: 101,
  provenance: smacna('Fig. 3-4 (p.3.11), Fig. 3-5 (p.3.12)'),
} as const;

/** Values the figures leave undimensioned. */
export const ROUND_FITTING_PRACTICE: Record<'teeStub' | 'lateralCollar' | 'wyeLegCentreline', DuctRuleProvenance> = {
  teeStub: { sourceId: 'project-practice', verified: false, note: 'A 90° tap stub is at least one spigot (51 mm) out of the main before its 51 mm spigot; Fig. 3-4 shows it undimensioned.' },
  lateralCollar: { sourceId: 'project-practice', verified: false, note: 'A 45° lateral collar reaches half the branch diameter past the main wall plus its 51 mm spigot, so the whole section is clear of the main.' },
  wyeLegCentreline: { sourceId: 'project-practice', verified: false, note: 'The wye\'s 3A/2 is read as each leg\'s centreline length to its outlet.' },
};

export interface RoundMainTapGeometry {
  /** Diameter cut in the main (the cone mouth for a conical tap). */
  openingMm: number;
  /** Half the length of main the fitting occupies, from the branch axis (the tee body, C + 102 mm). */
  windowHalfMm: number;
  /** Collar length along the branch, spigot included. */
  collarLengthMm: number;
  /** Angle between the main and the branch as it leaves (90° or 45°). */
  angleDeg: 90 | 45;
}

/** Where a round-main take-off cuts the main and how long its collar is. */
export function roundMainTapGeometry(style: DuctRoundMainTapStyle, branchDiameterMm: number, settings: { tapCollarMm: number }): RoundMainTapGeometry {
  const d = branchDiameterMm;
  const r = ROUND_FITTING_RULES;
  if (style === 'round-conical') {
    const mouth = d + r.conicalMouthExtraMm;
    return {
      openingMm: mouth,
      windowHalfMm: mouth / 2 + r.bodyExtraMm / 2,
      collarLengthMm: Math.max(settings.tapCollarMm, r.conicalMinLengthMm + r.spigotMm),
      angleDeg: 90,
    };
  }
  if (style === 'round-lateral') {
    // The branch meets the main along an ellipse d / sin 45° long.
    const along = d / Math.sin((r.lateralAngleDeg * Math.PI) / 180);
    return {
      openingMm: d,
      windowHalfMm: along / 2 + r.bodyExtraMm / 2,
      collarLengthMm: Math.max(settings.tapCollarMm, d / 2 + r.spigotMm),
      angleDeg: 45,
    };
  }
  return {
    openingMm: d,
    windowHalfMm: d / 2 + r.bodyExtraMm / 2,
    collarLengthMm: Math.max(settings.tapCollarMm, 2 * r.spigotMm),
    angleDeg: 90,
  };
}

/** The direction a round-main branch leaves in: square to the main, or 45° leaning downstream along the main's path. */
export function roundMainLeavingDirection(angleDeg: 90 | 45, outward: Point2D, mainDirection: Point2D): Point2D {
  if (angleDeg === 90) return outward;
  const x = outward.x + mainDirection.x;
  const y = outward.y + mainDirection.y;
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

/** S3.4: the largest branch a round main takes by a tap or saddle. */
export function maxRoundBranchMm(mainDiameterMm: number): number {
  return (2 / 3) * mainDiameterMm;
}

/** Length of the edge cut in the main for the fastener count: a circle, or the lateral's ellipse (Ramanujan). */
export function roundTapEdgeMm(style: DuctRoundMainTapStyle, openingMm: number): number {
  if (style !== 'round-lateral') return Math.PI * openingMm;
  const a = openingMm / Math.sin((ROUND_FITTING_RULES.lateralAngleDeg * Math.PI) / 180) / 2;
  const b = openingMm / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Fig. 3-5: a round reducer's cone is at least A − B long, and at least 102 mm. */
export function roundReducerMinLengthMm(fromDiameterMm: number, toDiameterMm: number): number {
  return Math.max(Math.abs(fromDiameterMm - toDiameterMm), ROUND_FITTING_RULES.reducerMinMm);
}

/** A wye leg's centreline length to its outlet (3A/2, A = the main's diameter). */
export function wyeLegLengthMm(mainDiameterMm: number): number {
  return ROUND_FITTING_RULES.wyeLegRatio * mainDiameterMm;
}
