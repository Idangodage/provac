import type { HvacElement, Wall } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { evaluateAutoRouteNetwork } from './autoRouteEvaluation';
import { getAutoRouteOwnership } from './pipeEditRetention';

interface CircuitIndex {
  affectedOutdoors: Set<string>;
  indoorsByOutdoor: Map<string, Set<string>>;
}

/** Native connections, including field-pipe joins and both sides of each kit. */
function circuitIndex(scene: readonly HvacElement[], changedIds: ReadonlySet<string>): CircuitIndex {
  const document = buildVrfDocumentFromHvacElements(scene);
  const parents = new Map<string, string>();
  const route = (id: string) => `route:${id}`;
  const equipment = (id: string) => `equipment:${id}`;
  const find = (id: string): string => {
    let root = id;
    while (parents.has(root)) root = parents.get(root)!;
    let current = id;
    while (parents.has(current)) {
      const next = parents.get(current)!;
      parents.set(current, root);
      current = next;
    }
    return root;
  };
  const join = (a: string, b: string) => {
    const left = find(a); const right = find(b);
    if (left !== right) parents.set(left, right);
  };
  const changedNodes: string[] = [];
  const recordChanged = (sourceId: unknown, nodes: string[]) => {
    if (typeof sourceId === 'string' && changedIds.has(sourceId)) changedNodes.push(...nodes);
  };
  for (const edge of Object.values(document.segmentEdges)) join(route(edge.startNodeId), route(edge.endNodeId));
  for (const branch of Object.values(document.branchKits)) {
    const nodes = [...branch.inletNodeIds, ...branch.outletNodeIds].map(route);
    for (const node of nodes.slice(1)) join(nodes[0]!, node);
    recordChanged(branch.metadata?.sourceElementId, nodes);
  }
  for (const reducer of Object.values(document.reducers)) {
    const nodes = [route(reducer.inletNodeId), route(reducer.outletNodeId)];
    join(nodes[0]!, nodes[1]!);
    recordChanged(reducer.metadata?.sourceElementId, nodes);
  }
  for (const run of Object.values(document.pipeRuns)) {
    for (const [portId, nodeId] of [[run.sourcePortId, run.nodeIds[0]], [run.targetPortId, run.nodeIds.at(-1)]] as const) {
      const unitId = portId ? document.equipmentPorts[portId]?.equipmentId : undefined;
      if (unitId && nodeId) join(equipment(unitId), route(nodeId));
    }
    recordChanged(run.metadata?.sourceElementId, run.nodeIds.map(route));
  }
  const outdoorsByRoot = new Map<string, string[]>();
  const indoorsByRoot = new Map<string, Set<string>>();
  for (const unit of Object.values(document.equipmentNodes)) {
    const root = find(equipment(unit.id));
    recordChanged(unit.metadata?.sourceElementId, [equipment(unit.id)]);
    if (unit.equipmentType === 'outdoor-unit') {
      outdoorsByRoot.set(root, [...(outdoorsByRoot.get(root) ?? []), unit.id]);
    } else if (unit.equipmentType === 'indoor-unit') {
      const indoorIds = indoorsByRoot.get(root) ?? new Set<string>();
      indoorIds.add(unit.id);
      indoorsByRoot.set(root, indoorIds);
    }
  }
  const affectedOutdoors = new Set(changedNodes.flatMap(node => outdoorsByRoot.get(find(node)) ?? []));
  // Ownership is only a fallback for a changed run that became disconnected.
  // Actual connectivity supplies the indoor scope; stale ownership cannot add
  // unrelated equipment to an otherwise sound circuit.
  for (const element of scene) {
    if (!changedIds.has(element.id)) continue;
    const owner = getAutoRouteOwnership(element);
    if (owner && document.equipmentNodes[owner.outdoorUnitId]?.equipmentType === 'outdoor-unit') {
      affectedOutdoors.add(owner.outdoorUnitId);
    }
  }
  const indoorsByOutdoor = new Map<string, Set<string>>();
  for (const [root, outdoors] of outdoorsByRoot) {
    for (const outdoorId of outdoors) indoorsByOutdoor.set(outdoorId, indoorsByRoot.get(root) ?? new Set());
  }
  return { affectedOutdoors, indoorsByOutdoor };
}

/**
 * Recheck only circuits touched by a proposed edit, after the final hop geometry
 * is built. Compare identical before/after scopes under the same rule profile:
 * unrelated or pre-existing violations do not block a valid local operation.
 * Both evaluations use new-layout policy so only newly introduced low pockets
 * are refused. Missing manufacturer data remains preliminary/advisory under
 * the existing evaluator; this helper does not infer a certification.
 */
export function refrigerantChangeIssues(
  beforeScene: readonly HvacElement[],
  afterScene: readonly HvacElement[],
  changedIds: ReadonlySet<string> | readonly string[],
  options: { profile?: ManufacturerRuleProfile; walls?: readonly Wall[] } = {},
): string[] {
  const changed = new Set(changedIds);
  if (!changed.size) return [];
  const before = circuitIndex(beforeScene, changed);
  const after = circuitIndex(afterScene, changed);
  const affected = [...new Set([...before.affectedOutdoors, ...after.affectedOutdoors])].sort();
  const byId = new Map([...beforeScene, ...afterScene].map(element => [element.id, element]));
  const issues = new Set<string>();
  for (const outdoorUnitId of affected) {
    const indoorUnitIds = [...new Set([
      ...(before.indoorsByOutdoor.get(outdoorUnitId) ?? []),
      ...(after.indoorsByOutdoor.get(outdoorUnitId) ?? []),
    ])].sort();
    const settings = { outdoorUnitId, indoorUnitIds, profile: options.profile,
      walls: options.walls ? [...options.walls] : undefined, elevationPolicy: 'new-layout' as const };
    const previous = new Set(evaluateAutoRouteNetwork({ ...settings, elements: [...beforeScene] }).hardIssues);
    const next = evaluateAutoRouteNetwork({ ...settings, elements: [...afterScene] });
    for (const issue of next.hardIssues) {
      if (!previous.has(issue)) issues.add(`${byId.get(outdoorUnitId)?.label || outdoorUnitId}: ${issue}`);
    }
  }
  return [...issues];
}
