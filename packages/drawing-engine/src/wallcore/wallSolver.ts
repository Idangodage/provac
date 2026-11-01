/**
 * Wall footprint solver. Pure & deterministic (LAW 4): per-edge centerline
 * offsets (justification-aware), per-node join resolution, junction cores.
 * Same graph ⇒ identical output, independent of entity iteration order.
 *
 * Ported from the reference app's `core/geometry/wallSolver.ts`, but its corner
 * rules left holes at crowded junctions (the miter limit also rejected inner
 * corners, then an angle sort folded the core), so they knowingly differ:
 *
 * - An inner corner two faces reach going forward is always taken: it cannot
 *   spike. The miter limit only guards corners that extend behind the node.
 * - The core is the ring of the walls' end caps in ring order, so every cap is
 *   exactly one of its edges and walls + core tile with no gap and no overlap.
 * - No face is cut back past its own wall's length, so short walls cannot twist.
 * - When neighbours alone cannot describe the shape (a thin wall through a thick
 *   one, a short wall) each wall keeps only cut-backs another body really covers
 *   and its cut-off part goes into the core. Quad + cut-off part = the wall's
 *   whole rectangle, so a hole cannot form whatever the cut-backs are.
 * - At a junction of unequal heights those parts keep their own wall's height,
 *   and outer corners are filled per height band, between the walls standing there.
 */
import {
  CUT_OVERLAP,
  GEOM_EPS,
  MIN_FACE_REMAINDER,
  MITER_LIMIT_FACTOR,
  PARALLEL_CROSS_EPS,
} from './tolerances';
import {
  add2,
  angleOf2,
  cross2,
  dist2,
  dot2,
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
  /** The wall's whole share of the plan: its quad plus its part of each junction core. */
  outline: Vec2[];
  height: number;
  baseOffset: number;
}
export interface NodeWedge {
  nodeId: WallEntityId;
  /** CCW polygon filling junction area not covered by edge footprints. A node may have several. */
  polygon: Vec2[];
  height: number;
  baseOffset: number;
  /** At a junction of unequal walls: the wall whose height and material this piece keeps. */
  edgeId?: WallEntityId;
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
  /** this end's node position */
  p: Vec2;
  /** outgoing unit direction from this node along the edge, and its CCW normal */
  u: Vec2;
  n: Vec2;
  length: number;
  /** half-width on the CCW side of u / CW side of u */
  hCcw: number;
  hCw: number;
  /** how far each face is cut back from the node: >0 into the wall, <0 extended behind it */
  cutCcw: number;
  cutCw: number;
  /** resolved corners at this node */
  cornerCcw: Vec2;
  cornerCw: Vec2;
}

/** The corner between one wall end and its next neighbour counter-clockwise. */
interface Seam {
  i: EndRef;
  j: EndRef;
  /** The single point both faces end at, while their cut-backs are still `si`/`sj`. */
  shared: Vec2 | null;
  si: number;
  sj: number;
}

interface Joint {
  nodeId: WallEntityId;
  p: Vec2;
  refs: EndRef[];
  seams: Seam[];
  /** All walls here span the same heights, so one core prism can serve them all. */
  uniform: boolean;
  /** The neighbour-by-neighbour ring cannot describe this junction: build it from each wall's cut-off part. */
  piecewise: boolean;
  core: 'none' | 'ring' | 'pieces';
}

const faceCcw = (r: EndRef, s: number): Vec2 => add2(add2(r.p, scale2(r.n, r.hCcw)), scale2(r.u, s));
const faceCw = (r: EndRef, s: number): Vec2 => add2(add2(r.p, scale2(r.n, -r.hCw)), scale2(r.u, s));

/** Is `q` inside this end's raw, square-ended wall rectangle? */
function insideBody(q: Vec2, r: EndRef): boolean {
  const d = sub2(q, r.p);
  const along = dot2(d, r.u);
  const across = dot2(d, r.n);
  return (
    along >= -GEOM_EPS &&
    along <= r.length + GEOM_EPS &&
    across <= r.hCcw + GEOM_EPS &&
    across >= -r.hCw - GEOM_EPS
  );
}

