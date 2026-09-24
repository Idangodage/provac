import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { buildCondensateBom } from './condensateBom';
import { generateCondensateNetwork, type CondensateGenerationResult } from './condensateGenerator';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { resolveCondensateSettings, type CondensateDesignSettings } from './condensateSettings';
import { layoutCondensateSupports } from './condensateSupports';
import { condensateInsulatedRadiusMm, readCondensatePipeSpec, type Point3 } from './condensateTypes';
import { validateCondensateNetwork } from './condensateValidation';

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

function gully(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: id.toUpperCase(), supplyZoneRatio: 0.5,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  };
}

function refrigerant(id: string, points: Array<{ x: number; y: number }>, z: number): HvacElement {
  return {
    id, type: 'refrigerant-pipe', position: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
    rotation: 0, width: 10, depth: 10, height: 40, elevation: z - 20, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5,
    properties: {
      routePoints: points, routeNodes3d: points.map((point) => ({ ...point, z })), pipeDiameterMm: 15.88,
      insulationThicknessMm: 25.4, lineKind: 'gas', fieldBendConstruction: 'formed-tube',
    },
  };
}

let ids = 0;
const idFactory = (prefix: string) => `${prefix}-${ids++}`;

function run(scene: HvacElement[], overrides: Partial<CondensateDesignSettings> = {}): CondensateGenerationResult {
  ids = 0;
  return generateCondensateNetwork(scene, { settings: resolveCondensateSettings(overrides), idFactory });
}

const planRun = (a: Point3, b: Point3) => Math.hypot(b.x - a.x, b.y - a.y);

