import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { readPipeDesign, type PipeDesign } from './pipeDesignModel';
import {
  ANGLE_PRESERVATION_TOLERANCE_DEG, pipeIncludedAngles, solvePipeOrientation,
} from './pipeOrientationSolver';
import type { PipeRouteNode3D } from './pipeRoute3d';
import type { PipeRuleContext } from './pipeRuleModel';

const context: PipeRuleContext = {
  socketElbows: true,
  pipeDiameterMm: 15.88,
  minimumSocketRadiusMm: 0,
  fieldBendRadiusMm: 30,
  minimumFieldBendRadiusMm: 0,
  minimumPortStubMm: 200,
  startIsUnitPort: false,
  endIsUnitPort: false,
};

/** An L route: +x then +y, both ends open unless a connection is supplied. */
const L_ROUTE: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 2600 }, { x: 2000, y: 0, z: 2600 }, { x: 2000, y: 3000, z: 2600 },
];

function design(nodes: PipeRouteNode3D[] = L_ROUTE,
  extra: Record<string, unknown> = {}, scene: HvacElement[] = []): PipeDesign {
  const element = {
    id: 'pipe-1', type: 'refrigerant-pipe', label: 'Gas Pipe',
    position: { x: 0, y: 0 }, width: 10, depth: 10, height: 10,
    elevation: 2000, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: {
      lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 15.88,
      routePoints: nodes.map(({ x, y }) => ({ x, y })),
      routeNodes3d: nodes,
      segmentMaterials: nodes.slice(1).map(() => 'flexible'),
      ...extra,
    },
  } as unknown as HvacElement;
  return readPipeDesign(element, scene);
}

const unit = (id: string): HvacElement => ({
  id, type: 'outdoor-unit', label: id, position: { x: 0, y: 0 },
  width: 100, depth: 100, height: 100, elevation: 0, rotation: 0,
  mountType: 'floor', supplyZoneRatio: 0, properties: {},
} as unknown as HvacElement);

const firstJointId = (source: PipeDesign) => source.joints[0]!.id;

