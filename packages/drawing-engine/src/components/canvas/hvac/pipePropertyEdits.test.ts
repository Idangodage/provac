import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { editablePipeNodes } from './pipeEditModel';
import { buildPipePropertyEdit, type PipePropertyEdit } from './pipePropertyEdits';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';

function pipe(): HvacElement {
  const nodes = [{ x: 0, y: 0, z: 2500 }, { x: 1000, y: 0, z: 2500 }, { x: 1000, y: 1000, z: 2500 }];
  return { id: 'pipe', type: 'refrigerant-pipe', label: 'Gas', position: { x: 0, y: 0 }, rotation: 0,
    width: 1000, depth: 1000, height: 22, elevation: 2500, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { lineKind: 'gas', pipeDiameterMm: 22, insulationThicknessMm: 10,
      routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes,
      segmentMaterials: ['flexible', 'flexible'], systemId: 'system-a' } };
}

describe('validated pipe property edits', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('moves the canonical world-coordinate point without changing unrelated elevation or metadata', () => {
    const source = pipe();
    const snapshot = structuredClone(source);
    const edited = buildPipePropertyEdit([source], source.id, { kind: 'coordinate', index: 2, axis: 'x', valueMm: 1200 });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(editablePipeNodes(edited.elements[0]!)).toEqual([snapshot.properties.routeNodes3d as unknown[]][0]!.map((node, index) =>
      index === 2 ? { ...(node as object), x: 1200 } : node));
    expect(edited.elements[0]!.id).toBe(source.id);
    expect(edited.elements[0]!.properties.systemId).toBe('system-a');
    expect(source).toEqual(snapshot);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects nonfinite coordinate %s without changing the pipe', valueMm => {
    const source = pipe(); const snapshot = structuredClone(source);
    const result = buildPipePropertyEdit([source], source.id, { kind: 'coordinate', index: 1, axis: 'z', valueMm });
    expect(result.ok).toBe(false);
    expect(source).toEqual(snapshot);
  });

  it('rejects a zero-length segment and insufficient bend space', () => {
    const source = pipe();
    const duplicate = buildPipePropertyEdit([source], source.id, { kind: 'coordinate', index: 1, axis: 'x', valueMm: 0 });
    expect(duplicate.ok).toBe(false);
    const shortBend = buildPipePropertyEdit([source], source.id, { kind: 'coordinate', index: 2, axis: 'y', valueMm: 1 });
    expect(shortBend.ok).toBe(false);
    if (!shortBend.ok) expect(shortBend.message).toContain('too short');
  });

  it('preserves a connected terminal position and tangent without silently clamping requested values', () => {
    const source = pipe();
    source.properties.startConnection = { connectionKind: 'field-pipe', sourceElementId: 'fixed-pipe',
      portPoint: { x: 0, y: 0 }, elevationMm: 2500, direction: { x: 1, y: 0 } };
    const snapshot = structuredClone(source);
    const moveEndpoint = buildPipePropertyEdit([source], source.id, { kind: 'coordinate', index: 0, axis: 'z', valueMm: 2600 });
    const tiltTangent = buildPipePropertyEdit([source], source.id, { kind: 'coordinate', index: 1, axis: 'z', valueMm: 2600 });
    expect(moveEndpoint.ok).toBe(false);
    expect(tiltTangent.ok).toBe(false);
    expect(source).toEqual(snapshot);
  });

  it.each(['routeLocked', 'routingLocked', 'locked', 'isLocked', 'reviewed', 'installationReviewed'])('enforces %s for every property operation', key => {
    const source = pipe(); source.properties[key] = true;
    const operations: PipePropertyEdit[] = [
      { kind: 'coordinate', index: 2, axis: 'x', valueMm: 1200 },
      { kind: 'insert', index: 1 }, { kind: 'remove', index: 1 },
      { kind: 'material', index: 1, material: 'hard' },
    ];
    for (const operation of operations) expect(buildPipePropertyEdit([source], source.id, operation).ok).toBe(false);
  });

  it('splits a 3D segment at its true midpoint and keeps the material when removing it', () => {
    const source = pipe();
    source.properties.routeNodes3d = [{ x: 0, y: 0, z: 1000 }, { x: 0, y: 0, z: 2000 }];
    source.properties.routePoints = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    source.properties.segmentMaterials = ['hard'];
    const split = buildPipePropertyEdit([source], source.id, { kind: 'insert', index: 0 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(editablePipeNodes(split.elements[0]!)).toEqual([{ x: 0, y: 0, z: 1000 }, { x: 0, y: 0, z: 1500 }, { x: 0, y: 0, z: 2000 }]);
    expect(split.elements[0]!.properties.segmentMaterials).toEqual(['hard', 'hard']);
    const joined = buildPipePropertyEdit(split.elements, source.id, { kind: 'remove', index: 1 });
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(editablePipeNodes(joined.elements[0]!)).toEqual(source.properties.routeNodes3d);
  });

  it('rejects removing a material boundary and replacing a flexible bend with an unsupported hard fitting', () => {
    const source = pipe(); source.properties.segmentMaterials = ['hard', 'flexible'];
    expect(buildPipePropertyEdit([source], source.id, { kind: 'remove', index: 1 }).ok).toBe(false);
    source.properties.routeNodes3d = [{ x: 0, y: 0, z: 2500 }, { x: 1000, y: 0, z: 2500 }, { x: 2000, y: 500, z: 2500 }];
    source.properties.routePoints = (source.properties.routeNodes3d as Array<{ x: number; y: number }>).map(({ x, y }) => ({ x, y }));
    source.properties.segmentMaterials = ['flexible', 'flexible'];
    const material = buildPipePropertyEdit([source], source.id, { kind: 'material', index: 0, material: 'hard' });
    expect(material.ok).toBe(false);
    if (!material.ok) expect(material.message).toContain('fitting');
  });

  it('changes valid segment material without rewriting the route geometry or levels', () => {
    const source = pipe(); source.properties.networkLevelPlan = { id: 'authored-level' };
    const result = buildPipePropertyEdit([source], source.id, { kind: 'material', index: 0, material: 'hard' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.elements[0]).toEqual({ ...source, properties: { ...source.properties, segmentMaterials: ['hard', 'flexible'] } });
  });
});
