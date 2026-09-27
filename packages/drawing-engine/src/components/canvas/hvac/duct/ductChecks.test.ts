import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';
import type { PipeRouteNode3D } from '../pipeRoute3d';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { getActiveDuctSettings, resolveDuctSettings, setActiveDuctSettings } from './ductSettings';
import { validateDuctRuns } from './ductValidation';
import { boxesOverlap, ductBoxesOf, segmentBoxDistance } from './ductVolumes';

const settings = resolveDuctSettings({ soffitMm: 2900 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const z0 = supply.lip.z - supply.heightMm / 2;
// Supply straight 5 m along −Y at the collar: centre z = collar centre, 674 wide.
const duct = { ...buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 5000 }] }, 'duct'), label: 'Supply duct' };

function pipe(id: string, nodes: PipeRouteNode3D[]): HvacElement {
  const xs = nodes.map((p) => p.x); const ys = nodes.map((p) => p.y); const zs = nodes.map((p) => p.z);
  return {
    id, type: 'refrigerant-pipe', position: { x: Math.min(...xs), y: Math.min(...ys) },
    width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...ys) - Math.min(...ys),
    height: Math.max(...zs) - Math.min(...zs) + 40, elevation: Math.min(...zs) - 20,
    mountType: 'ceiling', label: id, rotation: 0, supplyZoneRatio: 0,
    properties: {
      lineKind: 'gas', routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes,
      authoredCenterlineRoute: nodes.map(({ x, y }) => ({ x, y })), pipeDiameterMm: 20, insulationThicknessMm: 10, outerDiameterMm: 40,
    },
  };
}

// A gas pipe crossing the duct square to it, 2.5 m out.
const crossY = supply.lip.y - 2500;
const through = pipe('gas-through', [{ x: supply.lip.x - 1500, y: crossY, z: supply.lip.z }, { x: supply.lip.x + 1500, y: crossY, z: supply.lip.z }]);
// The same pipe 150 mm under the duct's sheet: the 70 mm insulated tube clears it.
const under = pipe('gas-under', [{ x: supply.lip.x - 1500, y: crossY, z: z0 - 150 }, { x: supply.lip.x + 1500, y: crossY, z: z0 - 150 }]);

afterEach(() => setActiveDuctSettings(resolveDuctSettings({})));

describe('duct design checks', () => {
  it('reports every DU_* issue of every run in the design-check shape, one entry per rule and message', () => {
    const twisted = { ...buildDuctRunDraftElement({ port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 2000 }, { x: supply.lip.x + 3000, y: supply.lip.y - 2000, z: z0 - 800 }] }, 'twisted'), label: 'Twisted' };
    const report = validateDuctRuns([unit, twisted], settings);
    const hardWay = report.issues.find((issue) => issue.code === 'DU_HARD_WAY_ELBOW')!;
    expect(hardWay).toMatchObject({ level: 'error', entityId: 'twisted' });
    expect(hardWay.message).toMatch(/^Twisted: /);
    expect(report.counts.error).toBeGreaterThanOrEqual(1);
    expect(new Set(report.issues.map((issue) => issue.id)).size).toBe(report.issues.length);
    expect(validateDuctRuns([unit], settings).issues).toEqual([]);
  });

  it('boxes the duct body; a pipe through it clashes, one passing under it does not', () => {
    const plan = getDuctRunPlan(duct, [unit, duct], settings)!;
    const boxes = ductBoxesOf(plan);
    expect(boxes.length).toBeGreaterThan(0);
    const straight = boxes.find((box) => box.mark.startsWith('S-'))!;
    expect(straight.halfWidth).toBeCloseTo(337 + 0.6, 6);
    expect(straight.halfHeight).toBeCloseTo(82 + 0.6, 6);
    const [a, b] = [through.properties.routeNodes3d as PipeRouteNode3D[]][0]!;
    expect(boxes.some((box) => segmentBoxDistance(a!, b!, box).distance === 0)).toBe(true);
    const report = validateDuctRuns([unit, duct, through, under], settings);
    const clashes = report.issues.filter((issue) => issue.code === 'DU_CLASH');
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.message).toMatch(/clashes with the refrigerant gas pipe gas-through/);
    expect(clashes[0]!.entityId).toBe('duct');
  });

  it('flags two runs whose bodies overlap, but never a branch and its parent', () => {
    const other = { ...buildDuctRunDraftElement({
      origin: { kind: 'free', point: { x: supply.lip.x - 2000, y: crossY }, bottomZ: z0, service: 'supply' },
      points: [{ x: supply.lip.x + 2000, y: crossY }], legSizes: [{ widthMm: 400, heightMm: 200 }],
    }, 'other'), label: 'Other' };
    const report = validateDuctRuns([unit, duct, other], settings);
    expect(report.issues.filter((issue) => issue.code === 'DU_CLASH').map((issue) => issue.message)).toEqual([
      expect.stringMatching(/clashes with the duct run Other/),
    ]);
    const plan = getDuctRunPlan(duct, [unit, duct], settings)!;
    const otherPlan = getDuctRunPlan(other, [other], settings)!;
    expect(ductBoxesOf(plan).some((a) => ductBoxesOf(otherPlan).some((b) => boxesOverlap(a, b)))).toBe(true);
  });

  it('a new refrigerant route may not pass through a duct (ducts are obstacles to the pipe engine)', () => {
    setActiveDuctSettings(settings);
    expect(getActiveDuctSettings()).toBe(settings);
    expect(findNewNetworkPipeClashes([unit, duct], [through])).toEqual([
      expect.objectContaining({ elementIds: ['duct', 'gas-through'] }),
    ]);
    expect(findNewNetworkPipeClashes([unit, duct], [under])).toEqual([]);
    // An existing contact kept as it is, is not new.
    expect(findNewNetworkPipeClashes([unit, duct, through], [through])).toEqual([]);
  });
});
