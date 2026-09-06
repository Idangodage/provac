import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElement, buildRefrigerantPipeElements, buildRefrigerantPipePhysicalPath,
  buildRefrigerantPipeVisual, getRefrigerantPipeBundleSnapTargets, type RefrigerantPipeVisualSpec,
} from './refrigerantPipePairModel';

const route = [{ x: 0, y: 0 }, { x: 1400, y: 0 }, { x: 1400, y: 1700 }];
function pipe(properties: Record<string, unknown> = {}): HvacElement {
  return { id: 'physical-pipe', type: 'refrigerant-pipe', position: { x: 200, y: 300 },
    width: 1000, depth: 700, height: 70, rotation: 0, elevation: 2200, mountType: 'ceiling',
    label: 'Gas', supplyZoneRatio: 0, properties: { routePoints: route.map(point => ({ ...point })), lineKind: 'gas',
      pipeDiameterMm: 15.875, outerDiameterMm: 70, segmentMaterials: ['hard', 'flexible'], ...properties } };
}
function physicalFields(visual: RefrigerantPipeVisualSpec) {
  const { localOuterPoints: _localOuter, localContinuousOuterPoints: _localContinuous,
    segmentVisuals: _segments, invalidHardSegmentCount: _invalid, ...physical } = visual;
  return physical;
}
function cassette(): HvacElement {
  return { id: 'physical-unit', type: 'ceiling-cassette-ac', position: { x: 500, y: 600 },
    width: 600, depth: 600, height: 250, elevation: 2200, rotation: 0, mountType: 'ceiling',
    label: 'Cassette', supplyZoneRatio: 0, properties: {} };
}
afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('physical pipe path without drawing-only allocations', () => {
  it.each([
    ['factory elbows', {}],
    ['formed tube', { fieldBendConstruction: 'formed-tube' }],
    ['derived paired lane', { authoredCenterlineRoute: route }],
    ['retained verified minimum', { minimumFieldBendRadiusMm: 150, bendRadiusFactor: 3 }],
    ['unresolved short bend', { routePoints: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 400, y: 15 }] }],
    ['empty imported route', { routePoints: [] }],
  ] as const)('matches every physical field of the complete visual for %s', (_, properties) => {
    const element = pipe(properties); const before = structuredClone(element);
    expect(buildRefrigerantPipePhysicalPath(element)).toStrictEqual(physicalFields(buildRefrigerantPipeVisual(element)));
    expect(element).toStrictEqual(before);
  });

  it('keeps saved element bounds identical to the complete visual bounds', () => {
    const built = buildRefrigerantPipeElement(route, { lineKind: 'gas', pipeDiameterMm: 15.875,
      outerDiameterMm: 70, segmentMaterials: ['hard', 'flexible'], bendRadiusFactor: 3 });
    const visual = buildRefrigerantPipeVisual(built as HvacElement);
    expect(built.position).toStrictEqual({ x: visual.bounds.minX, y: visual.bounds.minY });
    expect(built.width).toBe(visual.bounds.width); expect(built.depth).toBe(visual.bounds.height);
    expect(visual.segmentVisuals.map(segment => segment.material)).toEqual(['hard', 'flexible']);
  });

  it('heals both services from live equipment after in-place moves and rotations', () => {
    const unit = cassette(); const socket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    const pipes = buildRefrigerantPipeElements([socket.point,
      { x: socket.point.x + 1200, y: socket.point.y }, { x: socket.point.x + 1200, y: socket.point.y + 1500 }],
    { startBundleConnection: socket, bendRadiusFactor: 1 }).map((built, index) => ({ ...built, id: `pair-${index}` } as HvacElement));
    const scene = [unit, ...pipes];
    const before = pipes.map(element => buildRefrigerantPipePhysicalPath(element, scene));
    unit.position.x += 200; unit.rotation = 90; unit.elevation += 350;
    const liveSocket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    pipes.forEach((element, index) => {
      const current = buildRefrigerantPipePhysicalPath(element, scene);
      expect(current).toStrictEqual(physicalFields(buildRefrigerantPipeVisual(element, scene)));
      expect(current.startConnection).not.toStrictEqual(before[index]!.startConnection);
      expect(current.continuousOuterPoints[0]).toStrictEqual(current.lineKind === 'gas' ? liveSocket.gasPoint : liveSocket.liquidPoint);
    });
  });

  it('owns each result and respects changed properties and active routing settings', () => {
    const element = pipe(); const before = buildRefrigerantPipePhysicalPath(element);
    before.outerPoints[0]!.x += 10000;
    before.bounds.minX = -99999;
    expect(buildRefrigerantPipePhysicalPath(element)).toStrictEqual(physicalFields(buildRefrigerantPipeVisual(element)));
    element.properties.fieldBendConstruction = 'formed-tube';
    element.properties.bendRadiusFactor = 3;
    (element.properties.routePoints as Point2D[])[1] = { x: 1600, y: 0 };
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumPortStubMm: 400, minimumFieldBendRadiusMm: 160 });
    expect(buildRefrigerantPipePhysicalPath(element)).toStrictEqual(physicalFields(buildRefrigerantPipeVisual(element)));
  });
});
