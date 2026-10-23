// Two FDT28 cassettes one above the other, their drain outlets on one line, draining to one floor gully south-west of
// them (the east wing of the user's building, 23 October 2026). The second branch must neither pass through the first
// one's riser nor stand its riser on the first one's run.
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../../types';
import { findNewNetworkPipeClashes } from '../networkPipeClearance';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { generateCondensateNetwork } from './condensateGenerator';
import { resolveCondensateSettings } from './condensateSettings';

function place(definitionId: string, id: string, centre: Point2D): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: id, supplyZoneRatio: def.supplyZoneRatio ?? 0.5, properties: { definitionId: def.id, ...(def.defaultProperties ?? {}) },
  } as HvacElement;
}

let ids = 0;
const idFactory = (prefix: string) => `${prefix}-${ids++}`;

describe('condensate network: a branch keeps clear of the drains already laid', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it.each([
    ['one above the other', { x: 28421, y: 8996 }, { x: 28421, y: 13472 }, { x: 23641, y: 15167 }],
    ['the gully due south', { x: 5000, y: 0 }, { x: 5000, y: 4400 }, { x: 5600, y: 9000 }],
  ])('two cassettes with their outlets on one line (%s): no drain passes through the other', (_name, north, south, drain) => {
    ids = 0;
    const scene = [place('vrf-fdt28kxze1', 'ne', north), place('vrf-fdt28kxze1', 's', south), place('condensate-floor-gully', 'gully', drain)];
    const result = generateCondensateNetwork(scene, { settings: resolveCondensateSettings({}), idFactory });
    expect(result.perUnit.filter((unit) => unit.status === 'pumped' || unit.status === 'gravity')).toHaveLength(2);
    expect(findNewNetworkPipeClashes(scene, result.elementsToAdd)).toEqual([]);
  });
});
