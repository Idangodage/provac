/**
 * Tangent-arc fillet of a spine polyline (world mm). Each interior corner becomes
 * an arc tangent to both segments. Tangent length t = r / tan(θ/2); the two corners
 * sharing a segment must fit within it (t_a + t_b ≤ segLen) — if not, the radius is
 * CLAMPED (never overlapped) and a warning is emitted. See invariant B.
 */

import type { Point } from '../model/types';
import {
  add,
  cross,
  dist,
  dot,
  mul,
  norm,
  sub,
  type Path,
} from './path';

export interface FilletWarning {
  vertexIndex: number;
  requestedRadiusMm: number;
  appliedRadiusMm: number;
  reason: 'reach';
}

export interface FilletResult {
  path: Path;
  warnings: FilletWarning[];
}

function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 1e-7) out.push(p);
  }
  return out;
}

interface Corner {
  i: number;
  filletable: boolean;
  a1: Point; // unit dir from vertex toward prev
  a2: Point; // unit dir from vertex toward next
  half: number;
  tDesired: number;
}

export function filletSpine(spineRaw: Point[], radiusMm: number): FilletResult {
  const pts = dedupe(spineRaw);
  const n = pts.length;
  if (n < 2) return { path: [], warnings: [] };
  if (n === 2) return { path: [{ kind: 'line', a: pts[0]!, b: pts[1]! }], warnings: [] };

  const segLen: number[] = [];
  for (let i = 0; i < n - 1; i += 1) segLen.push(dist(pts[i]!, pts[i + 1]!));

  const corners: Corner[] = [];
  for (let i = 1; i < n - 1; i += 1) {
    const v = pts[i]!;
    const a1 = norm(sub(pts[i - 1]!, v));
    const a2 = norm(sub(pts[i + 1]!, v));
    const c = Math.max(-1, Math.min(1, dot(a1, a2)));
    const theta = Math.acos(c); // interior angle 0..π
    if (theta > Math.PI - 1e-3 || theta < 1e-3 || radiusMm <= 0) {
      corners[i] = { i, filletable: false, a1, a2, half: 0, tDesired: 0 };
      continue;
    }
    const half = theta / 2;
    corners[i] = { i, filletable: true, a1, a2, half, tDesired: radiusMm / Math.tan(half) };
  }

  // Clamp: on each segment, the tangents of its two end-corners must fit.
  const tApplied = new Map<number, number>();
  for (let i = 1; i < n - 1; i += 1) {
    if (corners[i]?.filletable) tApplied.set(i, corners[i]!.tDesired);
  }
  for (let pass = 0; pass < 4; pass += 1) {
    for (let seg = 0; seg < n - 1; seg += 1) {
      const tl = tApplied.get(seg) ?? 0; // corner at vertex `seg` extends forward
      const tr = tApplied.get(seg + 1) ?? 0; // corner at vertex `seg+1` extends back
      const total = tl + tr;
      if (total > 1e-9 && total > segLen[seg]! - 1e-6) {
        const k = (segLen[seg]! / total) * 0.999;
        if (tApplied.has(seg)) tApplied.set(seg, tl * k);
        if (tApplied.has(seg + 1)) tApplied.set(seg + 1, tr * k);
      }
    }
  }

  const path: Path = [];
  const warnings: FilletWarning[] = [];
  let cursor = pts[0]!;
  for (let i = 1; i < n - 1; i += 1) {
    const c = corners[i]!;
    const t = tApplied.get(i) ?? 0;
    if (!c.filletable || t < 1e-6) {
      // Sharp corner: line ends AT the vertex, next line starts there.
      path.push({ kind: 'line', a: cursor, b: pts[i]! });
      cursor = pts[i]!;
      continue;
    }
    const rEff = t * Math.tan(c.half);
    if (rEff < radiusMm - 1e-6) {
      warnings.push({ vertexIndex: i, requestedRadiusMm: radiusMm, appliedRadiusMm: rEff, reason: 'reach' });
    }
    const v = pts[i]!;
    const pIn = add(v, mul(c.a1, t));
    const pOut = add(v, mul(c.a2, t));
    const bis = norm(add(c.a1, c.a2));
    const center = add(v, mul(bis, rEff / Math.sin(c.half)));
    const a0 = Math.atan2(pIn.y - center.y, pIn.x - center.x);
    let a1 = Math.atan2(pOut.y - center.y, pOut.x - center.x);
    const ccw = cross(sub(pIn, center), sub(pOut, center)) > 0;
    if (ccw) {
      while (a1 < a0) a1 += 2 * Math.PI;
    } else {
      while (a1 > a0) a1 -= 2 * Math.PI;
    }
    path.push({ kind: 'line', a: cursor, b: pIn });
    path.push({ kind: 'arc', center, radius: rEff, a0, a1, ccw });
    cursor = pOut;
  }
  path.push({ kind: 'line', a: cursor, b: pts[n - 1]! });

  // Drop zero-length lines that can appear between back-to-back fillets.
  return { path: path.filter((s) => s.kind !== 'line' || dist(s.a, s.b) > 1e-6), warnings };
}
