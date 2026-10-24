import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement } from '../../../../types';

import { listAirPorts } from './ductAirPorts';
import { collarMarksMarkup } from './ductOverlayMarkup';

function unit(definitionId: string, rotation: number): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: definitionId, type: def.type, position: { x: 0, y: 0 }, rotation, width: def.widthMm, depth: def.depthMm, height: def.heightMm,
    elevation: 2400, mountType: def.mountType, label: def.name, supplyZoneRatio: 0.5, properties: { definitionId: def.id, ...(def.defaultProperties ?? {}) },
  } as HvacElement;
}

/** The plan y of the SA / RA label in the markup. */
const labelY = (markup: string, text: 'SA' | 'RA') => Number(new RegExp(`<text x="[^"]+" y="([^"]+)"[^>]*>${text}</text>`).exec(markup)![1]);

describe('collar marks in plan', () => {
  it('mark each collar of a ducted unit, supply SA and return RA, just outside it', () => {
    const markup = collarMarksMarkup(listAirPorts([unit('vrf-fdu224kxze1', 0)]), 0.1);
    expect(markup).toContain('data-collar-mark="vrf-fdu224kxze1:supply"');
    expect(markup).toContain('data-collar-mark="vrf-fdu224kxze1:return"');
    // At rotation 0 the FDU224's supply faces +y (down the plan) and its return −y; the FDUM140's the other way round.
    expect(labelY(markup, 'SA')).toBeGreaterThan(labelY(markup, 'RA'));
    const fdum = collarMarksMarkup(listAirPorts([unit('vrf-fdum140kxe6f', 0)]), 0.1);
    expect(labelY(fdum, 'SA')).toBeLessThan(labelY(fdum, 'RA'));
  });

  it('turn with the unit', () => {
    const markup = collarMarksMarkup(listAirPorts([unit('vrf-fdu224kxze1', 180)]), 0.1);
    expect(labelY(markup, 'SA')).toBeLessThan(labelY(markup, 'RA'));
  });
});
