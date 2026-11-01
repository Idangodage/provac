// One section for every service: the ceiling, the soffit, how high each wall goes; a sleeve where a pipe passes through
// a wall at its own height, and none above its top (the floating sleeves of the user's screenshots, 1 November 2026).
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_WALL_HEIGHT, type HvacElement, type Wall } from '../../../types';

import {
  buildingCeiling, buildingSoffitMm, checkWallsReachSoffit, drainFittingsAsBuilt, pipeSleeveBoreMm, pipeWallCrossings, raisedWallUpdates, wallsBelowSoffit,
} from './buildingSection';
import { deriveCondensateEnvelope } from './condensate/condensateEnvironment';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { ductWallsFromWalls, EMPTY_DUCT_BUILDING, setActiveDuctBuilding, type DuctWall } from './duct/ductBuilding';
import { resolveHvacCeilingVoid } from './move/hvacMoveModel';
import { DEFAULT_CEILING_LIMIT_MM } from './pipeRoutingRules';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import { refrigerantPenetrationBomRows, servicePenetrationScheduleRows, type ServicePenetration } from './servicePenetrations';
import { addPipeWallSleeves } from './three3d/pipeWallSleeves';

const at = (type: HvacElement['type'], elevation: number) => ({ type, elevation });
const wall = (id: string, x: number, topZ = 2900, extra: Partial<DuctWall> = {}): DuctWall => ({
  id, a: { x, y: -5000 }, b: { x, y: 5000 }, thicknessMm: 150, baseZ: 0, topZ, structural: false, ...extra,
});

afterEach(() => setActiveDuctBuilding(EMPTY_DUCT_BUILDING.walls, EMPTY_DUCT_BUILDING.rooms));

describe('the ceiling and the soffit', () => {
  it('the ceiling is where what sits flush with it says, whichever service asks', () => {
    const rooms = [{ properties3D: { ceilingHeight: 2700 } }];
    const cassettes = [at('ceiling-cassette-ac', 2400), at('ceiling-cassette-ac', 2400)];
    expect(buildingCeiling(cassettes, rooms).ceilingMm).toBe(2400);
    expect(buildingCeiling([at('diffuser', 2500), at('return-grille', 2500)], rooms).ceilingMm).toBe(2500);
    expect(buildingCeiling([at('ducted-ac', 2650), at('ducted-ac', 2600)], rooms).ceilingMm).toBe(2600);
    expect(buildingCeiling([], rooms).ceilingMm).toBe(2700);
    expect(buildingCeiling([]).ceilingMm).toBe(2400);
    // Drains and moves read the same: cassettes under rooms drawn at 2700 no longer give two ceilings.
    const scene = cassettes as HvacElement[];
    const settings = resolveCondensateSettings({});
    expect(deriveCondensateEnvelope(scene, settings, DEFAULT_PIPE_ROUTING_SETTINGS, rooms as never).ceilingPlaneMm).toBe(2400);
    expect(resolveHvacCeilingVoid(scene, rooms, 2900).ceilingMm).toBe(2400);
  });

  it('the soffit is a service\'s own setting, else the routing ceiling limit', () => {
    expect(buildingSoffitMm({ ceilingLimitMm: 2900 })).toBe(2900);
    expect(buildingSoffitMm({ ceilingLimitMm: 2900 }, 3100)).toBe(3100);
  });

  it('a new wall reaches the default soffit', () => {
    expect(DEFAULT_WALL_HEIGHT).toBe(DEFAULT_CEILING_LIMIT_MM);
  });
});