/** Stretch of the segment from + t·dir, t in [0, length], inside this end's raw wall rectangle. */
function clipToBody(from: Vec2, dir: Vec2, length: number, r: EndRef): [number, number] | null {
  let t0 = 0;
  let t1 = length;
  const slab = (offset: number, rate: number, lo: number, hi: number): boolean => {
    if (Math.abs(rate) < PARALLEL_CROSS_EPS) return offset >= lo - GEOM_EPS && offset <= hi + GEOM_EPS;
    const x = (lo - offset) / rate;
    const y = (hi - offset) / rate;
    t0 = Math.max(t0, Math.min(x, y));
    t1 = Math.min(t1, Math.max(x, y));
    return t0 <= t1 + GEOM_EPS;
  };
  const d = sub2(from, r.p);
  if (!slab(dot2(d, r.u), dot2(dir, r.u), 0, r.length)) return null;
  if (!slab(dot2(d, r.n), dot2(dir, r.n), -r.hCw, r.hCcw)) return null;
  return [t0, t1];
}

/**
 * How far a face can be cut back from the node with another wall's body still
 * covering it. Stops short of that body's edge so the two keep overlapping:
 * bodies that merely touch can part by a grid step once rounded.
 */
function coveredCut(from: Vec2, r: EndRef, others: readonly EndRef[]): number {
  const stretches = others
    .map((other) => clipToBody(from, r.u, r.length, other))
    .filter((stretch): stretch is [number, number] => stretch !== null)
    .sort((x, y) => x[0] - y[0]);
  let reach = 0;
  for (const [t0, t1] of stretches) {
    if (t0 > reach + GEOM_EPS) break;
    reach = Math.max(reach, t1);
  }
  return Math.max(0, reach - CUT_OVERLAP);
}

function shareCorner(seam: Seam, m: Vec2, si: number, sj: number): void {
  seam.shared = m;
  seam.si = si;
  seam.sj = sj;
  seam.i.cutCcw = si;
  seam.j.cutCw = sj;
}

/**
 * The corner two neighbouring walls leave open beyond their square ends, if any:
 * an outer corner, or the shoulder where one wall's face runs on past a thinner one.
 */
function cornerFill(i: EndRef, j: EndRef): Vec2[] | null {
  const turn = cross2(i.u, j.u);
  if (Math.abs(turn) <= PARALLEL_CROSS_EPS) return null;
  const oi = faceCcw(i, 0);
  const oj = faceCw(j, 0);
  const m = lineLineIntersect2(oi, i.u, oj, j.u);
  if (!m) return null;
  const si = dot2(sub2(m, oi), i.u);
  const sj = dot2(sub2(m, oj), j.u);
  const withinLimit = dist2(m, i.p) <= MITER_LIMIT_FACTOR * Math.max(i.edge.thickness, j.edge.thickness);
  if (turn > 0) {
    // One face inside the other wall, the other running on behind its node: the triangle closes the shoulder.
    const trueInnerCorner = si >= -GEOM_EPS && sj >= -GEOM_EPS;
    return !trueInnerCorner && withinLimit ? dedupe([oi, m, oj]) : null;
  }
  return si <= GEOM_EPS && sj <= GEOM_EPS && withinLimit ? dedupe([i.p, oi, m, oj]) : dedupe([i.p, oi, oj]);
}

