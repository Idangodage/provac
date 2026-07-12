/**
 * Wall footprint solver — verbatim port of the reference app's
 * `core/geometry/wallSolver.ts`. Pure & deterministic (LAW 4): per-edge
 * centerline offsets (justification-aware), per-node join resolution
 * (miter → bevel past the miter limit → butt caps), valence≥3 wedge polygons.
 * Same graph ⇒ identical output, independent of entity iteration order.
 */
import { GEOM_EPS, MITER_LIMIT_FACTOR } from './tolerances';
import {
  add2,
  angleOf2,
  cross2,
  dist2,
  lineLineIntersect2,
  norm2,
  perp2,
  scale2,
  sub2,
  type Vec2,
} from './vec2';
import type { WallEntityId, WallGraphDoc, WallJustification } from './wallModel';

export interface SolverNode {
  id: WallEntityId;
  p: Vec2;
}
export interface SolverEdge {
  id: WallEntityId;
  a: WallEntityId;
  b: WallEntityId;
  thickness: number;
  justification: WallJustification;
  height: number;
  baseOffset: number;
}
export interface WallGraphInput {
  nodes: SolverNode[];
  edges: SolverEdge[];
}

export interface EdgeFootprint {
  edgeId: WallEntityId;
  /**
   * Labeled corners [aLeft, bLeft, bRight, aRight] (left = +90° from the a→b direction).
   * NOTE: this label order winds CLOCKWISE; consumers normalize winding before earcut.
   */
  corners: [Vec2, Vec2, Vec2, Vec2];
  height: number;
  baseOffset: number;
}
export interface NodeWedge {
  nodeId: WallEntityId;
  /** CCW polygon filling the junction area not covered by edge footprints. */
  polygon: Vec2[];
  height: number;
  baseOffset: number;
}
export interface WallSolveResult {
  footprints: EdgeFootprint[];
  wedges: NodeWedge[];
}

/** Adapter: solve straight from a WallGraphDoc. */
export function solveWallGraphDoc(doc: WallGraphDoc): WallSolveResult {
  return solveWalls({
    nodes: Object.values(doc.nodes).map((n) => ({ id: n.id, p: n.p })),
    edges: Object.values(doc.edges).map((e) => ({
      id: e.id,
      a: e.a,
      b: e.b,
      thickness: e.thickness,
      justification: e.justification,
      height: e.height,
      baseOffset: e.baseOffset,
    })),
  });
}

/** Half-widths (left, right) w.r.t. the a→b direction, per justification. */
export function halfWidths(e: Pick<SolverEdge, 'thickness' | 'justification'>): { hl: number; hr: number } {
  switch (e.justification) {
    case 'center':
      return { hl: e.thickness / 2, hr: e.thickness / 2 };
    case 'left':
      // centerline on the LEFT face → body extends to the right of the line
      return { hl: 0, hr: e.thickness };
    case 'right':
      return { hl: e.thickness, hr: 0 };
  }
}

interface EndRef {
  edge: SolverEdge;
  /** outgoing unit direction from this node along the edge */
  u: Vec2;
  /** half-width on the CCW side of u / CW side of u */
  hCcw: number;
  hCw: number;
  /** resolved corners at this node (filled by join pass) */
  cornerCcw: Vec2 | null;
  cornerCw: Vec2 | null;
  atA: boolean;
}

