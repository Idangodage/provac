/**
 * Pure document operations (mutate an Immer draft). Connections are TOPOLOGICAL:
 * they store port ids, and geometry (run endpoints) is re-derived from the kit
 * transform on every kit move — so a kit move drags every connected endpoint and
 * drops zero connections (invariant F).
 */

import type { BoardDoc, KitTransform, Point, PortRole } from './types';
import {
  createRefnetKit,
  findPort,
  portOf,
  portPairCenterWorld,
  portPairDirWorld,
  snapKitToRunEnd,
} from '../geometry/kit';
import { dist, norm, sub } from '../geometry/path';

const endIndex = (len: number, end: 'start' | 'end') => (end === 'start' ? 0 : len - 1);

/**
 * Bind a paired run's endpoint to a kit port pair (gas↔gas, liquid↔liquid). Snaps
 * the endpoint onto the pair centre AND orients the run's last segment along the
 * port axis so the centrelines meet with no seam. Adds two topological connections.
 */
export function connectRunEnd(
  doc: BoardDoc,
  runId: string,
  end: 'start' | 'end',
  kitId: string,
  role: PortRole,
): void {
  const run = doc.runs[runId];
  const kit = doc.kits[kitId];
  if (!run || !kit) return;
  const gas = portOf(kit, role, 'gas');
  const liquid = portOf(kit, role, 'liquid');
  const center = portPairCenterWorld(kit, role);
  const dir = portPairDirWorld(kit, role);
  if (!gas || !liquid || !center || !dir) return;

  const i = endIndex(run.spine.length, end);
  run.spine[i] = { x: center.x, y: center.y };
  // Keep the last segment collinear with the port axis (no kink at the joint):
  // pull the neighbour point onto the port axis at its current distance.
  const nb = end === 'start' ? run.spine[1] : run.spine[run.spine.length - 2];
  if (nb) {
    const d = Math.hypot(nb.x - center.x, nb.y - center.y);
    // run leaves the kit ALONG +dir (outward), so the neighbour sits at center+dir·d.
    nb.x = center.x + dir.x * d;
    nb.y = center.y + dir.y * d;
  }

  // Avoid duplicate connections for the same (pipe,end,port).
  const exists = (portId: string) =>
    doc.connections.some((c) => c.pipeId === runId && c.pipeEnd === end && c.portId === portId);
  if (!exists(gas.id)) doc.connections.push({ pipeId: runId, pipeEnd: end, kitId, portId: gas.id });
  if (!exists(liquid.id)) doc.connections.push({ pipeId: runId, pipeEnd: end, kitId, portId: liquid.id });
}

/**
 * Re-pin every run endpoint connected to `kitId` to its port pair (call after the
 * kit transform changes). Endpoints follow; no connection is removed.
 */
export function syncKitConnections(doc: BoardDoc, kitId: string): void {
  const kit = doc.kits[kitId];
  if (!kit) return;
  const groups = new Map<string, { pipeId: string; end: 'start' | 'end'; role: PortRole }>();
  for (const c of doc.connections) {
    if (c.kitId !== kitId) continue;
    const port = findPort(kit, c.portId);
    if (!port) continue;
    groups.set(`${c.pipeId}|${c.pipeEnd}`, { pipeId: c.pipeId, end: c.pipeEnd, role: port.role });
  }
  for (const g of groups.values()) {
    const run = doc.runs[g.pipeId];
    const center = portPairCenterWorld(kit, g.role);
    const dir = portPairDirWorld(kit, g.role);
    if (!run || !center || !dir) continue;
    const i = endIndex(run.spine.length, g.end);
    const nb = g.end === 'start' ? run.spine[1] : run.spine[run.spine.length - 2];
    if (nb) {
      const d = Math.hypot(nb.x - run.spine[i]!.x, nb.y - run.spine[i]!.y) || Math.hypot(nb.x - center.x, nb.y - center.y);
      nb.x = center.x + dir.x * d;
      nb.y = center.y + dir.y * d;
    }
    run.spine[i] = { x: center.x, y: center.y };
  }
}

/** Move a kit and drag its connected endpoints along (invariant F). */
export function moveKit(doc: BoardDoc, kitId: string, transform: KitTransform): void {
  const kit = doc.kits[kitId];
  if (!kit) return;
  kit.transform = transform;
  syncKitConnections(doc, kitId);
}

/** Unit direction of a run's outward heading at an end (for snap alignment). */
export function runEndDir(doc: BoardDoc, runId: string, end: 'start' | 'end') {
  const run = doc.runs[runId];
  if (!run || run.spine.length < 2) return null;
  const i = endIndex(run.spine.length, end);
  const j = end === 'start' ? 1 : run.spine.length - 2;
  return norm(sub(run.spine[i]!, run.spine[j]!));
}

/** A location on a run spine: point `t∈[0,1]` along segment `segIndex`→`segIndex+1`. */
export interface SpineAt {
  segIndex: number;
  t: number;
}

/** Physical trunk half-length occupied by a kit — see geometry/kit KIT_TRUNK_HALF_MM. */
const STUB_MM = 60;
const EPS_T = 1e-9;
const cloneP = (p: Point): Point => ({ x: p.x, y: p.y });

/**
 * The "+" midpoint affordance: split a paired run at `at`, insert a REFNET branch
 * kit oriented along the run, and re-route — ALL as one mutation so a single undo
 * reverts it byte-for-byte. Upstream keeps `runId`; a fresh downstream run and a
 * branch stub run are created (ids `run_${n+1}`, `run_${n+2}`, kit `kit_${n}`).
 * Returns the next free id counter (`idCounter + 3`); no-op returns it unchanged.
 */
