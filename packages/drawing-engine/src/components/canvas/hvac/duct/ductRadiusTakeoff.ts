/**
 * A radius take-off: a swept rectangular branch (ASHRAE 5-22, Idelchik Diagram 7-22, published at r/W 1.0). It is a
 * radius elbow whose throat lies tangent along the main's wall; its heel, concentric with the throat, is cut by that
 * wall inside the branch's far cheek. Nothing enters the main, so it is no scoop (SMACNA Fig. 2-6 bans those).
 *
 * It is a tee, made in the shop as one with its section of the main: the throat runs into the wall too gradually for a
 * flange or screws, so its foot is a seam, not a joint, and the branch joins it past the sweep with an ordinary joint.
 *
 * One shape, in the frame of the branch's centre on the main's outside wall: `a` out along the branch, `b` along the
 * main toward its end, the throat on the side of the main's start. The plan, the 3D shell, the sheet and the hole in
 * the main all read it, so the views cannot disagree.
 */
export const RADIUS_TAKEOFF = {
  /** Where it is published, and SMACNA RE1's proportions (centreline R = 3W/2). */
  defaultRatio: 1,
  /** Here its opening on the main is no longer than a shoe's, so it fits wherever a shoe does. */
  minRatio: 0.25,
  maxRatio: 1.5,
  /** Under this the centreline ratio is under 1: the tight throat SMACNA allows up to 5 m/s (Fig. 2-2 RE1). */
  tightBelowRatio: 0.5,
  /** The straight past the sweep (mm): room for the joint at its end. */
  neckMm: 50,
} as const;

/** Sections a 90° sweep is drawn and judged through. */
const SWEEP_STEPS = 24;

/** A point in the take-off's frame (mm). */
export interface TakeoffPoint {
  a: number;
  b: number;
}

export interface RadiusTakeoffShape {
  widthMm: number;
  ratio: number;
  /** The throat's radius, r = ratio × W. */
  throatMm: number;
  /** The heel's radius, R = r + W, about the same centre. */
  heelMm: number;
  centre: TakeoffPoint;
  /** How far inside the branch's far cheek the heel meets the main's wall. */
  heelInMm: number;
}

/** A take-off's r/W within what is made: absent = the default. */
export function radiusTakeoffRatio(ratio?: number): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return RADIUS_TAKEOFF.defaultRatio;
  return Math.min(RADIUS_TAKEOFF.maxRatio, Math.max(RADIUS_TAKEOFF.minRatio, ratio));
}

/** A ratio as the drawing says it: 1.0, 0.75. */
export function formatRadiusRatio(ratio: number): string {
  return ratio.toFixed(Math.abs(ratio * 10 - Math.round(ratio * 10)) < 1e-9 ? 1 : 2);
}

export function radiusTakeoffShape(widthMm: number, ratio?: number): RadiusTakeoffShape {
  const value = radiusTakeoffRatio(ratio);
  const throatMm = value * widthMm;
  const heelMm = throatMm + widthMm;
  const centre = { a: throatMm, b: -(widthMm / 2 + throatMm) };
  return { widthMm, ratio: value, throatMm, heelMm, centre, heelInMm: widthMm / 2 - (centre.b + Math.sqrt(heelMm * heelMm - throatMm * throatMm)) };
}

/** Collar length: the sweep and its neck, at least the project's collar; `branchPartMm`, a tee's branch part, runs the neck on up to the damper after it. */
export function radiusTakeoffCollarMm(shape: RadiusTakeoffShape, tapCollarMm: number, branchPartMm?: number, damperMm = 0): number {
  const least = Math.max(tapCollarMm, shape.throatMm + RADIUS_TAKEOFF.neckMm);
  return branchPartMm === undefined ? least : Math.max(least, branchPartMm - damperMm);
}

export interface RadiusTakeoffSection {
  /** Throat side and heel side, on the skin; the heel side stops at the main's wall. */
  inner: TakeoffPoint;
  outer: TakeoffPoint;
  /** Unit, out from the centre across the fitting. */
  across: TakeoffPoint;
  /** This section's outer point is on the heel, not on the main's wall. */
  onHeel: boolean;
}

