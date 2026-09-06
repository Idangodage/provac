import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import type { PipeRouteNode3D } from './pipeRoute3d';
import {
  findNearestRefrigerantPipeBundleSegmentTarget,
  findNearestRefrigerantPipeSegmentTarget,
} from './refrigerantPipePairModel';

function line(
  id: string,
  lineKind: 'gas' | 'liquid',
  y: number,
  nodes: PipeRouteNode3D[] = [],
  properties: Record<string, unknown> = {},
): HvacElement {
  return {
    id, type: 'refrigerant-pipe', position: { x: 0, y }, width: 2000, depth: 40,
    height: 40, elevation: 2480, rotation: 0, mountType: 'ceiling', label: id, supplyZoneRatio: 0,
    properties: {
      routePoints: [{ x: 0, y }, { x: 2000, y }], lineKind, pipeDiameterMm: 20,
      insulationThicknessMm: 10, outerDiameterMm: 40, bundleId: 'main',
      ...(nodes.length ? { routeNodes3d: nodes } : {}), ...properties,
    },
  };
}

const target = (elements: HvacElement[], x: number, y = 0) =>
  findNearestRefrigerantPipeSegmentTarget(elements, { x, y }, 2, { minSegmentLengthMm: 100 });

describe('horizontal branch stations use the physical elevation profile', () => {
  it('reads the plateau at the station instead of the owning element bottom or first socket', () => {
    const gas = line('gas', 'gas', 0, [
      { x: 0, y: 0, z: 2500 }, { x: 600, y: 0, z: 2500 },
      { x: 600, y: 0, z: 2800 }, { x: 2000, y: 0, z: 2800 },
    ]);
    expect(target([gas], 300)?.elevationMm).toBe(2500);
    expect(target([gas], 1300)?.elevationMm).toBe(2800);
    expect(target([gas], 1300)?.segmentStart).toEqual({ x: 600, y: 0 });
  });

  it('never offers a horizontal fitting on a sloping span or a vertical riser', () => {
    const slope = line('slope', 'gas', 0, [
      { x: 0, y: 0, z: 2500 }, { x: 2000, y: 0, z: 2800 },
    ]);
    const riser = line('riser', 'gas', 0, [
      { x: 0, y: 0, z: 2500 }, { x: 0, y: 0, z: 2800 },
    ], { routePoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }] });
    expect(target([slope], 1000)).toBeNull();
    expect(target([riser], 0)).toBeNull();
  });

  it('excludes the full legacy bypass interval while retaining both clear sides', () => {
    const gas = line('gas', 'gas', 0, [], {
      bypasses: [{
        id: 'offset', obstaclePoint: { x: 900, y: 0 },
        enterPoint: { x: 600, y: 0 }, exitPoint: { x: 1200, y: 0 },
        baseElevationMm: 2500, bypassElevationMm: 2800, riseMm: 300,
      }],
    });
    expect(target([gas], 900)).toBeNull();
    expect(target([gas], 300)?.segmentEnd).toEqual({ x: 600, y: 0 });
    expect(target([gas], 1600)?.segmentStart).toEqual({ x: 1200, y: 0 });
  });

  it('keeps both line levels and all overlap intervals when only one lane changes level', () => {
    const gas = line('gas', 'gas', 0, [
      { x: 0, y: 0, z: 2600 }, { x: 2000, y: 0, z: 2600 },
    ]);
    const liquid = line('liquid', 'liquid', 80, [
      { x: 0, y: 80, z: 2600 }, { x: 500, y: 80, z: 2600 },
      { x: 800, y: 80, z: 2800 }, { x: 1200, y: 80, z: 2800 },
      { x: 1400, y: 80, z: 2600 }, { x: 2000, y: 80, z: 2600 },
    ]);
    const pairAt = (x: number) => findNearestRefrigerantPipeBundleSegmentTarget(
      [gas, liquid], { x, y: 40 }, 2, { minSegmentLengthMm: 100 },
    );
    expect(pairAt(250)?.liquidElevationMm).toBe(2600);
    expect(pairAt(650)).toBeNull();
    expect(pairAt(1000)?.gasElevationMm).toBe(2600);
    expect(pairAt(1000)?.liquidElevationMm).toBe(2800);
    expect(pairAt(1700)?.liquidElevationMm).toBe(2600);
  });

  it('does not merge through a rise and return at the same projected station', () => {
    const gas = line('gas', 'gas', 0, [
      { x: 0, y: 0, z: 2500 }, { x: 1000, y: 0, z: 2500 },
      { x: 1000, y: 0, z: 2800 }, { x: 1000, y: 0, z: 2500 },
      { x: 2000, y: 0, z: 2500 },
    ]);
    expect(target([gas], 500)?.segmentEnd).toEqual({ x: 1000, y: 0 });
    expect(target([gas], 1500)?.segmentStart).toEqual({ x: 1000, y: 0 });
  });
});
