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
 * Connected terminals remain graph-owned. A unit-port terminal also protects
 * the neighbouring mandatory straight stub node, so a vertex edit cannot bend
 * the copper at the flare/braze connection.
 */
export function getProtectedPipeNodeIndexes(
  nodeCount: number,
  start: HybridPipeEndpointProtection,
  end: HybridPipeEndpointProtection,
): Set<number> {
  const protectedIndexes = new Set<number>();
  if (nodeCount <= 0) return protectedIndexes;
  if (start.connected) protectedIndexes.add(0);
  if (start.unitPort && nodeCount > 1) protectedIndexes.add(1);
  if (end.connected) protectedIndexes.add(nodeCount - 1);
  if (end.unitPort && nodeCount > 1) protectedIndexes.add(nodeCount - 2);
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
