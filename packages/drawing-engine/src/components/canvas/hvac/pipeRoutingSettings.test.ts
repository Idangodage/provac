import { describe, expect, it } from 'vitest';

import { PROJECT_FALLBACK_RULE_PROFILE } from '../../../vrf/rules';

import {
  DEFAULT_PIPE_ROUTING_SETTINGS,
  resolvePipeRoutingSettings,
  routingSettingsFromRuleProfile,
} from './pipeRoutingSettings';

describe('VRF production compliance defaults', () => {
  it('uses the profile-aligned port and branch installation clearances', () => {
    expect(DEFAULT_PIPE_ROUTING_SETTINGS.minimumPortStubMm).toBe(200);
    expect(DEFAULT_PIPE_ROUTING_SETTINGS.defaultBranchKitClearanceMm).toBe(300);
    expect(DEFAULT_PIPE_ROUTING_SETTINGS.minBranchKitSpacingMm).toBe(500);
    expect(DEFAULT_PIPE_ROUTING_SETTINGS.enableRealTeeTopology).toBe(true);
  });

  it('backfills the new port-stub default when loading legacy settings', () => {
    const resolved = resolvePipeRoutingSettings({ defaultPipeGapMm: 30 });
    expect(resolved.defaultPipeGapMm).toBe(30);
    expect(resolved.minimumPortStubMm).toBe(200);
  });

  it('projects the active manufacturer installation rules into live geometry settings', () => {
    const settings = routingSettingsFromRuleProfile({
      ...PROJECT_FALLBACK_RULE_PROFILE,
      portDefaults: {
        ...PROJECT_FALLBACK_RULE_PROFILE.portDefaults,
        minimumStraightStubMm: {
          value: 275,
          source: 'manufacturer-family',
          verified: true,
        },
      },
      installation: {
        ...PROJECT_FALLBACK_RULE_PROFILE.installation,
        minimumBranchStraightBeforeMm: {
          value: 325,
          source: 'manufacturer-family',
          verified: true,
        },
        minimumBranchStraightAfterMm: {
          value: 450,
          source: 'manufacturer-family',
          verified: true,
        },
        minimumJointSpacingMm: {
          value: 650,
          source: 'manufacturer-family',
          verified: true,
        },
      },
    });
    expect(settings.minimumPortStubMm).toBe(275);
    expect(settings.defaultBranchKitClearanceMm).toBe(450);
    expect(settings.minBranchKitSpacingMm).toBe(650);
  });
});
