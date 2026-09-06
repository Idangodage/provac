import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile } from '../../../vrf/rules/rule-profile';

import { evaluateAutoRouteNetwork } from './autoRouteEvaluation';
import { planAutoRouteNetwork } from './autoRouteNetwork';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';

function scene(): HvacElement[] {
  return [
    { id: 'profile-outdoor', type: 'outdoor-unit', category: 'outdoor-unit', label: 'Outdoor',
      position: { x: 11000, y: 6500 }, rotation: 180, width: 900, depth: 450, height: 1200,
      elevation: 0, mountType: 'floor', supplyZoneRatio: 0, properties: {} },
    { id: 'profile-indoor', type: 'ceiling-cassette-ac', category: 'indoor-unit', label: 'Cassette',
      position: { x: 500, y: 500 }, rotation: 0, width: 600, depth: 600, height: 250,
      elevation: 2300, mountType: 'ceiling', supplyZoneRatio: 0, properties: {} },
  ];
}

/** Synthetic regression data only; these values do not describe a real manufacturer. */
function profile(radiusMm: number): ManufacturerRuleProfile {
  return { ...PROJECT_FALLBACK_RULE_PROFILE, id: `synthetic-radius-${radiusMm}`,
    portDefaults: { ...PROJECT_FALLBACK_RULE_PROFILE.portDefaults,
      minimumBendRadiusMm: { value: radiusMm, source: 'manufacturer-model', verified: true, sourceReference: 'synthetic integration-test fixture' } },
  };
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('Auto route with a verified geometric profile requirement', () => {
  it('reserves and persists the radius requirement without changing equipment or document defaults', async () => {
    const equipment = scene();
    const original = structuredClone(equipment);
    const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };
    const originalSettings = { ...settings };
    const selectedProfile = profile(150);
    const result = await planAutoRouteNetwork(equipment, { settings, profile: selectedProfile, objective: 'balanced' });
    expect(result.complete, result.issues.join('\n')).toBe(true);
    expect(result.elementsToAdd.filter(element => element.type === 'refrigerant-pipe')).toHaveLength(2);
    for (const pipe of result.elementsToAdd.filter(element => element.type === 'refrigerant-pipe')) {
      expect(Number(pipe.properties.bendRadiusFactor)).toBeGreaterThan(1);
    }
    // Re-evaluate after the worker-like settings scope has ended. The verified
    // radii must come from the placed geometry and its persisted sweep factor.
    expect(getActivePipeRoutingSettings().bendRadiusFactor).toBe(DEFAULT_PIPE_ROUTING_SETTINGS.bendRadiusFactor);
    const evaluation = evaluateAutoRouteNetwork({ elements: [...equipment, ...result.elementsToAdd],
      outdoorUnitId: 'profile-outdoor', indoorUnitIds: ['profile-indoor'], profile: selectedProfile });
    expect(evaluation.feasible, evaluation.hardIssues.join('\n')).toBe(true);
    expect(evaluation.advisoryIssues.some(issue => issue.includes('bend radii need explicit geometry'))).toBe(false);
    expect(equipment).toEqual(original);
    expect(settings).toEqual(originalSettings);
  }, 30000);

  it('preserves the existing complete layout when an impossible radius prevents its replacement', async () => {
    const equipment = scene();
    const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };
    const initial = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced' });
    expect(initial.complete, initial.issues.join('\n')).toBe(true);
    const existing = [...equipment, ...initial.elementsToAdd];
    const original = structuredClone(existing);
    const result = await planAutoRouteNetwork(existing, { settings, profile: profile(100000), objective: 'balanced', rebuildExisting: true });
    expect(result.elementsToAdd).toEqual([]);
    expect(result.removeElementIds).toEqual([]);
    expect(result.updates).toEqual([]);
    expect(result.issues.some(issue => issue.includes('preserved'))).toBe(true);
    expect(existing).toEqual(original);
    expect(getActivePipeRoutingSettings().bendRadiusFactor).toBe(DEFAULT_PIPE_ROUTING_SETTINGS.bendRadiusFactor);
  }, 30000);
});
