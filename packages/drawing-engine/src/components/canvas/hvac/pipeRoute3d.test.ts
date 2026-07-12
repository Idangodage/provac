import { describe, expect, it } from 'vitest';

import { attachPipeRoute3dToElements, readPipeRouteNodes3d } from './pipeRoute3d';
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
});