function joinNeighbours(i: EndRef, j: EndRef, joint: Joint): Seam {
  const seam: Seam = { i, j, shared: null, si: 0, sj: 0 };
  const oi = faceCcw(i, 0);
  const oj = faceCw(j, 0);
  const turn = cross2(i.u, j.u); // > 0: the gap from i to j is under 180°
  if (Math.abs(turn) <= PARALLEL_CROSS_EPS) {
    if (dot2(i.u, j.u) > 0) joint.piecewise = true; // two walls lying on top of each other
    else if (Math.abs(i.hCcw - j.hCw) < GEOM_EPS) shareCorner(seam, oi, 0, 0); // straight run: flat joint
    return seam; // otherwise a straight thickness step: both faces simply end at the node
  }
  const m = lineLineIntersect2(oi, i.u, oj, j.u);
  if (!m) return seam;
  const si = dot2(sub2(m, oi), i.u);
  const sj = dot2(sub2(m, oj), j.u);

  if (turn > 0) {
    // A true inner corner, if each face really runs inside the other wall back to the node.
    // Anything else (say a thickness shoulder, where one face runs on behind its node) cannot be a shared corner.
    const trueInnerCorner = si >= -GEOM_EPS && sj >= -GEOM_EPS && si <= i.length && sj <= j.length;
    if (trueInnerCorner && insideBody(oi, j) && insideBody(oj, i)) shareCorner(seam, m, si, sj);
    else joint.piecewise = true;
    return seam;
  }

  // Outer corner. A miter needs BOTH faces running backward: a mixed one would bite a wall's own corner.
  // Walls of unequal height never extend into one: their corner is filled per band, so no wall grows an ear.
  const withinLimit = dist2(m, i.p) <= MITER_LIMIT_FACTOR * Math.max(i.edge.thickness, j.edge.thickness);
  if (joint.uniform && si <= GEOM_EPS && sj <= GEOM_EPS && withinLimit) shareCorner(seam, m, si, sj);
  return seam;
}

function ringCrosses(ring: readonly Vec2[]): boolean {
  const n = ring.length;
  const side = (a: Vec2, b: Vec2, c: Vec2) => cross2(sub2(b, a), sub2(c, a));
  for (let k = 0; k < n; k += 1) {
    for (let l = k + 2; l < n; l += 1) {
      if (k === 0 && l === n - 1) continue;
      const a = ring[k]!;
      const b = ring[(k + 1) % n]!;
      const c = ring[l]!;
      const d = ring[(l + 1) % n]!;
      if (side(a, b, c) * side(a, b, d) < -GEOM_EPS && side(c, d, a) * side(c, d, b) < -GEOM_EPS) return true;
    }
  }
  return false;
}

/** The part of a wall's rectangle its quad gave up at this end. */
function cutOffPart(r: EndRef): Vec2[] | null {
  const a = Math.max(0, r.cutCcw);
  const b = Math.max(0, r.cutCw);
  if (a <= GEOM_EPS && b <= GEOM_EPS) return null;
  return dedupe([faceCcw(r, a), faceCcw(r, 0), faceCw(r, 0), faceCw(r, b)]);
}

function insideConvex(q: Vec2, ring: readonly Vec2[]): boolean {
  let sign = 0;
  for (let k = 0; k < ring.length; k += 1) {
    const a = ring[k]!;
    const side = cross2(sub2(ring[(k + 1) % ring.length]!, a), sub2(q, a));
    if (Math.abs(side) <= GEOM_EPS) continue;
    if (sign !== 0 && Math.sign(side) !== sign) return false;
    sign = Math.sign(side);
  }
  return true;
}

