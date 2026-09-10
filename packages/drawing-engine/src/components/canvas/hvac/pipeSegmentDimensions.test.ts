import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { editablePipeNodes } from './pipeEditModel';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildPipeSegmentLengthEdit } from './pipeSegmentDimensions';

const point = (x: number, y: number, z = 2400) => ({ x, y, z });
function pipe(nodes: ReturnType<typeof point>[]): HvacElement {
  return { id: 'pipe', type: 'refrigerant-pipe', position: { x: 0, y: 0 }, width: 2000, depth: 2000,
    rotation: 0, height: 40, elevation: 2380, mountType: 'ceiling', label: 'Pipe', supplyZoneRatio: 0,
    properties: { lineKind: 'gas', pipeDiameterMm: 15.88, insulationThicknessMm: 12,
      routeNodes3d: nodes, routePoints: nodes.map(({ x, y }) => ({ x, y })), segmentMaterials: nodes.slice(1).map(() => 'hard') } };
}

describe('Pipe segment dimensions', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it.each(['start', 'end'] as const)('sets a free segment length with its %s endpoint fixed', pivot => {
    const source = pipe([point(100, 200, 800), point(100, 200, 1800)]);
    const snapshot = structuredClone(source);
    const result = buildPipeSegmentLengthEdit({ elementId: source.id, elements: [source], segmentIndex: 0, lengthMm: 1500, pivot });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(editablePipeNodes(result.elements[0]!)).toEqual(pivot === 'start'
      ? [point(100, 200, 800), point(100, 200, 2300)] : [point(100, 200, 300), point(100, 200, 1800)]);
    expect(source).toEqual(snapshot);
  });

  it('changes an interior dimension by moving the adjoining leg while preserving both unit ports', () => {
    const nodes = [point(0, 0), point(1000, 0), point(1000, 1000), point(2000, 1000), point(2000, 2000), point(3000, 2000)];
    const source = pipe(nodes);
    source.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: 'inlet', portPoint: { x: 0, y: 0 }, elevationMm: 2400, direction: { x: 1, y: 0 } };
    source.properties.endConnection = { connectionKind: 'unit-port', sourceElementId: 'outlet', portPoint: { x: 3000, y: 2000 }, elevationMm: 2400, direction: { x: -1, y: 0 } };
    const result = buildPipeSegmentLengthEdit({ elementId: source.id, elements: [source], segmentIndex: 1, lengthMm: 1300, pivot: 'start' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(editablePipeNodes(result.elements[0]!)).toEqual([
      nodes[0], nodes[1], point(1000, 1300), point(2000, 1300), nodes[4], nodes[5],
    ]);
    expect(result.elements[0]!.properties.startConnection).toEqual(source.properties.startConnection);
    expect(result.elements[0]!.properties.endConnection).toEqual(source.properties.endConnection);
  });

  it('allows moving an intentional collinear division without moving its neighboring endpoints', () => {
    const source = pipe([point(0, 0), point(1000, 0), point(3000, 0)]);
    const result = buildPipeSegmentLengthEdit({ elementId: source.id, elements: [source], segmentIndex: 0, lengthMm: 1500, pivot: 'start' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(editablePipeNodes(result.elements[0]!)).toEqual([point(0, 0), point(1500, 0), point(3000, 0)]);
  });

  it('keeps the committed element unchanged when its existing length is entered', () => {
    const source = pipe([point(0, 0), point(1000, 0)]);
    const result = buildPipeSegmentLengthEdit({ elementId: source.id, elements: [source], segmentIndex: 0, lengthMm: 1000, pivot: 'start' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.elements[0]).toBe(source);
  });

  it('sets the exact length beside a 45-degree leg', () => {
    const source = pipe([point(0, 0), point(1000, 0), point(2000, 1000), point(2000, 2000)]);
    const result = buildPipeSegmentLengthEdit({ elementId: source.id, elements: [source], segmentIndex: 0, lengthMm: 1300, pivot: 'start' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const nodes = editablePipeNodes(result.elements[0]!);
    expect(nodes[0]).toEqual(point(0, 0));
    expect(nodes[1]!.x).toBeCloseTo(1300, 8); expect(nodes[1]!.y).toBeCloseTo(0, 8);
    expect(nodes[2]!.x).toBeCloseTo(2000, 8); expect(nodes[2]!.y).toBeCloseTo(700, 8);
    expect(nodes[3]).toEqual(point(2000, 2000));
  });

  it('holds the end pivot while moving the preceding leg for an interior length', () => {
    const source = pipe([point(0, 0), point(1000, 0), point(1000, 1000), point(2000, 1000)]);
    const result = buildPipeSegmentLengthEdit({ elementId: source.id, elements: [source], segmentIndex: 2, lengthMm: 1300, pivot: 'end' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(editablePipeNodes(result.elements[0]!)).toEqual([point(0, 0), point(700, 0), point(700, 1000), point(2000, 1000)]);
  });

  it('rejects constrained, locked and invalid dimensions without changing the model', () => {
    const source = pipe([point(0, 0), point(1000, 0)]);
    source.properties.endConnection = { connectionKind: 'unit-port', sourceElementId: 'fixed', portPoint: { x: 1000, y: 0 }, elevationMm: 2400, direction: { x: -1, y: 0 } };
    const request = { elementId: source.id, elements: [source], segmentIndex: 0, lengthMm: 1500, pivot: 'start' as const };
    expect(buildPipeSegmentLengthEdit(request).ok).toBe(false);
    source.properties.endConnection = null;
    source.properties.routeLocked = true;
    expect(buildPipeSegmentLengthEdit(request).ok).toBe(false);
    source.properties.routeLocked = false;
    const snapshot = structuredClone(source);
    for (const lengthMm of [0, -1, NaN, Infinity]) expect(buildPipeSegmentLengthEdit({ ...request, lengthMm }).ok).toBe(false);
    expect(buildPipeSegmentLengthEdit({ ...request, segmentIndex: -1 }).ok).toBe(false);
    expect(source).toEqual(snapshot);
  });
});
