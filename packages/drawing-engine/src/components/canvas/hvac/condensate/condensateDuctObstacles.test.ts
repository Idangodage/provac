import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { buildDuctRunDraftElement } from '../duct/ductDraft';
import { buildStraightGiDuctElement } from '../giDuctModel';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from '../pipeRoutingSettings';

import { buildCondensateEnvironment } from './condensateEnvironment';
import { unitFootprintBoundsMm } from './condensatePorts';
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
  it('an old straight duct stub is still one bounding-box obstacle, exactly as before', () => {
    const stub = {
      id: 'old', rotation: 0, supplyZoneRatio: 0,
      ...buildStraightGiDuctElement([{ x: 400, y: 0 }, { x: 400, y: -1200 }], {
        ductKind: 'supply', outerWidthMm: 400, outerHeightMm: 200, elevationMm: 2650,
      }),
    } as HvacElement;
    const obstacles = ductObstacles([unit, stub], 'old');
    expect(obstacles).toEqual([{ id: 'old', ...unitFootprintBoundsMm(stub), kind: 'equipment' }]);
  });

  it('an L-shaped run blocks its two legs, not the empty corner of its bounding box', () => {
    const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
    const run = buildDuctRunDraftElement({
      port: supply, points: [{ x: supply.lip.x, y: supply.lip.y - 3000 }, { x: supply.lip.x + 4000, y: supply.lip.y - 3000 }],
    }, 'run');
    const obstacles = ductObstacles([unit, run], 'run');
    expect(obstacles).toHaveLength(2);
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
});
