import type { RefrigerantLineKind, VrfPipingDocument } from '../domain/types';

import type { ElevationPoint } from './route-elevation';

export interface NetworkElevationPath {
  id: string;
  indoorEntityId: string;
  outdoorEntityId: string;
  lineKind: RefrigerantLineKind;
  runIds: string[];
  nodePositions: ElevationPoint[];
}

interface GraphLink {
  next: string;
  runId?: string;
}

/**
 * Trace real connections, separately for each service. Only a tree with one
 * outdoor source has a unique equipment path; cyclic or multiple-source
 * components are deliberately left to the topology/manufacturer checks.
 * Fitting connections join their actual terminal nodes, never nearby pipes.
 */
export function buildNetworkElevationPaths(document: VrfPipingDocument): NetworkElevationPath[] {
  const paths: NetworkElevationPath[] = [];
  const runs = Object.values(document.pipeRuns);
  const lineKinds = new Set(runs.map((run) => run.lineKind));
  for (const lineKind of lineKinds) {
    if (lineKind === 'drain') continue;
    const adjacency = new Map<string, GraphLink[]>();
    const join = (from: string, to: string, runId?: string) => {
      if (from === to || !document.routeNodes[from] || !document.routeNodes[to]) return;
      adjacency.set(from, [...(adjacency.get(from) ?? []), { next: to, runId }]);
      adjacency.set(to, [...(adjacency.get(to) ?? []), { next: from, runId }]);
    };
    for (const edge of Object.values(document.segmentEdges)) {
      if (edge.lineKind === lineKind) join(edge.startNodeId, edge.endNodeId, edge.runId);
    }
    for (const branch of Object.values(document.branchKits)) {
      if (branch.lineKind !== lineKind) continue;
      for (const inlet of branch.inletNodeIds) {
        for (const outlet of branch.outletNodeIds) join(inlet, outlet);
      }
    }
    for (const reducer of Object.values(document.reducers)) {
      if (reducer.lineKind === lineKind) join(reducer.inletNodeId, reducer.outletNodeId);
    }
    const terminals: Array<{ nodeId: string; equipmentId: string; outdoor: boolean }> = [];
    const terminalKeys = new Set<string>();
    for (const run of runs) {
      if (run.lineKind !== lineKind) continue;
      for (const [portId, nodeId] of [
        [run.sourcePortId, run.nodeIds[0]],
        [run.targetPortId, run.nodeIds[run.nodeIds.length - 1]],
      ] as const) {
        if (!portId || !nodeId) continue;
        const port = document.equipmentPorts[portId];
        const equipment = port ? document.equipmentNodes[port.equipmentId] : undefined;
        if (!equipment || equipment.equipmentType === 'other') continue;
        const key = `${equipment.id}:${nodeId}`;
        if (terminalKeys.has(key)) continue;
        terminalKeys.add(key);
        terminals.push({ nodeId, equipmentId: equipment.id, outdoor: equipment.equipmentType === 'outdoor-unit' });
      }
    }
    const terminalsByNode = new Map<string, typeof terminals>();
    for (const terminal of terminals) {
      terminalsByNode.set(terminal.nodeId, [
        ...(terminalsByNode.get(terminal.nodeId) ?? []), terminal,
      ]);
    }
    const visited = new Set<string>();
    for (const first of adjacency.keys()) {
      if (visited.has(first)) continue;
      const component: string[] = [first];
      visited.add(first);
      let degreeSum = 0;
      for (let index = 0; index < component.length; index += 1) {
        const current = component[index]!;
        degreeSum += adjacency.get(current)?.length ?? 0;
        for (const link of adjacency.get(current) ?? []) {
          if (visited.has(link.next)) continue;
          visited.add(link.next);
          component.push(link.next);
        }
      }
      if (degreeSum / 2 !== component.length - 1) continue;
      const attached = component.flatMap((nodeId) => terminalsByNode.get(nodeId) ?? []);
      const roots = attached.filter((terminal) => terminal.outdoor);
      if (roots.length !== 1) continue;
      const root = roots[0]!;
      const parent = new Map<string, { previous: string; runId?: string }>();
      const ordered = [root.nodeId];
      const reached = new Set(ordered);
      for (let index = 0; index < ordered.length; index += 1) {
        const current = ordered[index]!;
        for (const link of adjacency.get(current) ?? []) {
          if (reached.has(link.next)) continue;
          reached.add(link.next);
          parent.set(link.next, { previous: current, runId: link.runId });
          ordered.push(link.next);
        }
      }
      for (const indoor of attached.filter((terminal) => !terminal.outdoor)) {
        let current = indoor.nodeId;
        const nodeIds = [current];
        const runIds = new Set<string>();
        while (current !== root.nodeId) {
          const entry = parent.get(current);
          if (!entry) break;
          if (entry.runId) runIds.add(entry.runId);
          current = entry.previous;
          nodeIds.push(current);
        }
        // A single run is already analyzed directly, without duplicate alerts.
        if (current !== root.nodeId || runIds.size < 2) continue;
        paths.push({
          id: `${lineKind}:${root.equipmentId}:${indoor.equipmentId}:${indoor.nodeId}`,
          indoorEntityId: indoor.equipmentId,
          outdoorEntityId: root.equipmentId,
          lineKind,
          runIds: [...runIds],
          nodePositions: nodeIds.reverse().map((id) => ({ ...document.routeNodes[id]!.position })),
        });
      }
    }
  }
  return paths;
}