function solveJointCore(joint: Joint, quads: ReadonlyMap<WallEntityId, readonly Vec2[]>): NodeWedge[] {
  const { nodeId, refs, seams } = joint;
  const first = refs[0]!.edge;

  if (joint.uniform && !joint.piecewise) {
    const ring: Vec2[] = [];
    for (const seam of seams) {
      ring.push(seam.i.cornerCcw);
      if (!seam.shared) ring.push(seam.j.cornerCw);
    }
    const uniq = dedupe(ring);
    if (!ringCrosses(uniq)) {
      const closesItself = refs.length < 3 && seams.every((seam) => seam.shared);
      if (closesItself || uniq.length < 3 || Math.abs(polygonArea(uniq)) <= GEOM_EPS) return [];
      joint.core = 'ring';
      return [{ nodeId, polygon: uniq, height: first.height, baseOffset: first.baseOffset }];
    }
  }

  joint.core = 'pieces';
  const pieces: NodeWedge[] = [];
  for (const r of refs) {
    const part = cutOffPart(r);
    if (!part) continue;
    // Already inside a wall that stands at least as tall: drawing it again could only z-fight.
    const hidden = refs.some((other) => (
      other !== r &&
      other.edge.baseOffset <= r.edge.baseOffset + GEOM_EPS &&
      other.edge.baseOffset + other.edge.height >= r.edge.baseOffset + r.edge.height - GEOM_EPS &&
      part.every((q) => insideConvex(q, quads.get(other.edge.id)!))
    ));
    if (hidden) continue;
    pieces.push({
      nodeId,
      polygon: part,
      height: r.edge.height,
      baseOffset: r.edge.baseOffset,
      ...(joint.uniform ? {} : { edgeId: r.edge.id }),
    });
  }

  // Open corners, one band at a time: above a low wall, its taller neighbours close up across it.
  const levels = [...new Set(refs.flatMap((r) => [r.edge.baseOffset, r.edge.baseOffset + r.edge.height]))].sort((x, y) => x - y);
  for (let k = 0; k + 1 < levels.length; k += 1) {
    const lo = levels[k]!;
    const hi = levels[k + 1]!;
    const standing = refs.filter((r) => r.edge.baseOffset <= lo + GEOM_EPS && r.edge.baseOffset + r.edge.height >= hi - GEOM_EPS);
    standing.forEach((i, s) => {
      const j = standing[(s + 1) % standing.length]!;
      if (j === i) return;
      // A corner already closed by extending both walls needs no fill.
      if (seams.some((seam) => seam.i === i && seam.j === j && seam.shared)) return;
      const fill = cornerFill(i, j);
      if (fill) pieces.push({ nodeId, polygon: fill, height: hi - lo, baseOffset: lo });
    });
  }
  return pieces.filter((piece) => piece.polygon.length >= 3 && Math.abs(polygonArea(piece.polygon)) > GEOM_EPS);
}

