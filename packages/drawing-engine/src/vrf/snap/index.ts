/**
 * rbush-backed snapping with a strict priority: port → endpoint → parallel → grid.
 *
 * Design notes (why it is built this way):
 *  - Candidates are stored as ZERO-AREA point boxes; the CURSOR query box is inflated
 *    by the tolerance at query time. Tolerance is view-dependent (screen px ÷ zoom),
 *    so pre-inflating candidates would be wrong and force a rebuild on every zoom.
 *  - Only PORT + ENDPOINT (finite points) live in the rbush tree. PARALLEL guides are
 *    infinite lines — no finite bbox captures "within tol of the line" — so they are
 *    tested analytically (perpendicular distance) against a small array at query time.
 *  - Priority strictly dominates distance ACROSS tiers (a port at 7 mm beats an
 *    endpoint at 3 mm); distance only orders WITHIN a tier. Ties broken by a stable
 *    ref key so the choice never oscillates.
 *  - The tree is rebuilt only when a cheap memo key (doc topology + gap) changes;
 *    view/tool/slider state is deliberately excluded.
 */

import RBush from 'rbush';

import type { BoardDoc, Point, PortRole } from '../model/types';
import { portPairCenterWorld } from '../geometry/kit';
import { openRunEnds } from '../model/ops';
import { cross, dist, dot } from '../geometry/path';
import { pxToWorld, type ViewTransform } from '../geometry/transform';

export type SnapKind = 'port' | 'endpoint' | 'parallel' | 'grid';

export const SNAP_TIER: Record<SnapKind, number> = { port: 0, endpoint: 1, parallel: 2, grid: 3 };

export interface SnapRef {
  kitId?: string;
  role?: PortRole;
  runId?: string;
  end?: 'start' | 'end';
  guide?: 'h' | 'v' | 'seg';
  originId?: string;
}

export interface SnapCandidate {
  /** World mm. For a parallel guide this is the SEED point the line passes through. */
  point: Point;
  kind: Exclude<SnapKind, 'grid'>;
  /** Unit direction — only for guide='seg' (the axis the guide is parallel to). */
  dir?: Point;
  ref: SnapRef;
}

export interface SnapResult {
  /** The snapped world point (guide foot for parallels; the seed for port/endpoint). */
  point: Point;
  kind: SnapKind;
  ref?: SnapRef;
  distanceMm: number;
  tier: number;
  /** For a parallel result: the unit direction of the guide line (for drawing it). */
  guideDir?: Point;
}

export interface RBushEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  candidate: SnapCandidate;
}

export interface SnapIndexOptions {
  /** Live pipe gap — drives refnet port geometry, so it is part of the memo key. */
  gapMm: number;
  gridMm?: number;
  tolerancePx?: number;
  minWorldTolMm?: number;
  maxWorldTolMm?: number;
}

const DEFAULTS = { gridMm: 10, tolerancePx: 8, minWorldTolMm: 0.5, maxWorldTolMm: 500 };

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** A stable per-candidate key for deterministic tie-breaking. */
function refKey(c: SnapCandidate): string {
  const r = c.ref;
  return `${c.kind}|${r.kitId ?? ''}:${r.role ?? ''}|${r.runId ?? ''}:${r.end ?? ''}|${r.guide ?? ''}|${r.originId ?? ''}`;
}

/** Screen-px tolerance mapped to world mm, clamped so extreme zooms stay sane. */
export function worldTolerance(view: ViewTransform, opts: SnapIndexOptions): number {
  const raw = pxToWorld(view, opts.tolerancePx ?? DEFAULTS.tolerancePx);
  const lo = opts.minWorldTolMm ?? DEFAULTS.minWorldTolMm;
  const hi = opts.maxWorldTolMm ?? DEFAULTS.maxWorldTolMm;
  return Math.min(hi, Math.max(lo, raw));
}

export function nearestGrid(cursor: Point, gridMm: number): Point {
  const g = gridMm > 0 ? gridMm : 1;
  return { x: Math.round(cursor.x / g) * g, y: Math.round(cursor.y / g) * g };
}

