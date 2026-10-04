import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { buildStraightGiDuctElement } from '../giDuctModel';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from '../pipeRoutingSettings';

import { buildCondensateEnvironment } from './condensateEnvironment';
import { resolveCondensateSettings } from './condensateSettings';

const settings = resolveCondensateSettings({});
const routingSettings = DEFAULT_PIPE_ROUTING_SETTINGS;

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W' },
};

function ductObstacles(scene: HvacElement[], ductId: string) {
  return buildCondensateEnvironment(scene, { settings, routingSettings }).obstacles.filter((obstacle) => obstacle.id === ductId);
}

describe('condensate routing around ducts', () => {
  it('retains the physical body and elevation of an old straight duct stub', () => {
    const stub = {
      id: 'old', rotation: 0, supplyZoneRatio: 0,
      ...buildStraightGiDuctElement([{ x: 400, y: 0 }, { x: 400, y: -1200 }], {
        ductKind: 'supply', outerWidthMm: 400, outerHeightMm: 200, elevationMm: 2650,
      }),
    } as HvacElement;
    const obstacles = ductObstacles([unit, stub], 'old');
    expect(obstacles).toHaveLength(1);
    expect(obstacles[0]).toMatchObject({ id: 'old', minY: -1200, maxY: 0, kind: 'equipment' });
    expect((obstacles[0]!.minX + obstacles[0]!.maxX) / 2).toBe(400);
    expect(obstacles[0]!.maxX - obstacles[0]!.minX).toBeGreaterThan(395);
    expect(obstacles[0]!.minZ).toBeCloseTo(stub.elevation, 0);
    expect(obstacles[0]!.maxZ).toBeGreaterThan(stub.elevation);
  });

  it('an L-shaped run blocks its two legs, not the empty corner of its bounding box', () => {
    const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
    const run = buildDuctRunDraftElement({
      port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }, { x: supply.lip.x + 4000, y: supply.lip.y - 3000 }],
    }, 'run');
    const obstacles = ductObstacles([unit, run], 'run');
    expect(obstacles.length).toBeGreaterThanOrEqual(2);
    const emptyCorner = { x: supply.lip.x + 3000, y: supply.lip.y - 800 };
    const blocked = obstacles.some((box) => emptyCorner.x >= box.minX && emptyCorner.x <= box.maxX && emptyCorner.y >= box.minY && emptyCorner.y <= box.maxY);
    expect(blocked).toBe(false);
    const onLeg = { x: supply.lip.x, y: supply.lip.y - 1500 };
    expect(obstacles.some((box) => onLeg.x >= box.minX && onLeg.x <= box.maxX && onLeg.y >= box.minY && onLeg.y <= box.maxY)).toBe(true);
  });

  it('a scene without ducts builds the same obstacles as before', () => {
    const environment = buildCondensateEnvironment([unit], { settings, routingSettings });
    expect(environment.obstacles.every((obstacle) => obstacle.id === 'fdum')).toBe(true);
  });

  it.each(['diffuser', 'return-grille'] as const)('includes the actual %s plenum and neck above its face', (type) => {
    const terminal: HvacElement = {
      ...unit, id: type, type, position: { x: 3000, y: 0 }, width: 595, depth: 595,
      height: 20, elevation: 2400, properties: {},
    };
    const environment = buildCondensateEnvironment([unit, terminal], { settings, routingSettings });
    const boxes = environment.obstacles.filter((obstacle) => obstacle.id === type);
    expect(boxes.length).toBeGreaterThan(0);
    expect(Math.max(...boxes.map((box) => box.maxZ))).toBeGreaterThan(terminal.elevation + terminal.height);
  });
});
