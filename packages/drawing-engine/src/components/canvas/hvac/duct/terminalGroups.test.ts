import { describe, expect, it } from 'vitest';

import type { DuctTerminalSpec } from './ductTerminalCatalog';
import { groupTerminalsBySpec, terminalSpecKey, terminalSpecLabel } from './terminalGroups';

const spec = (patch: Partial<DuctTerminalSpec>): DuctTerminalSpec => ({
  kind: 'square-4way', service: 'supply', mount: 'lay-in', faceWidthMm: 595, faceDepthMm: 595, faceHeightMm: 40, neckDiameterMm: 300,
  plenumWidthMm: 400, plenumDepthMm: 400, plenumHeightMm: 300, spigotSide: 'back', spigotLengthMm: 60, ...patch,
});

describe('terminal groups', () => {
  it('groups terminals of one spec, larger necks first, supply before return', () => {
    const items = [
      { id: 'r1', spec: spec({ service: 'return', kind: 'return-egg-crate', neckDiameterMm: 300 }) },
      { id: 's1', spec: spec({ neckDiameterMm: 250 }) },
      { id: 's2', spec: spec({ neckDiameterMm: 300 }) },
      { id: 's3', spec: spec({ neckDiameterMm: 250 }) },
      { id: 's4', spec: spec({ neckDiameterMm: 300, designAirflowM3h: 500 }) },
    ];
    const groups = groupTerminalsBySpec(items, (item) => item.spec);
    expect(groups.map((group) => [terminalSpecLabel(group.spec), group.members.map((member) => member.id)])).toEqual([
      ['Square 4-way Ø300', ['s2', 's4']],
      ['Square 4-way Ø250', ['s1', 's3']],
      ['Egg-crate Ø300', ['r1']],
    ]);
  });

  it('tells specs apart by face, neck, face size, slots and filter, never by their airflow', () => {
    expect(terminalSpecKey(spec({ designAirflowM3h: 500 }))).toBe(terminalSpecKey(spec({})));
    expect(terminalSpecKey(spec({ kind: 'round' }))).not.toBe(terminalSpecKey(spec({})));
    expect(terminalSpecKey(spec({ faceWidthMm: 600, faceDepthMm: 600 }))).not.toBe(terminalSpecKey(spec({})));
    expect(terminalSpecKey(spec({ filter: 'G4' }))).not.toBe(terminalSpecKey(spec({})));
    expect(terminalSpecLabel(spec({ kind: 'linear-slot', slots: 2, neckDiameterMm: 200 }))).toBe('Linear slot ×2 Ø200');
    expect(terminalSpecLabel(spec({ service: 'return', kind: 'return-egg-crate', filter: 'G4' }))).toBe('Egg-crate Ø300 · G4');
  });
});
