import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { resolveCondensateSettings } from './condensate/condensateSettings';
import { readCondensatePipeSpec } from './condensate/condensateTypes';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';
import { applyServiceRouteCommand } from './serviceRouteValidation';
import { planUnifiedAutoRoute, unifiedRouteCommand, type UnifiedAutoRouteOptions } from './unifiedAutoRoute';
import { DEFAULT_AUTO_TURN_SETTINGS } from './unitOrientation';

const condensateSettings = resolveCondensateSettings({});

/** A 4-way cassette at `rotation` (its connections leave on its local +x side). */
function cassette(id: string, x: number, rotation: number): HvacElement {
  const element: HvacElement = { id, type: 'ceiling-cassette-ac', category: 'indoor-unit',
    label: id, position: { x, y: 300 }, rotation, width: 600, depth: 600, height: 250,
    elevation: 2200, mountType: 'ceiling', supplyZoneRatio: 0, properties: { capacityKw: 2.8, dischargeWays: 4 } };
  element.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([element])[0]!.liquidElevationMm;
  return element;
}

function outdoor(): HvacElement {
  const element: HvacElement = { id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit',
    label: 'outdoor', position: { x: 6900, y: 2600 }, rotation: 180, width: 900, depth: 450, height: 1200,
    elevation: 0, mountType: 'floor', supplyZoneRatio: 0, properties: {} };
  element.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([element])[0]!.gasElevationMm;
  return element;
}

function gully(): HvacElement {
  return { id: 'fg', type: 'condensate-gully', position: { x: 2400, y: -1300 }, rotation: 0, width: 200, depth: 200, height: 60,
    elevation: 0, mountType: 'floor', label: 'fg', supplyZoneRatio: 0.5,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' } };
}

const options = (turn: boolean): UnifiedAutoRouteOptions => ({
  services: { gas: true, liquid: true, condensate: true },
  refrigerant: { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' },
  condensate: { settings: condensateSettings },
  ...(turn ? { orientation: DEFAULT_AUTO_TURN_SETTINGS } : {}),
});

const direction = (unit: HvacElement) => getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port')!.direction;

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('Auto route turns a 4-way cassette first', () => {
  it('turns the cassette towards its services, lays the routes to it as turned, all in one command', async () => {
    // Its connections face west; the outdoor unit and the gully lie east.
    const away = [0, 90, 180, 270].map((rotation) => cassette('c-1', 500, rotation)).find((unit) => direction(unit).x < -0.5)!;
    const scene = [outdoor(), away, gully()];
    const result = await planUnifiedAutoRoute(scene, options(true));
    expect(result.orientation?.turns, result.issues.join(' ')).toHaveLength(1);
    const turned = result.orientation!.units[0]!;
    expect(direction(turned).x).toBeGreaterThan(0.5);
    expect(turned.properties.orientationSetBy).toBe('auto-route');
    expect(result.refrigerant!.complete, result.refrigerant!.issues.join(' ')).toBe(true);
    expect(result.condensate!.metrics.unitsConnected).toBe(1);
    // One command: the turn first, the routes laid to it.
    const command = unifiedRouteCommand(result);
    expect(command.updates?.[0]).toMatchObject({ id: 'c-1', updates: { rotation: turned.rotation } });
    const after = applyServiceRouteCommand(scene, command);
    const unit = after.find((element) => element.id === 'c-1')!;
    expect(unit.rotation).toBe(turned.rotation);
    const ports = getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port')!;
    const lines = after.filter((element) => element.type === 'refrigerant-pipe');
    const atUnit = lines.flatMap((line) => {
      const spec = resolveRefrigerantPipeSpec(line.properties);
      return [spec.startConnection, spec.endConnection].filter((end) => end?.sourceElementId === 'c-1');
    });
    expect(atUnit.length).toBeGreaterThan(0);
    for (const end of atUnit) {
      const near = Math.min(Math.hypot(end!.portPoint.x - ports.gasPoint.x, end!.portPoint.y - ports.gasPoint.y),
        Math.hypot(end!.portPoint.x - ports.liquidPoint.x, end!.portPoint.y - ports.liquidPoint.y));
      expect(near).toBeLessThan(1);
    }
    const drain = after.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).drainStart?.unitId === 'c-1');
    expect(drain).toBeDefined();
  }, 180000);

  it('without Auto-turn the cassette stays as placed', async () => {
    const away = [0, 90, 180, 270].map((rotation) => cassette('c-1', 500, rotation)).find((unit) => direction(unit).x < -0.5)!;
    const result = await planUnifiedAutoRoute([outdoor(), away, gully()], options(false));
    expect(result.orientation).toBeUndefined();
    expect(unifiedRouteCommand(result).updates?.some((update) => update.id === 'c-1')).toBe(false);
  }, 180000);
});
