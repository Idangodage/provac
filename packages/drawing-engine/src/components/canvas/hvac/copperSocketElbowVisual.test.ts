import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElement, buildRefrigerantPipeElements, buildRefrigerantPipePairElement,
  buildRefrigerantPipePairVisual, buildRefrigerantPipeVisual, getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
} from './refrigerantPipePairModel';

const route = [{ x: 0, y: 0 }, { x: 1400, y: 0 }, { x: 1400, y: 1700 }];
function compile(points: Point2D[], diameter: number) {
  return compileCopperSocketElbowRoute(points.map(point => ({ ...point, z: 0 })), diameter);
}
function cassette(rotation = 0): HvacElement {
  return { id: 'cassette-socket', type: 'ceiling-cassette-ac', position: { x: 500, y: 500 },
    width: 600, depth: 600, height: 250, elevation: 2200, rotation, mountType: 'ceiling', label: 'Cassette',
    supplyZoneRatio: 0, properties: {} };
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('authoritative C x C fitting plan geometry', () => {
  it('uses actual catalogue geometry while retaining each authored material owner', () => {
    const pipe = buildRefrigerantPipeElement(route, { lineKind: 'gas', pipeDiameterMm: 15.875,
      outerDiameterMm: 70, segmentMaterials: ['hard', 'flexible'], bendRadiusFactor: 3 });
    const snapshot = structuredClone(pipe);
    const visual = buildRefrigerantPipeVisual(pipe as HvacElement);
    const compiled = compile(visual.continuousOuterPoints, 15.875);
    expect(compiled.fittings).toHaveLength(1);
    expect(compiled.fittings[0]!.spec.centerlineRadiusMm).toBe(27);
    expect([...new Set(visual.segmentVisuals.map(segment => segment.index))]).toEqual([0, 1]);
    expect(visual.segmentVisuals.map(segment => segment.material)).toEqual(['hard', 'flexible']);
    const owned = visual.segmentVisuals.flatMap((segment, index) => index ? segment.points.slice(1) : segment.points);
    expect(owned).toEqual(visual.outerPoints);
    expect(visual.outerPoints[0]).toEqual(route[0]); expect(visual.outerPoints.at(-1)).toEqual(route.at(-1));
    expect(pipe).toEqual(snapshot);
  });

  it.each([0, 90, 180, 270])('keeps exact cassette sockets and one real field elbow per service at rotation %i', rotation => {
    const unit = cassette(rotation); const socket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    const normal = { x: -socket.direction.y, y: socket.direction.x };
    const corner = { x: socket.point.x + socket.direction.x * 700, y: socket.point.y + socket.direction.y * 700 };
    const pipes = buildRefrigerantPipeElements([socket.point, corner,
      { x: corner.x + normal.x * 2000, y: corner.y + normal.y * 2000 }], { startBundleConnection: socket, bendRadiusFactor: 1 });
    for (const pipe of pipes) {
      const snapshot = structuredClone(pipe);
      const gas = pipe.properties!.lineKind === 'gas'; const port = gas ? socket.gasPoint : socket.liquidPoint;
      const visual = buildRefrigerantPipeVisual(pipe as HvacElement);
      const resolved = compile(visual.continuousOuterPoints, visual.pipeDiameterMm);
      expect(resolved.issues).toEqual([]); expect(resolved.fittings).toHaveLength(1);
      expect(resolved.fittings[0]!.spec.angleDeg).toBe(90);
      expect(resolved.fittings[0]!.spec.centerlineRadiusMm).toBe(gas ? 27 : 7);
      expect(visual.continuousOuterPoints[0]).toEqual(port);
      expect(visual.continuousOuterPoints.at(-1)).toEqual((pipe.properties!.routePoints as Point2D[]).at(-1));
      for (let index = 1; index < visual.continuousOuterPoints.length; index += 1) {
        const a = visual.continuousOuterPoints[index - 1]!; const b = visual.continuousOuterPoints[index]!;
        expect((b.x - a.x) * socket.direction.x + (b.y - a.y) * socket.direction.y).toBeGreaterThanOrEqual(-1e-5);
      }
      expect(pipe).toEqual(snapshot);
    }
  });

  it.each(['single', 'pair'] as const)('retains a verified minimum on a saved %s after active settings change', kind => {
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumFieldBendRadiusMm: 150 });
    const built = kind === 'single'
      ? buildRefrigerantPipeElement(route, { lineKind: 'gas', pipeDiameterMm: 15.875, outerDiameterMm: 70, bendRadiusFactor: 3 })
      : buildRefrigerantPipePairElement(route, { bendRadiusFactor: 3 });
    expect(built.properties!.minimumFieldBendRadiusMm).toBe(150);
    const getPoints = () => kind === 'single' ? [buildRefrigerantPipeVisual(built as HvacElement).continuousOuterPoints]
      : (() => { const v = buildRefrigerantPipePairVisual(built as HvacElement); return [v.gasOuterPoints, v.liquidOuterPoints]; })();
    const before = getPoints();
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    expect(getPoints()).toEqual(before);
    // The unrestricted compiler could use the small catalogue part here;
    // the saved verified constraint deliberately retains the full-radius tube.
    expect(compile(before[0]!, 15.875).fittings).toHaveLength(1);
    expect(compileCopperSocketElbowRoute(before[0]!.map(point => ({ ...point, z: 0 })), 15.875,
      { minimumBendRadiusMm: 150 }).fittings).toHaveLength(0);
  });

  it('preserves the stronger saved radius requirement during coordinated equipment reflow', () => {
    const unit = cassette(); const socket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumFieldBendRadiusMm: 150 });
    const pipes = buildRefrigerantPipeElements([socket.point, { x: socket.point.x + 1800, y: socket.point.y },
      { x: socket.point.x + 1800, y: socket.point.y + 2000 }],
    { startBundleConnection: socket, bundleId: 'saved-radius-bundle', bendRadiusFactor: 3 })
      .map((pipe, index) => ({ ...pipe, id: `saved-radius-${index}` } as HvacElement));
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumFieldBendRadiusMm: 30 });
    const moved = { ...unit, position: { ...unit.position, x: unit.position.x + 200 } };
    const updates = resolveRefrigerantPipeUnitPortReconnectionUpdates([unit, ...pipes], moved);
    expect(updates).toHaveLength(2);
    expect(updates.map(update => update.updates.properties!.minimumFieldBendRadiusMm)).toEqual([150, 150]);
  });
});
