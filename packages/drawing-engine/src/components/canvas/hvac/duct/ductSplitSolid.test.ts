// The Y of a duct system has a body: routers and the clash check see it, and only the branches off its outlets touch it.
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec } from './ductTypes';
import { ductBoxesOf, findDuctClashes, segmentBoxDistance } from './ductVolumes';

const settings = resolveDuctSettings({ soffitMm: 2900 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2450, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const main = { widthMm: 700, heightMm: 250 };
const leg = { widthMm: 350, heightMm: 250 };

/** A straight main off the collar, ending in a Y with a branch out of each side. */
function system(): { parent: HvacElement; left: HvacElement; right: HvacElement } {
  const parent = buildDuctRunDraftElement({
    port: supply, points: [{ x: supply.lip.x, y: supply.lip.y + supply.normal.y * 3000 }],
    legSizes: [main], end: { kind: 'split', style: 'y' },
  } as never, 'parent');
  const spec = readDuctRunSpec(parent)!;
  const last = spec.path.at(-1)!;
  const branch = (id: string, side: 1 | -1): HvacElement => {
    const start = { kind: 'split-branch', parentId: 'parent', side } as const;
    const across = { x: side * 2500, y: 0 };
    return { ...parent, id, properties: { ...parent.properties, ductRun: {
      ...spec, start, end: { kind: 'open' }, legs: [leg],
      path: [{ x: last.x + side * 500, y: last.y + supply.normal.y * 450, z: last.z }, { x: last.x + across.x, y: last.y + supply.normal.y * 450, z: last.z }],
    } } } as HvacElement;
  };
  return { parent, left: branch('left', 1), right: branch('right', -1) };
}

describe('a split fitting as a solid', () => {
  const { parent, left, right } = system();
  const scene = [unit, parent, left, right];
  const plan = planDuctRun(parent, { settings, scene })!;
  const piece = plan.pieces.find((candidate) => candidate.kind === 'split')!;
  const boxes = ductBoxesOf(plan).filter((box) => box.mark === piece.mark);

  it('has a body where it stands: routers read it', () => {
    expect(piece).toBeTruthy();
    expect(boxes.length).toBeGreaterThan(0);
    // A pipe through the neck of the Y hits it.
    const origin = piece.split!.origin;
    const z = piece.split!.bottomZ + main.heightMm / 2;
    const d = piece.split!.direction;
    const hit = boxes.map((box) => segmentBoxDistance(
      { x: origin.x + d.x * 20 - 500, y: origin.y + d.y * 20, z }, { x: origin.x + d.x * 20 + 500, y: origin.y + d.y * 20, z }, box,
    ).distance);
    expect(Math.min(...hit)).toBe(0);
  });

  it('its own branches touching it at the outlets is no clash', () => {
    const clashes = findDuctClashes(scene, settings, []).filter((clash) => clash.kind === 'duct');
    expect(clashes).toEqual([]);
  });

  it('another duct through it is one', () => {
    const origin = piece.split!.origin;
    const d = piece.split!.direction;
    const stray = buildDuctRunDraftElement({
      port: { ...supply, lip: { ...supply.lip, x: origin.x - 2000 + d.x * 20, y: origin.y + d.y * 20 }, normal: { x: 1, y: 0, z: 0 } } as never,
      points: [{ x: origin.x + 2000 + d.x * 20, y: origin.y + d.y * 20 }], legSizes: [{ widthMm: 200, heightMm: 200 }],
    } as never, 'stray');
    const clashes = findDuctClashes([...scene, stray], settings, []).filter((clash) => clash.kind === 'duct' && (clash.ductId === 'stray' || clash.otherId === 'stray'));
    expect(clashes.length).toBeGreaterThan(0);
  });
});
