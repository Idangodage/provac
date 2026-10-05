import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import type { ServiceCtx } from './ductAutoContext';
import { generateAutoDuct, inspectAutoDuctRouting, type AutoDuctRequest, type AutoDuctResult } from './ductAutoLayout';
import { planAutoRouteDucts } from './ductAutoRoute';
import { buildDuctBom } from './ductBom';
import type { DuctWallInput } from './ductBuilding';
import { resolveDuctSettings, type DuctDesignSettings } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';
import { buildRoutingGraph } from './optimizer/routingGraph';
import { SizingModel } from './optimizer/sizingModel';

/*
 * Two rooms one above the other on plan: A (the unit's) and B beyond a 100 mm
 * partition 2.5 m in front of the supply collar, inside 200 mm exterior walls.
 */
const unit: HvacElement = {
  id: 'unit', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0,
  width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
  label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const lip = supply.lip;
// The collar faces −Y: "ahead" is −Y.
const ahead = (distance: number, across = 0): Point2D => ({ x: lip.x + across, y: lip.y - distance });
const partitionY = lip.y - 2500;
const [xMin, xMax, yTop, yBottom] = [lip.x - 3500, lip.x + 3500, lip.y + 2000, lip.y - 7000];
const wall = (id: string, a: Point2D, b: Point2D, thickness: number, extra: Partial<DuctWallInput> = {}): DuctWallInput => ({
  id, startPoint: a, endPoint: b, thickness, baseZ: 0, topZ: 3000, structural: thickness >= 200, ...extra,
});
const walls: DuctWallInput[] = [
  wall('north', { x: xMin, y: yTop }, { x: xMax, y: yTop }, 200),
  wall('south', { x: xMin, y: yBottom }, { x: xMax, y: yBottom }, 200),
  wall('west', { x: xMin, y: yBottom }, { x: xMin, y: yTop }, 200),
  wall('east', { x: xMax, y: yBottom }, { x: xMax, y: yTop }, 200),
  wall('partition', { x: xMin, y: partitionY }, { x: xMax, y: partitionY }, 100, { material: 'partition' }),
];
const rooms = [
  { id: 'A', vertices: [{ x: xMin + 100, y: partitionY + 50 }, { x: xMax - 100, y: partitionY + 50 }, { x: xMax - 100, y: yTop - 100 }, { x: xMin + 100, y: yTop - 100 }] },
  { id: 'B', vertices: [{ x: xMin + 100, y: yBottom + 100 }, { x: xMax - 100, y: yBottom + 100 }, { x: xMax - 100, y: partitionY - 50 }, { x: xMin + 100, y: partitionY - 50 }] },
];

/** A square diffuser centred at `at`, its spigot facing back at the collar. */
function diffuser(id: string, at: Point2D): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', rotation: 180, position: { x: at.x - envelope.widthMm / 2, y: at.y - envelope.depthMm / 2 },
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

const settings = resolveDuctSettings({ soffitMm: 3000 });
const inB = diffuser('sd-b', ahead(4500));
const inA = diffuser('sd-a', ahead(1400, 1600));

function design(terminals: HvacElement[], options: { rooms?: typeof rooms; settings?: DuctDesignSettings } = {}): AutoDuctResult {
  const request: AutoDuctRequest = {
    unitId: unit.id, terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', layout: 'auto', shape: 'optimal',
    services: { supply: true, return: false }, rebuildExisting: false, walls, ...(options.rooms ? { rooms: options.rooms } : {}),
  };
  return generateAutoDuct([unit, ...terminals], request, options.settings ?? settings);
}

const best = (result: AutoDuctResult) => result.designs[result.picks?.lifeCycle ?? 0];

afterEach(() => inspectAutoDuctRouting(null));

describe('a unit serving a room beyond a partition', () => {
  it('passes through the partition by sleeve, clean, when its system spans the rooms', () => {
    const result = design([inA, inB], { rooms });
    const chosen = best(result)!;
    expect(chosen.errors).toBe(0);
    const plans = chosen.services.flatMap((service) => service.plans);
    const penetrations = plans.flatMap((plan) => plan.penetrations);
    expect(penetrations.map((penetration) => penetration.wallId)).toEqual(['partition']);
    expect(penetrations[0]).toMatchObject({ fireDamper: false, exterior: false, onFlex: false });
    expect(plans.flatMap((plan) => plan.issues).filter((issue) => issue.code.startsWith('DU_PENETRATION') && issue.severity !== 'info')).toEqual([]);
    // Both terminals served; the sleeve is in the BOM.
    const served = new Set(chosen.runs.flatMap((run) => { const end = readDuctRunSpec(run)?.end; return end?.kind === 'terminal' ? [end.terminalId] : []; }));
    expect([...served].sort()).toEqual(['sd-a', 'sd-b']);
    expect(buildDuctBom(plans).some((row) => row.category === 'Wall penetrations' && row.description.startsWith('Wall sleeve'))).toBe(true);
    expect(chosen.cost.penetrations).toBeGreaterThan(0);
  }, 120000);

  it('never crosses a wall in a one-room system (the same layout without the rooms)', () => {
    const result = design([inA, inB]);
    expect(result.designs.length).toBeGreaterThan(0);
    expect(result.designs.every((candidate) => candidate.errors > 0)).toBe(true);
    const issues = result.services.flatMap((service) => service.issues);
    expect(issues.some((issue) => issue.code === 'DU_AUTO_WALL')).toBe(true);
    expect(issues.some((issue) => issue.code === 'DU_AUTO_WHY' && issue.message.startsWith('SD-B: the duct would have to pass through a wall it may not cross'))).toBe(true);
  }, 120000);

  it('puts a fire damper in the partition when the policy asks for one in every wall', () => {
    const result = design([inA, inB], { rooms, settings: resolveDuctSettings({ soffitMm: 3000, fireDamperPolicy: 'all' }) });
    const chosen = best(result)!;
    expect(chosen.errors).toBe(0);
    const plans = chosen.services.flatMap((service) => service.plans);
    expect(plans.flatMap((plan) => plan.penetrations).map((penetration) => [penetration.wallId, penetration.fireDamper])).toEqual([['partition', true]]);
    expect(plans.flatMap((plan) => plan.pieces).filter((piece) => piece.kind === 'fire-damper')).toHaveLength(1);
  }, 120000);

  it('only adds edges through the interior walls a spanning system may cross (everything else as before)', () => {
    const contexts: ServiceCtx[] = [];
    inspectAutoDuctRouting((entry) => { contexts.push(entry.ctx); });
    design([inA, inB], { rooms });
    const ctx = contexts[0]!;
    expect(ctx.crossing).toBeDefined();
    const model = new SizingModel(ctx, 'rect', ctx.airflowM3h);
    // The same context without the crossing rule: the graph a one-room system gets.
    const plain = buildRoutingGraph({ ...ctx, crossing: undefined }, model, 0);
    const withCrossing = buildRoutingGraph(ctx, model, 0);
    expect(plain.cross).toBeUndefined();
    expect(withCrossing.crossWalls).toEqual(['partition']);
    expect(withCrossing.xs).toEqual(plain.xs);
    expect(withCrossing.ys).toEqual(plain.ys);
    expect([...withCrossing.nodeClear]).toEqual([...plain.nodeClear]);
    let crossings = 0;
    for (let e = 0; e < plain.neighbour.length; e += 1) {
      if (withCrossing.cross![e]! >= 0) {
        crossings += 1;
        expect(plain.neighbour[e]).toBe(-1);
        expect(withCrossing.crossCost![e]).toBe(settings.econPenetrationEach);
        continue;
      }
      expect(withCrossing.neighbour[e]).toBe(plain.neighbour[e]);
      expect(withCrossing.edgeLength[e]).toBe(plain.edgeLength[e]);
      expect(withCrossing.corridor[e]).toBe(plain.corridor[e]);
    }
    expect(crossings).toBeGreaterThan(0);
  }, 120000);

  it('in the unified Auto route, serves the other room\'s terminal dedicated to the unit, and says what it made', () => {
    // Auto route adopts only its own room's free terminals; one in another room joins by being dedicated to the unit.
    const dedicated = { ...inB, properties: { ...inB.properties, airSystem: { unitId: unit.id } } };
    const result = planAutoRouteDucts([unit, inA, dedicated], { supply: true, return: false }, {
      settings, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing', walls, rooms,
    });
    const designed = result.units.find((entry) => entry.unitId === unit.id)!;
    expect(designed.status).toBe('designed');
    expect(designed.supplyTerminals).toBe(2);
    expect(designed.notes.some((note) => note.startsWith('The supply duct passes through a wall: a sleeve, no fire dampers'))).toBe(true);
    // Without the dedication the far terminal is left for its own room's system.
    const own = planAutoRouteDucts([unit, inA, inB], { supply: true, return: false }, {
      settings, shape: 'optimal', fanSpeed: 'hi', rebuildExisting: false, scope: 'drawing', walls, rooms,
    });
    expect(own.units.find((entry) => entry.unitId === unit.id)!.supplyTerminals).toBe(1);
  }, 120000);
});

/*
 * A unit in a corridor serving two bedrooms beyond the corridor wall, a
 * partition between them: the corridor wall 2 m in front of the collar, the
 * bedrooms side by side across the collar's axis.
 */
describe('a corridor unit serving two bedrooms', () => {
  const corridorY = lip.y - 2000;
  const [left, right, back, far] = [lip.x - 4000, lip.x + 4000, lip.y + 2400, lip.y - 6500];
  const corridorWalls: DuctWallInput[] = [
    wall('outer-back', { x: left, y: back }, { x: right, y: back }, 200),
    wall('outer-far', { x: left, y: far }, { x: right, y: far }, 200),
    wall('outer-left', { x: left, y: far }, { x: left, y: back }, 200),
    wall('outer-right', { x: right, y: far }, { x: right, y: back }, 200),
    wall('corridor', { x: left, y: corridorY }, { x: right, y: corridorY }, 100, { material: 'partition' }),
    wall('between', { x: lip.x, y: far }, { x: lip.x, y: corridorY }, 100, { material: 'partition' }),
  ];
  const corridorRooms = [
    { id: 'corridor', vertices: [{ x: left + 100, y: corridorY + 50 }, { x: right - 100, y: corridorY + 50 }, { x: right - 100, y: back - 100 }, { x: left + 100, y: back - 100 }] },
    { id: 'bedroom-1', vertices: [{ x: left + 100, y: far + 100 }, { x: lip.x - 50, y: far + 100 }, { x: lip.x - 50, y: corridorY - 50 }, { x: left + 100, y: corridorY - 50 }] },
    { id: 'bedroom-2', vertices: [{ x: lip.x + 50, y: far + 100 }, { x: right - 100, y: far + 100 }, { x: right - 100, y: corridorY - 50 }, { x: lip.x + 50, y: corridorY - 50 }] },
  ];
  const bedroom1 = diffuser('sd-1', ahead(4300, -2000));
  const bedroom2 = diffuser('sd-2', ahead(4300, 2000));

  it('is clean with two sleeves, every one through an interior wall', () => {
    const result = generateAutoDuct([unit, bedroom1, bedroom2], {
      unitId: unit.id, terminalIds: [bedroom1.id, bedroom2.id], fanSpeed: 'hi', layout: 'auto', shape: 'optimal',
      services: { supply: true, return: false }, rebuildExisting: false, walls: corridorWalls, rooms: corridorRooms,
    }, settings);
    const chosen = best(result)!;
    const issues = [...result.issues, ...result.services.flatMap((service) => service.issues)].filter((issue) => issue.severity === 'error').map((issue) => issue.message);
    expect(chosen.errors, issues.join(' / ')).toBe(0);
    const plans = chosen.services.flatMap((service) => service.plans);
    const served = new Set(chosen.runs.flatMap((run) => { const end = readDuctRunSpec(run)?.end; return end?.kind === 'terminal' ? [end.terminalId] : []; }));
    expect([...served].sort()).toEqual(['sd-1', 'sd-2']);
    const penetrations = plans.flatMap((plan) => plan.penetrations);
    expect(penetrations).toHaveLength(2);
    for (const penetration of penetrations) {
      expect(['corridor', 'between']).toContain(penetration.wallId);
      expect(penetration).toMatchObject({ exterior: false, onFlex: false, fireDamper: false });
    }
    expect(plans.flatMap((plan) => plan.issues).filter((issue) => issue.code.startsWith('DU_PENETRATION') && issue.severity !== 'info')).toEqual([]);
    expect(buildDuctBom(plans).find((row) => row.category === 'Wall penetrations' && row.description.startsWith('Wall sleeve'))?.quantity).toBe(2);
  }, 120000);
});
