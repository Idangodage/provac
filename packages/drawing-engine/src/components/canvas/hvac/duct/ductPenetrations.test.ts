import fc from 'fast-check';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { addDuctRunMeshes } from '../three3d/ductMeshes';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctBom } from './ductBom';
import { withActiveDuctBuilding, type DuctRoomOutline, type DuctWall } from './ductBuilding';
import { buildDuctRunDraftElement } from './ductDraft';
import { priceDuctPlans } from './ductEconomics';
import { planDuctRun, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductPenetrationSchedule, ductPenetrationScheduleToCsv } from './ductPenetrationSchedule';
import { ductWallCrossings, penetrationHasFireDamper, polylinePenetrationZones, wallCrossingRule } from './ductPenetrations';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings, type DuctDesignSettings } from './ductSettings';
import { planDuctSupports } from './ductSupports';
import type { DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const lip = supply.lip;

/** Supply leaves the −Y collar: 3000 mm away from the unit, then 4000 mm to the right (the planner test's run). */
function run(overrides: Partial<DuctRunSpec> = {}, legs: Point2D[] = [{ x: 0, y: -3000 }, { x: 4000, y: 0 }]): HvacElement {
  const points: Point2D[] = [];
  let cursor: Point2D = { x: lip.x, y: lip.y };
  for (const leg of legs) {
    cursor = { x: cursor.x + leg.x, y: cursor.y + leg.y };
    points.push(cursor);
  }
  const element = buildDuctRunDraftElement({ port: supply, points }, 'run');
  return { ...element, properties: { ...element.properties, ductRun: { ...(element.properties.ductRun as object), ...overrides } } };
}

/** A wall across the first leg, `stationMm` from the collar (square to the duct unless `angleDeg`). */
function wallAcross(stationMm: number, extra: Partial<DuctWall> = {}, angleDeg = 0): DuctWall {
  const centre = { x: lip.x, y: lip.y - stationMm };
  const angle = (angleDeg * Math.PI) / 180;
  const along = { x: Math.cos(angle), y: Math.sin(angle) };
  return {
    id: 'w1', a: { x: centre.x - along.x * 2000, y: centre.y - along.y * 2000 }, b: { x: centre.x + along.x * 2000, y: centre.y + along.y * 2000 },
    thicknessMm: 200, baseZ: 0, topZ: 3000, structural: true, material: 'brick', ...extra,
  };
}

function plan(element: HvacElement, walls: DuctWall[], rooms: DuctRoomOutline[] = [], overrideSettings: DuctDesignSettings = settings): DuctFabricationPlan {
  return planDuctRun(element, { settings: overrideSettings, scene: [unit, element], building: { walls, rooms } })!;
}

/** Each piece starts where the one before it ended (the run's centreline is covered once). */
function expectContiguous(result: DuctFabricationPlan): void {
  const rigid = result.pieces.filter((piece) => piece.kind !== 'flex' && piece.kind !== 'end-cap');
  for (let index = 1; index < rigid.length; index += 1) {
    expect(Math.abs(rigid[index]!.stationStartMm - rigid[index - 1]!.stationEndMm)).toBeLessThan(1);
  }
}

const codes = (result: DuctFabricationPlan) => result.issues.map((issue) => issue.code);

describe('wall crossings', () => {
  const spec = {
    path: [{ x: 0, y: 0, z: 2500 }, { x: 4000, y: 0, z: 2500 }], legs: [{ widthMm: 300, heightMm: 200 }],
    insulationThicknessMm: 0, end: { kind: 'end-cap' as const },
  };
  const wall = (extra: Partial<DuctWall> = {}): DuctWall => ({
    id: 'w1', a: { x: 2000, y: -2000 }, b: { x: 2000, y: 2000 }, thicknessMm: 200, baseZ: 0, topZ: 3000, structural: false, ...extra,
  });

  it('finds where a leg passes through a wall, with the wall\'s depth along the duct', () => {
    const [crossing, ...rest] = ductWallCrossings(spec, [wall()]);
    expect(rest).toEqual([]);
    expect(crossing).toMatchObject({ wallId: 'w1', key: 'w1:0', legIndex: 0, angleDeg: 0, onFlex: false });
    expect(crossing!.legStationMm).toBeCloseTo(2000, 6);
    expect(crossing!.zoneFromMm).toBeCloseTo(1900, 6);
    expect(crossing!.zoneToMm).toBeCloseTo(2100, 6);
  });

  it('passes over a wall that stops below the duct, and under one above it', () => {
    expect(ductWallCrossings(spec, [wall({ topZ: 2400 })])).toEqual([]);
    expect(ductWallCrossings(spec, [wall({ baseZ: 2800, topZ: 4000 })])).toEqual([]);
    expect(ductWallCrossings(spec, [wall({ topZ: 2600 })])).toHaveLength(1);
  });

  it('measures an oblique crossing (the zone along the duct grows by 1/cos)', () => {
    const [crossing] = ductWallCrossings(spec, [wall({ a: { x: 1000, y: -2000 }, b: { x: 3000, y: 2000 } })]);
    const cos = 2 / Math.hypot(1, 2);
    expect(crossing!.angleDeg).toBeCloseTo((Math.acos(cos) * 180) / Math.PI, 6);
    expect(crossing!.zoneToMm - crossing!.zoneFromMm).toBeCloseTo(200 / cos, 6);
  });

  it('numbers a wall crossed twice by occurrence', () => {
    const twice = {
      path: [{ x: 0, y: 0, z: 2500 }, { x: 4000, y: 0, z: 2500 }, { x: 4000, y: 1000, z: 2500 }, { x: 0, y: 1000, z: 2500 }],
      legs: [{ widthMm: 300, heightMm: 200 }, { widthMm: 300, heightMm: 200 }, { widthMm: 300, heightMm: 200 }],
      insulationThicknessMm: 0, end: { kind: 'end-cap' as const },
    };
    expect(ductWallCrossings(twice, [wall()]).map((crossing) => [crossing.key, crossing.legIndex])).toEqual([['w1:0', 0], ['w1:1', 2]]);
  });

  it('names the rooms either side; one side outside every room is an exterior wall', () => {
    const left: DuctRoomOutline = { id: 'A', vertices: [{ x: -1000, y: -2000 }, { x: 1900, y: -2000 }, { x: 1900, y: 2000 }, { x: -1000, y: 2000 }] };
    const right: DuctRoomOutline = { id: 'B', vertices: [{ x: 2100, y: -2000 }, { x: 5000, y: -2000 }, { x: 5000, y: 2000 }, { x: 2100, y: 2000 }] };
    const [interior] = ductWallCrossings(spec, [wall()], [left, right]);
    expect([...interior!.rooms].sort()).toEqual(['A', 'B']);
    expect(interior!.exterior).toBe(false);
    const [exterior] = ductWallCrossings(spec, [wall()], [left]);
    expect(exterior!.exterior).toBe(true);
  });

  it('takes the fire damper from the run\'s own choice, else the policy', () => {
    expect(penetrationHasFireDamper({ key: 'w1:0', structural: true }, undefined, 'none')).toBe(false);
    expect(penetrationHasFireDamper({ key: 'w1:0', structural: true }, undefined, 'structural')).toBe(true);
    expect(penetrationHasFireDamper({ key: 'w1:0', structural: false }, undefined, 'structural')).toBe(false);
    expect(penetrationHasFireDamper({ key: 'w1:0', structural: false }, undefined, 'all')).toBe(true);
    expect(penetrationHasFireDamper({ key: 'w1:0', structural: false }, { 'w1:0': { fireDamper: false } }, 'all')).toBe(false);
    expect(penetrationHasFireDamper({ key: 'w1:0', structural: false }, { 'w1:0': { fireDamper: true } }, 'none')).toBe(true);
  });

  it('gives the auto layout its zones (fire damper sleeve and joint margin) and crossing rule', () => {
    const zones = polylinePenetrationZones([{ x: 0, y: 0 }, { x: 4000, y: 0 }], 2500, 200, [wall()], settings);
    expect(zones).toEqual([{ from: 1900 - 50, to: 2100 + 50, wallId: 'w1' }]);
    const dampered = polylinePenetrationZones([{ x: 0, y: 0 }, { x: 4000, y: 0 }], 2500, 200, [wall()], resolveDuctSettings({ fireDamperPolicy: 'all' }));
    expect(dampered[0]).toMatchObject({ from: 1900 - 100 - 50, to: 2100 + 100 + 50 });
    const rooms: DuctRoomOutline[] = [
      { id: 'A', vertices: [{ x: -1000, y: -2000 }, { x: 1900, y: -2000 }, { x: 1900, y: 2000 }, { x: -1000, y: 2000 }] },
      { id: 'B', vertices: [{ x: 2100, y: -2000 }, { x: 5000, y: -2000 }, { x: 5000, y: 2000 }, { x: 2100, y: 2000 }] },
    ];
    const rule = wallCrossingRule(rooms, settings);
    expect(rule.allows(wall(), { x: 2000, y: 0 })).toBe(true);
    expect(wallCrossingRule(rooms.slice(0, 1), settings).allows(wall(), { x: 2000, y: 0 })).toBe(false);
    expect(rule.price(wall())).toBe(settings.econPenetrationEach);
    expect(wallCrossingRule(rooms, resolveDuctSettings({ fireDamperPolicy: 'all' })).price(wall()))
      .toBe(settings.econPenetrationEach + settings.econFireDamperEach + settings.econAccessDoorEach);
  });
});

describe('a run through a wall', () => {
  it('passes plain straight duct through it, its joints clear of the wall, with a sleeve', () => {
    const result = plan(run(), [wallAcross(1200)]);
    expect(result.status).toBe('ok');
    expect(codes(result).filter((code) => code.startsWith('DU_PENETRATION'))).toEqual([]);
    const [penetration, ...rest] = result.penetrations;
    expect(rest).toEqual([]);
    expect(penetration).toMatchObject({ mark: 'PN-01', key: 'w1:0', fireDamper: false, legIndex: 0, material: 'brick', exterior: false });
    expect(penetration!.stationMm).toBeCloseTo(1200, 3);
    expect(penetration!.opening.widthMm).toBeCloseTo(penetration!.outerWidthMm + 2 * settings.penetrationClearanceMm, 6);
    expect(penetration!.opening.heightMm).toBeCloseTo(penetration!.outerHeightMm + 2 * settings.penetrationClearanceMm, 6);
    // No transverse joint in the wall or within 50 mm of its faces.
    for (const joint of result.joints) {
      expect(joint.stationMm <= penetration!.fromStationMm - 50 + 0.5 || joint.stationMm >= penetration!.toStationMm + 50 - 0.5).toBe(true);
    }
    expect(result.pieces.some((piece) => piece.kind === 'fire-damper')).toBe(false);
    expectContiguous(result);
  });

  it('puts a fire damper in its sleeve, centred in the wall, under the policy', () => {
    const policy = resolveDuctSettings({ fireDamperPolicy: 'all' });
    const result = plan(run(), [wallAcross(1200)], [], policy);
    const damper = result.pieces.find((piece) => piece.kind === 'fire-damper')!;
    expect(damper).toBeDefined();
    expect(damper.mark).toBe('FD-01');
    expect(damper.lengthMm).toBeCloseTo(200 + 2 * policy.fireDamperSleeveExtensionMm, 6);
    expect((damper.stationStartMm + damper.stationEndMm) / 2).toBeCloseTo(1200, 3);
    expect(damper.sheetAreaM2).toBe(0);
    expect(damper.massKg).toBeGreaterThan(0);
    expect(damper.penetrationKey).toBe('w1:0');
    expect(result.penetrations[0]).toMatchObject({ fireDamper: true, damperMark: 'FD-01' });
    // Breakaway joints at both ends of the sleeve.
    expect(result.joints.some((joint) => Math.abs(joint.stationMm - damper.stationStartMm) < 0.5)).toBe(true);
    expect(result.joints.some((joint) => Math.abs(joint.stationMm - damper.stationEndMm) < 0.5)).toBe(true);
    expect(result.status).toBe('ok');
    expectContiguous(result);
  });

  it('takes the run\'s own fire damper choice over the policy', () => {
    const own = plan(run({ penetrations: { 'w1:0': { fireDamper: true } } }), [wallAcross(1200)]);
    expect(own.pieces.filter((piece) => piece.kind === 'fire-damper')).toHaveLength(1);
    const none = plan(run({ penetrations: { 'w1:0': { fireDamper: false } } }), [wallAcross(1200)], [], resolveDuctSettings({ fireDamperPolicy: 'all' }));
    expect(none.pieces.filter((piece) => piece.kind === 'fire-damper')).toEqual([]);
  });

  it('refuses a wall at a fitting, flexible duct through a wall, and flags an oblique or exterior crossing', () => {
    // The elbow at the corner takes the last ~1061 mm of the first leg.
    expect(codes(plan(run(), [wallAcross(2800)]))).toContain('DU_PENETRATION_FITTING');
    expect(plan(run(), [wallAcross(2800)]).status).toBe('error');
    // A fire damper's sleeve needs its extension too: at 1800 it reaches the elbow.
    expect(codes(plan(run(), [wallAcross(1800)], [], resolveDuctSettings({ fireDamperPolicy: 'all' })))).toContain('DU_PENETRATION_FITTING');
    expect(codes(plan(run(), [wallAcross(1200, {}, 30)]))).toContain('DU_PENETRATION_ANGLE');
    const room: DuctRoomOutline = { id: 'A', vertices: [{ x: lip.x - 3000, y: lip.y - 1100 }, { x: lip.x + 3000, y: lip.y - 1100 }, { x: lip.x + 3000, y: lip.y + 500 }, { x: lip.x - 3000, y: lip.y + 500 }] };
    expect(codes(plan(run(), [wallAcross(1200)], [room]))).toContain('DU_PENETRATION_EXTERIOR');
    // A runout through a wall: the last leg is flexible duct.
    const flexRun = buildDuctRunDraftElement({
      port: supply, points: [{ x: lip.x, y: lip.y - 1500 }, { x: lip.x, y: lip.y - 2500 }],
      end: { kind: 'terminal', terminalId: 'ghost', portId: 'spigot', flex: true },
    }, 'flex-run');
    const flex = plan(flexRun, [wallAcross(2000)]);
    expect(codes(flex)).toContain('DU_PENETRATION_FLEX');
    expect(flex.penetrations[0]).toMatchObject({ onFlex: true, fireDamper: false });
  });

  it('keeps every joint out of the wall, or says it could not (any wall position and thickness)', () => {
    fc.assert(fc.property(fc.integer({ min: 300, max: 1800 }), fc.integer({ min: 75, max: 350 }), fc.boolean(), (station, thickness, damper) => {
      const result = plan(run(), [wallAcross(station, { thicknessMm: thickness })], [], damper ? resolveDuctSettings({ fireDamperPolicy: 'all' }) : settings);
      expectContiguous(result);
      const [penetration] = result.penetrations;
      if (!penetration) return false;
      const flagged = codes(result).some((code) => code === 'DU_PENETRATION_JOINT' || code === 'DU_PENETRATION_FITTING');
      if (damper) return flagged || result.pieces.some((piece) => piece.kind === 'fire-damper' && piece.stationStartMm <= penetration.fromStationMm && piece.stationEndMm >= penetration.toStationMm);
      const clear = result.joints.every((joint) => joint.stationMm <= penetration.fromStationMm - 50 + 0.5 || joint.stationMm >= penetration.toStationMm + 50 - 0.5);
      return clear || flagged;
    }), { numRuns: 60 });
  });
});

describe('what a penetration brings', () => {
  const policy = resolveDuctSettings({ fireDamperPolicy: 'all' });
  const plain = plan(run(), [wallAcross(1200)]);
  const dampered = plan(run(), [wallAcross(1200)], [], policy);

  it('lists sleeves, packing and sealant, fire dampers and access doors in the BOM (not as sheet metal)', () => {
    const rows = buildDuctBom([plain]).filter((row) => row.category === 'Wall penetrations');
    expect(rows.map((row) => row.description)).toEqual([
      'Wall sleeve, galvanised steel, for a 200 mm wall',
      'Mineral wool packing and acoustic sealant round plain penetrations',
    ]);
    const withDamper = buildDuctBom([dampered]);
    const penetrationRows = withDamper.filter((row) => row.category === 'Wall penetrations').map((row) => row.description);
    expect(penetrationRows.some((description) => description.startsWith('Fire damper'))).toBe(true);
    expect(penetrationRows.some((description) => description.startsWith('Access door'))).toBe(true);
    expect(withDamper.some((row) => row.category === 'Fabricated pieces' && row.description.startsWith('Fire damper'))).toBe(false);
  });

  it('prices each sleeve, and each fire damper with its access door', () => {
    const base = priceDuctPlans([plan(run(), [])], settings);
    const sleeve = priceDuctPlans([plain], settings);
    const damper = priceDuctPlans([dampered], policy);
    expect(base.penetrations).toBe(0);
    expect(sleeve.penetrations).toBeGreaterThan(0);
    expect(damper.penetrations).toBeGreaterThan(sleeve.penetrations + settings.econAccessDoorEach - 1e-9);
    expect(sleeve.total).toBeCloseTo(sleeve.sheet + sleeve.fabrication + sleeve.fittings + sleeve.install + sleeve.insulation + sleeve.flex
      + sleeve.dampers + sleeve.joints + sleeve.hangers + sleeve.penetrations, 6);
  });

  it('schedules the openings for the builder (CSV)', () => {
    const rows = ductPenetrationSchedule([plain, dampered], new Map([['run', 'Supply duct']]));
    expect(rows.map((row) => [row.ref, row.run, row.mark, row.wall, row.fireDamper])).toEqual([
      ['WP-01', 'Supply duct', 'PN-01', 'brick', false], ['WP-02', 'Supply duct', 'PN-01', 'brick', true],
    ]);
    const csv = ductPenetrationScheduleToCsv(rows);
    expect(csv.split('\n')[0]).toBe('Ref,Run,Mark,Wall,Construction,Thickness (mm),Duct,Opening,X (mm),Y (mm),Duct bottom (mm),Angle (deg),Fire damper,Exterior wall');
    expect(csv.split('\n')).toHaveLength(3);
  });

  it('hangs no support inside the wall', () => {
    const supports = planDuctSupports(plain, [unit], settings);
    const penetration = plain.penetrations[0]!;
    expect(supports.hangers.length).toBeGreaterThan(0);
    for (const hanger of supports.hangers) {
      expect(hanger.stationMm < penetration.fromStationMm || hanger.stationMm > penetration.toStationMm).toBe(true);
    }
  });

  it('draws the sleeve and the fire damper in plan, and in 3D', () => {
    expect(buildDuctPlanPresentation(plain).sleeves).toHaveLength(1);
    expect(buildDuctPlanPresentation(plain).fireDampers).toEqual([]);
    const presentation = buildDuctPlanPresentation(dampered);
    expect(presentation.fireDampers.map((damper) => damper.label)).toEqual(['FD FD-01']);
    expect(presentation.sleeves[0]!.label).toMatch(/^PN-01 · SLV \d+×\d+$/);
    const group = new THREE.Group();
    const element = run();
    withActiveDuctBuilding([wallAcross(1200)], [], () => addDuctRunMeshes(group, element, { allElements: [unit, element], ductSettings: policy }));
    expect(group.getObjectByName('duct-sleeves')).toBeDefined();
    expect(group.getObjectByName('duct-accessories')).toBeDefined();
  });
});
