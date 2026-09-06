import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { buildPipePlanTubes } from './pipePlanPresentation';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipeVisual } from './refrigerantPipePairModel';

function unitPipe(leg: number, terminal: 'start' | 'end'): HvacElement {
  const route = [{ x: 0, y: 0 }, { x: leg, y: 0 }, { x: leg, y: 1000 }];
  return { id: 'protected-unit-straight', type: 'refrigerant-pipe', position: { x: 0, y: 0 },
    width: 1000, depth: 1000, height: 70, elevation: 2400, rotation: 0, mountType: 'ceiling',
    label: 'Gas pipe', supplyZoneRatio: 0,
    properties: { routePoints: terminal === 'start' ? route : [...route].reverse(), lineKind: 'gas',
      pipeDiameterMm: 15.875, outerDiameterMm: 70, segmentMaterials: ['flexible', 'flexible'],
      [`${terminal}Connection`]: { connectionKind: 'unit-port', portPoint: route[0],
        direction: { x: 1, y: 0 }, elevationMm: 2435 } } };
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('plan fitting terminal protection', () => {
  it.each(['start', 'end'] as const)('does not reinsert a rejected elbow inside the protected unit %s straight', terminal => {
    const pipe = unitPipe(225, terminal); const snapshot = structuredClone(pipe);
    const visual = buildRefrigerantPipeVisual(pipe);
    const plan = buildPipePlanTubes(pipe)[0]!;
    // The real 38 mm takeoff would leave only 187 mm of the required
    // 200 mm equipment straight. Rendering cannot relax the model's budget.
    expect(plan.fittings ?? []).toHaveLength(0);
    expect(visual.invalidHardSegmentCount).toBe(2);
    expect(plan.unresolvedSegments).toHaveLength(2);
    expect(plan.points).toEqual(visual.continuousOuterPoints);
    expect(plan.points).toEqual(pipe.properties.routePoints);
    expect(pipe).toEqual(snapshot);
  });

  it.each(['start', 'end'] as const)('still proposes the catalogue elbow when its unit %s straight actually fits', terminal => {
    const pipe = unitPipe(240, terminal);
    const visual = buildRefrigerantPipeVisual(pipe);
    const plan = buildPipePlanTubes(pipe)[0]!;
    expect(plan.fittings).toHaveLength(1);
    expect(visual.invalidHardSegmentCount).toBe(0);
    expect(plan.unresolvedSegments ?? []).toHaveLength(0);
    const fitting = plan.fittings![0]!;
    expect(fitting.spec.centerToFaceMm).toBe(38);
    const face = terminal === 'start' ? fitting.startFace : fitting.endFace;
    expect(face.x).toBeCloseTo(202, 6); expect(face.y).toBeCloseTo(0, 6);
    expect(plan.points[0]).toMatchObject((pipe.properties.routePoints as Array<{ x: number; y: number }>)[0]!);
    expect(plan.points.at(-1)).toMatchObject((pipe.properties.routePoints as Array<{ x: number; y: number }>).at(-1)!);
  });

  it('keeps a separate direction reversal unresolved after the near-unit elbow is resolved', () => {
    const pipe = unitPipe(240, 'start');
    pipe.properties.routePoints = [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 1000 },
      { x: 240, y: 500 }, { x: 1000, y: 500 }];
    pipe.properties.segmentMaterials = ['flexible', 'flexible', 'flexible', 'flexible'];
    const visual = buildRefrigerantPipeVisual(pipe);
    const plan = buildPipePlanTubes(pipe)[0]!;
    expect(plan.fittings!.some(fitting => Math.hypot(fitting.corner.x - 240, fitting.corner.y) < 1e-5)).toBe(true);
    expect(visual.segmentVisuals.find(segment => segment.index === 0)!.invalidHardGeometry).toBe(false);
    expect(visual.segmentVisuals.filter(segment => segment.index === 1 || segment.index === 2)
      .every(segment => segment.invalidHardGeometry)).toBe(true);
    expect(plan.unresolvedSegments!.length).toBeGreaterThan(0);
  });

  it('keeps other unfittable neighbouring elbows unresolved when one factory elbow succeeds', () => {
    const pipe = unitPipe(240, 'start');
    pipe.properties.routePoints = [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 1000 },
      { x: 260, y: 1000 }, { x: 260, y: 1500 }];
    pipe.properties.segmentMaterials = ['flexible', 'flexible', 'flexible', 'flexible'];
    const visual = buildRefrigerantPipeVisual(pipe);
    const plan = buildPipePlanTubes(pipe)[0]!;
    expect(plan.fittings).toHaveLength(1);
    expect(visual.segmentVisuals.find(segment => segment.index === 0)!.invalidHardGeometry).toBe(false);
    expect(visual.segmentVisuals.filter(segment => segment.index > 0).every(segment => segment.invalidHardGeometry)).toBe(true);
    expect(plan.unresolvedSegments).toHaveLength(3);
  });

  it('does not clear a failed approach when the factory elbow fails its saved minimum radius constraint', () => {
    const pipe = unitPipe(240, 'start');
    pipe.properties.minimumFieldBendRadiusMm = 50;
    const visual = buildRefrigerantPipeVisual(pipe);
    const plan = buildPipePlanTubes(pipe)[0]!;
    expect(plan.fittings ?? []).toHaveLength(0);
    expect(visual.invalidHardSegmentCount).toBe(2);
    expect(plan.unresolvedSegments).toHaveLength(2);
  });
});
