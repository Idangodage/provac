import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipeVisual,
  constrainRefrigerantPipeRouteForConnections,
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeUnitPortReconnectionUpdates,
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

describe('authored pair clearance', () => {
  it('renders the resolved pair bends without spline overshoot at the port takeoff', () => {
    const elements = buildRefrigerantPipeElements(
      [p(0, 20), p(500, 20), p(500, 900)],
      { startBundleConnection: unitPortBundle, pipeGapMm: 60 },
    );
    for (const element of elements) {
      element.properties!.fieldBendConstruction = 'formed-tube';
      const points = element.properties!.routePoints as Point2D[];
      const visual = buildRefrigerantPipeVisual(element as HvacElement);
      // Every rendered point must lie on the persisted lane. Curving already
      // sampled bends again made hooks outside this physical route.
      for (const point of visual.outerPoints) {
        const distance = Math.min(...points.slice(1).map((end, index) => {
          const start = points[index]!;
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
          return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
        }));
        expect(distance).toBeLessThan(0.01);
      }
      expect(visual.outerPoints[0]).toEqual(points[0]);
      expect(visual.outerPoints.at(-1)).toEqual(points.at(-1));
    }
  });

  it('uses the explicit insulated clear gap when building both lanes', () => {
    for (const gap of [0, 25.4, 75, 150]) {
      const [gas, liquid] = buildRefrigerantPipeElements([p(0, 0), p(2000, 0)], { pipeGapMm: gap });
      const gasPoints = gas!.properties!.routePoints as Point2D[];
      const liquidPoints = liquid!.properties!.routePoints as Point2D[];
      const centerSpacing = Math.hypot(
        gasPoints[0]!.x - liquidPoints[0]!.x,
        gasPoints[0]!.y - liquidPoints[0]!.y,
      );
      const outerRadii = (gas!.properties!.outerDiameterMm as number) / 2
        + (liquid!.properties!.outerDiameterMm as number) / 2;
      expect(centerSpacing - outerRadii).toBeCloseTo(gap, 6);
      expect(gas!.properties!.pipeGapMm).toBe(gap);
      expect(liquid!.properties!.pipeGapMm).toBe(gap);
    }
  });

  it('preserves lateral separation after turning away from a branch-kit outlet', () => {
    const fieldBundle: RefrigerantPipeBundleConnection = {
      ...unitPortBundle,
      gasPoint: p(0, -50), liquidPoint: p(0, 50),
      gasFieldPoint: p(0, -50), liquidFieldPoint: p(0, 50), point: p(0, 0),
      connectionKind: 'field-pipe',
      terminalRole: 'branch-outlet',
      sourceElementId: 'branch-kit-1',
    };
    const [gas, liquid] = buildRefrigerantPipeElements(
      [p(0, 0), p(2000, 0), p(2000, 3000)],
      { startBundleConnection: fieldBundle },
    );
    const gasPoints = gas!.properties!.routePoints as Point2D[];
    const liquidPoints = liquid!.properties!.routePoints as Point2D[];
    expect(gasPoints[0]).toEqual(fieldBundle.gasPoint);
    expect(liquidPoints[0]).toEqual(fieldBundle.liquidPoint);
    // Global XY translation made these final legs collinear (zero gap).
    expect(Math.abs(gasPoints.at(-1)!.x - liquidPoints.at(-1)!.x)).toBeCloseTo(100, 6);
    expect(gasPoints.at(-1)!.y).toBeCloseTo(3000, 6);
    expect(liquidPoints.at(-1)!.y).toBeCloseTo(3000, 6);
    expect(gas!.properties!.pairCenterSpacingMm).toBeCloseTo(100, 6);
    const outerRadii = (gas!.properties!.outerDiameterMm as number) / 2
      + (liquid!.properties!.outerDiameterMm as number) / 2;
    expect(gas!.properties!.pipeGapMm).toBeCloseTo(100 - outerRadii, 6);
  });
});

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

