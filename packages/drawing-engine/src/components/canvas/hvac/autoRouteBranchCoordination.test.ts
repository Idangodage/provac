import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import { evaluateAutoRouteNetwork } from './autoRouteEvaluation';
import { planAutoRouteNetwork } from './autoRouteNetwork';
import { buildBranchKitInsertion, proposeBranchKit, type BranchKitProposal } from './branchKitProposal';
import { coordinatedBranchApproachStations } from './coordinatedBranchStations';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets, type RefrigerantPipeBundleConnection } from './refrigerantPipePairModel';

const settings = DEFAULT_PIPE_ROUTING_SETTINGS;
const proposalOptions = { settings, bendRadiusFactor: settings.bendRadiusFactor,
  proposalRadiusMm: 100, maxRecoveryStations: 1 };

function unit(id: string, x: number, y: number, outdoor = false): HvacElement {
  return { id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac', category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    label: id, position: { x, y }, rotation: outdoor ? 180 : 0, width: outdoor ? 900 : 600,
    depth: outdoor ? 450 : 600, height: outdoor ? 1200 : 250, elevation: outdoor ? 1000 : 2200,
    mountType: outdoor ? 'floor' : 'ceiling', supplyZoneRatio: 0, properties: {} };
}

function branchBends(scene: HvacElement[]): number[] {
  return scene.filter(element => element.properties.routeClass === 'indoor-connection').map(element => {
    const points = element.properties.authoredCenterlineRoute as Point2D[];
    const directions = points.slice(1).flatMap((point, index) => {
      const dx = point.x - points[index]!.x; const dy = point.y - points[index]!.y;
      const length = Math.hypot(dx, dy);
      return length > 0.001 ? [{ x: dx / length, y: dy / length }] : [];
    });
    return directions.slice(1).filter((direction, index) =>
      direction.x * directions[index]!.x + direction.y * directions[index]!.y < 1 - 1e-6).length;
  });
}

function insert(scene: HvacElement[], proposal: BranchKitProposal, port: RefrigerantPipeBundleConnection): HvacElement[] {
  expect(proposal.validity, proposal.violations.join('\n')).toBe('valid');
  const insertion = buildBranchKitInsertion(proposal, port, scene);
  expect(insertion).not.toBeNull();
  const replaced = new Set([...insertion!.removeElementIds, ...(insertion!.updates ?? []).map(element => element.id)]);
  return [...scene.filter(element => !replaced.has(element.id)), ...(insertion!.updates ?? []), ...insertion!.elementsToAdd];
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('physical coordination of adjacent copper branch pairs', () => {
  it('rebuilds both services with direct bends when moving the preceding kit frees a crowded takeoff', async () => {
    // Opposite sides of one unobstructed main. The old first station is valid,
    // but leaves the next downstream kit too close to its unit's departure.
    const equipment = [unit('outdoor', 11000, 500, true), unit('seed', 500, 3000),
      unit('previous', 3500, 3000), unit('next', 4250, -1800)];
    const originalEquipment = structuredClone(equipment);
    const seed = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced', selectedIds: ['outdoor', 'seed'] });
    expect(seed.complete, seed.issues.join('\n')).toBe(true);
    const baseline = [...equipment, ...seed.elementsToAdd];
    const previousPort = getRefrigerantPipeBundleSnapTargets([equipment[2]!])[0]!;
    const nextPort = getRefrigerantPipeBundleSnapTargets([equipment[3]!])[0]!;
    const previous = proposeBranchKit(baseline, previousPort, { x: 5300, y: 725 }, proposalOptions)!;
    expect(previous).not.toBeNull();
    const crowded = insert(baseline, previous, previousPort);
    const foldedProposal = proposeBranchKit(crowded, nextPort, { x: 4550, y: 725 }, proposalOptions)!;
    expect(foldedProposal).not.toBeNull();
    const folded = insert(crowded, foldedProposal, nextPort);
    expect(branchBends(folded).sort()).toEqual([2, 2, 4, 4]);

    // Both proposals are evaluated on the original unsplit host before their
    // physical insertions are replayed; neither kit's geometry is translated.
    const next = proposeBranchKit(baseline, nextPort, previous.teePoint, proposalOptions)!;
    expect(next).not.toBeNull();
    const snapshot = JSON.stringify({ baseline, previous, next });
    const candidates = coordinatedBranchApproachStations({ previous, previousPort, next, nextPort, settings });
    expect(candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify({ baseline, previous, next })).toBe(snapshot);
    const pair = candidates[0]!;
    expect(pair.previousStation.x).toBeGreaterThan(previous.teePoint.x);
    expect(pair.nextStation.x).toBeLessThan(pair.previousStation.x);
    const movedPrevious = proposeBranchKit(baseline, previousPort, pair.previousStation, proposalOptions)!;
    const replayed = insert(baseline, movedPrevious, previousPort);
    const directNext = proposeBranchKit(replayed, nextPort, pair.nextStation, proposalOptions)!;
    const coordinated = insert(replayed, directNext, nextPort);

    expect(branchBends(coordinated)).toEqual([2, 2, 2, 2]);
    const generated = coordinated.filter(element => !equipment.includes(element));
    expect(findNewNetworkPipeClashes(equipment, generated)).toEqual([]);
    expect(generated.filter(element => element.type === 'refrigerant-branch-kit')).toHaveLength(4);
    const evaluation = evaluateAutoRouteNetwork({ elements: coordinated, outdoorUnitId: 'outdoor',
      indoorUnitIds: ['seed', 'previous', 'next'], objective: 'balanced' });
    expect(evaluation.feasible, evaluation.hardIssues.join('\n')).toBe(true);
    expect(evaluation.metrics.elevationReversalCount).toBe(0);
    const oldEvaluation = evaluateAutoRouteNetwork({ elements: folded, outdoorUnitId: 'outdoor',
      indoorUnitIds: ['seed', 'previous', 'next'], objective: 'balanced' });
    expect(evaluation.score).toBeLessThan(oldEvaluation.score);
    const document = buildVrfDocumentFromHvacElements(coordinated);
    for (const element of equipment) {
      const ports = Object.values(document.equipmentPorts).filter(port => port.equipmentId === element.id);
      expect(ports).toHaveLength(2);
      expect(ports.every(port => port.isConnected), element.id).toBe(true);
    }
    expect(equipment).toEqual(originalEquipment);
  }, 30000);
});