export function insertBranchAt(
  doc: BoardDoc,
  runId: string,
  at: SpineAt,
  idCounter: number,
  gapMm: number,
): number {
  const run = doc.runs[runId];
  if (!run || run.spine.length < 2 || run.lineType !== 'paired') return idCounter;

  const { segIndex } = at;
  if (!Number.isInteger(segIndex) || segIndex < 0 || segIndex > run.spine.length - 2) return idCounter;
  let t = Math.min(1, Math.max(0, at.t));
  if (t < EPS_T) t = 0;
  else if (t > 1 - EPS_T) t = 1;

  const hasConn = (end: 'start' | 'end') =>
    doc.connections.some((c) => c.pipeId === runId && c.pipeEnd === end);
  // A split at a bound tip splits off nothing — reject.
  if (segIndex === 0 && t === 0 && hasConn('start')) return idCounter;
  if (segIndex === run.spine.length - 2 && t === 1 && hasConn('end')) return idCounter;

  const A = run.spine[segIndex]!;
  const B = run.spine[segIndex + 1]!;
  if (dist(A, B) < 1e-9) return idCounter; // degenerate segment — cannot orient
  const tng = norm(sub(B, A)); // run heading at c (upstream→downstream)
  const c: Point = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };

  // Two spines; upstream's last point and downstream's first point are CLONES of the
  // same value but distinct objects (connectRunEnd mutates endpoints in place).
  let upstreamSpine: Point[];
  let downstreamSpine: Point[];
  if (t > 0 && t < 1) {
    upstreamSpine = run.spine.slice(0, segIndex + 1).map(cloneP).concat([cloneP(c)]);
    downstreamSpine = [cloneP(c)].concat(run.spine.slice(segIndex + 1).map(cloneP));
  } else if (t === 0) {
    upstreamSpine = run.spine.slice(0, segIndex + 1).map(cloneP); // ends at A = c
    downstreamSpine = run.spine.slice(segIndex).map(cloneP); // starts at A = c
  } else {
    upstreamSpine = run.spine.slice(0, segIndex + 2).map(cloneP); // ends at B = c
    downstreamSpine = run.spine.slice(segIndex + 1).map(cloneP); // starts at B = c
  }
  if (upstreamSpine.length < 2 || downstreamSpine.length < 2) return idCounter;

  const n = idCounter;
  const kitId = `kit_${n}`;
  const downstreamId = `run_${n + 1}`;
  const stubId = `run_${n + 2}`;

  // SPLIT — upstream keeps runId; downstream is new.
  run.spine = upstreamSpine;
  doc.runs[downstreamId] = { id: downstreamId, spine: downstreamSpine, lineType: 'paired', size: run.size, bendRadiusMm: run.bendRadiusMm };

  // Re-home R's END-side connections onto the downstream run (mutate pipeId in place
  // for a minimal, exactly-invertible patch); START-side stays on upstream (runId).
  for (const conn of doc.connections) {
    if (conn.pipeId === runId && conn.pipeEnd === 'end') conn.pipeId = downstreamId;
  }

  // INSERT + orient: inlet binds at c, trunk extends downstream (+tng), so the inlet's
  // outward (−tng) faces upstream. (snapKitToRunEnd's 2nd arg is the trunk heading.)
  doc.kits[kitId] = createRefnetKit(kitId, snapKitToRunEnd(c, tng), gapMm);
  const kit = doc.kits[kitId]!;

  // Branch stub — born with two DISTINCT points along the out_branch world axis so
  // connectRunEnd has a real neighbour to align (a zero-length stub would go NaN).
  const branchCenter = portPairCenterWorld(kit, 'out_branch');
  const branchDir = portPairDirWorld(kit, 'out_branch');
  if (!branchCenter || !branchDir) return n + 1; // shouldn't happen for a REFNET kit
  doc.runs[stubId] = {
    id: stubId,
    spine: [cloneP(branchCenter), { x: branchCenter.x + branchDir.x * STUB_MM, y: branchCenter.y + branchDir.y * STUB_MM }],
    lineType: 'paired',
    size: run.size,
    bendRadiusMm: run.bendRadiusMm,
  };

  // WIRE the three new joints (each pins the endpoint onto its port-pair centre).
  connectRunEnd(doc, runId, 'end', kitId, 'in');
  connectRunEnd(doc, downstreamId, 'start', kitId, 'out_main');
  connectRunEnd(doc, stubId, 'start', kitId, 'out_branch');

  return n + 3;
}

export interface OpenEnd {
  runId: string;
  end: 'start' | 'end';
  pos: Point;
  /** Outward heading (into empty space, where a kit would attach). */
  outward: Point;
}

/** Every run endpoint not already bound to a kit port (snap candidates). */
export function openRunEnds(doc: BoardDoc): OpenEnd[] {
  const out: OpenEnd[] = [];
  for (const run of Object.values(doc.runs)) {
    if (run.spine.length < 2) continue;
    for (const end of ['start', 'end'] as const) {
      if (doc.connections.some((c) => c.pipeId === run.id && c.pipeEnd === end)) continue;
      const i = endIndex(run.spine.length, end);
      const j = end === 'start' ? 1 : run.spine.length - 2;
      const p = run.spine[i]!;
      out.push({ runId: run.id, end, pos: { x: p.x, y: p.y }, outward: norm(sub(p, run.spine[j]!)) });
    }
  }
  return out;
}
