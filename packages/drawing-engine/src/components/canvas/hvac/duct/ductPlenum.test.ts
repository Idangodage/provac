import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { findBranchTarget, spigotOrigin } from './ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun } from './ductFabricationPlanner';
import { ductRunElementWithSpec, reanchorBranches } from './ductFollow';
import { expandDuctDeletion } from './ductNetwork';
import { checkSpigotFit, defaultPlenumSize, plenumGeometry } from './ductPlenum';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import { planDuctSupports } from './ductSupports';
import { readDuctRunSpec, roundLeg, type DuctSpigotFace } from './ductTypes';

const settings = resolveDuctSettings({ soffitMm: 2900 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const z0 = supply.lip.z - supply.heightMm / 2;
// 1 m off the supply collar (−Y), ending in a 900 × 300 × 500 plenum.
const main = buildDuctRunDraftElement({
  port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 1000 }], end: { kind: 'plenum', widthMm: 900, heightMm: 300, lengthMm: 500 },
}, 'plenum-run');

function spigotBranch(id: string, face: DuctSpigotFace, alongMm: number, acrossMm: number, scene: HvacElement[], diameter = 200): HvacElement {
  const origin = spigotOrigin(main, settings, { face, alongMm, acrossMm, style: 'spin-in', vcd: true }, roundLeg(diameter))!;
  if (origin.kind !== 'spigot') throw new Error('expected a spigot origin');
  const point = { x: origin.point.x + origin.direction.x * 1000, y: origin.point.y + origin.direction.y * 1000 };
  return buildDuctRunDraft({ origin, points: [point], legSizes: [roundLeg(diameter)] }, id, scene).element;
}

const left = spigotBranch('left', 'left', 250, 0, [unit, main]);
const right = spigotBranch('right', 'right', 250, 0, [unit, main]);
const end = spigotBranch('end', 'end', 0, 0, [unit, main]);
const scene = [unit, main, left, right, end];

describe('plenums and spigots', () => {
  it('the plenum fills the end of the run on the duct\'s flat bottom, joined to the duct by a flange', () => {
    const plan = planDuctRun(main, { settings, scene })!;
    const plenum = plan.pieces.at(-1)!;
    expect(plenum.kind).toBe('plenum');
    expect(plenum.lengthMm).toBe(500);
    expect(plenum.stationEndMm).toBeCloseTo(1000, 6);
    expect(plenum).toMatchObject({ widthMm: 900, heightMm: 300 });
    expect(plenum.bottomZ).toBeCloseTo(z0, 6);
    expect(plenum.plenum!.spigots).toHaveLength(3);
    const joint = plan.joints.at(-1)!;
    expect(joint.between[1]).toBe(plenum.mark);
    expect(joint.widthMm).toBe(674);
    expect(plan.pieces.some((piece) => piece.kind === 'end-cap')).toBe(false);
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('spigot branches leave the faces square, half way up the plenum, with a spin-in collar and a damper', () => {
    const geometry = plenumGeometry(readDuctRunSpec(main)!)!;
    for (const branch of [left, right, end]) {
      const plan = planDuctRun(branch, { settings, scene })!;
      expect(plan.pieces.map((piece) => piece.kind).slice(0, 2)).toEqual(['takeoff', 'damper']);
      expect(plan.pieces[0]!.takeoff?.style).toBe('spin-in');
      expect(plan.issues.map((issue) => issue.code)).not.toContain('DU_STALE');
      expect(plan.joints[0]!.kind).toBe('tap-connection');
      // Centre half way up: clear bottom = box bottom + 150 − 100.
      expect(readDuctRunSpec(branch)!.path[0]!.z).toBeCloseTo(z0 + 50, 6);
    }
    const start = readDuctRunSpec(left)!.path[0]!;
    // On the outside of the side sheet (0.7 mm for a 900 mm plenum at 500 Pa).
    const out = Math.abs((start.x - geometry.back.x) * geometry.normal.x + (start.y - geometry.back.y) * geometry.normal.y);
    expect(out).toBeGreaterThan(450.4);
    expect(out).toBeLessThan(451.6);
  });

  it('checks that every spigot fits its face and keeps clear of the next', () => {
    expect(checkSpigotFit({ widthMm: 900, heightMm: 300, lengthMm: 500 }, [
      { branchId: 'a', face: 'left', alongMm: 250, acrossMm: 0, openingMm: 250 },
    ]).map((issue) => issue.code)).toEqual(['DU_PLENUM_SIZE']);
    expect(checkSpigotFit({ widthMm: 900, heightMm: 350, lengthMm: 600 }, [
      { branchId: 'a', face: 'left', alongMm: 150, acrossMm: 0, openingMm: 200 },
      { branchId: 'b', face: 'left', alongMm: 380, acrossMm: 0, openingMm: 200 },
    ]).map((issue) => issue.code)).toEqual(['DU_SPIGOT_CLASH']);
    expect(defaultPlenumSize({ widthMm: 674, heightMm: 164 }, 200)).toEqual({ widthMm: 874, heightMm: 300, lengthMm: 500 });
  });

  it('the duct tool finds a plenum face; branches follow a resized plenum and are orphaned with it', () => {
    const geometry = plenumGeometry(readDuctRunSpec(main)!)!;
    const nearLeft = { x: geometry.back.x + geometry.direction.x * 200 + geometry.normal.x * 470, y: geometry.back.y + geometry.direction.y * 200 + geometry.normal.y * 470 };
    expect(findBranchTarget(nearLeft, [unit, main], settings, 40)).toMatchObject({ kind: 'spigot', face: 'left', alongMm: 200 });
    const taller = ductRunElementWithSpec(main, { ...readDuctRunSpec(main)!, end: { kind: 'plenum', widthMm: 900, heightMm: 400, lengthMm: 500 } });
    const moved = reanchorBranches(scene.map((element) => (element.id === main.id ? taller : element)), new Map([[main.id, taller]]), settings);
    expect(moved.map((element) => element.id).sort()).toEqual(['end', 'left', 'right']);
    expect(readDuctRunSpec(moved[0]!)!.path[0]!.z).toBeCloseTo(z0 + 100, 6);
    const kept = expandDuctDeletion(scene, new Set([main.id]));
    expect(kept.filter((element) => element.type === 'duct').map((element) => readDuctRunSpec(element)!.start)).toEqual([
      { kind: 'open', orphaned: true }, { kind: 'open', orphaned: true }, { kind: 'open', orphaned: true },
    ]);
  });

  it('draws the box with its diagonals and tag, builds it in 3D, lists it in the BOM and hangs it', () => {
    const plan = planDuctRun(main, { settings, scene })!;
    const presentation = buildDuctPlanPresentation(plan);
    expect(presentation.boxDiagonals).toHaveLength(2);
    expect(presentation.tags.some((tag) => /^PLENUM 900×300×500/.test(tag.text))).toBe(true);
    const bom = buildDuctBom([plan]);
    expect(bom.some((row) => row.description === 'Plenum box 900×300×500, 3 spigot openings')).toBe(true);
    const group = new THREE.Group();
    addDuctRunMeshes(group, main, { allElements: scene, ductSettings: resolveDuctSettings({ showSupports: false }) });
    const box = new THREE.Box3().setFromObject(group);
    expect(box.max.x - box.min.x).toBeGreaterThan(900);
    const supports = planDuctSupports(plan, scene, settings, 2900);
    expect(supports.hangers.some((hanger) => hanger.stationMm >= 500 && hanger.stationMm <= 1000 && hanger.outerWidthMm > 900)).toBe(true);
  });
});
