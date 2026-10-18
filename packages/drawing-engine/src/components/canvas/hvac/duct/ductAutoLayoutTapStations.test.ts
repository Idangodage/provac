/**
 * Take-offs at their terminals stay among Auto duct's options when take-offs
 * moved to the edge of an obstacle in a stub's way are added. In a tight room
 * the stub check calls the take-off in front of each diffuser blocked; the
 * moved ones then fail exact sizing ("its all-flex runout fits from none of
 * this main's sections"). With only those, every split-trunk design was lost
 * and Auto duct chose a straight trunk that ran into the wall.
 *
 * The room is the test project's (walls 6.6 × 4.8 m, 150 mm) with an FDUM22
 * and two Ø200 square diffusers at 600 m³/h each, placed as the canvas check
 * duct-sizing places them.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { generateAutoDuct, inspectAutoDuctOptions, type AutoDuctResult } from './ductAutoLayout';
import type { DuctWallInput } from './ductBuilding';
import { resolveDuctSettings } from './ductSettings';
import { defaultSizingBasis, linkSizingBasis } from './ductSystemSizing';

const settings = resolveDuctSettings({ autoSizingMethod: 'constant-friction' });

const walls: DuctWallInput[] = [
  { id: 'wall-top', startPoint: { x: 2300, y: 1350 }, endPoint: { x: 8900, y: 1350 }, thickness: 150 },
  { id: 'wall-right', startPoint: { x: 8900, y: 1350 }, endPoint: { x: 8900, y: 6150 }, thickness: 150 },
  { id: 'wall-bottom', startPoint: { x: 8900, y: 6150 }, endPoint: { x: 2300, y: 6150 }, thickness: 150 },
  { id: 'wall-left', startPoint: { x: 2300, y: 6150 }, endPoint: { x: 2300, y: 1350 }, thickness: 150 },
];
const room = { id: 'room', vertices: [{ x: 2375, y: 1425 }, { x: 8825, y: 1425 }, { x: 8825, y: 6075 }, { x: 2375, y: 6075 }] };

const unit: HvacElement = {
  id: 'du-1', type: 'ducted-ac', position: { x: 3148.9375, y: 4638.8958 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'room',
  properties: { modelCode: 'FDUM22KXE6F-W', airflowM3min: { 'p-hi': 13, hi: 10, me: 9, lo: 8 }, maxEspPa: 100 },
};

function diffuser(id: string, label: string, x: number): HvacElement {
  return {
    id, type: 'diffuser', position: { x, y: 2733.5011 }, rotation: 0, width: 595, depth: 595, height: 335, elevation: 2400,
    mountType: 'ceiling', label, supplyZoneRatio: 0.5, roomId: 'room',
    properties: {
      terminal: {
        service: 'supply', mount: 'lay-in', kind: 'square-4way', neckDiameterMm: 200, spigotSide: 'back', spigotLengthMm: 60,
        faceWidthMm: 595, faceDepthMm: 595, faceHeightMm: 35, plenumWidthMm: 530, plenumDepthMm: 530, plenumHeightMm: 300,
      },
      airSystem: { unitId: 'du-1' },
    },
  };
}

const terminals = [diffuser('sad-1', 'SAD-1', 2471.9051), diffuser('sad-2', 'SAD-2', 4069.228)];

describe('Auto duct in a tight room: take-offs at their terminals stay among the options', () => {
  it('designs the two diffusers without errors and without running into a wall', () => {
    const basis = linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null, 'hi'), airflowM3h: 1200 }, 1200);
    const options: Array<{ label: string; errors: number }> = [];
    inspectAutoDuctOptions((_ctx, serviceOptions) => {
      options.push(...serviceOptions.map((option) => ({ label: option.label, errors: option.errors })));
    });
    let result: AutoDuctResult;
    try {
      result = generateAutoDuct([unit, ...terminals], {
        unitId: unit.id, terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', airflowM3h: 1200, layout: 'auto',
        services: { supply: true, return: false }, rebuildExisting: false, shape: 'rect', sizing: { supply: basis },
        walls, rooms: [room],
      }, settings);
    } finally {
      inspectAutoDuctOptions(null);
    }
    // What the designer sees: a clean design, not a trunk through the wall.
    const design = result.designs[result.selected]!;
    const issues = design.services.flatMap((service) => service.issues);
    expect(design.errors).toBe(0);
    expect(issues.some((issue) => issue.code === 'DU_AUTO_WALL')).toBe(false);
    // Why: a split trunk with its take-offs at the diffusers is buildable here and is kept among the options.
    expect(options.some((option) => /Split trunk/.test(option.label) && option.errors === 0)).toBe(true);
  }, 120000);
});