function unitBranch(result: CondensateGenerationResult, unitId: string) {
  const element = result.elementsToAdd.find((candidate) => readCondensatePipeSpec(candidate).drainStart?.unitId === unitId)!;
  return { element, spec: readCondensatePipeSpec(element) };
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('condensate drains built like site practice', () => {
  it('rises plumb beside a pumped cassette to the soffit, then falls away (flexible hose at the socket)', () => {
    const unit = cassette('c-1', 0, 0);
    const result = run([unit, gully('fg', 6000, 400)]);
    const port = getIndoorUnitDrainPort(unit, resolveCondensateSettings({}))!;
    const { spec } = unitBranch(result, 'c-1');
    const [start, foot, top, next] = spec.routeNodes3d as [Point3, Point3, Point3, Point3];
    expect(spec.pumped).toBe(true);
    expect(start.z).toBeCloseTo(port.z, 3);
    expect(planRun(start, foot)).toBeLessThanOrEqual(300 + 1e-6);
    expect(planRun(foot, top)).toBeLessThan(0.5);
    const radius = condensateInsulatedRadiusMm(spec);
    expect(top.z).toBeCloseTo(Math.min(port.z + port.pumpMaxLiftMm, result.envelope.voidTopMm - radius), 0);
    expect(next.z).toBeLessThan(top.z);
    expect(spec.drainHoseLengthMm).toBeGreaterThan(planRun(start, foot));
    expect(spec.drainHoseLengthMm).toBeLessThan(planRun(start, foot) + (top.z - foot.z));
    expect(spec.hangers?.topZ).toBe(result.envelope.soffitMm);
  });

  it('climbs the full pump head when the slab is high, and stays minimal when asked to lift only as needed', () => {
    const unit = cassette('c-1', 0, 0);
    const port = getIndoorUnitDrainPort(unit, resolveCondensateSettings({}))!;
    const high = unitBranch(run([unit, gully('fg', 6000, 400)], { soffitMm: 3800 }), 'c-1').spec.routeNodes3d;
    expect(high[2]!.z).toBeCloseTo(port.z + port.pumpMaxLiftMm, 0);
    const minimal = run([unit, gully('fg', 6000, 400)], { soffitMm: 3800, pumpPolicy: 'when-needed' });
    expect(minimal.perUnit[0]!.status).toBe('gravity');
    expect(unitBranch(minimal, 'c-1').spec.drainHoseLengthMm).toBe(0);
  });

  it('moves the riser aside to climb clear of a refrigerant run above the outlet', () => {
    const unit = cassette('c-1', 0, 0);
    const port = getIndoorUnitDrainPort(unit, resolveCondensateSettings({}))!;
    const along = port.direction;
    // A gas run straight over the outlet axis, above the drain outlet.
    const service = refrigerant('gas-1', [
      { x: port.point.x + along.x * 60, y: port.point.y + along.y * 60 },
      { x: port.point.x + along.x * 2500, y: port.point.y + along.y * 2500 },
    ], port.z + 140);
    const scene = [unit, service, gully('fg', port.point.x + along.x * 400 + 3000 * -along.y, port.point.y + along.y * 400 + 3000 * along.x)];
    const result = run(scene, { soffitMm: 3800 });
    const { spec } = unitBranch(result, 'c-1');
    const [, foot, top] = spec.routeNodes3d as [Point3, Point3, Point3];
    const serviceRadius = 15.88 / 2 + 25.4;
    const required = serviceRadius + condensateInsulatedRadiusMm(spec) + resolveCondensateSettings({}).refrigerantClearanceMm;
    // The riser foot left the outlet axis, far enough to climb past the run.
    const offAxis = Math.abs((foot.x - port.point.x) * -along.y + (foot.y - port.point.y) * along.x);
    expect(offAxis).toBeGreaterThanOrEqual(required - 0.5);
    expect(top.z).toBeGreaterThan(port.z + 140 + required);
    const report = validateCondensateNetwork([...scene, ...result.elementsToAdd], { settings: resolveCondensateSettings({ soffitMm: 3800 }), routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    expect(report.issues.filter((issue) => issue.code === 'CD_CLASH')).toEqual([]);
  });

  it('finds a riser position clear of the unit\'s own refrigerant stubs leaving beside the drain outlet', () => {
    // As drawn on the board: the pair leaves the cassette just above the drain
    // outlet and turns along the outlet side ~175 mm out, boxing in the usual foot.
    const unit = cassette('c-1', 0, 0);
    const port = getIndoorUnitDrainPort(unit, resolveCondensateSettings({}))!;
    const at = (dx: number, dy: number) => ({ x: port.point.x + dx, y: port.point.y + dy });
    const own = { startConnection: { connectionKind: 'unit-port', sourceElementId: 'c-1' } };
    const liquid = refrigerant('liq-own', [at(-24, -93), at(176, -93), at(176, -33), at(176, 4300)], port.z + 35);
    const gas = refrigerant('gas-own', [at(-13, -135), at(187, -135), at(254, -98), at(226, 3778)], port.z + 61);
    liquid.properties = { ...liquid.properties, ...own, lineKind: 'liquid', pipeDiameterMm: 9.52 };
    gas.properties = { ...gas.properties, ...own };
    const scene = [unit, liquid, gas, gully('fg', port.point.x - 2500, port.point.y + 3500)];
    const settings = resolveCondensateSettings({ soffitMm: 3500 });
    const result = run(scene, { soffitMm: 3500 });
    const { spec } = unitBranch(result, 'c-1');
    const [, foot, top] = spec.routeNodes3d as [Point3, Point3, Point3];
    expect(spec.pumped).toBe(true);
    expect(planRun(foot, top)).toBeLessThan(0.5);
    expect(top.z).toBeGreaterThan(port.z + 400);
    // Every refrigerant sample keeps its clearance from the riser column.
    const radius = condensateInsulatedRadiusMm(spec);
    for (const service of [liquid, gas]) {
      const serviceRadius = Number(service.properties.pipeDiameterMm) / 2 + 25.4;
      const required = serviceRadius + radius + settings.refrigerantClearanceMm;
      const nodes = service.properties.routeNodes3d as Point3[];
      for (let index = 1; index < nodes.length; index += 1) {
        for (let t = 0; t <= 1; t += 0.01) {
          const x = nodes[index - 1]!.x + (nodes[index]!.x - nodes[index - 1]!.x) * t;
          const y = nodes[index - 1]!.y + (nodes[index]!.y - nodes[index - 1]!.y) * t;
          const z = nodes[index]!.z;
          const plan = Math.hypot(x - foot.x, y - foot.y);
          const vertical = z < foot.z ? foot.z - z : z > top.z ? z - top.z : 0;
          expect(Math.hypot(plan, vertical)).toBeGreaterThanOrEqual(required - 0.5);
        }
      }
    }
    const report = validateCondensateNetwork([...scene, ...result.elementsToAdd], { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('makes level changes as 45° offsets: branches enter mains from above at 45°, never by a plumb step', () => {
    const scene = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), gully('fg', 6500, 3400)];
    const result = run(scene);
    const settings = resolveCondensateSettings({});
    let joins = 0;
    for (const element of result.elementsToAdd) {
      const spec = readCondensatePipeSpec(element);
      if (spec.segmentRole === 'drop' || spec.segmentRole === 'terminal') continue;
      const nodes = spec.routeNodes3d;
      nodes.forEach((node, index) => {
        if (index === 0) return;
        const previous = nodes[index - 1]!;
        const plan = planRun(previous, node);
        const fall = previous.z - node.z;
        const isRiser = spec.pumped && index === 2;
        if (plan < 0.5) {
          expect(isRiser, `${element.id} has a plumb step at node ${index}`).toBe(true);
          return;
        }
        if (plan < 60) return;
        const slope = (fall / plan) * 100;
        const designFall = slope >= settings.minSlopePercent - 0.05 && slope <= settings.preferredSlopePercent + 0.05;
        const offset = Math.abs(slope - 100) < 3;
        expect(designFall || offset || (spec.pumped && index === 1), `${element.id} segment ${index}: ${slope.toFixed(2)} %`).toBe(true);
      });
      if (spec.drainEnd?.kind === 'junction' && spec.fittings.some((fitting) => fitting.kind === 'wye')) {
        joins += 1;
        const last = nodes[nodes.length - 1]!;
        const before = nodes[nodes.length - 2]!;
        expect(before.z - last.z).toBeCloseTo(planRun(before, last), 0);
      }
    }
    expect(joins).toBeGreaterThan(0);
    const report = validateCondensateNetwork([...scene, ...result.elementsToAdd], { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('hangs the runs from the slab on rods, carries the hose on its clamps, and counts both in the BOM', () => {
    const scene = [cassette('c-1', 0, 0), gully('fg', 6000, 400)];
    const result = run(scene, { soffitMm: 3500 });
    const { element, spec } = unitBranch(result, 'c-1');
    const supports = layoutCondensateSupports(element, spec.hangers!);
    expect(supports.length).toBeGreaterThan(2);
    expect(supports.every((support) => support.rodLengthMm > 0)).toBe(true);
    // No hanger on the flexible hose.
    const foot = spec.routeNodes3d[1]!;
    expect(supports.some((support) => planRun(support.point, foot) < 0.5 && support.point.z < foot.z + 80)).toBe(false);

    const mesh = buildHvacElementMesh(element, { allElements: [...scene, ...result.elementsToAdd] })!;
    const names = new Map<string, THREE.Object3D[]>();
    mesh.updateMatrixWorld(true);
    mesh.traverse((child) => names.set(child.name, [...(names.get(child.name) ?? []), child]));
    expect(names.has('condensate-drain-hose')).toBe(true);
    expect(names.has('condensate-pipe-bend')).toBe(true);
    expect(names.has('condensate-pipe-joint')).toBe(false);
    const rods = names.get('condensate-hanger-rod') ?? [];
    expect(rods.length).toBe(supports.length);
    for (const rod of rods) {
      const box = new THREE.Box3().setFromObject(rod);
      expect(box.max.z).toBeCloseTo(3500, 0);
    }

    const bom = buildCondensateBom([...result.elementsToAdd, scene[1]!], resolveCondensateSettings({ soffitMm: 3500 }));
    expect(bom.find((row) => row.description.startsWith('Flexible drain hose'))?.quantity).toBe(1);
    expect(bom.find((row) => row.description.startsWith('Threaded rod'))?.quantity).toBeGreaterThan(0);
  });
});
