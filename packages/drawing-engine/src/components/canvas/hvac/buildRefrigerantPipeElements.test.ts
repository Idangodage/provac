import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import {
  buildRefrigerantPipeElements,
  constrainRefrigerantPipeRouteForConnections,
  seedRefrigerantPipeRouteStart,
  translateRefrigerantPipeProperties,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';

const p = (x: number, y: number): Point2D => ({ x, y });
const route = [p(0, 0), p(1000, 0), p(1000, 800)];

const lineKindOf = (element: { properties?: Record<string, unknown> }): unknown =>
  (element.properties ?? {}).lineKind;

describe('buildRefrigerantPipeElements — line mode', () => {
  it('defaults to a coordinated gas + liquid pair', () => {
    const elements = buildRefrigerantPipeElements(route);
    expect(elements).toHaveLength(2);
    expect(elements.map(lineKindOf).sort()).toEqual(['gas', 'liquid']);
  });

  it('draws a single gas line centered on the drawn route', () => {
    const elements = buildRefrigerantPipeElements(route, { lineMode: 'gas' });
    expect(elements).toHaveLength(1);
    const gas = elements[0]!;
    expect(gas.type).toBe('refrigerant-pipe');
    expect(lineKindOf(gas)).toBe('gas');
    // The lone line's centerline is the drawn route itself — no lateral offset.
    const routePoints = (gas.properties?.routePoints ?? []) as Point2D[];
    expect(routePoints).toEqual(route);
  });

  it('draws a single liquid line centered on the drawn route', () => {
    const elements = buildRefrigerantPipeElements(route, { lineMode: 'liquid' });
    expect(elements).toHaveLength(1);
    const liquid = elements[0]!;
    expect(lineKindOf(liquid)).toBe('liquid');
    const routePoints = (liquid.properties?.routePoints ?? []) as Point2D[];
    expect(routePoints).toEqual(route);
  });
});

const unitPortBundle: RefrigerantPipeBundleConnection = {
  point: p(0, 20),
  gasPoint: p(0, 0),
  liquidPoint: p(0, 40),
  gasFieldPoint: p(0, 0),
  liquidFieldPoint: p(0, 40),
  gasDirection: p(1, 0),
  liquidDirection: p(1, 0),
  direction: p(1, 0),
  elevationMm: 2600,
  gasElevationMm: 2600,
  liquidElevationMm: 2600,
  connectionKind: 'unit-port',
  sourceElementId: 'indoor-1',
};

describe('unit-port mandatory straight stub', () => {
  it('seeds the live route 200 mm along the unit port normal', () => {
    expect(
      seedRefrigerantPipeRouteStart(
        { x: 0, y: 20, z: 2600 },
        unitPortBundle,
        'pair',
        200,
      ),
    ).toEqual([
      { x: 0, y: 20, z: 2600 },
      { x: 200, y: 20, z: 2600 },
    ]);
  });

  it('keeps branch-kit/field-pipe starts as a single topological port seed', () => {
    const fieldBundle: RefrigerantPipeBundleConnection = {
      ...unitPortBundle,
      connectionKind: 'field-pipe',
      terminalRole: 'branch-outlet',
      sourceElementId: 'branch-kit-1',
    };
    const start = { x: 10, y: 20, z: 2600 };
    expect(seedRefrigerantPipeRouteStart(start, fieldBundle, 'pair', 200)).toEqual([start]);
  });

  it('persists a rigid first segment of at least 200 mm on both pair lines', () => {
    const elements = buildRefrigerantPipeElements(
      [p(0, 20), p(40, 300), p(800, 300)],
      {
        startBundleConnection: unitPortBundle,
        segmentMaterialMode: 'flexible',
      },
    );

    expect(elements).toHaveLength(2);
    for (const element of elements) {
      const properties = element.properties as Record<string, unknown>;
      const points = properties.routePoints as Point2D[];
      const first = points[0]!;
      const second = points[1]!;
      expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThanOrEqual(199.9);
      expect(second.x - first.x).toBeGreaterThan(0);
      expect(Math.abs(second.y - first.y)).toBeLessThan(0.001);
      expect((properties.segmentMaterials as string[])[0]).toBe('hard');
    }
  });

  it('keeps a connected port pinned when the run is nudged', () => {
    const element = buildRefrigerantPipeElements(
      [p(0, 20), p(400, 20), p(800, 20)],
      { startBundleConnection: unitPortBundle, lineMode: 'gas' },
    )[0]!;
    const properties = translateRefrigerantPipeProperties(
      element.properties!,
      { x: 0, y: 100 },
    );
    const points = properties.routePoints as Point2D[];
    expect(points[0]).toEqual(unitPortBundle.gasPoint);
    expect(points[1]).toEqual({ x: 200, y: 0 });
    expect(properties.startConnection).toMatchObject({
      sourceElementId: 'indoor-1',
      connectionKind: 'unit-port',
    });
  });

  it('re-applies the port-normal stub after a pinned endpoint edit', () => {
    const element = buildRefrigerantPipeElements(
      [p(0, 20), p(400, 20), p(800, 20)],
      { startBundleConnection: unitPortBundle, lineMode: 'gas' },
    )[0]!;

    const constrained = constrainRefrigerantPipeRouteForConnections(
      element.type,
      element.properties ?? {},
      [p(0, 0), p(40, 160), p(800, 160)],
    );

    expect(constrained[0]).toEqual(unitPortBundle.gasPoint);
    expect(constrained[1]).toEqual({ x: 200, y: 0 });
    expect(constrained.at(-1)).toEqual({ x: 800, y: 160 });
  });
});