describe('unit-port bond geometry', () => {
  const routePointsOf = (element: { properties?: Record<string, unknown> }): Point2D[] =>
    (element.properties?.routePoints ?? []) as Point2D[];

  it('gives BOTH pair lines a straight port-normal stub before any lateral move', () => {
    const [gas, liquid] = buildRefrigerantPipeElements(
      [p(0, 20), p(3000, 20)],
      { startBundleConnection: unitPortBundle },
    );
    for (const element of [gas!, liquid!]) {
      const points = routePointsOf(element);
      expect(points.length).toBeGreaterThanOrEqual(2);
      const startY = points[0]!.y;
      // Every vertex inside the takeoff zone must sit on the port normal:
      // flare joints cannot bend at the equipment casing.
      for (const point of points) {
        if (point.x < 199.5) {
          expect(Math.abs(point.y - startY)).toBeLessThanOrEqual(1);
        }
      }
      expect(points.some((point) => point.x >= 199.5)).toBe(true);
    }
  });

  it('routes an end approach around the unit body instead of through it', () => {
    const endBundle: RefrigerantPipeBundleConnection = {
      point: p(5000, 20),
      gasPoint: p(5000, 0),
      liquidPoint: p(5000, 40),
      gasFieldPoint: p(5000, 0),
      liquidFieldPoint: p(5000, 40),
      gasDirection: p(1, 0),
      liquidDirection: p(1, 0),
      direction: p(1, 0),
      elevationMm: 1300,
      gasElevationMm: 1300,
      liquidElevationMm: 1300,
      connectionKind: 'unit-port',
      sourceElementId: 'odu-1',
      sourceBoundsMm: { minX: 4400, minY: -362, maxX: 5000, maxY: 402 },
    };
    const elements = buildRefrigerantPipeElements(
      [p(0, 20), p(4000, 20), p(5000, 20)],
      { startBundleConnection: unitPortBundle, endBundleConnection: endBundle },
    );

    // Shrink the body by 1mm so port-face terminations on the boundary pass.
    const body = { minX: 4401, minY: -361, maxX: 4999, maxY: 401 };
    const insideBody = (point: Point2D): boolean =>
      point.x > body.minX && point.x < body.maxX
      && point.y > body.minY && point.y < body.maxY;
    for (const element of elements) {
      const points = routePointsOf(element);
      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1]!;
        const to = points[index]!;
        for (let stepIndex = 0; stepIndex <= 20; stepIndex += 1) {
          const t = stepIndex / 20;
          const sample = {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
          };
          expect(insideBody(sample)).toBe(false);
        }
      }
      // The run still terminates at the port face, arriving from outside.
      const last = points[points.length - 1]!;
      expect(Math.abs(last.x - 5000)).toBeLessThanOrEqual(25);
      expect(points[points.length - 2]!.x).toBeGreaterThan(5000);
    }
  });
});

