import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement } from '../../../types';

import { connectionFaceLayout } from './unit/UnitConnectionsFigure';
import { layoutConnectionTags, makerConnectionTags } from './unitConnectionTags';

function placed(definitionId: string, properties: Record<string, unknown> = {}): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: definitionId, type: definition.type, position: { x: 0, y: 0 }, rotation: 0,
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
    mountType: 'ceiling', label: definition.name, supplyZoneRatio: 0.5,
    properties: { ...(definition.defaultProperties ?? {}), ...properties },
  } as HvacElement;
}

describe('plan tags at the maker stubs', () => {
  it('names each connection with its field size and joint, at its stub tip', () => {
    const tags = makerConnectionTags(placed('vrf-fdum140kxe6f'));
    expect(tags.map((tag) => tag.text)).toEqual(['G 5/8″ flare', 'L 3/8″ flare', 'D VP25 pump']);
    expect(tags[0]!.tip).toEqual({ x: 696, y: -97 });
    expect(tags[2]!.tip.x).toBe(842);
  });

  it('says brazed for the FDU and gravity when it is set so', () => {
    const tags = makerConnectionTags(placed('vrf-fdu280kxze1', { hasDrainPump: false, drainPumpSetBy: 'user' }));
    expect(tags.map((tag) => tag.text)).toEqual(['G 7/8″ brazed', 'L 3/8″ brazed', 'D VP25 gravity']);
  });

  it('tags the FDT28 on its −x side, without a size its catalogue entry does not give', () => {
    const tags = makerConnectionTags(placed('vrf-fdt28kxze1'));
    expect(tags.map((tag) => tag.text)).toEqual(['G flare', 'L flare', 'D VP25 pump']);
    expect(tags.every((tag) => tag.axis === -1 && tag.tip.x <= -373.5)).toBe(true);
  });

  it('tags nothing on a unit without maker data', () => {
    expect(makerConnectionTags(placed('vrf-fdum140kxe6f', { modelCode: undefined, model: undefined }))).toEqual([]);
  });
});

describe('the tag column', () => {
  const options = { pitchMm: 145, gapMm: 160 };
  const tags = makerConnectionTags(placed('vrf-fdum140kxe6f'));

  it('stands beyond the stubs, one under another down the sheet in the order of the stubs, text running away', () => {
    const laid = layoutConnectionTags(tags, 0, options);
    // Down the sheet: the drain (y −263.5), then the gas (−97), then the liquid (−35).
    expect(laid.map((tag) => tag.text[0])).toEqual(['D', 'G', 'L']);
    expect(laid.every((tag) => tag.at.x === 842 + 160 && tag.anchor === 'left')).toBe(true);
    expect(laid[1]!.at.y - laid[0]!.at.y).toBeCloseTo(145, 6);
    // Each leader runs from its stub's tip to its tag.
    for (const tag of laid) expect(tag.leader).toEqual([tag.tip, tag.at]);
  });

  it('still stands clear beyond the stubs on a unit turned a quarter, and runs its text away on a half turn', () => {
    const quarter = layoutConnectionTags(tags, 90, options);
    expect(Math.min(...quarter.map((tag) => tag.at.x))).toBeGreaterThanOrEqual(842 + 160 - 1e-9);
    // Down the sheet is the unit's +x when it is turned a quarter: the tags step along it.
    expect(quarter[1]!.at.x - quarter[0]!.at.x).toBeCloseTo(145, 6);
    expect(layoutConnectionTags(tags, 180, options)[0]!.anchor).toBe('right');
  });
});

describe('the connection face figure', () => {
  const display = (system: 'si' | 'ip') => ({ system, height: (mm: number) => `${Math.round(mm)} mm up` });

  it('draws the FDUM140 end with its gas above its liquid and its drain at the pump outlet', () => {
    const layout = connectionFaceLayout(placed('vrf-fdum140kxe6f'), display('si'))!;
    const mark = (service: string) => layout.marks.find((entry) => entry.service === service)!;
    expect(mark('gas').cy).toBeLessThan(mark('liquid').cy);
    expect(mark('drain').cy).toBeLessThan(mark('gas').cy);
    // Seen from outside the +x end, the −y side (the gas) sits to the right of the liquid.
    expect(mark('gas').cx).toBeGreaterThan(mark('liquid').cx);
    expect(layout.rows.map((row) => row.text)).toEqual(['Ø15.88 · flare · 146 mm up', 'Ø9.52 · flare · 96 mm up', 'VP25 · hose end · 188 mm up']);
    expect(layout.rows[2]!.pumpOutlet).toBe(true);
    // Every stub sits on the face.
    for (const entry of layout.marks) {
      expect(entry.cx).toBeGreaterThanOrEqual(layout.face.x);
      expect(entry.cx).toBeLessThanOrEqual(layout.face.x + layout.face.width);
      expect(entry.cy).toBeGreaterThanOrEqual(layout.face.y);
      expect(entry.cy).toBeLessThanOrEqual(layout.baseY);
    }
  });

  it('gives inch sizes in IP, and the gravity outlet when the unit is set to gravity', () => {
    const layout = connectionFaceLayout(placed('vrf-fdum140kxe6f', { hasDrainPump: false, drainPumpSetBy: 'user' }), display('ip'))!;
    expect(layout.rows.map((row) => row.text)).toEqual(['5/8 in · flare · 146 mm up', '3/8 in · flare · 96 mm up', 'VP25 · socket · 30 mm up']);
    expect(layout.rows[2]!.pumpOutlet).toBe(false);
  });

  it('looks at the FDT28 from its −x side', () => {
    const layout = connectionFaceLayout(placed('vrf-fdt28kxze1'), display('si'))!;
    const mark = (service: string) => layout.marks.find((entry) => entry.service === service)!;
    // From outside the −x end, +y runs to the right: the drain (y +333) right of the gas (y −303).
    expect(mark('drain').cx).toBeGreaterThan(mark('gas').cx);
  });
});
