import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';
import type { PipeRouteNode3D } from '../pipeRoute3d';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { getActiveDuctSettings, resolveDuctSettings, setActiveDuctSettings } from './ductSettings';
import { terminalSpigotPort } from './ductTerminals';
import { roundLeg } from './ductTypes';
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

  it('checks downstream branch loops against their own parent while allowing the intended takeoff', () => {
    const origin = tapOrigin(duct, settings, { legIndex: 0, stationMm: 2500, side: 1, style: 'spin-in', vcd: true }, roundLeg(150))!;
    if (origin.kind !== 'tap') throw new Error('Expected a takeoff');
    const start = origin.point;
    const straight = buildDuctRunDraftElement({ origin, points: [{ x: start.x + 2000, y: start.y }], legSizes: [roundLeg(150)] }, 'branch');
    expect(validateDuctRuns([unit, duct, straight], settings).issues.filter(issue => issue.code === 'DU_CLASH')).toEqual([]);
    const loop = buildDuctRunDraftElement({ origin, points: [{ x: start.x + 2000, y: start.y },
      { x: start.x + 2000, y: start.y - 1500 }, { x: start.x - 2000, y: start.y - 1500 }], legSizes: [roundLeg(150)] }, 'branch');
    expect(validateDuctRuns([unit, duct, loop], settings).issues.filter(issue => issue.code === 'DU_CLASH')).toHaveLength(1);
  });

  it('does not exempt a served terminal plenum from a run looping through its body', () => {
    const terminal: HvacElement = { ...unit, id: 'terminal', type: 'diffuser', width: 595, depth: 595, elevation: 2400, properties: {} };
    const port = terminalSpigotPort(terminal)!;
    const centre = { x: terminal.width / 2, y: terminal.depth / 2 };
    const loop = buildDuctRunDraftElement({ origin: { kind: 'free', point: { x: centre.x - 2000, y: centre.y },
      bottomZ: port.lip.z - 100, service: 'supply' }, points: [{ x: centre.x + 2000, y: centre.y },
      { x: centre.x + 2000, y: port.lip.y - 600 }, { x: port.lip.x, y: port.lip.y - 600 }, port.lip],
    legSizes: [roundLeg(200)], end: { kind: 'terminal', terminalId: terminal.id, portId: port.portId, flex: false } }, 'loop');
    expect(validateDuctRuns([terminal, loop], settings).issues.filter(issue => issue.code === 'DU_CLASH'))
      .toEqual([expect.objectContaining({ message: expect.stringContaining('air terminal') })]);
  });

  it('rejects a duct crossing another equipment casing but permits its own source collar and a clear overhead body', () => {
    const obstacle: HvacElement = { ...unit, id: 'other-unit', position: { x: supply.lip.x - 200, y: crossY - 200 },
      width: 400, depth: 400, height: 400, elevation: z0 - 50, properties: {} };
    expect(validateDuctRuns([unit, duct, obstacle], settings).issues.filter(issue => issue.code === 'DU_CLASH'))
      .toEqual([expect.objectContaining({ message: expect.stringContaining('equipment') })]);
    expect(validateDuctRuns([unit, duct, { ...obstacle, elevation: 3100 }], settings).issues.filter(issue => issue.code === 'DU_CLASH')).toEqual([]);
  });

  it('reports a moved or extended pipe contact with a duct even if those same elements already touched', () => {
    const moved = pipe(through.id, [{ x: supply.lip.x - 1500, y: crossY + 500, z: supply.lip.z },
      { x: supply.lip.x + 1500, y: crossY + 500, z: supply.lip.z }]);
    expect(findNewNetworkPipeClashes([unit, duct, through], [moved])).toHaveLength(1);
    const original = pipe('parallel', [{ x: supply.lip.x, y: crossY, z: supply.lip.z },
      { x: supply.lip.x, y: crossY - 500, z: supply.lip.z }]);
    const longer = pipe('parallel', [{ x: supply.lip.x, y: crossY, z: supply.lip.z },
      { x: supply.lip.x, y: crossY - 1500, z: supply.lip.z }]);
    expect(findNewNetworkPipeClashes([unit, duct, original], [original])).toEqual([]);
    expect(findNewNetworkPipeClashes([unit, duct, original], [longer])).toHaveLength(1);
  });
});