/**
 * Sections across the sweep from the throat's tangent point on the wall to the branch, `skinMm` outside the clear
 * shape (the throat's skin on the centre's side, the heel's away from it). The section at the heel's foot is one of
 * them, so the heel starts exactly on the wall.
 */
export function radiusTakeoffSections(shape: RadiusTakeoffShape, skinMm = 0, steps = SWEEP_STEPS): RadiusTakeoffSection[] {
  const { centre, throatMm } = shape;
  const inside = Math.max(0, throatMm - skinMm);
  const heel = shape.heelMm + skinMm;
  const foot = Math.acos(throatMm / heel);
  const angles = Array.from({ length: steps + 1 }, (_, index) => (index / steps) * (Math.PI / 2)).filter((angle) => Math.abs(angle - foot) > 1e-6);
  angles.push(foot);
  angles.sort((x, y) => x - y);
  return angles.map((angle) => {
    const across = { a: -Math.cos(angle), b: Math.sin(angle) };
    const onHeel = angle >= foot;
    const reach = onHeel ? heel : throatMm / Math.cos(angle);
    return {
      inner: { a: centre.a + inside * across.a, b: centre.b + inside * across.b },
      outer: onHeel ? { a: centre.a + reach * across.a, b: centre.b + reach * across.b } : { a: 0, b: centre.b + reach * across.b },
      across, onHeel,
    };
  });
}

/** The plan outline, `skinMm` outside the clear shape, closed along the main's wall. */
export function radiusTakeoffOutline(shape: RadiusTakeoffShape, lengthMm: number, skinMm = 0, steps = SWEEP_STEPS): TakeoffPoint[] {
  const sections = radiusTakeoffSections(shape, skinMm, steps);
  const half = shape.widthMm / 2 + skinMm;
  const end = Math.max(lengthMm, shape.throatMm);
  const first = sections[0]!;
  const heel = sections.filter((section) => section.onHeel).reverse();
  return [
    { a: 0, b: first.inner.b },
    ...sections.map((section) => section.inner),
    { a: end, b: -half },
    { a: end, b: half },
    ...heel.map((section) => section.outer),
  ];
}

/** The clear plan area (mm²): the sweep, the wedge between the throat and the wall, the neck. */
export function radiusTakeoffPlanAreaMm2(shape: RadiusTakeoffShape, lengthMm: number): number {
  const { throatMm: r, heelMm: R, widthMm } = shape;
  const foot = Math.acos(r / R);
  const sweep = ((Math.PI / 2 - foot) / 2) * (R * R - r * r);
  const wedge = (r * r * (Math.tan(foot) - foot)) / 2;
  return sweep + wedge + widthMm * Math.max(0, lengthMm - r);
}

/** The length of its cheeks: the throat, the heel to the wall, both sides of the neck. */
function radiusTakeoffCheeksMm(shape: RadiusTakeoffShape, lengthMm: number): number {
  const { throatMm: r, heelMm: R } = shape;
  return (Math.PI / 2) * r + (Math.PI / 2 - Math.acos(r / R)) * R + 2 * Math.max(0, lengthMm - r);
}

/** Its sheet (m²), before seams and flanges: the flat top and bottom, the throat and heel cheeks, the neck's two cheeks. */
export function radiusTakeoffSheetAreaM2(shape: RadiusTakeoffShape, lengthMm: number, heightMm: number): number {
  return (2 * radiusTakeoffPlanAreaMm2(shape, lengthMm) + heightMm * radiusTakeoffCheeksMm(shape, lengthMm)) / 1e6;
}

/** Its foot on the main's wall: from the throat's tangent point to where the wall cuts the heel. */
export function radiusTakeoffFootMm(shape: RadiusTakeoffShape): number {
  return shape.widthMm + shape.throatMm - shape.heelInMm;
}

/** The length a seam of its four panels runs on average: half its cheeks. */
export function radiusTakeoffSeamRunMm(shape: RadiusTakeoffShape, lengthMm: number): number {
  return radiusTakeoffCheeksMm(shape, lengthMm) / 2;
}
