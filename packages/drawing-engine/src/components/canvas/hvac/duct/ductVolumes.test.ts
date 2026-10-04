import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveDuctSettings } from './ductSettings';
import { equipmentBoxOf, findDuctClashes, segmentBoxDistance, terminalBoxesOf, type Vec3 } from './ductVolumes';

const equipment = (rotation = 0): HvacElement => ({ id: 'body', type: 'outdoor-unit', position: { x: -5, y: -5 },
  width: 10, depth: 10, height: 10, elevation: -5, rotation, mountType: 'floor', label: 'Body', supplyZoneRatio: 0, properties: {} });

describe('analytical segment to solid distance', () => {
  it('finds the stationary point outside an edge, with a zero length segment and with tangency', () => {
    const body = equipmentBoxOf(equipment())!;
    const edge = segmentBoxDistance({ x: 8, y: 3, z: 0 }, { x: 3, y: 8, z: 0 }, body);
    expect(edge.distance).toBeCloseTo(Math.SQRT1_2, 12);
    expect(edge.point).toEqual({ x: 5.5, y: 5.5, z: 0 });
    expect(segmentBoxDistance({ x: 8, y: 9, z: 0 }, { x: 8, y: 9, z: 0 }, body).distance).toBe(5);
    expect(segmentBoxDistance({ x: -10, y: 5, z: 0 }, { x: 10, y: 5, z: 0 }, body).distance).toBe(0);
  });

  it('does not lose millimetre accuracy on very long crossing segments', () => {
    const body = equipmentBoxOf(equipment())!;
    expect(segmentBoxDistance({ x: -1e9, y: 6, z: 7 }, { x: 1e9, y: 6, z: 7 }, body).distance).toBeCloseTo(Math.sqrt(5), 12);
    expect(segmentBoxDistance({ x: -1e9, y: 0, z: 0 }, { x: 1e9, y: 0, z: 0 }, body).distance).toBe(0);
  });

  it('preserves distance under equipment rotation and endpoint reversal', () => {
    const body = equipmentBoxOf(equipment(37))!;
    const rotate = (point: Vec3): Vec3 => ({ x: point.x * body.axisT.x + point.y * body.axisN.x,
      y: point.x * body.axisT.y + point.y * body.axisN.y, z: point.z });
    const a = rotate({ x: 8, y: 3, z: 0 }); const b = rotate({ x: 3, y: 8, z: 0 });
    expect(segmentBoxDistance(a, b, body).distance).toBeCloseTo(Math.SQRT1_2, 12);
    expect(segmentBoxDistance(b, a, body).distance).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('shared equipment and terminal envelopes', () => {
  it('places equipment above its elevation and rotates around its unrotated footprint centre', () => {
    const body = equipmentBoxOf({ ...equipment(90), position: { x: 10, y: 20 }, width: 800, depth: 400, height: 300, elevation: 2400 })!;
    expect(body.centre).toEqual({ x: 410, y: 220, z: 2550 });
    expect(body.bounds.minX).toBeCloseTo(210, 10);
    expect(body.bounds.maxY).toBeCloseTo(620, 10);
    expect(body.bounds.minZ).toBe(2400);
    expect(body.bounds.maxZ).toBe(2700);
  });

  it('includes the diffuser face below its plenum and its projecting connection neck', () => {
    const terminal = { ...equipment(), type: 'diffuser' as const, width: 595, depth: 595, elevation: 2400, properties: {} };
    const bodies = terminalBoxesOf(terminal);
    expect(bodies.map(body => body.mark)).toEqual(['plenum box', 'terminal face', 'terminal neck']);
    const face = bodies[1]!; const plenum = bodies[0]!; const neck = bodies[2]!;
    expect(face.bounds.minZ).toBe(2400);
    expect(face.bounds.maxZ).toBe(plenum.bounds.minZ);
    expect(neck.bounds.minY).toBeLessThan(plenum.bounds.minY);
    expect(equipmentBoxOf(terminal)).toBeNull();
    expect(equipmentBoxOf({ ...equipment(), type: 'refrigerant-pipe' })).toBeNull();
  });

  it('detects terminal-to-terminal and terminal-to-equipment interference', () => {
    const terminal: HvacElement = { ...equipment(), id: 'terminal', type: 'diffuser', width: 595, depth: 595,
      position: { x: 0, y: 0 }, elevation: 2400, properties: {} };
    const other = { ...terminal, id: 'other-terminal', position: { x: 200, y: 0 } };
    const body = { ...equipment(), position: { x: 200, y: 200 }, width: 400, depth: 400, height: 300, elevation: 2450 };
    expect(findDuctClashes([terminal, other], resolveDuctSettings({}), []))
      .toEqual([expect.objectContaining({ ductId: terminal.id, otherId: other.id, kind: 'terminal' })]);
    expect(findDuctClashes([terminal, body], resolveDuctSettings({}), []))
      .toEqual([expect.objectContaining({ ductId: terminal.id, otherId: body.id, kind: 'equipment' })]);
  });
});
