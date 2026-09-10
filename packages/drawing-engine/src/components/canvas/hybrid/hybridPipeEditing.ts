import type { PipeRouteNode3D } from "../hvac/pipeRoute3d";

export type HybridPipeConstraintKey =
  | "free"
  | "x"
  | "y"
  | "z"
  | "xy"
  | "xz"
  | "yz";

export interface HybridPipeEndpointProtection {
  connected: boolean;
  unitPort: boolean;
}

/**
 * Connected terminals and their adjacent tangent remain graph-owned. Protect
 * the neighboring straight node for field joints as well as unit ports, so a
 * vertex edit cannot silently rotate an attached connector's direction.
 */
export function getProtectedPipeNodeIndexes(
  nodeCount: number,
  start: HybridPipeEndpointProtection,
  end: HybridPipeEndpointProtection,
): Set<number> {
  const protectedIndexes = new Set<number>();
  if (nodeCount <= 0) return protectedIndexes;
  if (start.connected) protectedIndexes.add(0);
  if ((start.connected || start.unitPort) && nodeCount > 1) protectedIndexes.add(1);
  if (end.connected) protectedIndexes.add(nodeCount - 1);
  if ((end.connected || end.unitPort) && nodeCount > 1) protectedIndexes.add(nodeCount - 2);
  return protectedIndexes;
}

export function moveEditablePipeNode(
  nodes: readonly PipeRouteNode3D[],
  nodeIndex: number,
  point: PipeRouteNode3D,
  protectedIndexes: ReadonlySet<number>,
): PipeRouteNode3D[] {
  if (
    nodeIndex < 0
    || nodeIndex >= nodes.length
    || protectedIndexes.has(nodeIndex)
    || ![point.x, point.y, point.z].every(Number.isFinite)
    || [nodes[nodeIndex - 1], nodes[nodeIndex + 1]].some((neighbor) => neighbor
      && Math.hypot(point.x - neighbor.x, point.y - neighbor.y, point.z - neighbor.z) < 0.25)
  ) {
    return nodes.map((node) => ({ ...node }));
  }
  return nodes.map((node, index) => index === nodeIndex ? { ...point } : { ...node });
}

/** Blender-style constraint keys, with Ctrl/Cmd reserved as the quick Z lock. */
export function resolveHybridPipeConstraintKey(input: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  key?: string | null;
}): HybridPipeConstraintKey {
  if (input.ctrlKey || input.metaKey) return "z";
  const key = input.key?.toLowerCase();
  if (key !== "x" && key !== "y" && key !== "z") return "free";
  if (!input.shiftKey) return key;
  if (key === "x") return "yz";
  if (key === "y") return "xz";
  return "xy";
}
