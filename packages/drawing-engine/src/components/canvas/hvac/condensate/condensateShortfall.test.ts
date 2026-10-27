// The FDU224 of the user's building (23 October 2026), set to gravity (MHI KX-T-222 shows a gravity drain; the project
// draws a built-in pump unless the unit's Drain pump setting says otherwise) about 24 m from the only floor gully. The
// drain cannot fall that far in the void: Auto route says by how much, and offers a pump.
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../../types';
import { buildAutoRouteReview } from '../autoRouteReview';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import type { UnifiedAutoRouteResult } from '../unifiedAutoRoute';

import { generateCondensateNetwork } from './condensateGenerator';
import { resolveCondensateSettings } from './condensateSettings';

function place(definitionId: string, id: string, centre: Point2D, properties: Record<string, unknown> = {}): HvacElement {
  const def = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id, type: def.type, category: def.equipmentCategory, subtype: def.subtype, modelLabel: def.modelLabel,
    position: { x: centre.x - def.widthMm / 2, y: centre.y - def.depthMm / 2 }, rotation: 0,
    width: def.widthMm, depth: def.depthMm, height: def.heightMm, elevation: def.elevationMm, mountType: def.mountType,
    label: id, supplyZoneRatio: def.supplyZoneRatio ?? 0.5, properties: { definitionId: def.id, ...(def.defaultProperties ?? {}), ...properties },
  } as HvacElement;
}

let ids = 0;
const idFactory = (prefix: string) => `${prefix}-${ids++}`;
const run = (scene: HvacElement[]) => {
  ids = 0;
  return generateCondensateNetwork(scene, { settings: resolveCondensateSettings({}), idFactory });
};

describe('a gravity drain too far from its termination', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));
  const gully = place('condensate-floor-gully', 'gully', { x: 24000, y: 0 });

  it('says how far, how much fall it needs and what the void gives, and that a pump would carry it', () => {
    const result = run([place('vrf-fdu224kxze1', 'FDU224', { x: 0, y: 0 }, { hasDrainPump: false, drainPumpSetBy: 'user' }), gully]);
    const unit = result.perUnit.find((entry) => entry.unitId === 'FDU224')!;
    expect(unit.status).toBe('infeasible');
    expect(unit.pumpWouldHelp).toBe(true);
    expect(unit.reason).toMatch(/^about 2\d m of drain to .+ needs about 2\d0 mm of fall; the void gives about 1\d0 mm \(no drain pump\) — \d+ mm short$/);
    const review = buildAutoRouteReview({ services: { gas: false, liquid: false, condensate: true }, ducts: null, refrigerant: null,
      condensate: result, clashes: [], issues: [] } as unknown as UnifiedAutoRouteResult, []);
    const issue = review.issues.find((entry) => entry.key === 'drain:FDU224')!;
    expect(issue.action).toEqual({ kind: 'fit-pump', unitId: 'FDU224' });
    expect(issue.message).toMatch(/Fit a condensate pump, put a drain point nearer, or raise the unit by the shortfall\.$/);
  });

  it('with a pump fitted it drains, pumped', () => {
    const result = run([place('vrf-fdu224kxze1', 'FDU224', { x: 0, y: 0 }, { hasDrainPump: true }), gully]);
    expect(result.perUnit.find((entry) => entry.unitId === 'FDU224')?.status).toBe('pumped');
  });

  it('is pumped as placed: every ducted unit has a built-in pump', () => {
    const result = run([place('vrf-fdu224kxze1', 'FDU224', { x: 0, y: 0 }), gully]);
    expect(result.perUnit.find((entry) => entry.unitId === 'FDU224')?.status).toBe('pumped');
  });
});
