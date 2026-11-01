/**
 * What the audit of the user's 3D screenshots (1 November 2026) put right in
 * how things are drawn: no routing is involved here.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { ductRunMeshes } from '../../hybrid/hybridDuctSegments';
import { layoutCondensateSupports } from '../condensate/condensateSupports';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { planDuctRun } from '../duct/ductFabricationPlanner';
import { resolveDuctSettings } from '../duct/ductSettings';
import { planDuctSupports } from '../duct/ductSupports';
import { DEFAULT_PIPE_ROUTING_SETTINGS, resolvePipeRoutingSettings, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { buildHvacElementMesh } from './buildHvacElementMesh';

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

const named = (root: THREE.Object3D, test: (name: string) => boolean) => {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => { if (test(object.name)) found.push(object); });
  return found;
};

describe('the fitting view', () => {
  it('is Insulated by default, and for a drawing saved with Copper detail nobody chose', () => {
    expect(DEFAULT_PIPE_ROUTING_SETTINGS.fittingDisplay).toBe('insulated');
    expect(resolvePipeRoutingSettings({ fittingDisplay: 'copper' }).fittingDisplay).toBe('insulated');
    expect(resolvePipeRoutingSettings({ fittingDisplay: 'copper', fittingDisplayChosen: true }).fittingDisplay).toBe('copper');
  });
});

describe('a branch kit', () => {
  const kit = (lineKind: 'gas' | 'liquid'): HvacElement => ({
    id: `kit-${lineKind}`, type: 'refrigerant-branch-kit', position: { x: 0, y: 0 }, rotation: 0, width: 525, depth: 195, height: 57,
    elevation: 2600, mountType: 'ceiling', label: 'Kit', supplyZoneRatio: 0.5,
    properties: { branchKitLineKind: lineKind, branchKitType: 'dis-22-1g', gasInletDiameterMm: 15.88, gasRunOutletDiameterMm: 15.88, gasBranchOutletDiameterMm: 15.88,
      liquidInletDiameterMm: 9.52, liquidRunOutletDiameterMm: 9.52, liquidBranchOutletDiameterMm: 9.52 },
  } as unknown as HvacElement);
  const insulationTubes = (root: THREE.Object3D) => named(root, (name) => /^refrigerant-(gas|liquid)-insulation$/.test(name));

  it('wears its cover over the copper in the Insulated view, as thick as the lines it joins', () => {
    setActivePipeRoutingSettings({ fittingDisplay: 'insulated' });
    const element = kit('gas');
    const mesh = buildHvacElementMesh(element, { allElements: [element] })!;
    const tubes = insulationTubes(mesh);
    expect(tubes.length).toBeGreaterThanOrEqual(3);
    const box = new THREE.Box3().setFromObject(tubes.at(-1)!);
    // 15.88 mm copper in 25.4 mm of insulation: 66.7 mm over the tube.
    expect(box.max.z - box.min.z).toBeGreaterThan(60);
  });

  it('shows the copper bare in Copper detail, as before', () => {
    setActivePipeRoutingSettings({ fittingDisplay: 'copper', fittingDisplayChosen: true });
    const element = kit('gas');
    const mesh = buildHvacElementMesh(element, { allElements: [element] })!;
    expect(insulationTubes(mesh)).toHaveLength(1);
  });
});

describe('duct hangers', () => {
  const settings = resolveDuctSettings({ soffitMm: 2900 });
  const unit: HvacElement = {
    id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
    elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
    properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
  };
  const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;

  it('a bar on a transition fits the section where it hangs, not the wider end', () => {
    const base = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'run');
    const spec = base.properties.ductRun as { path: Array<{ x: number; y: number; z: number }>; legs: Array<{ widthMm: number; heightMm: number }> };
    const [from, to] = [spec.path[0]!, spec.path[1]!];
    // The same run, narrowing to a third of its width from half way: a long, tapering piece with a hanger on it.
    const element = { ...base, properties: { ...base.properties, ductRun: { ...spec,
      path: [from, { x: from.x, y: from.y - 1200, z: from.z }, to],
      legs: [spec.legs[0]!, { widthMm: Math.round(spec.legs[0]!.widthMm / 3), heightMm: spec.legs[0]!.heightMm }],
    } } } as HvacElement;
    const plan = planDuctRun(element, { settings, scene: [unit, element] })!;
    const collar = plan.pieces.find((piece) => piece.kind === 'transition');
    expect(collar, 'the collar narrows to the duct').toBeTruthy();
    const supports = planDuctSupports(plan, [unit, element], settings, 2900);
    const onTransition = supports.hangers.filter((hanger) => hanger.stationMm >= collar!.stationStartMm && hanger.stationMm <= collar!.stationEndMm);
    for (const hanger of onTransition) {
      const f = (hanger.stationMm - collar!.stationStartMm) / (collar!.stationEndMm - collar!.stationStartMm);
      const width = collar!.widthMm + (collar!.endWidthMm - collar!.widthMm) * f;
      expect(hanger.outerWidthMm).toBeCloseTo(width + 2 * (collar!.sheetThicknessMm ?? 1), 6);
    }
  });

  it("a run's outline traces the duct, not its rods and bars", () => {
    const element = buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 6000 }] }, 'run');
    const mesh = buildHvacElementMesh(element, { allElements: [unit, element], ductSettings: settings })!;
    expect(named(mesh, (name) => name === 'duct-supports').length).toBeGreaterThan(0);
    const root = new THREE.Group();
    root.add(mesh);
    const outlined = ductRunMeshes(root, element.id);
    expect(outlined.length).toBeGreaterThan(0);
    expect(outlined.some((part) => part.name === 'duct-supports')).toBe(false);
  });
});

describe('drain hangers', () => {
  const drain = (nodes: Array<{ x: number; y: number; z: number }>): HvacElement => ({
    id: 'cd', type: 'condensate-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 50, depth: 50, height: 50, elevation: 0,
    mountType: 'ceiling', label: 'CD', supplyZoneRatio: 0.5,
    properties: {
      routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes, pipeSystem: 'bs-en-1329', nominalSize: '32', outerDiameterMm: 32, innerDiameterMm: 28.4,
      insulationThicknessMm: 9, designSlopePercent: 1, segmentRole: 'unit-branch', upstreamUnitIds: [], fittings: [], pumped: true, drainHoseLengthMm: 0,
      hangers: { topZ: 2900, supportSpacingHorizontalMm: 1000, supportSpacingVerticalMm: 1500, supportNearFittingMm: 300 },
    },
  } as unknown as HvacElement);
  const rules = { supportSpacingHorizontalMm: 1000, supportSpacingVerticalMm: 1500, supportNearFittingMm: 300 };

  it('a short piece between two bends has no rod of its own', () => {
    const supports = layoutCondensateSupports(drain([
      { x: 0, y: 0, z: 2587 }, { x: 150, y: 0, z: 2587 }, { x: 150, y: 0, z: 2850 }, { x: 4150, y: 0, z: 2810 },
    ]), rules);
    expect(supports.length).toBeGreaterThan(0);
    // None on the 150 mm stub or the 263 mm riser: all on the long run.
    expect(supports.every((support) => support.point.x > 150 + 200)).toBe(true);
  });
});