export function solveWalls(graph: WallGraphInput): WallSolveResult {
  const nodeById = new Map<WallEntityId, SolverNode>();
  for (const n of graph.nodes) nodeById.set(n.id, n);

  // sort edges by id for order-independence (LAW 4 determinism)
  const edges = [...graph.edges].sort((x, y) => (x.id < y.id ? -1 : 1));

  // per-node incident end refs
  const ends = new Map<WallEntityId, EndRef[]>();
  const endByEdge = new Map<WallEntityId, { atA: EndRef; atB: EndRef }>();
  for (const e of edges) {
    const pa = nodeById.get(e.a)?.p;
    const pb = nodeById.get(e.b)?.p;
    if (!pa || !pb || dist2(pa, pb) < GEOM_EPS) continue;
    const d = norm2(sub2(pb, pa));
    const { hl, hr } = halfWidths(e);
    // at A: u = d → ccw side = left(hl), cw = right(hr)
    const atA: EndRef = { edge: e, u: d, hCcw: hl, hCw: hr, cornerCcw: null, cornerCw: null, atA: true };
    // at B: u = −d → perp(u) = −perp(d): ccw side w.r.t u = right face(hr), cw = left(hl)
    const atB: EndRef = {
      edge: e,
      u: scale2(d, -1),
      hCcw: hr,
      hCw: hl,
      cornerCcw: null,
      cornerCw: null,
      atA: false,
    };
    pushMulti(ends, e.a, atA);
    pushMulti(ends, e.b, atB);
    endByEdge.set(e.id, { atA, atB });
  }

  const wedges: NodeWedge[] = [];

  for (const [nodeId, refs] of [...ends.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const node = nodeById.get(nodeId)!;
    const p = node.p;
    if (refs.length === 1) {
      // butt cap: 1 edge → square cap
      const r = refs[0]!;
      r.cornerCcw = add2(p, scale2(perp2(r.u), r.hCcw));
      r.cornerCw = add2(p, scale2(perp2(r.u), -r.hCw));
      continue;
    }
    // sort incident ends by outgoing angle (stable: angle, then edge id)
    refs.sort((x, y) => {
      const ax = angleOf2(x.u);
      const ay = angleOf2(y.u);
      return ax !== ay ? ax - ay : x.edge.id < y.edge.id ? -1 : 1;
    });
    const junctionPts: Vec2[] = [];
    const maxT = Math.max(...refs.map((r) => r.edge.thickness));

    for (let i = 0; i < refs.length; i++) {
      const ei = refs[i]!;
      const ej = refs[(i + 1) % refs.length]!;
      // ei's CCW-side offset line vs ej's CW-side offset line
      const oi = add2(p, scale2(perp2(ei.u), ei.hCcw));
      const oj = add2(p, scale2(perp2(ej.u), -ej.hCw));
      const cross = Math.abs(cross2(ei.u, ej.u));
      let assigned = false;
      if (cross > 1e-9) {
        const m = lineLineIntersect2(oi, ei.u, oj, ej.u);
        if (m) {
          // Validity = locality: outer miters legitimately sit "behind" the offset base
          // points, so the only rejection criterion is the miter limit.
          const miterLen = dist2(m, p);
          if (miterLen <= MITER_LIMIT_FACTOR * maxT) {
            ei.cornerCcw = m;
            ej.cornerCw = m;
            junctionPts.push(m);
            assigned = true;
          }
        }
      } else if (Math.abs(ei.hCcw - ej.hCw) < GEOM_EPS && cross2(ei.u, ej.u) <= 0) {
        // collinear continuation with equal offsets → shared flat joint point
        const m = oi;
        ei.cornerCcw = m;
        ej.cornerCw = m;
        junctionPts.push(m);
        assigned = true;
      }
      if (!assigned) {
        // bevel / butt fallback (sharp angle, reflex, parallel step)
        ei.cornerCcw = oi;
        ej.cornerCw = oj;
        junctionPts.push(oi, oj);
      }
    }

    // wedge polygon: junction points around the node not covered by edge quads
    if (refs.length >= 3 || junctionPts.length > refs.length) {
      const uniq = dedupe(junctionPts);
      if (uniq.length >= 3) {
        uniq.sort((q1, q2) => angleOf2(sub2(q1, p)) - angleOf2(sub2(q2, p)));
        wedges.push({
          nodeId,
          polygon: uniq,
          height: Math.min(...refs.map((r) => r.edge.height)),
          baseOffset: Math.max(...refs.map((r) => r.edge.baseOffset)),
        });
      }
    }
  }

  const footprints: EdgeFootprint[] = [];
  for (const e of edges) {
    const pair = endByEdge.get(e.id);
    if (!pair) continue;
    const { atA, atB } = pair;
    // left face runs aCcw → bCw; right face runs aCw → bCcw (see EndRef mapping)
    const aL = atA.cornerCcw!;
    const aR = atA.cornerCw!;
    const bL = atB.cornerCw!;
    const bR = atB.cornerCcw!;
    footprints.push({
      edgeId: e.id,
      corners: [aL, bL, bR, aR],
      height: e.height,
      baseOffset: e.baseOffset,
    });
  }
  return { footprints, wedges };
}

function pushMulti(map: Map<WallEntityId, EndRef[]>, key: WallEntityId, ref: EndRef): void {
  const list = map.get(key);
  if (list) list.push(ref);
  else map.set(key, [ref]);
}

function dedupe(pts: Vec2[], eps = 1e-6): Vec2[] {
  const out: Vec2[] = [];
  for (const q of pts) {
    if (!out.some((o) => dist2(o, q) < eps)) out.push(q);
  }
  return out;
}

/** Shoelace area (CCW positive) — used by tests and triangulation. */
export function polygonArea(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