describe('unit-port takeoff with a sharp turn', () => {
  it('keeps the route bounded when the drawn route turns 90deg after the port', () => {
    const elements = buildRefrigerantPipeElements(
      [p(0, 20), p(0, 3000), p(6000, 3000)],
      { startBundleConnection: unitPortBundle },
    );
    for (const element of elements) {
      const points = (element.properties?.routePoints ?? []) as Point2D[];
      // No offset-miter spikes: every vertex stays near the drawn envelope.
      for (const point of points) {
        expect(point.x).toBeGreaterThanOrEqual(-500);
        expect(point.x).toBeLessThanOrEqual(6500);
        expect(point.y).toBeGreaterThanOrEqual(-500);
        expect(point.y).toBeLessThanOrEqual(3500);
      }
      // The straight port stub still leads the route.
      const startY = points[0]!.y;
      for (const point of points) {
        if (point.x < 199.5 && point.y < 500) {
          expect(Math.abs(point.y - startY)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('unit-move reconnection reflow', () => {
  const unit = (id: string, x: number, y: number): HvacElement => ({
    id,
    type: 'outdoor-unit',
    category: 'outdoor-unit',
    position: { x, y },
    rotation: 0,
    width: 1350,
    depth: 764,
    height: 1650,
    elevation: 0,
    mountType: 'floor',
    label: 'ODU',
    supplyZoneRatio: 0.5,
    properties: {},
  } as HvacElement);

  it('rebuilds the takeoff instead of accumulating staircase jogs across moves', () => {
    const source = unit('odu-1', 1000, 1000);
    const target = getRefrigerantPipeBundleSnapTargets([source])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;
    let pipes = buildRefrigerantPipeElements(
      [target.point, { x: target.point.x + 4000, y: target.point.y }, { x: target.point.x + 4000, y: target.point.y + 3000 }],
      { startBundleConnection: target, bundleId: 'b-1' },
    ).map((partial, index) => ({ id: `pipe-${index}`, ...partial })) as HvacElement[];

    const applyMove = (movedTo: { x: number; y: number }): void => {
      const moved = unit('odu-1', movedTo.x, movedTo.y);
      const updates = resolveRefrigerantPipeUnitPortReconnectionUpdates(
        [moved, ...pipes],
        moved,
      );
      pipes = pipes.map((pipe) => {
        const update = updates.find((entry) => entry.id === pipe.id);
        return update ? { ...pipe, ...update.updates, properties: { ...pipe.properties, ...update.updates.properties } } : pipe;
      });
    };

    applyMove({ x: 1300, y: 1450 });
    applyMove({ x: 900, y: 1900 });
    applyMove({ x: 1500, y: 700 });
    const finalTarget = getRefrigerantPipeBundleSnapTargets([unit('odu-1', 1500, 700)])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;

    for (const pipe of pipes) {
      const points = (pipe.properties.routePoints ?? []) as Point2D[];
      // The head must be a clean fresh weld — port, straight 200mm stub, at
      // most one elbow, then the retained main — never a staircase of stale
      // fragments from previous moves.
      const port = pipe.properties.lineKind === 'gas' ? finalTarget.gasPoint : finalTarget.liquidPoint;
      expect(Math.hypot(points[0]!.x - port.x, points[0]!.y - port.y)).toBeLessThanOrEqual(1);
      const legs = points.slice(1).map((point, index) => Math.hypot(
        point.x - points[index]!.x,
        point.y - points[index]!.y,
      ));
      expect(legs[0]!).toBeGreaterThanOrEqual(199);
      // Port, stub, gather, at most one connector — then the main.
      const firstLongLegIndex = legs.findIndex((leg) => leg >= 300);
      expect(firstLongLegIndex).toBeGreaterThanOrEqual(0);
      expect(firstLongLegIndex).toBeLessThanOrEqual(3);
    }
  });

  it('keeps bundle spacing and absorbs an axis-parallel move into the main bend', () => {
    const source = unit('odu-1', 1000, 1000);
    const target = getRefrigerantPipeBundleSnapTargets([source])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;
    let pipes = buildRefrigerantPipeElements(
      [target.point, { x: target.point.x + 5000, y: target.point.y }, { x: target.point.x + 5000, y: target.point.y + 3000 }],
      { startBundleConnection: target, bundleId: 'b-2' },
    ).map((partial, index) => ({ id: `pipe-${index}`, ...partial })) as HvacElement[];

    // Move mostly laterally: the retained main's first (east) leg is parallel
    // to the port normal, so the descent bend must absorb the offset.
    const moved = unit('odu-1', 700, 1600);
    const updates = resolveRefrigerantPipeUnitPortReconnectionUpdates(
      [moved, ...pipes],
      moved,
    );
    expect(updates).toHaveLength(2);
    pipes = pipes.map((pipe) => {
      const update = updates.find((entry) => entry.id === pipe.id);
      return update ? { ...pipe, ...update.updates, properties: { ...pipe.properties, ...update.updates.properties } } : pipe;
    });

    const gas = pipes.find((pipe) => pipe.properties.lineKind === 'gas')!;
    const liquid = pipes.find((pipe) => pipe.properties.lineKind === 'liquid')!;
    const gasPoints = (gas.properties.routePoints ?? []) as Point2D[];
    const liquidPoints = (liquid.properties.routePoints ?? []) as Point2D[];

    // Minimum bends: the run leaves the port straight and reaches the descent
    // with no Z-jog — the first lateral move happens only at the main bend,
    // far from the port (stub + gather region ends well before 1000mm out).
    const startY = gasPoints[0]!.y;
    for (const point of gasPoints) {
      if (point.x < gasPoints[0]!.x + 1000) {
        expect(Math.abs(point.y - startY)).toBeLessThanOrEqual(95);
      }
    }

    // Bundle spacing holds through the run after the gather (sampled mid-run).
    const length = (pts: Point2D[]): number => pts.slice(1).reduce(
      (total, point, index) => total + Math.hypot(point.x - pts[index]!.x, point.y - pts[index]!.y),
      0,
    );
    const pointAt = (pts: Point2D[], fraction: number): Point2D => {
      let remaining = length(pts) * fraction;
      for (let index = 1; index < pts.length; index += 1) {
        const seg = Math.hypot(pts[index]!.x - pts[index - 1]!.x, pts[index]!.y - pts[index - 1]!.y);
        if (remaining <= seg) {
          const t = remaining / seg;
          return {
            x: pts[index - 1]!.x + (pts[index]!.x - pts[index - 1]!.x) * t,
            y: pts[index - 1]!.y + (pts[index]!.y - pts[index - 1]!.y) * t,
          };
        }
        remaining -= seg;
      }
      return pts[pts.length - 1]!;
    };
    const distanceToPolyline = (point: Point2D, pts: Point2D[]): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let index = 1; index < pts.length; index += 1) {
        const a = pts[index - 1]!;
        const b = pts[index]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq <= 1e-12
          ? 0
          : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
        best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
      }
      return best;
    };
    const spacing = (gas.properties.pairCenterSpacingMm ?? 0) as number;
    expect(spacing).toBeGreaterThan(0);
    for (const fraction of [0.4, 0.5, 0.6]) {
      const separation = distanceToPolyline(pointAt(gasPoints, fraction), liquidPoints);
      expect(Math.abs(separation - spacing)).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('unit-move reflow stability', () => {
  const unit = (id: string, x: number, y: number): HvacElement => ({
    id,
    type: 'outdoor-unit',
    category: 'outdoor-unit',
    position: { x, y },
    rotation: 0,
    width: 1350,
    depth: 764,
    height: 1650,
    elevation: 0,
    mountType: 'floor',
    label: 'ODU',
    supplyZoneRatio: 0.5,
    properties: {},
  } as HvacElement);


  it('keeps everything after the main bend fixed and restores the layout on return', () => {
    const source = unit('odu-1', 1000, 1000);
    const target = getRefrigerantPipeBundleSnapTargets([source])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;
    const descentX = target.point.x + 5000;
    let pipes = buildRefrigerantPipeElements(
      [target.point, { x: descentX, y: target.point.y }, { x: descentX, y: target.point.y + 3000 }],
      { startBundleConnection: target, bundleId: 'b-4' },
    ).map((partial, index) => ({ id: `pipe-${index}`, ...partial })) as HvacElement[];
    const baseline = (pipes[0]!.properties.routePoints as Point2D[]).map((point) => ({ ...point }));
    const baselineEnd = baseline[baseline.length - 1]!;

    const applyMove = (movedTo: { x: number; y: number }): void => {
      const moved = unit('odu-1', movedTo.x, movedTo.y);
      const updates = resolveRefrigerantPipeUnitPortReconnectionUpdates(
        [moved, ...pipes],
        moved,
      );
      pipes = pipes.map((pipe) => {
        const update = updates.find((entry) => entry.id === pipe.id);
        return update ? { ...pipe, ...update.updates, properties: { ...pipe.properties, ...update.updates.properties } } : pipe;
      });
      for (const pipe of pipes) {
        const points = (pipe.properties.routePoints ?? []) as Point2D[];
        const end = points[points.length - 1]!;
        // The far endpoint (after the main bend) never moves.
        if (pipe.properties.lineKind === 'gas') {
          expect(Math.hypot(end.x - baselineEnd.x, end.y - baselineEnd.y)).toBeLessThanOrEqual(1);
        }
        // The descent line (the main bend's leg) keeps its position.
        expect(points.some((point) => Math.abs(point.x - descentX) <= 60)).toBe(true);
      }
    };

    applyMove({ x: 1000, y: 200 });
    applyMove({ x: 400, y: 900 });
    // Park the unit right next to the main bend: the takeoff bubble then
    // covers the first authored corner, which must NOT erase the main's leg.
    applyMove({ x: 5900, y: 1000 });
    applyMove({ x: 1000, y: 1000 });

    // Back at the original spot the layout is restored exactly.
    const restored = (pipes.find((pipe) => pipe.properties.lineKind === 'gas')!
      .properties.routePoints as Point2D[]);
    const restoredEnd = restored[restored.length - 1]!;
    expect(Math.hypot(restoredEnd.x - baselineEnd.x, restoredEnd.y - baselineEnd.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(restored[0]!.y - baseline[0]!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(restored[0]!.x - baseline[0]!.x)).toBeLessThanOrEqual(1);
  });

  it('stays bounded and exactly spaced across many moves in varying directions', () => {
    const source = unit('odu-1', 1000, 1000);
    const target = getRefrigerantPipeBundleSnapTargets([source])
      .find((candidate) => candidate.connectionKind === 'unit-port')!;
    let pipes = buildRefrigerantPipeElements(
      [target.point, { x: target.point.x + 5000, y: target.point.y }, { x: target.point.x + 5000, y: target.point.y + 3000 }],
      { startBundleConnection: target, bundleId: 'b-3' },
    ).map((partial, index) => ({ id: `pipe-${index}`, ...partial })) as HvacElement[];

    const moves = [
      { x: 700, y: 1600 }, { x: 1200, y: 400 }, { x: 300, y: 900 }, { x: 1600, y: 1900 },
      { x: 900, y: 2400 }, { x: 1400, y: 1100 }, { x: 500, y: 300 }, { x: 1000, y: 1000 },
    ];
    for (const movedTo of moves) {
      const moved = unit('odu-1', movedTo.x, movedTo.y);
      const updates = resolveRefrigerantPipeUnitPortReconnectionUpdates(
        [moved, ...pipes],
        moved,
      );
      pipes = pipes.map((pipe) => {
        const update = updates.find((entry) => entry.id === pipe.id);
        return update ? { ...pipe, ...update.updates, properties: { ...pipe.properties, ...update.updates.properties } } : pipe;
      });
    }

    const gas = pipes.find((pipe) => pipe.properties.lineKind === 'gas')!;
    const liquid = pipes.find((pipe) => pipe.properties.lineKind === 'liquid')!;
    const gasPoints = (gas.properties.routePoints ?? []) as Point2D[];
    const liquidPoints = (liquid.properties.routePoints ?? []) as Point2D[];
    // Bounded: no feedback divergence spiralling off the drawing.
    for (const point of [...gasPoints, ...liquidPoints]) {
      expect(point.x).toBeGreaterThanOrEqual(-2000);
      expect(point.x).toBeLessThanOrEqual(16000);
      expect(point.y).toBeGreaterThanOrEqual(-2000);
      expect(point.y).toBeLessThanOrEqual(16000);
    }
    expect(gasPoints.length).toBeLessThanOrEqual(80);
    // Exact bundle spacing mid-run.
    const length = (pts: Point2D[]): number => pts.slice(1).reduce(
      (total, point, index) => total + Math.hypot(point.x - pts[index]!.x, point.y - pts[index]!.y),
      0,
    );
    const midpoint = (pts: Point2D[]): Point2D => {
      let remaining = length(pts) / 2;
      for (let index = 1; index < pts.length; index += 1) {
        const seg = Math.hypot(pts[index]!.x - pts[index - 1]!.x, pts[index]!.y - pts[index - 1]!.y);
        if (remaining <= seg) {
          const t = remaining / seg;
          return {
            x: pts[index - 1]!.x + (pts[index]!.x - pts[index - 1]!.x) * t,
            y: pts[index - 1]!.y + (pts[index]!.y - pts[index - 1]!.y) * t,
          };
        }
        remaining -= seg;
      }
      return pts[pts.length - 1]!;
    };
    const mid = midpoint(gasPoints);
    let separation = Number.POSITIVE_INFINITY;
    for (let index = 1; index < liquidPoints.length; index += 1) {
      const a = liquidPoints[index - 1]!;
      const b = liquidPoints[index]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq <= 1e-12
        ? 0
        : Math.max(0, Math.min(1, ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / lengthSq));
      separation = Math.min(separation, Math.hypot(mid.x - (a.x + dx * t), mid.y - (a.y + dy * t)));
    }
    const spacing = (gas.properties.pairCenterSpacingMm ?? 0) as number;
    expect(Math.abs(separation - spacing)).toBeLessThanOrEqual(1.5);
  });
});
