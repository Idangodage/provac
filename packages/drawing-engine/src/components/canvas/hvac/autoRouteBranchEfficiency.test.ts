import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { evaluateAutoRouteNetwork } from './autoRouteEvaluation';
import { planAutoRouteNetwork } from './autoRouteNetwork';
import { buildBranchKitInsertion, proposeBranchKit } from './branchKitProposal';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';

const settings = DEFAULT_PIPE_ROUTING_SETTINGS;
function unit(id: string, x: number, y: number, outdoor = false): HvacElement {
  return { id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac', category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    label: id, position: { x, y }, rotation: outdoor ? 180 : 0, width: outdoor ? 900 : 600,
    depth: outdoor ? 450 : 600, height: outdoor ? 1200 : 250, elevation: outdoor ? 1000 : 2200,
    mountType: outdoor ? 'floor' : 'ceiling', supplyZoneRatio: 0, properties: {} };
}
function equipmentScene(transform: 'original' | 'rotated' | 'mirrored' = 'original'): HvacElement[] {
  return [unit('outdoor', 11000, 500, true), unit('cassette-a', 500, 3000),
    unit('cassette-b', 3500, 3000), unit('cassette-c', 6500, 3000)].map(element => {
    const center = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
    const transformed = transform === 'rotated' ? { x: -center.y, y: center.x }
      : transform === 'mirrored' ? { x: -center.x, y: center.y } : center;
    return { ...element, position: { x: transformed.x - element.width / 2, y: transformed.y - element.depth / 2 },
      rotation: transform === 'rotated' ? (element.rotation + 90) % 360
        : transform === 'mirrored' ? (180 - element.rotation + 360) % 360 : element.rotation };
  });
}
function guideDirections(element: HvacElement): Point2D[] {
  const points = element.properties.authoredCenterlineRoute as Point2D[];
  expect(points?.length, element.id).toBeGreaterThanOrEqual(2);
  return points.slice(1).flatMap((point, index) => {
    const dx = point.x - points[index]!.x; const dy = point.y - points[index]!.y;
    const length = Math.hypot(dx, dy);
    return length > 0.001 ? [{ x: dx / length, y: dy / length }] : [];
  });
}
function bendCount(element: HvacElement): number {
  const directions = guideDirections(element);
  return directions.slice(1).filter((direction, index) =>
    direction.x * directions[index]!.x + direction.y * directions[index]!.y < 1 - 1e-6).length;
}
function verifyNetwork(equipment: HvacElement[], generated: HvacElement[]): void {
  expect(findNewNetworkPipeClashes(equipment, generated)).toEqual([]);
  const evaluation = evaluateAutoRouteNetwork({ elements: [...equipment, ...generated], outdoorUnitId: 'outdoor',
    indoorUnitIds: equipment.filter(element => element.id !== 'outdoor').map(element => element.id), objective: 'balanced' });
  expect(evaluation.feasible, evaluation.hardIssues.join('\n')).toBe(true);
  expect(evaluation.metrics.elevationReversalCount).toBe(0);
}
function verifyDirectBranches(generated: HvacElement[]): void {
  // Splitting a previous indoor connection adds main pieces with the same
  // routeClass. Their count depends on the chosen tree; every such piece must
  // still avoid an unnecessary planar fold. The seed main can legitimately
  // need a longer detour around the intervening equipment bodies.
  const branches = generated.filter(element => element.properties.routeClass === 'indoor-connection');
  expect(branches.length).toBeGreaterThanOrEqual(4);
  for (const branch of branches) {
    expect(bendCount(branch), JSON.stringify(branch.properties.authoredCenterlineRoute)).toBeLessThanOrEqual(2);
  }
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('automatic branch installation efficiency', () => {
  it('chooses a complete network at least as efficient as the feasible two-bend branch layout', async () => {
    // Feasible witness uses the same production equipment sockets, copper-kit
    // geometry, level planner and graph evaluation as the automatic optimizer.
    const equipment = equipmentScene();
    const seed = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced', selectedIds: ['outdoor', 'cassette-a'] });
    expect(seed.complete, seed.issues.join('\n')).toBe(true);
    let scene = [...equipment, ...seed.elementsToAdd];
    for (const [id, x] of [['cassette-b', 5500], ['cassette-c', 8500]] as const) {
      const port = getRefrigerantPipeBundleSnapTargets([equipment.find(element => element.id === id)!])[0]!;
      const proposal = proposeBranchKit(scene, port, { x, y: 725 }, {
        settings, bendRadiusFactor: settings.bendRadiusFactor, proposalRadiusMm: 100, maxRecoveryStations: 1,
      });
      expect(proposal?.validity, proposal?.violations.join('\n')).toBe('valid');
      const insertion = proposal && buildBranchKitInsertion(proposal, port, scene);
      expect(insertion).not.toBeNull();
      const replaced = new Set([...insertion!.removeElementIds, ...(insertion!.updates ?? []).map(element => element.id)]);
      scene = [...scene.filter(element => !replaced.has(element.id)), ...(insertion!.updates ?? []), ...insertion!.elementsToAdd];
      const branches = insertion!.elementsToAdd.filter(element => element.properties.routeClass === 'indoor-connection');
      expect(branches).toHaveLength(2);
      for (const branch of branches) expect(bendCount(branch)).toBe(2);
    }
    const generated = scene.filter(element => !equipment.includes(element));
    verifyNetwork(equipment, generated);
    const witness = evaluateAutoRouteNetwork({ elements: scene, outdoorUnitId: 'outdoor',
      indoorUnitIds: ['cassette-a', 'cassette-b', 'cassette-c'], objective: 'balanced' });
    const automatic = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced' });
    expect(automatic.complete, automatic.issues.join('\n')).toBe(true);
    expect(automatic.metrics?.branchPairCount).toBe(2);
    verifyNetwork(equipment, automatic.elementsToAdd);
    verifyDirectBranches(automatic.elementsToAdd);
    expect(automatic.evaluations[0]!.score).toBeLessThanOrEqual(witness.score + 0.01);
  }, 90000);

  it.each(['rotated', 'mirrored'] as const)('avoids S-shaped cassette branches when the free main has room: %s', async transform => {
    const equipment = equipmentScene(transform);
    const result = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced' });
    expect(result.complete, result.issues.join('\n')).toBe(true);
    expect(result.metrics?.branchPairCount).toBe(2);
    verifyNetwork(equipment, result.elementsToAdd);
    verifyDirectBranches(result.elementsToAdd);
  }, 90000);

  it('keeps a necessary detour around a fixed obstacle while preserving the physical sockets', async () => {
    const equipment = [unit('outdoor', 11000, 500, true), unit('cassette-b', 3500, 4500)];
    const obstacle = { minX: 4400, minY: 1800, maxX: 12000, maxY: 3300 };
    const result = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced', obstacles: [obstacle] });
    expect(result.complete, result.issues.join('\n')).toBe(true);
    verifyNetwork(equipment, result.elementsToAdd);
    for (const pipe of result.elementsToAdd.filter(element => element.type === 'refrigerant-pipe')) {
      expect(bendCount(pipe)).toBeGreaterThanOrEqual(4);
      const points = pipe.properties.authoredCenterlineRoute as Point2D[];
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1]!; const b = points[index]!;
        const crosses = Math.abs(a.x - b.x) < 0.001
          ? a.x > obstacle.minX && a.x < obstacle.maxX && Math.max(a.y, b.y) > obstacle.minY && Math.min(a.y, b.y) < obstacle.maxY
          : a.y > obstacle.minY && a.y < obstacle.maxY && Math.max(a.x, b.x) > obstacle.minX && Math.min(a.x, b.x) < obstacle.maxX;
        expect(crosses).toBe(false);
      }
    }
  }, 90000);
});