describe('walls and the soffit', () => {
  it('flags walls under the soffit, not those low by design, and one click raises them', () => {
    const walls = [wall('low', 0, 2700), wall('tall', 1000), wall('half', 2000, 1200, { lowByDesign: true })];
    expect(wallsBelowSoffit(walls, 2900).map((entry) => entry.id)).toEqual(['low']);
    const [issue] = checkWallsReachSoffit(walls, 2900);
    expect(issue).toMatchObject({ code: 'BUILDING_WALL_LOW', level: 'advisory', fix: { kind: 'raise-walls-to-soffit', wallIds: ['low'], soffitMm: 2900 } });
    expect(issue!.message).toBe('1 of 3 walls stop at 2700 mm, under the 2900 mm soffit: pipes and ducts higher up pass over them, with no sleeve.');
    expect(checkWallsReachSoffit([wall('tall', 0)], 2900)).toEqual([]);

    const drawn = [{ id: 'low', properties3D: { height: 2700, baseElevation: 100 } }, { id: 'other', properties3D: { height: 2000, baseElevation: 0 } }] as Wall[];
    expect(raisedWallUpdates(drawn, ['low'], 2900)).toEqual([{ id: 'low', updates: { properties3D: { height: 2800, baseElevation: 100 } } }]);
  });

  it('a half-height partition reads as low by design from the drawing', () => {
    const base = { id: 'p', startPoint: { x: 0, y: 0 }, endPoint: { x: 1000, y: 0 }, thickness: 100 };
    expect(ductWallsFromWalls([{ ...base, partitionMode: 'half' }])[0]!.lowByDesign).toBe(true);
    expect(ductWallsFromWalls([{ ...base, partitionMode: 'full' }])[0]!.lowByDesign).toBeUndefined();
    expect(ductWallsFromWalls([base])[0]!.topZ).toBe(DEFAULT_WALL_HEIGHT);
  });
});

describe('where a pipe passes through a wall', () => {
  const run = (z: number) => [{ a: { x: -1000, y: 0, z }, b: { x: 1000, y: 0, z } }];

  it('at its own height, square or oblique; above the top, or under the base, it does not', () => {
    const [crossing] = pipeWallCrossings(run(2600), 33, [wall('w', 0)]);
    expect(crossing).toMatchObject({ wallId: 'w', z: 2600, angleDeg: 0, thicknessMm: 150, throughMm: 150 });
    expect(crossing!.point).toEqual({ x: 0, y: 0 });
    // Over a 2700 wall, with the insulation clear of its top.
    expect(pipeWallCrossings(run(2740), 33, [wall('w', 0, 2700)])).toEqual([]);
    // Its insulation still in the wall.
    expect(pipeWallCrossings(run(2730), 33, [wall('w', 0, 2700)])).toHaveLength(1);
    expect(pipeWallCrossings(run(2600), 33, [wall('w', 0, 2900, { baseZ: 2700 })])).toEqual([]);
    const oblique = pipeWallCrossings([{ a: { x: -1000, y: -1000, z: 2600 }, b: { x: 1000, y: 1000, z: 2600 } }], 33, [wall('w', 0)])[0]!;
    expect(oblique.angleDeg).toBeCloseTo(45, 6);
    expect(oblique.throughMm).toBeCloseTo(150 * Math.SQRT2, 6);
  });

  it('in order along the pipe, the height read where it crosses on a sloping run', () => {
    const crossings = pipeWallCrossings([{ a: { x: -1000, y: 0, z: 2600 }, b: { x: 1000, y: 0, z: 2800 } }], 30, [wall('later', 500), wall('sooner', -500)]);
    expect(crossings.map((crossing) => crossing.wallId)).toEqual(['sooner', 'later']);
    expect(crossings[0]!.z).toBeCloseTo(2650, 6);
    expect(crossings[1]!.z).toBeCloseTo(2750, 6);
  });

  it('a riser crosses nothing', () => {
    expect(pipeWallCrossings([{ a: { x: 0, y: 0, z: 2000 }, b: { x: 0, y: 0, z: 2600 } }], 30, [wall('w', 0)])).toEqual([]);
  });

  it('a sleeve\'s bore is the insulated pipe with its clearance, to the next 5 mm', () => {
    expect(pipeSleeveBoreMm(33.3)).toBe(95);
    expect(pipeSleeveBoreMm(30.2)).toBe(90);
  });
});

