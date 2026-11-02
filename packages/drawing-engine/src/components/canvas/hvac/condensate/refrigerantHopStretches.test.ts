import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { buildCondensateEnvironment } from './condensateEnvironment';
import type { RefrigerantHopProposal } from './condensateNetworkPlanner';
import { resolveCondensateSettings } from './condensateSettings';
import { buildRefrigerantHopUpdates, refrigerantHopStretches } from './refrigerantHopProposal';

function pipe(id: string, points: Point2D[], z: number, lineKind: 'gas' | 'liquid' = 'liquid'): HvacElement {
  return { id, type: 'refrigerant-pipe', position: points[0]!, rotation: 0,
    width: 4000, depth: 4000, height: 40, elevation: z - 20, mountType: 'ceiling',
    label: id, supplyZoneRatio: 0.5,
    properties: { routePoints: points, routeNodes3d: points.map((point) => ({ ...point, z })),
      pipeDiameterMm: lineKind === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 9, lineKind,
      fieldBendConstruction: 'formed-tube' },
  };
}

const fromUnit = (run: HvacElement) => {
  run.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: 'unit',
    portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2500 };
  return run;
};

const rounded = (stretches: Array<{ a: Point2D; b: Point2D }>) => stretches.map(({ a, b }) => [Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)]);

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('where a refrigerant hop over a drain can stand', () => {
  it('on its level legs, clear of its port stub and corners by a hop\'s elbows', () => {
    const run = fromUnit(pipe('liquid', [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }], 2500));
    // Port stub 200 + half an approach 60 + an approach 120 from the unit; a corner 150 + an approach 120.
    expect(rounded(refrigerantHopStretches(run, [run]))).toEqual([[380, 0, 3730, 0], [4000, 270, 4000, 2730]]);
  });

  it('is where a hop is built: one the drain\'s window past the stretch\'s start is, one short of it is not', () => {
    const run = fromUnit(pipe('liquid', [{ x: 0, y: 0 }, { x: 4000, y: 0 }], 2500));
    const at = (x: number): RefrigerantHopProposal => ({ key: `hop-${x}`, refrigerantElementId: run.id, point: { x, y: 0 },
      networkId: 'drain', condensateZ: 2500, requiredCentrelineZ: 2700, halfWindowMm: 50, withinSoffit: true });
    const routing = { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3400 };
    const start = refrigerantHopStretches(run, [run])[0]!.a.x;
    expect(buildRefrigerantHopUpdates([run], [at(start + 50)], resolveCondensateSettings({}), routing).updates).toHaveLength(1);
    expect(buildRefrigerantHopUpdates([run], [at(start + 30)], resolveCondensateSettings({}), routing).rejected[0]?.reason).toMatch(/port stub/);
  });

  it('none on a riser or a leg too short for a hop\'s elbows', () => {
    const run = fromUnit(pipe('liquid', [{ x: 0, y: 0 }, { x: 300, y: 0 }], 2500));
    run.properties.routeNodes3d = [{ x: 0, y: 0, z: 2500 }, { x: 300, y: 0, z: 2500 }, { x: 300, y: 0, z: 2815 }, { x: 3000, y: 0, z: 2815 }];
    expect(rounded(refrigerantHopStretches(run, [run]))).toEqual([[570, 0, 2730, 0]]);
  });

  it('not where another run passes over it (a liquid dipped under its gas)', () => {
    const liquid = pipe('liquid', [{ x: 0, y: 0 }, { x: 4000, y: 0 }], 2690);
    const gas = pipe('gas', [{ x: 2000, y: -2000 }, { x: 2000, y: 2000 }], 2815, 'gas');
    const environment = buildCondensateEnvironment([liquid, gas], { settings: resolveCondensateSettings({}), routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    const stretches = environment.services.find((service) => service.elementId === 'liquid')!.hopStretches!;
    expect(stretches).toHaveLength(2);
    expect(stretches[0]!.b.x).toBeLessThan(1990);
    expect(stretches[1]!.a.x).toBeGreaterThan(2010);
    // The gas, over nothing, can hop anywhere on its leg.
    expect(environment.services.find((service) => service.elementId === 'gas')!.hopStretches).toHaveLength(1);
  });
});
