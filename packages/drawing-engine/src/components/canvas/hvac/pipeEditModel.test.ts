import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { resolvePipeBendEdit } from './pipeBendEdit';
import { resolvePipeEditFrame } from './pipeEditGeometry';
import { buildPipeModelEdit, connectedPipeIds, editablePipeNodes, pipeEditControlIndices, validatePipeModelReplacement, type PipeModelEditResult } from './pipeEditModel';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipePairVisual, buildRefrigerantPipeVisual, getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';

const point = (x: number, y: number, z = 2400) => ({ x, y, z });
function pipe(id: string, nodes: PipeRouteNode3D[]): HvacElement {
  return { id, type: 'refrigerant-pipe', position: { x: 0, y: 0 }, width: 1000, depth: 1000,
    rotation: 0, height: 40, elevation: 2380, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5,
    properties: { lineKind: 'gas', pipeDiameterMm: 15.88, insulationThicknessMm: 12,
      routeNodes3d: nodes, routePoints: nodes.map(({ x, y }) => ({ x, y })), segmentMaterials: nodes.slice(1).map(() => 'hard'), systemId: 'VRF-1' } };
}
function success(result: PipeModelEditResult): HvacElement[] {
  expect(result.ok, result.ok ? '' : result.message).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.elements;
}
const world = resolvePipeEditFrame({ mode: 'world', nodes: [], selection: { kind: 'run' } })!;

