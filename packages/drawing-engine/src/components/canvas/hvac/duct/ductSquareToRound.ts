/**
 * Square-to-round transition (SMACNA Fig. 2-7: "transitions may convert duct
 * profiles to any combination for rectangular, round or flat oval shapes").
 * The fabricated form is the classic development: four flat triangles, each
 * on one side of the rectangle with its apex on the circle, and four oblique
 * cone quarters, each from one rectangle corner to a quarter of the circle.
 * The same triangulation gives the developed sheet area and the 3D surface,
 * so what is drawn is what is scheduled.
 *
 * Local frame: s along the axis, a across (+ = the left of the heading), u up.
 */

export interface LocalPoint {
  s: number;
  a: number;
  u: number;
}

export interface SquareToRoundInput {
  /** Rectangle half sizes (outside) and its centre height. */
  rectHalfWidthMm: number;
  rectHalfHeightMm: number;
  rectCentreUpMm: number;
  /** Circle radius (outside) and its centre height. */
  radiusMm: number;
  circleCentreUpMm: number;
  /** Axial length of the lofted part (the necks are straight pieces). */
  lengthMm: number;
  /** The rectangle is at s = 0 and the circle at s = length; else the other way round. */
  rectAtStart: boolean;
  segmentsPerQuarter?: number;
}

export type LocalTriangle = [LocalPoint, LocalPoint, LocalPoint];

/** The development's triangles: 4 flat side triangles and 4 corner fans (the cone quarters). */
export function squareToRoundTriangles(input: SquareToRoundInput): LocalTriangle[] {
  const n = Math.max(2, Math.round(input.segmentsPerQuarter ?? 8));
  const sRect = input.rectAtStart ? 0 : input.lengthMm;
  const sCircle = input.rectAtStart ? input.lengthMm : 0;
  const w = input.rectHalfWidthMm;
  const h = input.rectHalfHeightMm;
  const c = input.rectCentreUpMm;
  // Corners by quadrant: +a+u, −a+u, −a−u, +a−u (counter-clockwise seen along +s).
  const corners: LocalPoint[] = [
    { s: sRect, a: w, u: c + h },
    { s: sRect, a: -w, u: c + h },
    { s: sRect, a: -w, u: c - h },
    { s: sRect, a: w, u: c - h },
  ];
  const circle = (phi: number): LocalPoint => ({
    s: sCircle, a: input.radiusMm * Math.cos(phi), u: input.circleCentreUpMm + input.radiusMm * Math.sin(phi),
  });
  const triangles: LocalTriangle[] = [];
  for (let quadrant = 0; quadrant < 4; quadrant += 1) {
    const corner = corners[quadrant]!;
    const from = (quadrant * Math.PI) / 2;
    // Cone quarter: the corner to the circle arc of its quadrant.
    for (let k = 0; k < n; k += 1) {
      triangles.push([corner, circle(from + (k * Math.PI) / (2 * n)), circle(from + ((k + 1) * Math.PI) / (2 * n))]);
    }
    // Flat side between this corner and the next, apex at the circle point between their quadrants.
    const next = corners[(quadrant + 1) % 4]!;
    triangles.push([corner, next, circle(from + Math.PI / 2)]);
  }
  return triangles;
}

function triangleArea([p, q, r]: LocalTriangle): number {
  const u = { s: q.s - p.s, a: q.a - p.a, u: q.u - p.u };
  const v = { s: r.s - p.s, a: r.a - p.a, u: r.u - p.u };
  const cross = {
    s: u.a * v.u - u.u * v.a,
    a: u.u * v.s - u.s * v.u,
    u: u.s * v.a - u.a * v.s,
  };
  return Math.hypot(cross.s, cross.a, cross.u) / 2;
}

/** Developed sheet area of the lofted part (mm²). */
export function squareToRoundAreaMm2(input: SquareToRoundInput): number {
  return squareToRoundTriangles({ ...input, segmentsPerQuarter: input.segmentsPerQuarter ?? 16 })
    .reduce((total, triangle) => total + triangleArea(triangle), 0);
}
