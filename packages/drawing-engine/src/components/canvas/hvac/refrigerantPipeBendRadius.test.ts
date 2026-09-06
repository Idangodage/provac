import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipePairElement,
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
  getRefrigerantPipeBundleSnapTargets,
  getUnitPortApproachStraightMm,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';

const route = [{ x: 0, y: 0 }, { x: 2400, y: 0 }, { x: 2400, y: 2200 }];

function measuredCircularRadii(points: Point2D[]): number[] {
  const radii: number[] = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1]!; const b = points[index]!; const c = points[index + 1]!;
    const ab = Math.hypot(b.x - a.x, b.y - a.y); const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ac = Math.hypot(c.x - a.x, c.y - a.y);
    const cross = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (ab < 1e-6 || bc < 1e-6 || cross < 1e-6 || Math.max(ab, bc) / Math.min(ab, bc) > 1.05) continue;
    radii.push(ab * bc * ac / (2 * cross));
  }
  return radii;
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('persisted engineering bend radius', () => {
  it('reserves actual socket stagger and exact offset bends without counting the next elbow twice', () => {
    const socket: RefrigerantPipeBundleConnection = {
      point: { x: 0, y: 0 }, gasPoint: { x: 10, y: -20 }, liquidPoint: { x: -10, y: 20 },
      gasFieldPoint: { x: 10, y: -20 }, liquidFieldPoint: { x: -10, y: 20 },
      direction: { x: 1, y: 0 }, elevationMm: 2600, gasElevationMm: 2600, liquidElevationMm: 2600,
      connectionKind: 'unit-port', sourceElementId: 'unit',
    };
    // Each lane moves laterally 40 mm. Two 100 mm-radius arcs need 120 mm
    // of axial travel (a 3-4-5 triangle), plus the gas socket's 10 mm stagger
    // and its 200 mm protected straight. The later field elbow is separate.
    expect(getUnitPortApproachStraightMm(socket, 120, 100, 200)).toBeCloseTo(330, 8);
    // Already matching socket spacing only needs its straight and stagger.
    expect(getUnitPortApproachStraightMm(socket, 40, 100, 200)).toBeCloseTo(210, 8);
  });

  it('fits the actual cassette gather at its derived minimum departure without shrinking the adjacent elbow', () => {
    const unit = { id: 'cassette-minimum', type: 'ceiling-cassette-ac', category: 'indoor-unit',
      position: { x: 500, y: 500 }, rotation: 0, width: 600, depth: 600, height: 250,
      elevation: 2200, mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: {} } as HvacElement;
    const socket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
    const radius = 66.675;
    const spacing = 88.9;
    const firstLeg = getUnitPortApproachStraightMm(socket, spacing, radius, 200) + radius + spacing / 2;
    expect(firstLeg).toBeGreaterThan(390);
    expect(firstLeg).toBeLessThan(400);
    const corner = { x: socket.point.x + firstLeg, y: socket.point.y };
    const pair = buildRefrigerantPipeElements([socket.point, corner, { x: corner.x, y: corner.y + 2000 }],
      { startBundleConnection: socket, bendRadiusFactor: 1 });
    for (const pipe of pair) {
      const points = pipe.properties!.routePoints as Point2D[];
      expect(Math.min(...measuredCircularRadii(points))).toBeGreaterThanOrEqual(radius - 1e-4);
      const headings = points.slice(1).map((point, index) => Math.atan2(point.y - points[index]!.y, point.x - points[index]!.x));
      for (let index = 1; index < headings.length; index += 1) {
        expect(Math.abs(headings[index]! - headings[index - 1]!) * 180 / Math.PI).toBeLessThanOrEqual(4);
      }
    }
  });

  it.each([0, 90, 180, 270].flatMap(rotation => [400, 700].flatMap(departure => [-1, 1].map(side => ({ rotation, departure, side })))))
    ('keeps the real cassette neck tangent and free of micro-loops: %j', ({ rotation, departure, side }) => {
      const unit = { id: 'cassette', type: 'ceiling-cassette-ac', category: 'indoor-unit',
        position: { x: 500, y: 500 }, rotation, width: 600, depth: 600, height: 250,
        elevation: 2200, mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: {} } as HvacElement;
      const socket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
      const normal = { x: -socket.direction.y, y: socket.direction.x };
      const corner = { x: socket.point.x + socket.direction.x * departure, y: socket.point.y + socket.direction.y * departure };
      const pair = buildRefrigerantPipeElements([socket.point, corner,
        { x: corner.x + normal.x * side * 2000, y: corner.y + normal.y * side * 2000 }],
      { startBundleConnection: socket, bendRadiusFactor: 1 });
      expect(pair).toHaveLength(2);
      const radius = Math.max(...pair.map(element => Number(element.properties!.outerDiameterMm)));
      for (const pipe of pair) {
        const points = pipe.properties!.routePoints as Point2D[];
        const port = pipe.properties!.lineKind === 'gas' ? socket.gasPoint : socket.liquidPoint;
        expect(points[0]).toEqual(port);
        const directions: Point2D[] = [];
        for (let index = 1; index < points.length; index += 1) {
          const delta = { x: points[index]!.x - points[index - 1]!.x, y: points[index]!.y - points[index - 1]!.y };
          // Even where the gather turns against the final elbow, progress away
          // from the unit never reverses. The old stitched liquid neck did so
          // nineteen times while making a visible ~3 mm-radius bulge.
          expect(delta.x * socket.direction.x + delta.y * socket.direction.y).toBeGreaterThanOrEqual(-1e-6);
          const length = Math.hypot(delta.x, delta.y);
          if (length > 1e-6) directions.push({ x: delta.x / length, y: delta.y / length });
        }
        for (let index = 1; index < directions.length; index += 1) {
          const dot = directions[index - 1]!.x * directions[index]!.x + directions[index - 1]!.y * directions[index]!.y;
          expect(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toBeLessThanOrEqual(4);
        }
        const radii = measuredCircularRadii(points);
        expect(radii.length).toBeGreaterThan(12);
        expect(Math.min(...radii)).toBeGreaterThanOrEqual(radius - 1e-4);
      }
    });

  it('uses tangent full-radius gathers at both unit sockets after reserving their straight stubs', () => {
    const connection = (x: number, y: number, dx: number): RefrigerantPipeBundleConnection => ({
      point: { x, y: y + 20 }, gasPoint: { x, y }, liquidPoint: { x, y: y + 40 },
      gasFieldPoint: { x, y }, liquidFieldPoint: { x, y: y + 40 },
      direction: { x: dx, y: 0 }, elevationMm: 2600, gasElevationMm: 2600, liquidElevationMm: 2600,
      connectionKind: 'unit-port', sourceElementId: `unit-${x}`,
    });
    const start = connection(0, 0, 1); const end = connection(3000, 2500, -1);
    const built = buildRefrigerantPipeElements([start.point, { x: 1500, y: 20 }, { x: 1500, y: 2520 }, end.point],
      { startBundleConnection: start, endBundleConnection: end, bendRadiusFactor: 3 });
    const radius = Math.max(...built.map(element => Number(element.properties!.outerDiameterMm))) * 3;
    for (const element of built) {
      const points = element.properties!.routePoints as Point2D[];
      const gas = element.properties!.lineKind === 'gas';
      expect(points[0]).toEqual(gas ? start.gasPoint : start.liquidPoint);
      expect(points.at(-1)).toEqual(gas ? end.gasPoint : end.liquidPoint);
      for (const terminalRoute of [points, [...points].reverse()]) {
        const port = terminalRoute[0]!; const stub = terminalRoute[1]!;
        expect(Math.abs(stub.x - port.x)).toBeCloseTo(DEFAULT_PIPE_ROUTING_SETTINGS.minimumPortStubMm, 5);
        expect(stub.y).toBeCloseTo(port.y, 5);
        const neck = terminalRoute.filter(point => Math.abs(point.x - port.x) < 1000);
        const measured = measuredCircularRadii(neck);
        expect(measured.length).toBeGreaterThan(8);
        expect(Math.min(...measured)).toBeGreaterThanOrEqual(radius - 1e-4);
      }
    }
  });

  it('builds both actual paired fillets at or above the explicit insulated-diameter multiple', () => {
    const built = buildRefrigerantPipeElements(route, { bendRadiusFactor: 3 });
    expect(built).toHaveLength(2);
    const minimum = Math.max(...built.map(element => element.properties!.outerDiameterMm as number)) * 3;
    for (const element of built) {
      expect(element.properties!.bendRadiusFactor).toBe(3);
      const radii = measuredCircularRadii(element.properties!.routePoints as Point2D[]);
      expect(radii.length).toBeGreaterThan(8);
      expect(Math.min(...radii)).toBeGreaterThanOrEqual(minimum - 1e-5);
      const before = buildRefrigerantPipeVisual(element as HvacElement).continuousOuterPoints;
      setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 0.2 });
      expect(buildRefrigerantPipeVisual(element as HvacElement).continuousOuterPoints).toEqual(before);
    }
  });

  it('uses the persisted radius when an older pair element regenerates its planar geometry', () => {
    const element = buildRefrigerantPipePairElement(route, { bendRadiusFactor: 2.5 });
    element.properties!.fieldBendConstruction = 'formed-tube';
    expect(element.properties!.bendRadiusFactor).toBe(2.5);
    const first = buildRefrigerantPipePairVisual(element as HvacElement);
    const minimum = Math.max(first.gasOuterDiameterMm, first.liquidOuterDiameterMm) * 2.5;
    for (const points of [first.gasOuterPoints, first.liquidOuterPoints]) {
      expect(Math.min(...measuredCircularRadii(points))).toBeGreaterThanOrEqual(minimum - 1e-5);
    }
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 5 });
    const next = buildRefrigerantPipePairVisual(element as HvacElement);
    expect(next.gasOuterPoints).toEqual(first.gasOuterPoints);
    expect(next.liquidOuterPoints).toEqual(first.liquidOuterPoints);
  });

  it('preserves existing manual paired geometry when no explicit radius is supplied', () => {
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    const original = buildRefrigerantPipeElements(route);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 5 });
    const rebuilt = buildRefrigerantPipeElements(route);
    expect(rebuilt).toEqual(original);
    expect(rebuilt.every(element => element.properties!.bendRadiusFactor === undefined)).toBe(true);
  });
});
