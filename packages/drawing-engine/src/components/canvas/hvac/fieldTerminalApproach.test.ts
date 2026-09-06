import { afterEach, describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipeElements, type RefrigerantPipeBundleConnection } from './refrigerantPipePairModel';

const start: RefrigerantPipeBundleConnection = {
  point: { x: 1111.283962, y: 648 },
  gasPoint: { x: 1116.607924, y: 627 }, liquidPoint: { x: 1105.96, y: 669 },
  gasFieldPoint: { x: 1116.607924, y: 627 }, liquidFieldPoint: { x: 1105.96, y: 669 },
  direction: { x: 1, y: 0 }, gasDirection: { x: 1, y: 0 }, liquidDirection: { x: 1, y: 0 },
  elevationMm: 2402.18, gasElevationMm: 2413.88, liquidElevationMm: 2390.48,
  connectionKind: 'unit-port', sourceElementId: 'indoor',
};
const end: RefrigerantPipeBundleConnection = {
  point: { x: 1197, y: 2009.5 },
  gasPoint: { x: 1179, y: 2050.45 }, liquidPoint: { x: 1215, y: 1968.55 },
  gasFieldPoint: { x: 1179, y: 2050.45 }, liquidFieldPoint: { x: 1215, y: 1968.55 },
  direction: { x: -1, y: 0 }, gasDirection: { x: -1, y: 0 }, liquidDirection: { x: -1, y: 0 },
  elevationMm: 2938.25, gasElevationMm: 3007.5, liquidElevationMm: 2869,
  connectionKind: 'field-pipe', sourceElementId: 'gas-kit', liquidSourceElementId: 'liquid-kit', terminalRole: 'branch-outlet',
};
const route = [start.point, { x: 1811.283962, y: 648 }, { x: 1811.283962, y: 1400 },
  { x: 1811.283962, y: 1550 }, { x: 897, y: 1550 }, { x: 897, y: 2009.5 }, end.point];

function rotate(point: Point2D, angle: number): Point2D {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: cos * point.x - sin * point.y, y: sin * point.x + cos * point.y };
}
function rotateBundle(bundle: RefrigerantPipeBundleConnection, angle: number): RefrigerantPipeBundleConnection {
  return { ...bundle,
    point: rotate(bundle.point, angle), gasPoint: rotate(bundle.gasPoint, angle), liquidPoint: rotate(bundle.liquidPoint, angle),
    gasFieldPoint: rotate(bundle.gasFieldPoint, angle), liquidFieldPoint: rotate(bundle.liquidFieldPoint, angle),
    direction: rotate(bundle.direction, angle), gasDirection: rotate(bundle.gasDirection!, angle), liquidDirection: rotate(bundle.liquidDirection!, angle),
  };
}

describe('field fitting approaches with reversed gas/liquid outlet order', () => {
  afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('aligns the complete final elbow at orientation %s', (angle) => {
    const elements = buildRefrigerantPipeElements(route.map(point => rotate(point, angle)), {
      startBundleConnection: rotateBundle(start, angle), endBundleConnection: rotateBundle(end, angle),
    });
    for (const element of elements) {
      const service = element.properties!.lineKind === 'gas' ? 'gas' : 'liquid';
      const socket = service === 'gas' ? end.gasFieldPoint : end.liquidFieldPoint;
      const points = (element.properties!.routePoints as Point2D[]).map(point => rotate(point, -angle));
      expect(points.at(-1)!.x).toBeCloseTo(socket.x, 6);
      expect(points.at(-1)!.y).toBeCloseTo(socket.y, 6);
      // The old final-vertex-only correction left the liquid elbow up on its
      // own trunk at y=2055.55, even though the actual socket is y=1968.55.
      expect(Math.max(...points.map(point => point.y))).toBeLessThanOrEqual(socket.y + 0.01);
      let straightMm = 0;
      for (let index = points.length - 2; index >= 0; index -= 1) {
        const point = points[index]!;
        if (Math.abs(point.y - socket.y) > 0.01) break;
        expect(point.x).toBeLessThanOrEqual(socket.x + 0.01);
        straightMm = Math.max(straightMm, socket.x - point.x);
      }
      expect(straightMm).toBeGreaterThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.defaultBranchKitClearanceMm - 0.1);
      expect(element.properties!.bypasses).toBeUndefined();
    }
  });

  it.each([false, true])('preserves a valid branch approach with a longer unit straight (intermediate waypoint: %s)', (intermediateWaypoint) => {
    setActivePipeRoutingSettings({ minimumPortStubMm: 1000, defaultBranchKitClearanceMm: 300 });
    const from: RefrigerantPipeBundleConnection = {
      ...start,
      point: { x: 0, y: 0 },
      gasPoint: { x: 0, y: -40 }, gasFieldPoint: { x: 0, y: -40 },
      liquidPoint: { x: 0, y: 40 }, liquidFieldPoint: { x: 0, y: 40 },
    };
    const to: RefrigerantPipeBundleConnection = {
      ...end,
      point: { x: 2000, y: 1000 },
      gasPoint: { x: 2000, y: 960 }, gasFieldPoint: { x: 2000, y: 960 },
      liquidPoint: { x: 2000, y: 1040 }, liquidFieldPoint: { x: 2000, y: 1040 },
    };
    const guide = [from.point, { x: 1600, y: 0 }, { x: 1600, y: 1000 },
      ...(intermediateWaypoint ? [{ x: 1850, y: 1000 }] : []), to.point];
    const elements = buildRefrigerantPipeElements(guide, {
      startBundleConnection: from, endBundleConnection: to,
    });
    expect(elements).toHaveLength(2);
    for (const element of elements) {
      const points = element.properties!.routePoints as Point2D[];
      const socket = element.properties!.lineKind === 'gas' ? to.gasFieldPoint : to.liquidFieldPoint;
      expect(points.at(-1)).toEqual(socket);
      const finalTurn = points.filter(point => point.y >= 800);
      expect(finalTurn.length).toBeGreaterThan(2);
      for (let index = 1; index < finalTurn.length; index += 1) {
        expect(finalTurn[index]!.x).toBeGreaterThanOrEqual(finalTurn[index - 1]!.x - 0.01);
      }
      const straight = [...points].reverse().find(point => Math.abs(point.y - socket.y) > 0.01);
      expect(straight).toBeDefined();
      expect(socket.x - straight!.x).toBeGreaterThanOrEqual(300);
    }
  });
});