/** Foot of the cursor on a guide + its perpendicular distance. */
export function projectOntoGuide(c: SnapCandidate, cursor: Point): { point: Point; distanceMm: number } {
  const P = c.point;
  if (c.ref.guide === 'h') return { point: { x: cursor.x, y: P.y }, distanceMm: Math.abs(cursor.y - P.y) };
  if (c.ref.guide === 'v') return { point: { x: P.x, y: cursor.y }, distanceMm: Math.abs(cursor.x - P.x) };
  // seg: line through P with unit direction dir
  const u = c.dir ?? { x: 1, y: 0 };
  const rel = { x: cursor.x - P.x, y: cursor.y - P.y };
  const t = dot(rel, u);
  return { point: { x: P.x + u.x * t, y: P.y + u.y * t }, distanceMm: Math.abs(cross(rel, u)) };
}

/** All PORT + ENDPOINT + PARALLEL candidates for a document (grid is never a candidate). */
export function buildSnapEntries(doc: BoardDoc, opts: SnapIndexOptions): RBushEntry[] {
  const point = (p: Point, candidate: SnapCandidate): RBushEntry => ({
    minX: p.x, minY: p.y, maxX: p.x, maxY: p.y, candidate,
  });
  const out: RBushEntry[] = [];

  // PORTS — the port-PAIR centre (what connectRunEnd binds the spine endpoint to).
  // Ports contribute only their point target, NOT alignment guides: seeding h/v
  // guides from every port would make any point sharing a port's axis "sticky" and
  // starve the grid tier. Alignment guides are seeded from open ENDPOINTS only.
  const roles: PortRole[] = ['in', 'out_main', 'out_branch'];
  for (const kit of Object.values(doc.kits)) {
    for (const role of roles) {
      const c = portPairCenterWorld(kit, role);
      if (!c) continue;
      out.push(point(c, { point: c, kind: 'port', ref: { kitId: kit.id, role, originId: `${kit.id}:${role}` } }));
    }
  }

  // ENDPOINTS — open run ends (connected ends are excluded by openRunEnds). Each
  // seeds three guides: the run's own axis (seg) + a horizontal + a vertical.
  for (const e of openRunEnds(doc)) {
    const originId = `${e.runId}:${e.end}`;
    out.push(point(e.pos, { point: e.pos, kind: 'endpoint', ref: { runId: e.runId, end: e.end, originId } }));
    out.push(point(e.pos, { point: e.pos, kind: 'parallel', dir: e.outward, ref: { guide: 'seg', runId: e.runId, end: e.end, originId } }));
    out.push(point(e.pos, { point: e.pos, kind: 'parallel', ref: { guide: 'h', originId } }));
    out.push(point(e.pos, { point: e.pos, kind: 'parallel', ref: { guide: 'v', originId } }));
  }

  return out;
}

/** Cheap, deterministic key sensitive to every change that moves a candidate. */
export function snapMemoKey(doc: BoardDoc, opts: SnapIndexOptions): string {
  const parts: (string | number)[] = ['g', r3(opts.gapMm)];
  for (const kitId of Object.keys(doc.kits).sort()) {
    const t = doc.kits[kitId]!.transform;
    parts.push('k', kitId, r3(t.pos.x), r3(t.pos.y), r3(t.rotation), t.mirror ? 1 : 0);
  }
  for (const runId of Object.keys(doc.runs).sort()) {
    const sp = doc.runs[runId]!.spine;
    const a = sp[0]!;
    const b = sp[sp.length - 1]!;
    parts.push('r', runId, sp.length, r3(a.x), r3(a.y), r3(b.x), r3(b.y));
  }
  parts.push('c', doc.connections.length, doc.connections.map((c) => `${c.pipeId}:${c.pipeEnd}`).sort().join(','));
  return parts.join('|');
}

