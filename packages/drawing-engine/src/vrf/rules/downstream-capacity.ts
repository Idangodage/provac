export type CapacityNodeKind = 'equipment' | 'route' | 'branch' | 'fitting';

export interface CapacityGraphNode {
  id: string;
  kind: CapacityNodeKind;
  equipmentId?: string;
  capacityIndex?: number;
  capacityIndexByRuleProfile?: Record<string, number>;
}

export interface CapacityGraphArc {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  enabled?: boolean;
}

export interface CapacityTraversalGraph {
  nodes: Record<string, CapacityGraphNode>;
  arcs: Record<string, CapacityGraphArc>;
  /** Optional root for whole-system disconnected-subgraph auditing. */
  systemRootNodeId?: string;
}

export interface DownstreamCapacityResult {
  totalCapacityIndex: number;
  equipmentIds: string[];
  visitedNodeIds: string[];
  duplicateEquipmentIds: string[];
  cycleNodeIds: string[];
  missingNodeIds: string[];
  disconnectedNodeIds: string[];
  valid: boolean;
}

function outgoing(graph: CapacityTraversalGraph): Map<string, CapacityGraphArc[]> {
  const result = new Map<string, CapacityGraphArc[]>();
  for (const arc of Object.values(graph.arcs)) {
    if (arc.enabled === false) continue;
    const list = result.get(arc.fromNodeId);
    if (list) list.push(arc);
    else result.set(arc.fromNodeId, [arc]);
  }
  for (const list of result.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

function reachableFrom(
  graph: CapacityTraversalGraph,
  startNodeId: string,
  adjacency: Map<string, CapacityGraphArc[]>,
): Set<string> {
  const reached = new Set<string>();
  const pending = [startNodeId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id) || !graph.nodes[id]) continue;
    reached.add(id);
    for (const arc of adjacency.get(id) ?? []) pending.push(arc.toNodeId);
  }
  return reached;
}

/**
 * Directed, downstream-only traversal. Equipment reached by converging paths is
 * counted once, cycles are reported, and missing/disconnected topology is never
 * silently ignored.
 */
export function calculateDownstreamCapacity(
  graph: CapacityTraversalGraph,
  startNodeId: string,
  ruleProfileId?: string,
): DownstreamCapacityResult {
  const adjacency = outgoing(graph);
  const visited = new Set<string>();
  const active = new Set<string>();
  const equipment = new Map<string, number>();
  const duplicates = new Set<string>();
  const cycleNodes = new Set<string>();
  const missingNodes = new Set<string>();

  const visit = (nodeId: string): void => {
    if (active.has(nodeId)) {
      cycleNodes.add(nodeId);
      return;
    }
    if (visited.has(nodeId)) return;
    const node = graph.nodes[nodeId];
    if (!node) {
      missingNodes.add(nodeId);
      return;
    }
    active.add(nodeId);
    visited.add(nodeId);
    if (node.kind === 'equipment' && node.equipmentId) {
      const value = ruleProfileId
        ? node.capacityIndexByRuleProfile?.[ruleProfileId] ?? node.capacityIndex
        : node.capacityIndex;
      if (equipment.has(node.equipmentId)) duplicates.add(node.equipmentId);
      else equipment.set(node.equipmentId, Number.isFinite(value) ? Math.max(0, value ?? 0) : 0);
    }
    for (const arc of adjacency.get(nodeId) ?? []) {
      if (!graph.nodes[arc.toNodeId]) missingNodes.add(arc.toNodeId);
      visit(arc.toNodeId);
      if (active.has(arc.toNodeId)) {
        cycleNodes.add(nodeId);
        cycleNodes.add(arc.toNodeId);
      }
    }
    active.delete(nodeId);
  };

  visit(startNodeId);

  const root = graph.systemRootNodeId;
  const systemReachable = root ? reachableFrom(graph, root, adjacency) : new Set(Object.keys(graph.nodes));
  const disconnectedNodeIds = Object.keys(graph.nodes)
    .filter((id) => !systemReachable.has(id))
    .sort();

  return {
    totalCapacityIndex: [...equipment.values()].reduce((sum, value) => sum + value, 0),
    equipmentIds: [...equipment.keys()].sort(),
    visitedNodeIds: [...visited].sort(),
    duplicateEquipmentIds: [...duplicates].sort(),
    cycleNodeIds: [...cycleNodes].sort(),
    missingNodeIds: [...missingNodes].sort(),
    disconnectedNodeIds,
    valid: cycleNodes.size === 0 && missingNodes.size === 0 && disconnectedNodeIds.length === 0,
  };
}

