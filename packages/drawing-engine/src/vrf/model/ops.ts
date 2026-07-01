/**
 * Pure document operations (mutate an Immer draft). Connections are TOPOLOGICAL:
 * they store port ids, and geometry (run endpoints) is re-derived from the kit
 * transform on every kit move — so a kit move drags every connected endpoint and
 * drops zero connections (invariant F).
 */

import type { BoardDoc, KitTransform, Point, PortRole } from './types';
import {
  findPort,
  portOf,
  portPairCenterWorld,
  portPairDirWorld,
} from '../geometry/kit';
import { norm, sub } from '../geometry/path';

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