/** What lies between this end's corners on the way across the junction, clockwise side first. */
function shareOfCore(r: EndRef, joint: Joint | undefined): Vec2[] {
  if (joint?.core === 'ring') return [joint.p];
  if (joint?.core !== 'pieces') return [];
  return [
    ...(r.cutCw > GEOM_EPS ? [faceCw(r, 0)] : []),
    ...(r.cutCcw > GEOM_EPS ? [faceCcw(r, 0)] : []),
  ];
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
    const length = dist2(pa, pb);
    const { hl, hr } = halfWidths(e);
    const end = (p: Vec2, u: Vec2, hCcw: number, hCw: number): EndRef => ({
      edge: e,
      p,
      u,
      n: perp2(u),
      length,
      hCcw,
      hCw,
      cutCcw: 0,
      cutCw: 0,
      cornerCcw: p,
      cornerCw: p,
    });
    // at A: u = d → ccw side = left(hl), cw = right(hr)
    const atA = end(pa, d, hl, hr);
    // at B: u = −d → perp(u) = −perp(d): ccw side w.r.t u = right face(hr), cw = left(hl)
    const atB = end(pb, scale2(d, -1), hr, hl);
    pushMulti(ends, e.a, atA);
    pushMulti(ends, e.b, atB);
    endByEdge.set(e.id, { atA, atB });
  }

  // Each junction's ideal seams, as cut-backs on its walls' faces.
  const joints = new Map<WallEntityId, Joint>();
  for (const [nodeId, refs] of [...ends.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (refs.length === 1) continue;
    // sort incident ends by outgoing angle (stable: angle, then edge id)
    refs.sort((x, y) => {
      const ax = angleOf2(x.u);
      const ay = angleOf2(y.u);
      return ax !== ay ? ax - ay : x.edge.id < y.edge.id ? -1 : 1;
    });
    const first = refs[0]!.edge;
    const joint: Joint = {
      nodeId,
      p: nodeById.get(nodeId)!.p,
      refs,
      seams: [],
      uniform: refs.every(
        (r) =>
          Math.abs(r.edge.height - first.height) < GEOM_EPS &&
          Math.abs(r.edge.baseOffset - first.baseOffset) < GEOM_EPS,
      ),
      piecewise: false,
      core: 'none',
    };
    joint.seams = refs.map((ref, k) => joinNeighbours(ref, refs[(k + 1) % refs.length]!, joint));
    joints.set(nodeId, joint);
  }

  // A wall too short for what both its ends want cannot join by neighbours alone.
  const roomOf = (length: number) => Math.max(0, length - Math.min(MIN_FACE_REMAINDER, length * 0.01));
  const wanted = (a: number, b: number) => Math.max(0, a) + Math.max(0, b);
  for (const e of edges) {
    const pair = endByEdge.get(e.id);
    if (!pair) continue;
    const { atA, atB } = pair;
    const room = roomOf(atA.length);
    // left face runs atA.ccw → atB.cw; right face runs atA.cw → atB.ccw
    if (wanted(atA.cutCcw, atB.cutCw) > room || wanted(atA.cutCw, atB.cutCcw) > room) {
      for (const nodeId of [e.a, e.b]) {
        const joint = joints.get(nodeId);
        if (joint) joint.piecewise = true;
      }
    }
  }
  for (const joint of joints.values()) {
    if (!joint.piecewise) continue;
    // Square-ended walls cut only where another body really covers them; corner fills close the rest.
    for (const r of joint.refs) {
      const others = joint.refs.filter((other) => other !== r);
      r.cutCcw = coveredCut(faceCcw(r, 0), r, others);
      r.cutCw = coveredCut(faceCw(r, 0), r, others);
    }
  }
  // Even then no face may be cut back past its own length.
  for (const e of edges) {
    const pair = endByEdge.get(e.id);
    if (!pair) continue;
    const { atA, atB } = pair;
    const room = roomOf(atA.length);
    const fit = (a: number, b: number): [number, number] => {
      const total = wanted(a, b);
      return total <= room ? [a, b] : [(a * room) / total, (b * room) / total];
    };
    [atA.cutCcw, atB.cutCw] = fit(atA.cutCcw, atB.cutCw);
    [atA.cutCw, atB.cutCcw] = fit(atA.cutCw, atB.cutCcw);
  }

  // Corners: a seam still at its agreed cut-backs shares one exact point, so walls and core tile bit-for-bit.
  for (const refs of ends.values()) {
    for (const r of refs) {
      r.cornerCcw = faceCcw(r, r.cutCcw);
      r.cornerCw = faceCw(r, r.cutCw);
    }
  }
  for (const joint of joints.values()) {
    for (const seam of joint.seams) {
      if (seam.shared && seam.i.cutCcw === seam.si && seam.j.cutCw === seam.sj) {
        seam.i.cornerCcw = seam.shared;
        seam.j.cornerCw = seam.shared;
      } else {
        seam.shared = null;
      }
    }
  }

  const quads = new Map<WallEntityId, readonly Vec2[]>();
  const corners = new Map<WallEntityId, EdgeFootprint['corners']>();
  for (const e of edges) {
    const pair = endByEdge.get(e.id);
    if (!pair) continue;
    // left face runs aCcw → bCw; right face runs aCw → bCcw (see EndRef mapping)
    const quad: EdgeFootprint['corners'] = [pair.atA.cornerCcw, pair.atB.cornerCw, pair.atB.cornerCcw, pair.atA.cornerCw];
    corners.set(e.id, quad);
    quads.set(e.id, quad);
  }

  const wedges: NodeWedge[] = [];
  for (const joint of joints.values()) wedges.push(...solveJointCore(joint, quads));

  const footprints: EdgeFootprint[] = [];
  for (const e of edges) {
    const pair = endByEdge.get(e.id);
    if (!pair) continue;
    const quad = corners.get(e.id)!;
    const [aL, bL, bR, aR] = quad;
    const outline = dedupe([
      aL,
      bL,
      ...shareOfCore(pair.atB, joints.get(e.b)),
      bR,
      aR,
      ...shareOfCore(pair.atA, joints.get(e.a)),
    ]);
    footprints.push({
      edgeId: e.id,
      corners: quad,
      outline: ringCrosses(outline) ? [...quad] : outline,
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

/** Drops consecutive repeats around a ring, keeping its order. */
function dedupe(pts: readonly Vec2[], eps = 1e-6): Vec2[] {
  const out: Vec2[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (!last || dist2(last, q) >= eps) out.push(q);
  }
  while (out.length > 1 && dist2(out[0]!, out[out.length - 1]!) < eps) out.pop();
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
