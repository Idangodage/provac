import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { analysePipeCornerFittings, analysePipeEdge, analysePipeEnvironment, describePipeEnvironment } from './pipeEnvironment';
import type { PipeRouteNode3D } from './pipeRoute3d';
import type { PipeRuleContext } from './pipeRuleModel';
import { buildPipeSkeleton } from './pipeSkeleton';

const context: PipeRuleContext = {
  socketElbows: true,
  pipeDiameterMm: 15.88,
  minimumSocketRadiusMm: 0,
  fieldBendRadiusMm: 30,
  minimumFieldBendRadiusMm: 0,
  minimumPortStubMm: 200,
  startIsUnitPort: true,
  endIsUnitPort: false,
};

const base = (id: string, type: HvacElement['type'], properties: Record<string, unknown> = {}): HvacElement => ({
  id, type, label: id, position: { x: 0, y: 0 }, width: 500, depth: 500, height: 100,
  elevation: 2000, rotation: 0, properties,
} as unknown as HvacElement);

const ROUTE: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2600 },
  { x: 1000, y: 2000, z: 2600 }, { x: 1000, y: 2000, z: 1400 }, { x: 1600, y: 2000, z: 1400 },
];

function pipe(properties: Record<string, unknown> = {}): HvacElement {
  return base('pipe-1', 'refrigerant-pipe', {
    lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 15.88,
    routePoints: ROUTE.map(({ x, y }) => ({ x, y })), routeNodes3d: ROUTE,
    segmentMaterials: ['hard', 'hard', 'hard', 'hard'],
    ...properties,
  });
}

describe('analysePipeEdge', () => {
  it('reads an open end', () => {
    expect(analysePipeEdge(pipe(), 'start', [], 200)).toEqual({ kind: 'open' });
  });

  it('identifies an equipment port, its approach direction and its reserved stub', () => {
    const unit = base('odu-1', 'outdoor-unit');
    const element = pipe({
      startConnection: { connectionKind: 'unit-port', sourceElementId: 'odu-1',
        portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2600 },
    });
    const edge = analysePipeEdge(element, 'start', [unit], 200);
    expect(edge.kind).toBe('unit-port');
    if (edge.kind !== 'unit-port') return;
    expect(edge.elementId).toBe('odu-1');
    expect(edge.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(edge.stubMm).toBe(200);
  });

  it('identifies a branch kit, its terminal role and whether it can be turned', () => {
    const kit = { ...base('kit-1', 'refrigerant-branch-kit'), rotation: 30 };
    const element = pipe({
      endConnection: { connectionKind: 'field-pipe', sourceElementId: 'kit-1',
        terminalRole: 'run-outlet', point: { x: 1600, y: 2000 }, direction: { x: -1, y: 0 }, elevationMm: 1400 },
    });
    const edge = analysePipeEdge(element, 'end', [kit], 200);
    expect(edge.kind).toBe('branch-kit');
    if (edge.kind !== 'branch-kit') return;
    expect(edge.terminalRole).toBe('run-outlet');
    expect(edge.rotationDeg).toBe(30);
    expect(edge.attachedPipeIds).toEqual([]);
  });

  it('reports the other pipes on a kit, which is what forbids turning it', () => {
    const kit = base('kit-1', 'refrigerant-branch-kit');
    const sibling = base('pipe-2', 'refrigerant-pipe', {
      endConnection: { connectionKind: 'field-pipe', sourceElementId: 'kit-1' },
    });
    const element = pipe({
      endConnection: { connectionKind: 'field-pipe', sourceElementId: 'kit-1', direction: { x: -1, y: 0 } },
    });
    const edge = analysePipeEdge(element, 'end', [kit, sibling], 200);
    expect(edge.kind === 'branch-kit' && edge.attachedPipeIds).toEqual(['pipe-2']);
  });

  it('treats a weld to another field pipe as its own kind', () => {
    const other = base('pipe-9', 'refrigerant-pipe');
    const element = pipe({
      startConnection: { connectionKind: 'field-pipe', sourceElementId: 'pipe-9', direction: { x: 1, y: 0 } },
    });
    expect(analysePipeEdge(element, 'start', [other], 200).kind).toBe('pipe-weld');
  });
});

describe('analysePipeCornerFittings', () => {
  const skeleton = buildPipeSkeleton(ROUTE, { materials: ['hard', 'hard', 'hard', 'hard'], defaultBendRadiusMm: 30 });

  it('names each corner as the part it actually is', () => {
    const fittings = analysePipeCornerFittings(skeleton, context);
    expect(fittings).toHaveLength(3);
    // A plan corner on hard copper at 90 degrees IS a catalogue socket elbow.
    expect(fittings[0]!.kind).toBe('socket-elbow');
    expect(fittings[0]!.orientation).toBe('plan');
    expect(fittings[0]!.catalogue?.angleDeg).toBe(90);
    expect(fittings[0]!.angleIsFree).toBe(false);
    // The two corners bracketing the vertical drop are riser elbows.
    expect(fittings[1]!.kind).toBe('riser-elbow');
    expect(fittings[2]!.kind).toBe('riser-elbow');
  });

  it('calls a non-catalogue turn a formed field bend whose angle is free', () => {
    const free = buildPipeSkeleton([
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1600, y: 900, z: 0 },
    ], { materials: ['flexible', 'flexible'], defaultBendRadiusMm: 30 });
    const fittings = analysePipeCornerFittings(free, context);
    expect(fittings[0]!.kind).toBe('field-bend');
    expect(fittings[0]!.catalogue).toBeNull();
    expect(fittings[0]!.angleIsFree).toBe(true);
  });
});

describe('analysePipeEnvironment', () => {
  it('summarises both edges, the fittings and the risers in one line', () => {
    const unit = base('odu-1', 'outdoor-unit');
    const kit = base('kit-1', 'refrigerant-branch-kit');
    const element = pipe({
      startConnection: { connectionKind: 'unit-port', sourceElementId: 'odu-1',
        portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2600 },
      endConnection: { connectionKind: 'field-pipe', sourceElementId: 'kit-1',
        terminalRole: 'inlet', direction: { x: -1, y: 0 }, elevationMm: 1400 },
    });
    const skeleton = buildPipeSkeleton(ROUTE, { materials: ['hard', 'hard', 'hard', 'hard'], defaultBendRadiusMm: 30 });
    const environment = analysePipeEnvironment(element, [unit, kit, element], skeleton, context);
    expect(environment.start.kind).toBe('unit-port');
    expect(environment.end.kind).toBe('branch-kit');
    expect(environment.riserLegIndices).toEqual([2]);
    const description = describePipeEnvironment(environment);
    expect(description).toContain('odu-1 (equipment port)');
    expect(description).toContain('kit-1 (branch kit · inlet)');
    expect(description).toContain('riser');
  });
});
