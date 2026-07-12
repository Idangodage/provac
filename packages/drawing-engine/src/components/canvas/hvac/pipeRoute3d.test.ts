import { describe, expect, it } from 'vitest';

import {
  attachPipeRoute3dToElements,
  projectPipeRouteNodes3dForPlanEdit,
  readPipeRouteNodes3d,
  splitPipeRoute3dAtPlanInterval,
  withCanonicalPipeRoute,
} from './pipeRoute3d';
import { buildRefrigerantPipeElements } from './refrigerantPipePairModel';

describe('pipeRoute3d', () => {
  it('stamps preview and commit builders with identical absolute world nodes', () => {
    const makeElement = () => ({
      type: 'refrigerant-pipe' as const,
      position: { x: 0, y: 0 },
      rotation: 0,
      width: 100,
      depth: 10,
      height: 20,
      elevation: 0,
      mountType: 'ceiling' as const,
      label: 'Gas Pipe',
      properties: {
        routePoints: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }],
        outerDiameterMm: 20,
      },
    });
    const route = [{ x: 0, y: 0, z: 200 }, { x: 100, y: 0, z: 500 }];
    const preview = attachPipeRoute3dToElements([makeElement()], route)[0]!;
    const commit = attachPipeRoute3dToElements([makeElement()], route)[0]!;
    expect(readPipeRouteNodes3d(preview as never)).toEqual(readPipeRouteNodes3d(commit as never));
    expect(readPipeRouteNodes3d(preview as never)).toEqual([
      { x: 0, y: 0, z: 200 },
      { x: 100, y: 0, z: 500 },
    ]);
  });

  it('supports a true vertical riser whose plan x/y does not move', () => {
    const element = {
      type: 'refrigerant-pipe' as const,
      position: { x: 10, y: 20 },
      rotation: 0,
      width: 1,
      depth: 1,
      height: 12,
      elevation: 0,
      mountType: 'wall' as const,
      label: 'Riser',
      properties: {
        routePoints: [{ x: 10, y: 20 }, { x: 10, y: 20 }],
        outerDiameterMm: 12,
      },
    };
    const [result] = attachPipeRoute3dToElements(
      [element],
      [{ x: 10, y: 20, z: 100 }, { x: 10, y: 20, z: 800 }],
    );
    expect(readPipeRouteNodes3d(result as never)).toEqual([
      { x: 10, y: 20, z: 100 },
      { x: 10, y: 20, z: 800 },
    ]);
    expect(result?.height).toBe(712);
  });

  it('keeps a degenerate plan projection available for 3D-native rendering', () => {
    const built = buildRefrigerantPipeElements(
      [{ x: 10, y: 20 }, { x: 10, y: 20 }],
      { lineMode: 'gas', elevationMm: 100 },
    );
    expect(built).toHaveLength(1);
    const stamped = attachPipeRoute3dToElements(
      built,
      [{ x: 10, y: 20, z: 100 }, { x: 10, y: 20, z: 800 }],
    );
    expect(readPipeRouteNodes3d(stamped[0] as never)).toEqual([
      { x: 10, y: 20, z: 100 },
      { x: 10, y: 20, z: 800 },
    ]);
  });

  it('keeps gas and liquid risers separated when pair routing is vertical', () => {
    const route = [{ x: 40, y: 60, z: 100 }, { x: 40, y: 60, z: 900 }];
    const stamped = attachPipeRoute3dToElements(
      buildRefrigerantPipeElements(route, { lineMode: 'pair', elevationMm: 100 }),
      route,
    );
    expect(stamped).toHaveLength(2);
    const gas = readPipeRouteNodes3d(stamped[0] as never);
    const liquid = readPipeRouteNodes3d(stamped[1] as never);
    expect(gas).toHaveLength(2);
    expect(liquid).toHaveLength(2);
    expect(Math.hypot(gas[0]!.x - liquid[0]!.x, gas[0]!.y - liquid[0]!.y)).toBeGreaterThan(0);
  });

  it('moves matching 3D nodes with an edited plan vertex while preserving Z', () => {
    const element = {
      properties: {
        routePoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }],
        routeNodes3d: [
          { x: 0, y: 0, z: 200 },
          { x: 100, y: 0, z: 350 },
          { x: 200, y: 0, z: 500 },
        ],
      },
    };
    const updated = withCanonicalPipeRoute(element, [
      { x: 0, y: 0 },
      { x: 120, y: 45 },
      { x: 200, y: 0 },
    ]);
    expect(updated.properties.routePoints).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 45 },
      { x: 200, y: 0 },
    ]);
    expect(updated.properties.routeNodes3d).toEqual([
      { x: 0, y: 0, z: 200 },
      { x: 120, y: 45, z: 350 },
      { x: 200, y: 0, z: 500 },
    ]);
  });

  it('keeps equal-XY vertical-riser nodes distinct after an XY edit', () => {
    const projected = projectPipeRouteNodes3dForPlanEdit(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }],
      [{ x: 0, y: 0 }, { x: 100, y: 40 }, { x: 100, y: 40 }, { x: 200, y: 0 }],
      [
        { x: 0, y: 0, z: 200 },
        { x: 100, y: 0, z: 200 },
        { x: 100, y: 0, z: 900 },
        { x: 200, y: 0, z: 900 },
      ],
    );
    expect(projected).toEqual([
      { x: 0, y: 0, z: 200 },
      { x: 100, y: 40, z: 200 },
      { x: 100, y: 40, z: 900 },
      { x: 200, y: 0, z: 900 },
    ]);
  });

  it('adds an inserted plan vertex with interpolated Z without dropping the authored ends', () => {
    const projected = projectPipeRouteNodes3dForPlanEdit(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }],
      [{ x: 0, y: 0, z: 100 }, { x: 100, y: 0, z: 300 }],
    );
    expect(projected).toEqual([
      { x: 0, y: 0, z: 100 },
      { x: 50, y: 50, z: 200 },
      { x: 100, y: 0, z: 300 },
    ]);
  });

  it('does not invent routeNodes3d for a legacy planar pipe', () => {
    const updated = withCanonicalPipeRoute(
      { properties: { routePoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }] } },
      [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      { segmentMaterials: ['hard'] },
    );
    expect(updated.properties).toEqual({
      routePoints: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      segmentMaterials: ['hard'],
    });
  });

  it('partitions a fitting interval without copying the full 3D route into both halves', () => {
    const split = splitPipeRoute3dAtPlanInterval(
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
      [
        { x: 0, y: 0, z: 100 },
        { x: 250, y: 0, z: 100 },
        { x: 250, y: 0, z: 500 },
        { x: 500, y: 0, z: 500 },
        { x: 800, y: 0, z: 600 },
        { x: 1000, y: 0, z: 700 },
      ],
      { x: 300, y: 0 },
      { x: 700, y: 0 },
      { first: 450, second: 550 },
    );

    expect(split?.before).toEqual([
      { x: 0, y: 0, z: 100 },
      { x: 250, y: 0, z: 100 },
      { x: 250, y: 0, z: 500 },
      { x: 300, y: 0, z: 450 },
    ]);
    expect(split?.after).toEqual([
      { x: 700, y: 0, z: 550 },
      { x: 800, y: 0, z: 600 },
      { x: 1000, y: 0, z: 700 },
    ]);
    expect(split?.before.some((node) => node.x >= 700)).toBe(false);
    expect(split?.after.some((node) => node.x <= 300)).toBe(false);
  });
});