describe('pipe editing model transactions', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('does not inspect unrelated route geometry while validating an edit', () => {
    const source = pipe('selected', [point(0, 0), point(1000, 0)]);
    const unrelated = pipe('unrelated', [point(0, 5000), point(1000, 5000)]);
    delete unrelated.properties.routeNodes3d;
    Object.defineProperty(unrelated.properties, 'routePoints', { get() { throw new Error('Unrelated geometry was read during this edit.'); } });
    const edited = success(buildPipeModelEdit({ elements: [source, unrelated], elementId: source.id, selection: { kind: 'run' }, frame: world,
      operation: { kind: 'translate', offset: point(100, 200, 300) } }));
    expect(editablePipeNodes(edited[0]!)).toEqual([point(100, 200, 2700), point(1100, 200, 2700)]);
  });

  it('extracts legacy single and paired canonical nodes with the same datum as their rendered pipes', () => {
    const source = pipe('legacy', [point(0, 0), point(1000, 0), point(1000, 1000)]);
    delete source.properties.routeNodes3d;
    for (const endpoint of [null, 'start', 'end'] as const) {
      source.properties.startConnection = null; source.properties.endConnection = null;
      if (endpoint) source.properties[`${endpoint}Connection`] = { connectionKind: 'field-pipe', sourceElementId: 'fixed',
        portPoint: endpoint === 'start' ? { x: 0, y: 0 } : { x: 1000, y: 1000 },
        direction: endpoint === 'start' ? { x: 1, y: 0 } : { x: 0, y: -1 }, elevationMm: 2750 };
      const visual = buildRefrigerantPipeVisual(source);
      expect(editablePipeNodes(source)).toEqual(visual.routePoints.map(point => ({ ...point, z: source.elevation + visual.localZMm })));
    }
    const paired = { ...source, type: 'refrigerant-pipe-pair' as const,
      properties: { routePoints: source.properties.routePoints, gasPipeDiameterMm: 15.88, liquidPipeDiameterMm: 9.52,
        insulationThicknessMm: 12, pipeGapMm: 25 } };
    const visual = buildRefrigerantPipePairVisual(paired);
    expect(editablePipeNodes(paired)).toEqual(visual.routePoints.map(point => ({ ...point,
      z: paired.elevation + (visual.gasLocalZMm + visual.liquidLocalZMm) / 2 })));
  });

  it('moves linked pipes in one pure transaction, including their connection records and dimensions', () => {
    const left = pipe('left', [point(0, 0), point(1000, 0)]);
    const right = pipe('right', [point(1000, 0), point(2000, 0)]);
    right.properties.startConnection = { sourceElementId: 'left', connectionKind: 'field-pipe',
      portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2400, portId: 'joint-A' };
    const unrelated = pipe('unrelated', [point(0, 800), point(1000, 800)]);
    const elements = [left, right, unrelated]; const snapshot = structuredClone(elements);
    expect(connectedPipeIds('left', elements)).toEqual(['left', 'right']);
    const edited = success(buildPipeModelEdit({ elements, elementId: 'left', selection: { kind: 'run' }, frame: world,
      connected: true, operation: { kind: 'translate', offset: { x: 125, y: -50, z: 300 } } }));
    expect(edited.map(element => element.id)).toEqual(['left', 'right']);
    expect(editablePipeNodes(edited[0]!).at(-1)).toEqual(editablePipeNodes(edited[1]!)[0]);
    expect(edited[1]!.properties.startConnection).toMatchObject({ portId: 'joint-A', portPoint: { x: 1125, y: -50 }, elevationMm: 2700, direction: { x: 1, y: 0 } });
    expect(edited[0]!.properties.systemId).toBe('VRF-1');
    expect(edited[0]!.elevation).toBeGreaterThan(left.elevation);
    expect(elements).toEqual(snapshot);
  });

  it('rejects moving a one-sided attached terminal and rejects a locked connected neighbour', () => {
    const left = pipe('left', [point(0, 0), point(1000, 0)]);
    const right = pipe('right', [point(1000, 0), point(2000, 0)]);
    right.properties.startConnection = { sourceElementId: 'left', connectionKind: 'field-pipe', portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2400 };
    const request = { elements: [left, right], elementId: 'left', selection: { kind: 'run' as const }, frame: world,
      operation: { kind: 'translate' as const, offset: point(0, 100, 0) } };
    expect(buildPipeModelEdit(request).ok).toBe(false);
    right.properties.routeLocked = true;
    expect(buildPipeModelEdit({ ...request, connected: true }).ok).toBe(false);
  });

  it('uses a shared pivot for all connected pipes and rotates internal port directions', () => {
    const left = pipe('left', [point(0, 0), point(1000, 0)]);
    const right = pipe('right', [point(1000, 0), point(2000, 0)]);
    right.properties.startConnection = { sourceElementId: 'left', connectionKind: 'field-pipe', portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2400 };
    const edited = success(buildPipeModelEdit({ elements: [left, right], elementId: 'left', selection: { kind: 'run' }, frame: world,
      connected: true, operation: { kind: 'rotate', axis: 'z', angleDegrees: 90, pivot: 'start' } }));
    expect(editablePipeNodes(edited[0]!)[0]).toEqual(point(0, 0));
    expect(editablePipeNodes(edited[1]!)[1]!.y).toBeCloseTo(2000, 8);
    const record = edited[1]!.properties.startConnection as { direction: { x: number; y: number } };
    expect(record.direction.x).toBeCloseTo(0, 8); expect(record.direction.y).toBeCloseTo(1, 8);
    expect(buildPipeModelEdit({ elements: [left, right], elementId: 'left', selection: { kind: 'run' }, frame: world,
      connected: true, operation: { kind: 'rotate', axis: 'y', angleDegrees: 90, pivot: 'start' } }).ok).toBe(false);
  });

  it.each(['start', 'end'] as const)('rolls a rigid bend around its actual %s socket without changing the port or fitting dimensions', fixed => {
    const source = pipe('bend', [point(0, 0), point(1000, 0), point(1000, 1000)]);
    const original = structuredClone(source);
    const bend = resolvePipeBendEdit(source, 1, fixed)!;
    expect(bend).not.toBeNull();
    expect(bend.pivotPoint).not.toEqual(editablePipeNodes(source)[1]);
    const next = success(buildPipeModelEdit({ elements: [source], elementId: source.id, selection: bend.selection, frame: bend.frame,
      operation: { kind: 'rotate', axis: 'x', angleDegrees: 90, pivot: bend.pivotPoint } }))[0]!;
    const rotated = resolvePipeBendEdit(next, 1, fixed)!;
    for (const axis of ['x', 'y', 'z'] as const) expect(rotated.pivotPoint[axis]).toBeCloseTo(bend.pivotPoint[axis], 8);
    expect(rotated.radiusMm).toBe(bend.radiusMm);
    expect(rotated.angleDegrees).toBeCloseTo(bend.angleDegrees, 8);
    expect(next.properties.pipeDiameterMm).toBe(source.properties.pipeDiameterMm);
    const fixedNode = fixed === 'start' ? 0 : 2;
    expect(editablePipeNodes(next)[fixedNode]).toEqual(editablePipeNodes(source)[fixedNode]);
    expect(source).toEqual(original);
  });

  it('allows rolling at a connected inlet and rejects a roll whose far terminal is fixed', () => {
    const source = pipe('bend', [point(0, 0), point(1000, 0), point(1000, 1000)]);
    source.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: 'unit', portPoint: { x: 0, y: 0 }, elevationMm: 2400, direction: { x: 1, y: 0 } };
    const bend = resolvePipeBendEdit(source, 1, 'start')!;
    const request = { elements: [source], elementId: source.id, selection: bend.selection, frame: bend.frame,
      operation: { kind: 'rotate' as const, axis: 'x' as const, angleDegrees: 90, pivot: bend.pivotPoint } };
    expect(buildPipeModelEdit(request).ok).toBe(true);
    source.properties.endConnection = { connectionKind: 'field-pipe', sourceElementId: 'fixed', portPoint: { x: 1000, y: 1000 }, elevationMm: 2400, direction: { x: 0, y: -1 } };
    expect(buildPipeModelEdit(request).ok).toBe(false);
  });

  it('rigidly moves explicitly selected gas/liquid lanes without changing their separation', () => {
    const gas = pipe('gas', [point(0, 0), point(1000, 0)]);
    const liquid = pipe('liquid', [point(0, 150), point(1000, 150)]);
    liquid.properties.lineKind = 'liquid';
    const next = success(buildPipeModelEdit({ elements: [gas, liquid], elementId: 'gas', selectedIds: ['gas', 'liquid'],
      selection: { kind: 'run' }, frame: world, operation: { kind: 'rotate', axis: 'x', angleDegrees: 90, pivot: 'start' } }));
    const gasStart = editablePipeNodes(next[0]!)[0]!; const liquidStart = editablePipeNodes(next[1]!)[0]!;
    expect(Math.hypot(gasStart.x - liquidStart.x, gasStart.y - liquidStart.y, gasStart.z - liquidStart.z)).toBeCloseTo(150, 8);
    expect(liquidStart.z - gasStart.z).toBeCloseTo(150, 8);
  });

  it('slides a connected hard-pipe segment along its adjoining straights despite along-segment pointer drift', () => {
    const source = pipe('connected', [point(0, 0), point(1000, 0), point(1000, 1000), point(2000, 1000)]);
    source.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: 'inlet', portPoint: { x: 0, y: 0 }, elevationMm: 2400, direction: { x: 1, y: 0 } };
    source.properties.endConnection = { connectionKind: 'unit-port', sourceElementId: 'outlet', portPoint: { x: 2000, y: 1000 }, elevationMm: 2400, direction: { x: -1, y: 0 } };
    const next = success(buildPipeModelEdit({ elements: [source], elementId: source.id, selection: { kind: 'segment', index: 1 }, frame: world,
      operation: { kind: 'translate', offset: point(200, 23, 0) } }))[0]!;
    expect(editablePipeNodes(next)).toEqual([point(0, 0), point(1200, 0), point(1200, 1000), point(2000, 1000)]);
    expect(next.properties.startConnection).toEqual(source.properties.startConnection);
    expect(next.properties.endConnection).toEqual(source.properties.endConnection);
    expect(validatePipeModelReplacement(source, next, [source])).toBeNull();
  });

  it('edits an actual generated network segment without rejecting its existing fittings', async () => {
    const indoor: HvacElement = { id: 'indoor', type: 'ceiling-cassette-ac', category: 'indoor-unit', label: 'Indoor',
      position: { x: 500, y: 300 }, rotation: 0, width: 600, depth: 600, height: 250, elevation: 2200,
      mountType: 'ceiling', supplyZoneRatio: 0, properties: {} };
    indoor.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([indoor])[0]!.liquidElevationMm;
    const outdoor: HvacElement = { ...indoor, id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit',
      position: { x: 6900, y: 2600 }, rotation: 180, width: 900, depth: 450, height: 1200, elevation: 0, mountType: 'floor' };
    outdoor.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([outdoor])[0]!.gasElevationMm;
    const scene = [indoor, outdoor];
    const result = await planAutoRouteNetwork(scene, { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' });
    expect(result.complete, result.issues.join(' ')).toBe(true);
    const generated = result.elementsToAdd.filter(element => element.type === 'refrigerant-pipe');
    for (const source of generated) {
      const nodes = editablePipeNodes(source);
      const segmentIndex = nodes.findIndex((node, index) => index > 0 && index + 2 < nodes.length
        && Math.abs(node.x - nodes[index + 1]!.x) < 0.001 && Math.abs(node.y - nodes[index + 1]!.y) > 1000
        && Math.abs(node.z - nodes[index + 1]!.z) < 0.001);
      expect(segmentIndex).toBeGreaterThan(0);
      expect(pipeEditControlIndices(source).nodes.length).toBeLessThan(nodes.length / 2);
      const next = success(buildPipeModelEdit({ elementId: source.id, elements: [...scene, ...generated],
        selection: { kind: 'segment', index: segmentIndex }, frame: world, operation: { kind: 'translate', offset: point(200, 17, 0) } }))[0]!;
      const edited = editablePipeNodes(next);
      expect(edited[0]).toEqual(nodes[0]); expect(edited.at(-1)).toEqual(nodes.at(-1));
      expect(edited[segmentIndex]!.x - nodes[segmentIndex]!.x).toBeCloseTo(200, 8);
      expect(edited[segmentIndex + 1]!.x - nodes[segmentIndex + 1]!.x).toBeCloseTo(200, 8);
      expect(next.properties.startConnection).toEqual(source.properties.startConnection);
      expect(next.properties.endConnection).toEqual(source.properties.endConnection);
      expect(validatePipeModelReplacement(source, next, [...scene, ...generated])).toBeNull();
      const distortedArc = structuredClone(source);
      const sampledIndex = nodes.findIndex((_, index) => index > 0 && index < nodes.length - 1
        && !pipeEditControlIndices(source).nodes.includes(index));
      const distortedNodes = editablePipeNodes(distortedArc);
      distortedNodes[sampledIndex]!.z += 3;
      distortedArc.properties.routeNodes3d = distortedNodes;
      expect(validatePipeModelReplacement(source, distortedArc, [...scene, ...generated])).not.toBeNull();
      const shortenedApproach = structuredClone(source);
      const shortNodes = editablePipeNodes(shortenedApproach);
      const firstStraightAfterArc = nodes.findIndex((node, index) => index > 1
        && Math.hypot(node.x - nodes[index - 1]!.x, node.y - nodes[index - 1]!.y, node.z - nodes[index - 1]!.z) > 12);
      const stubLength = Math.hypot(nodes[1]!.x - nodes[0]!.x, nodes[1]!.y - nodes[0]!.y, nodes[1]!.z - nodes[0]!.z);
      for (let index = 1; index < firstStraightAfterArc; index++) {
        for (const axis of ['x', 'y', 'z'] as const) shortNodes[index]![axis] -= (nodes[1]![axis] - nodes[0]![axis]) / stubLength * 100;
      }
      shortenedApproach.properties.routeNodes3d = shortNodes;
      expect(validatePipeModelReplacement(source, shortenedApproach, [...scene, ...generated])).toContain('approach');
      for (let index = 1; index < nodes.length; index++) {
        const before = nodes[index]!; const previous = nodes[index - 1]!;
        const after = edited[index]!; const editedPrevious = edited[index - 1]!;
        const beforeLength = Math.hypot(before.x - previous.x, before.y - previous.y, before.z - previous.z);
        const afterLength = Math.hypot(after.x - editedPrevious.x, after.y - editedPrevious.y, after.z - editedPrevious.z);
        for (const axis of ['x', 'y', 'z'] as const) expect((after[axis] - editedPrevious[axis]) / afterLength)
          .toBeCloseTo((before[axis] - previous[axis]) / beforeLength, 8);
        if (beforeLength <= 12) expect(afterLength).toBeCloseTo(beforeLength, 8);
      }
    }
  });

  it('rejects a segment slide that removes required equipment approach or fitting space', () => {
    const source = pipe('connected', [point(0, 0), point(1000, 0), point(1000, 1000), point(2000, 1000)]);
    source.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: 'unit', portPoint: { x: 0, y: 0 }, elevationMm: 2400, direction: { x: 1, y: 0 } };
    const snapshot = structuredClone(source);
    const result = buildPipeModelEdit({ elements: [source], elementId: source.id, selection: { kind: 'segment', index: 1 }, frame: world,
      operation: { kind: 'translate', offset: point(-900, 0, 0) } });
    expect(result.ok).toBe(false);
    expect(source).toEqual(snapshot);
  });

  it('guards legacy plan replacements against locks, collapsed segments and lost endpoint orientation', () => {
    const source = pipe('legacy', [point(0, 0), point(1000, 0), point(1000, 1000)]);
    const next = structuredClone(source);
    source.properties.routeLocked = true;
    expect(validatePipeModelReplacement(source, next, [source])).toContain('locked');
    source.properties.routeLocked = false;
    next.properties.routeNodes3d = [point(0, 0), point(0, 0), point(1000, 1000)];
    expect(validatePipeModelReplacement(source, next, [source])).toContain('zero-length');
    source.properties.startConnection = { connectionKind: 'field-pipe', sourceElementId: 'fixed', portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2400 };
    next.properties.routeNodes3d = [point(0, 0), point(1000, 200), point(1000, 1000)];
    expect(validatePipeModelReplacement(source, next, [source])).toContain('direction');
  });
});
