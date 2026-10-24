// The FDU224 of the user's top hall (23 October 2026): turned away from its terminals, with two Ø250 diffusers and two
// Ø250 grilles for 4,320 m³/h. Auto route must say why it has no layout and what puts it right.
import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../../types';

import { planAutoRouteDucts, type AutoRouteDuctOptions } from './ductAutoRoute';
import { DEFAULT_DUCT_SETTINGS } from './ductSettings';

let serial = 0;
function place(definitionId: string, centre: Point2D, extra: Partial<HvacElement> = {}, properties: Record<string, unknown> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  serial += 1;
  return {
    id: `${definitionId}-${serial}`, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: def.type === 'diffuser' ? `SAD-${serial}` : def.type === 'return-grille' ? `RAG-${serial}` : def.name, supplyZoneRatio: 0.5,
    properties: { definitionId: def.id, ...(def.defaultProperties ?? {}), ...properties }, ...extra,
  } as HvacElement;
}

const options: AutoRouteDuctOptions = { settings: DEFAULT_DUCT_SETTINGS, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing' };

function hall(rotation: number) {
  serial = 0;
  const unit = place('vrf-fdu224kxze1', { x: 9200, y: 4700 }, { rotation, elevation: 2400 }, { airSystemTag: 'DU-1' });
  const terminals = [
    place('terminal-square-595-250', { x: 2200, y: 1300 }), place('terminal-square-595-250', { x: 15400, y: 1500 }),
    place('terminal-return-eggcrate-595-250', { x: 2900, y: 7600 }), place('terminal-return-eggcrate-595-250', { x: 15800, y: 7600 }),
  ].map((terminal) => ({ ...terminal, elevation: 2400, properties: { ...terminal.properties, airSystem: { unitId: unit.id } } }));
  return planAutoRouteDucts([unit, ...terminals], { supply: true, return: true }, options).units[0]!;
}

describe('Auto route: a ducted unit it cannot serve says why, and what puts it right', () => {
  it('turned away from its terminals, with too few of them: kept, with the reasons and the fixes', () => {
    const unit = hall(0);
    expect(unit.status).toBe('kept');
    const codes = (unit.diagnostics ?? []).map((issue) => `${issue.service}:${issue.code}`);
    expect(codes).toContain('supply:DU_AUTO_BEHIND_COLLAR');
    expect(codes).toContain('return:DU_AUTO_BEHIND_COLLAR');
    const noLayout = (unit.diagnostics ?? []).filter((issue) => issue.code === 'DU_AUTO_NO_LAYOUT').map((issue) => issue.message);
    expect(noLayout).toEqual([
      'No buildable layout for these terminals: SAD-2 and SAD-3 are behind the supply collar; too much air through each terminal for their necks.',
      'No buildable layout for these terminals: RAG-4 and RAG-5 are behind the return collar; too much air through each terminal for their necks.',
    ]);
    expect(unit.advice?.map((advice) => advice.kind === 'turn-unit' ? `turn ${advice.angleDeg}` : `${advice.service} ${advice.total} × Ø${advice.neckMm}`))
      .toEqual(['turn 180', 'supply 6 × Ø300', 'return 5 × Ø300']);
    expect(unit.notes.slice(0, 3)).toEqual([
      'Turn DU-1 180°: all 4 of its terminals are then ahead of their collars (none are now).',
      'DU-1 supply: 4,320 m³/h through 2 × Ø250 is 2,160 m³/h each, 12.2 m/s in the neck (limit 3 m/s). It needs at least 6 × Ø300 or 9 × Ø250 diffusers.',
      'DU-1 return: 4,320 m³/h through 2 × Ø250 is 2,160 m³/h each, 12.2 m/s in the neck (limit 3.5 m/s). It needs at least 5 × Ø300 or 7 × Ø250 return grilles.',
    ]);
  });

  it('turned to face them: no word of turning, the terminal counts remain', () => {
    const unit = hall(180);
    expect((unit.diagnostics ?? []).some((issue) => issue.code === 'DU_AUTO_BEHIND_COLLAR')).toBe(false);
    expect(unit.advice?.map((advice) => advice.kind)).toEqual(['add-terminals', 'add-terminals']);
  });
});