describe('a drain\'s sleeves as built', () => {
  const sleeve = (z: number, note = 'w') => ({ kind: 'wall-sleeve' as const, point: { x: 0, y: 0, z }, outerDiameterMm: 32, note });
  const elbow = { kind: 'elbow-90' as const, point: { x: 0, y: 0, z: 2800 }, outerDiameterMm: 32 };

  it('only where a wall holds the pipe at its own height: none floats above a wall it passes over', () => {
    const fittings = [sleeve(2650), sleeve(2800), elbow];
    expect(drainFittingsAsBuilt(fittings, [wall('w', 0, 2700)]).map((fitting) => fitting.point.z)).toEqual([2650, 2800]);
    expect(drainFittingsAsBuilt(fittings, [wall('w', 0, 2700)]).filter((fitting) => fitting.kind === 'wall-sleeve')).toHaveLength(1);
    // Raised to the soffit: every sleeve stands.
    expect(drainFittingsAsBuilt(fittings, [wall('w', 0, 2900)]).filter((fitting) => fitting.kind === 'wall-sleeve')).toHaveLength(2);
  });

  it('with no walls known nothing is judged; an outlet\'s own sleeve always stands; a wall gone takes its sleeve', () => {
    expect(drainFittingsAsBuilt([sleeve(2800)], [])).toHaveLength(1);
    expect(drainFittingsAsBuilt([{ ...sleeve(2800), note: undefined }], [wall('w', 0, 2700)])).toHaveLength(1);
    expect(drainFittingsAsBuilt([sleeve(2600)], [wall('elsewhere', 5000)])).toEqual([]);
  });
});

describe('a refrigerant line\'s sleeves', () => {
  const points = (z: number) => [new THREE.Vector3(-1000, 0, z), new THREE.Vector3(1000, 0, z)];
  const sleevesOf = (group: THREE.Group) => group.children.filter((child) => child.name === 'pipe-wall-sleeve');

  it('in 3D: a collar at the height it crosses, proud of both faces, derived from the walls as they are', () => {
    setActiveDuctBuilding([wall('w', 0)], []);
    const group = new THREE.Group();
    addPipeWallSleeves(group, points(2600), 33.3);
    const [sleeve] = sleevesOf(group);
    expect(sleeve!.position.toArray()).toEqual([0, 0, 2600]);
    const box = new THREE.Box3().setFromObject(sleeve!);
    expect(box.max.x - box.min.x).toBeCloseTo(150 + 24, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(95, 0);
    // Over a low wall, none.
    setActiveDuctBuilding([wall('w', 0, 2500)], []);
    const over = new THREE.Group();
    addPipeWallSleeves(over, points(2600), 33.3);
    expect(sleevesOf(over)).toEqual([]);
  });

  const penetration = (service: string, elementId: string, bore = 95): ServicePenetration => ({
    elementId, service, wallId: 'w', point: { x: 1000.4, y: 20.2 }, z: 2600, direction: { x: 1, y: 0 }, angleDeg: 0, thicknessMm: 150, throughMm: 150,
    structural: true, material: 'brick', exterior: false, pipeOuterMm: 66.7, sleeveBoreMm: bore,
  });

  it('on the schedule, numbered on from the ducts\', with every service', () => {
    const rows = servicePenetrationScheduleRows([penetration('gas', 'g'), penetration('drain', 'd')], new Map([['g', 'Gas 1']]), 3);
    expect(rows[0]).toMatchObject({ ref: 'WP-04', run: 'Gas 1', mark: 'PS-01', wall: 'brick', duct: 'Gas line Ø67', opening: 'Ø95', x: 1000, y: 20, bottomZ: 2567, fireDamper: false });
    expect(rows[1]).toMatchObject({ ref: 'WP-05', run: 'd', duct: 'Drain Ø67' });
  });

  it('in the BOM: a sleeve per crossing by size and wall, the seal, and only refrigerant (a drain has its own BOM)', () => {
    const rows = refrigerantPenetrationBomRows([penetration('gas', 'g'), penetration('gas', 'g2'), penetration('liquid', 'l', 90), penetration('drain', 'd')]);
    expect(rows.map((row) => `${row.size} × ${row.quantity}`)).toEqual(['Ø90 × 1', 'Ø95 × 2', '— × 0.9']);
    expect(refrigerantPenetrationBomRows([penetration('drain', 'd')])).toEqual([]);
  });
});