describe('roll-joint — orientation without changing the fitting', () => {
  it.each([5, 25, 60])('rolls by %i° and preserves the included angle exactly', (angleDeg) => {
    const source = design();
    const before = pipeIncludedAngles(source.nodes.map(node => ({ x: node.x, y: node.y, z: node.z })));
    const result = solvePipeOrientation({
      design: source, context, goal: { kind: 'roll-joint', jointId: firstJointId(source), angleDeg },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('exact');
    expect(result.achievedAngleDeg).toBeCloseTo(angleDeg, 9);

    // The defining property: this is orientation, not a different elbow.
    const after = pipeIncludedAngles(result.nodes);
    expect(after).toHaveLength(before.length);
    after.forEach((angle, index) => {
      expect(Math.abs(angle - before[index]!)).toBeLessThanOrEqual(ANGLE_PRESERVATION_TOLERANCE_DEG);
    });
    // Nothing is reported as a re-angle, because nothing was re-angled.
    expect(result.adaptations.some(entry => entry.kind === 're-angle-bend')).toBe(false);
    expect(result.adaptations.some(entry => entry.kind === 'roll-bend-plane')).toBe(true);
  });

  it('keeps the leg lengths a roll cannot change', () => {
    const source = design();
    const result = solvePipeOrientation({
      design: source, context, goal: { kind: 'roll-joint', jointId: firstJointId(source), angleDeg: 37 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const length = (a: PipeRouteNode3D, b: PipeRouteNode3D) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    expect(length(result.nodes[0]!, result.nodes[1]!)).toBeCloseTo(2000, 6);
    expect(length(result.nodes[1]!, result.nodes[2]!)).toBeCloseTo(3000, 6);
  });

  it('turns a plan elbow into a riser elbow at 90° and says so', () => {
    const source = design();
    const result = solvePipeOrientation({
      design: source, context, goal: { kind: 'roll-joint', jointId: firstJointId(source), angleDeg: 90 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The outgoing leg leaves the plan entirely; the corner itself is untouched.
    expect(result.nodes[1]).toEqual({ x: 2000, y: 0, z: 2600 });
    expect(result.nodes[2]!.z).toBeCloseTo(5600, 6);
    expect(result.adaptations[0]!.label).toBe('bend rolled horizontal → vertical');
  });

  it('refuses when the far end is welded — the roll would drag the weld', () => {
    const source = design(L_ROUTE, {
      endConnection: {
        connectionKind: 'unit-port', sourceElementId: 'idu-1',
        portPoint: { x: 2000, y: 3000 }, direction: { x: 0, y: -1 }, elevationMm: 2600,
      },
    }, [unit('idu-1')]);
    const result = solvePipeOrientation({
      design: source, context, goal: { kind: 'roll-joint', jointId: firstJointId(source), angleDeg: 30 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('end connection must remain fixed');
  });

  it('refuses a locked bend plane rather than silently ignoring the lock', () => {
    const source = design();
    const locked: PipeDesign = {
      ...source,
      joints: source.joints.map(joint => ({ ...joint, lock: 'plane' as const })),
    };
    const result = solvePipeOrientation({
      design: locked, context, goal: { kind: 'roll-joint', jointId: firstJointId(source), angleDeg: 20 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('locked');
  });

  it('reports no movement rather than success for a zero angle', () => {
    const source = design();
    const result = solvePipeOrientation({
      design: source, context, goal: { kind: 'roll-joint', jointId: firstJointId(source), angleDeg: 0 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a roll aimed at a terminal rather than a bend', () => {
    const source = design();
    const result = solvePipeOrientation({
      design: source, context, goal: { kind: 'roll-joint', jointId: 'not-a-joint', angleDeg: 20 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('interior bend');
  });
});

describe('rotate-component — a rigid sub-chain about a connection', () => {
  it('rotates the whole run about its start without re-angling anything', () => {
    const source = design();
    const before = pipeIncludedAngles(source.nodes.map(node => ({ x: node.x, y: node.y, z: node.z })));
    const result = solvePipeOrientation({
      design: source, context,
      goal: {
        kind: 'rotate-component',
        nodeIds: source.nodes.map(node => node.id),
        pivot: source.nodes[0]!,
        axis: { x: 0, y: 0, z: 1 },
        angleDeg: 30,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A rigid rotation cannot change an interior angle.
    pipeIncludedAngles(result.nodes).forEach((angle, index) => {
      expect(Math.abs(angle - before[index]!)).toBeLessThanOrEqual(ANGLE_PRESERVATION_TOLERANCE_DEG);
    });
    expect(result.adaptations.some(entry => entry.kind === 're-angle-bend')).toBe(false);
    // The pivot itself is untouched, so a weld there survives.
    expect(result.nodes[0]).toEqual({ x: 0, y: 0, z: 2600 });
  });

  it('re-angles only the boundary joint when a sub-chain turns, and reports it', () => {
    const source = design();
    const result = solvePipeOrientation({
      design: source, context,
      goal: {
        kind: 'rotate-component',
        nodeIds: [source.nodes[2]!.id],
        pivot: source.nodes[1]!,
        axis: { x: 0, y: 0, z: 1 },
        angleDeg: 20,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reangled = result.adaptations.filter(entry => entry.kind === 're-angle-bend');
    expect(reangled).toHaveLength(1);
    expect(reangled[0]!.jointIndex).toBe(1);
    expect(reangled[0]!.label).toMatch(/90\.0° → 1?\d\d?\.\d°/);
  });

  it('rejects a degenerate rotation axis', () => {
    const source = design();
    const result = solvePipeOrientation({
      design: source, context,
      goal: {
        kind: 'rotate-component', nodeIds: source.nodes.map(node => node.id),
        pivot: source.nodes[0]!, axis: { x: 0, y: 0, z: 0 }, angleDeg: 30,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('valid rotation axis');
  });
});
