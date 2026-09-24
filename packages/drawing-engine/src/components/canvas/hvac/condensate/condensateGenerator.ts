/**
 * Top-level condensate generation: plan → elements → a structured-clone-safe
 * result for the worker, the preview overlay and the apply command.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { buildCondensateBom, type CondensateBomRow } from './condensateBom';
import { buildCondensatePlanElements } from './condensateElements';
import type { CondensateEnvelope } from './condensateEnvironment';
import {
  planCondensateNetwork,
  type CondensateCrossing,
  type CondensatePlanOptions,
  type CondensateUnitResult,
  type NetNodeKind,
  type RefrigerantHopProposal,
} from './condensateNetworkPlanner';
import { isCondensateGully } from './condensateTypes';

export interface CondensateNetworkSummary {
  networkId: string;
  gullyId: string;
  gullyLabel: string;
  terminationKind: string;
  unitIds: string[];
  mainSlopePercent: number;
  exposed: boolean;
  nodes: Array<{ id: string; kind: NetNodeKind; x: number; y: number; z: number; slackMm: number; down: string | null }>;
}

export interface CondensateGenerationMetrics {
  unitsTotal: number;
  unitsConnected: number;
  pumpedUnits: number;
  networks: number;
  pipeLengthMm: number;
  fittingCount: number;
  crossings: number;
  hops: number;
}

export interface CondensateGenerationResult {
  elementsToAdd: HvacElement[];
  removeElementIds: string[];
  perUnit: CondensateUnitResult[];
  crossings: CondensateCrossing[];
  hopProposals: RefrigerantHopProposal[];
  networks: CondensateNetworkSummary[];
  unresolvedPaths: Array<{ unitId: string; points: Point2D[]; shortfallMm: number | null }>;
  issues: string[];
  envelope: CondensateEnvelope;
  metrics: CondensateGenerationMetrics;
  bom: CondensateBomRow[];
}

export function generateCondensateNetwork(scene: HvacElement[], options: CondensatePlanOptions): CondensateGenerationResult {
  const plan = planCondensateNetwork(scene, options);
  let counter = 0;
  const salt = Math.random().toString(36).slice(2, 8);
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${salt}${(counter++).toString(36)}`);
  const elementsToAdd = buildCondensatePlanElements(plan, { settings: options.settings, idFactory });
  const pipeLengthMm = elementsToAdd.reduce((sum, element) => {
    const nodes = (element.properties.routeNodes3d as Array<{ x: number; y: number; z: number }>) ?? [];
    let total = 0;
    for (let index = 1; index < nodes.length; index += 1) {
      total += Math.hypot(nodes[index]!.x - nodes[index - 1]!.x, nodes[index]!.y - nodes[index - 1]!.y, nodes[index]!.z - nodes[index - 1]!.z);
    }
    return sum + total;
  }, 0);
  const fittingCount = elementsToAdd.reduce((sum, element) => sum + ((element.properties.fittings as unknown[]) ?? []).length, 0);
  const crossings = plan.networks.flatMap((network) => network.crossings);
  const gullies = scene.filter(isCondensateGully);
  return {
    elementsToAdd,
    removeElementIds: plan.environment.replaceableElementIds,
    perUnit: plan.perUnit,
    crossings,
    hopProposals: plan.hopProposals,
    networks: plan.networks.map((network) => ({
      networkId: network.networkId,
      gullyId: network.sink.gullyId,
      gullyLabel: network.sink.label,
      terminationKind: network.sink.kind,
      unitIds: network.units.map((unit) => unit.source.unitId),
      mainSlopePercent: network.mainSlopePercent,
      exposed: network.exposed,
      nodes: [...network.nodes.values()].map((node) => ({
        id: node.id, kind: node.kind, x: node.point.x, y: node.point.y, z: node.z, slackMm: node.slackMm, down: node.down,
      })),
    })),
    unresolvedPaths: plan.unresolvedPaths,
    issues: plan.issues,
    envelope: plan.envelope,
    metrics: {
      unitsTotal: plan.environment.sources.length,
      unitsConnected: plan.perUnit.filter((unit) => unit.status === 'gravity' || unit.status === 'pumped').length,
      pumpedUnits: plan.perUnit.filter((unit) => unit.status === 'pumped').length,
      networks: plan.networks.length,
      pipeLengthMm,
      fittingCount,
      crossings: crossings.length,
      hops: plan.hopProposals.length,
    },
    bom: buildCondensateBom([...elementsToAdd, ...gullies], options.settings),
  };
}
