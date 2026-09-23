import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { resolvePipeEditFrame, type PipeEditSelection } from './pipeEditGeometry';
import { buildPipeModelEdit, editablePipeNodes } from './pipeEditModel';
import { pipeIncludedAngles } from './pipeOrientationSolver';
import type { PipeRouteNode3D } from './pipeRoute3d';

/**
 * A four-corner route. Rotating an interior SECTION of it is the case the rigid
 * kernel cannot solve: it demands the boundary edge to each unselected
 * neighbour still point exactly where the rotation would have put it.
 */
const ROUTE: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 2600 },
  { x: 2000, y: 0, z: 2600 },
  { x: 2000, y: 3000, z: 2600 },
  { x: 5000, y: 3000, z: 2600 },
];

const pipe = (nodes: PipeRouteNode3D[] = ROUTE, extra: Record<string, unknown> = {}): HvacElement => ({
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
} as unknown as HvacElement);

function rotate(element: HvacElement, selection: PipeEditSelection, angleDegrees: number,
  mode: 'rigid' | 'adaptive') {
  const nodes = editablePipeNodes(element);
  const frame = resolvePipeEditFrame({ mode: 'world', nodes, selection })!;
  return buildPipeModelEdit({
    elementId: element.id,
    elements: [element],
    selection,
    operation: { kind: 'rotate', axis: 'z', angleDegrees, pivot: 'start' },
    frame,
    mode,
  });
}

describe('command-bar rotation reaches the adaptive solver', () => {
  const section: PipeEditSelection = { kind: 'section', startIndex: 1, endIndex: 2 };

  it('the rigid path refuses to rotate an interior section', () => {
    const result = rotate(pipe(), section, 20, 'rigid');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('cannot maintain the rotated connection direction');
  });

  it('the adaptive path solves the same rotation and reports what it cost', () => {
    const result = rotate(pipe(), section, 20, 'adaptive');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(1);
    // Both corners of a two-node section are boundaries, so both absorb the
    // turn — and both are reported rather than silently changed.
    const reangled = (result.adaptations ?? []).filter(entry => entry.kind === 're-angle-bend');
    expect(reangled.map(entry => entry.jointIndex).sort()).toEqual([1, 2]);
  });

  it('keeps the fittings INSIDE a rotated sub-chain at their purchased angles', () => {
    // Five corners, so the section [1..3] has a genuinely interior corner at 2.
    const longer: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 2600 },
      { x: 2000, y: 0, z: 2600 },
      { x: 2000, y: 3000, z: 2600 },
      { x: 5000, y: 3000, z: 2600 },
      { x: 5000, y: 6000, z: 2600 },
    ];
    const before = pipeIncludedAngles(longer);
    const result = rotate(pipe(longer), { kind: 'section', startIndex: 1, endIndex: 3 }, 20, 'adaptive');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = pipeIncludedAngles(editablePipeNodes(result.elements[0]!));
    // The interior corner is carried rigidly: its angle is untouched.
    expect(after[1]).toBeCloseTo(before[1]!, 6);
    // Only the two boundary corners changed, and both are reported.
    const reangled = (result.adaptations ?? []).filter(entry => entry.kind === 're-angle-bend');
    expect(reangled.map(entry => entry.jointIndex).sort()).toEqual([1, 3]);
  });

  it('preserves the pivot, so a weld there survives the rotation', () => {
    const result = rotate(pipe(), { kind: 'run' }, 35, 'adaptive');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = editablePipeNodes(result.elements[0]!);
    expect(after[0]).toEqual({ x: 0, y: 0, z: 2600 });
  });

  it('rotating a whole run rigidly changes no included angle', () => {
    const before = pipeIncludedAngles(ROUTE);
    const result = rotate(pipe(), { kind: 'run' }, 35, 'adaptive');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    pipeIncludedAngles(editablePipeNodes(result.elements[0]!)).forEach((angle, index) => {
      expect(angle).toBeCloseTo(before[index]!, 6);
    });
    expect((result.adaptations ?? []).some(entry => entry.kind === 're-angle-bend')).toBe(false);
  });

  it('writes the design through, so the edit survives a re-read', () => {
    const result = rotate(pipe(), { kind: 'run' }, 35, 'adaptive');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = result.elements[0]!;
    // The semantic design is persisted alongside the regenerated fabrication route.
    expect(written.properties.pipeDesign).toBeTruthy();
    expect((written.properties.routeNodes3d as unknown[])).toHaveLength(ROUTE.length);
    expect((written.properties.segmentMaterials as unknown[])).toHaveLength(ROUTE.length - 1);
  });

  it('refuses a rotation that would drag a welded end, naming the connection', () => {
    const welded = pipe(ROUTE, {
      endConnection: {
        connectionKind: 'unit-port', sourceElementId: 'idu-1',
        portPoint: { x: 5000, y: 3000 }, direction: { x: -1, y: 0 }, elevationMm: 2600,
      },
    });
    const result = rotate(welded, { kind: 'run' }, 35, 'adaptive');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('end connection must remain fixed');
  });
});
