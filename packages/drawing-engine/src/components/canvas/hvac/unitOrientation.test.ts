import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Wall } from '../../../types';

import { resolveCondensateSettings } from './condensate/condensateSettings';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';
import {
  applyUnitTurns,
  DEFAULT_AUTO_TURN_SETTINGS,
  isFourWayCassette,
  planUnitOrientations,
  unitTurnText,
  type UnitOrientationOptions,
} from './unitOrientation';

function cassette(id: string, x: number, y: number, rotation: number, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation, width: 1043, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: 'MHI 4-Way Cassette — FDT28KXZE1 (3D)', modelLabel: 'MHI FDT28KXZE1', supplyZoneRatio: 0.5,
    properties: { modelCode: 'FDT28KXZE1', capacityKw: 2.8, ...properties },
  };
}

function outdoor(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'outdoor-unit', position: { x, y }, rotation: 0, width: 1350, depth: 720, height: 1690, elevation: 0,
    mountType: 'floor', label: 'Outdoor', modelLabel: 'MHI FDC280KXZE1', supplyZoneRatio: 0.5, properties: {},
  };
}

function gully(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: id.toUpperCase(), supplyZoneRatio: 0.5,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  };
}

function wall(id: string, a: { x: number; y: number }, b: { x: number; y: number }): Wall {
  return { id, startPoint: a, endPoint: b, thickness: 150 } as Wall;
}

const options = (overrides: Partial<UnitOrientationOptions> = {}): UnitOrientationOptions => ({
  refrigerant: true, condensate: true, walls: [], settings: DEFAULT_AUTO_TURN_SETTINGS,
  condensateSettings: resolveCondensateSettings({ soffitMm: 3400 }), routing: DEFAULT_PIPE_ROUTING_SETTINGS,
  replaceable: new Set(), ...overrides,
});

/** The way the unit's pipes leave it (its pair's bundle). */
const pairDirection = (unit: HvacElement) => getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port')!.direction;

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('Auto-turn: 4-way cassettes turned for shorter runs', () => {
  // The outdoor unit and the gully lie east of the cassette.
  const services = [outdoor('odu', 9000, 0), gully('fg', 8000, 2200)];

  it('a cassette whose connections face away from its services is turned towards them', () => {
    const unit = cassette('c-1', 2000, 0, 0);
    const away = (pairDirection(unit).x < -0.5) ? unit : cassette('c-1', 2000, 0, 180);
    expect(pairDirection(away).x).toBeLessThan(-0.5);
    const { turns } = planUnitOrientations([away, ...services], options());
    expect(turns).toHaveLength(1);
    const turned = applyUnitTurns([away], turns)[0]!;
    // Towards them now: east, and shorter by a real gain.
    expect(pairDirection(turned).x).toBeGreaterThan(0.5);
    expect(turns[0]!.gainMm).toBeGreaterThanOrEqual(DEFAULT_AUTO_TURN_SETTINGS.minGainMm);
    expect(turns[0]!.after.refrigerantMm!).toBeLessThan(turns[0]!.before.refrigerantMm!);
    expect(unitTurnText(turns[0]!)).toMatch(/turned (90° (anti)?clockwise|180°): .*shorter/);
  });

  it('a cassette already facing its services stays', () => {
    const unit = cassette('c-1', 2000, 0, 0);
    const facing = pairDirection(unit).x > 0.5 ? unit : cassette('c-1', 2000, 0, 180);
    expect(planUnitOrientations([facing, ...services], options()).turns).toHaveLength(0);
  });

  it('a wall in front of the connection side refuses that turn', () => {
    const unit = cassette('c-1', 2000, 0, 0);
    const away = pairDirection(unit).x < -0.5 ? unit : cassette('c-1', 2000, 0, 180);
    // A wall 150 mm off the east face: no room there for the connections.
    const east = away.position.x + away.width + 150;
    const { turns } = planUnitOrientations([away, ...services], options({ walls: [wall('w-1', { x: east, y: -2000 }, { x: east, y: 3000 })] }));
    for (const turn of turns) expect(pairDirection(applyUnitTurns([away], [turn])[0]!).x).toBeLessThan(0.5);
  });

  it('keeps a cassette turned by hand, a locked one and one piped by hand; only 4-way cassettes', () => {
    const unit = cassette('c-1', 2000, 0, 0);
    const away = pairDirection(unit).x < -0.5 ? unit : cassette('c-1', 2000, 0, 180);
    const byHand = { ...away, properties: { ...away.properties, orientationSetBy: 'user' } };
    expect(planUnitOrientations([byHand, ...services], options()).kept).toEqual([expect.objectContaining({ unitId: 'c-1', reason: 'turned by hand' })]);
    const locked = { ...away, properties: { ...away.properties, locked: true } };
    expect(planUnitOrientations([locked, ...services], options()).kept[0]!.reason).toBe('locked');
    const pipe: HvacElement = {
      id: 'p-1', type: 'refrigerant-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 1, depth: 1, height: 1, elevation: 2600, mountType: 'ceiling',
      label: 'p', supplyZoneRatio: 0, properties: { lineKind: 'gas', routePoints: [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
        startConnection: { portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2600, connectionKind: 'unit-port', sourceElementId: 'c-1' } },
    };
    expect(planUnitOrientations([away, pipe, ...services], options()).kept[0]!.reason).toMatch(/kept as they are/);
    // Replaced by this Auto route: it may turn.
    expect(planUnitOrientations([away, pipe, ...services], options({ replaceable: new Set(['p-1']) })).turns).toHaveLength(1);
    expect(isFourWayCassette({ ...away, label: 'Cassette', modelLabel: 'MHI FDTS', properties: { modelCode: 'FDTS28' } })).toBe(false);
  });

  it('turns only for a real gain', () => {
    const unit = cassette('c-1', 2000, 0, 0);
    const away = pairDirection(unit).x < -0.5 ? unit : cassette('c-1', 2000, 0, 180);
    const strict = { ...DEFAULT_AUTO_TURN_SETTINGS, minGainMm: 1e6 };
    expect(planUnitOrientations([away, ...services], options({ settings: strict })).turns).toHaveLength(0);
    expect(planUnitOrientations([away, ...services], options({ settings: { ...DEFAULT_AUTO_TURN_SETTINGS, enabled: false } })).turns).toHaveLength(0);
  });

  it('a turn is on the unit\'s centre, marked as Auto route\'s', () => {
    const unit = cassette('c-1', 2000, 0, 0);
    const [turned] = applyUnitTurns([unit], [{ unitId: 'c-1', label: 'c', angleDeg: 90, fromDeg: 0, toDeg: 90, before: { refrigerantMm: 1, drainMm: 1 }, after: { refrigerantMm: 1, drainMm: 1 }, gainMm: 1 }]);
    expect(turned!.rotation).toBe(90);
    expect(turned!.position).toEqual(unit.position);
    expect(turned!.properties.orientationSetBy).toBe('auto-route');
  });
});