/**
 * A memoized snap index. Hold ONE in a ref and call ensure() every pointer move
 * (a string compare + occasional rebuild); query() is pure w.r.t. its inputs.
 */
export class SnapIndex {
  private tree = new RBush<RBushEntry>();
  private guides: SnapCandidate[] = [];
  private opts: SnapIndexOptions;
  memoKey = '';

  constructor(doc: BoardDoc, opts: SnapIndexOptions) {
    this.opts = opts;
    this.rebuild(doc, opts);
  }

  /** Rebuild only if the doc/gap changed; always refresh live opts (grid/tol). */
  ensure(doc: BoardDoc, opts: SnapIndexOptions): void {
    const key = snapMemoKey(doc, opts);
    this.opts = opts;
    if (key === this.memoKey) return;
    this.rebuild(doc, opts);
  }

  rebuild(doc: BoardDoc, opts: SnapIndexOptions): void {
    const entries = buildSnapEntries(doc, opts);
    this.guides = entries.filter((e) => e.candidate.kind === 'parallel').map((e) => e.candidate);
    this.tree = new RBush<RBushEntry>();
    this.tree.load(entries.filter((e) => e.candidate.kind !== 'parallel'));
    this.opts = opts;
    this.memoKey = snapMemoKey(doc, opts);
  }

  query(worldCursor: Point, view: ViewTransform): SnapResult | null {
    if (!Number.isFinite(worldCursor.x) || !Number.isFinite(worldCursor.y)) return null;
    const tol = worldTolerance(view, this.opts);

    type Hit = { point: Point; distanceMm: number; kind: SnapKind; ref: SnapRef; key: string; guideDir?: Point };
    const pool: Hit[] = [];

    // STEP A — tree tiers (port + endpoint). rbush overlap is a square superset,
    // so refine each hit by the exact circular distance.
    const box = { minX: worldCursor.x - tol, minY: worldCursor.y - tol, maxX: worldCursor.x + tol, maxY: worldCursor.y + tol };
    for (const e of this.tree.search(box)) {
      const d = dist(e.candidate.point, worldCursor);
      if (d <= tol) pool.push({ point: e.candidate.point, distanceMm: d, kind: e.candidate.kind, ref: e.candidate.ref, key: refKey(e.candidate) });
    }

    // STEP B — parallel guides, analytic perpendicular distance.
    for (const g of this.guides) {
      const pr = projectOntoGuide(g, worldCursor);
      if (pr.distanceMm > tol) continue;
      const guideDir = g.ref.guide === 'h' ? { x: 1, y: 0 } : g.ref.guide === 'v' ? { x: 0, y: 1 } : g.dir;
      pool.push({ point: pr.point, distanceMm: pr.distanceMm, kind: 'parallel', ref: g.ref, key: refKey(g), guideDir });
    }

    // STEP C — priority: tier, then distance, then a stable key.
    if (pool.length > 0) {
      pool.sort((a, b) => {
        const ta = SNAP_TIER[a.kind];
        const tb = SNAP_TIER[b.kind];
        if (ta !== tb) return ta - tb;
        if (a.distanceMm !== b.distanceMm) return a.distanceMm - b.distanceMm;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
      const best = pool[0]!;
      return { point: best.point, kind: best.kind, ref: best.ref, distanceMm: best.distanceMm, tier: SNAP_TIER[best.kind], guideDir: best.guideDir };
    }

    // STEP D — grid fallback (the base plane is always defined; ungated by tol so
    // drawing always has a definite point — the caller may treat far grid as free).
    const gp = nearestGrid(worldCursor, this.opts.gridMm ?? DEFAULTS.gridMm);
    return { point: gp, kind: 'grid', distanceMm: dist(gp, worldCursor), tier: SNAP_TIER.grid };
  }
}

/** One-shot functional facade (fresh tree each call) — for tests / cold paths. */
export function snap(worldCursor: Point, view: ViewTransform, doc: BoardDoc, opts: SnapIndexOptions): SnapResult | null {
  return new SnapIndex(doc, opts).query(worldCursor, view);
}
