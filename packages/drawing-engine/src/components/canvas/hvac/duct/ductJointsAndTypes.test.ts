import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { buildStraightGiDuctElement } from '../giDuctModel';

import { companionAngleForClass } from './ductCatalog';
import { formedFlangeCleatsPerSide, jointHardware, slipOverHardware } from './ductJoints';
import { buildDuctRunElement, readDuctRunSpec, type DuctRunSpec } from './ductTypes';

const input600x400 = { sideAMm: 600, sideBMm: 400, pressureClassPa: 500, washersPerBolt: 2 };

describe('joint hardware (per joint = two duct ends)', () => {
  it('TDC: 8 corners, 4 M10 bolts, T-24 cleats, gasket round the perimeter', () => {
    const h = jointHardware({ system: 'tdc', ratedClass: 'D', thickened: false }, input600x400);
    expect(h.cornerPieces).toBe(8);
    expect(h.bolts).toEqual({ size: 'M10', lengthMm: 25, count: 4 });
    expect(h.nuts).toBe(4);
    expect(h.washers).toBe(8);
    // 152 mm clips within 152 mm of each corner, ≤381 mm apart: 2 per 600 and per 400 side.
    expect(formedFlangeCleatsPerSide(600, 381)).toBe(2);
    expect(formedFlangeCleatsPerSide(1200, 381)).toBe(4);
    expect(formedFlangeCleatsPerSide(250, 381)).toBe(1);
    expect(h.cleats).toEqual({ lengthMm: 152, count: 8 });
    expect(h.gasketLengthMm).toBe(2000);
    expect(h.ductFasteners).toBeNull();
  });

  it('T-22 companion angle: M8 bolts at ≤152 mm, rivets at ≤305 mm, welded frames', () => {
    const member = companionAngleForClass('F');
    expect(member).toEqual({ legMm: 25, thicknessMm: 3.2, hotRolled: true });
    const h = jointHardware({ system: 'angle-flange', member, forClass: 'F' }, input600x400);
    // ceil(600/152) = 4 and ceil(400/152) = 3 per side, corners shared.
    expect(h.bolts).toEqual({ size: 'M8', lengthMm: 25, count: 14 });
    expect(h.washers).toBe(28);
    // ceil(600/305) = 2 and ceil(400/305) = 2 per side per end → 8 × 2 ends.
    expect(h.ductFasteners).toMatchObject({ kind: 'rivet', count: 16 });
    expect(h.ductFasteners!.spec).toMatch(/closed-end/);
    expect(h.angleLengthMm).toBe(2 * (2000 + 8 * 25));
    expect(h.cornerWelds).toBe(8);
  });

  it('classes below E use the E angle (Table 1-12M "use E")', () => {
    expect(companionAngleForClass('B')).toEqual({ legMm: 25, thicknessMm: 3.2 });
    expect(companionAngleForClass(null)).toEqual({ legMm: 25, thicknessMm: 3.2 });
  });

  it('Ductmate: manufacturer screw and cleat schedules', () => {
    const h = jointHardware({ system: 'ductmate', series: 'DM25', ratedClass: 'F', flangeHeightMm: 25 }, input600x400);
    expect(h.flangePieces).toBe(8);
    expect(h.cleats).toEqual({ lengthMm: 152, count: 4 });
    // ≤24″ sides: one screw at each corner of the side → 8 per end, both ends.
    expect(h.ductFasteners).toMatchObject({ kind: 'screw', count: 16 });
    const wide = jointHardware({ system: 'ductmate', series: 'DM35', ratedClass: 'J', flangeHeightMm: 35 }, { ...input600x400, sideAMm: 1000 });
    // 25–48″ side: corners + centre → 3; per end 3 + 2 + 3 + 2.
    expect(wide.ductFasteners!.count).toBe(20);
  });

  it('slip-over onto the unit collar: screws within 51 mm of corners and ≤305 mm apart', () => {
    const h = slipOverHardware({ sideAMm: 675.2, sideBMm: 165.2, pressureClassPa: 500, washersPerBolt: 2 });
    // 675: ceil(573/305)+1 = 3; 165: ceil(63/305)+1 = 2 → 3+2+3+2.
    expect(h.ductFasteners).toMatchObject({ kind: 'screw', count: 10 });
  });
});

describe('persisted duct run', () => {
  const spec: DuctRunSpec = {
    version: 1, service: 'supply', construction: 'gi-bare',
    path: [{ x: 0, y: 0, z: 2670 }, { x: 0, y: -3000, z: 2670 }, { x: 4000, y: -3000, z: 2670 }],
    legs: [{ widthMm: 674, heightMm: 164 }, { widthMm: 674, heightMm: 164 }],
    insulationThicknessMm: 0, pressureClassPa: null, jointSystem: null,
    start: { kind: 'unit-port', unitId: 'u', portId: 'supply', connector: true }, end: { kind: 'end-cap' },
    nodeOverrides: { 1: { elbowStyle: 'square-vaned' } }, locked: false,
  };

  it('round-trips through the element and never uses refrigerant connection names', () => {
    const element = { id: 'r', rotation: 0, supplyZoneRatio: 0, ...buildDuctRunElement(spec) } as HvacElement;
    expect(readDuctRunSpec(element)).toEqual(spec);
    expect(element.subtype).toBe('duct-run');
    expect(element.properties.startConnection).toBeUndefined();
    expect(element.properties.endConnection).toBeUndefined();
    expect(element.elevation).toBeLessThan(2670);
    expect(element.width).toBeGreaterThan(4000);
  });

  it('reads the old straight GI stub as a one-leg run (outer size → clear, BOD → clear bottom)', () => {
    const legacy = {
      id: 'old', rotation: 0, supplyZoneRatio: 0,
      ...buildStraightGiDuctElement([{ x: 100, y: 200 }, { x: 100, y: 1400 }], {
        ductKind: 'return', outerWidthMm: 402, outerHeightMm: 202, wallThicknessMm: 1, elevationMm: 2500,
        startConnection: { point: { x: 100, y: 200 }, direction: { x: 0, y: 1 }, sourceElementId: 'u', sourceOpeningKind: 'return' },
      }),
    } as HvacElement;
    const read = readDuctRunSpec(legacy)!;
    expect(read.legacy).toBe(true);
    expect(read.service).toBe('return');
    expect(read.legs).toEqual([{ widthMm: 400, heightMm: 200 }]);
    expect(read.path).toEqual([{ x: 100, y: 200, z: 2501 }, { x: 100, y: 1400, z: 2501 }]);
    expect(read.start).toEqual({ kind: 'unit-port', unitId: 'u', portId: 'return', connector: false });
    expect(read.end).toEqual({ kind: 'open' });
  });

  it('never throws on a corrupt record', () => {
    const corrupt = { id: 'x', type: 'duct', position: { x: 0, y: 0 }, width: 10, depth: 10, elevation: 0, properties: { ductRun: { version: 1, path: 'nope' } } } as unknown as HvacElement;
    expect(() => readDuctRunSpec(corrupt)).not.toThrow();
    expect(readDuctRunSpec({ ...corrupt, type: 'ducted-ac' })).toBeNull();
  });
});
