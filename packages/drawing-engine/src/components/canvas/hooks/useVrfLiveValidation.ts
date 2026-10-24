import { useEffect, useState } from 'react';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';
import {
  buildVrfValidationSnapshot,
  PROJECT_FALLBACK_RULE_PROFILE,
  validateVrfNetwork,
  type ManufacturerRuleProfile,
  type VrfValidationReport,
} from '../../../vrf/rules';
import type { VrfValidationIssue } from '../../../vrf/rules/validation-engine';
import { connectionRatioMessage, connectionRatioProblems } from '../hvac/connectionRatio';
import { DEFAULT_PIPE_ROUTING_SETTINGS, type PipeRoutingSettings } from '../hvac/pipeRoutingSettings';

export const VRF_VALIDATION_DEBOUNCE_MS = 125;

export const EMPTY_VRF_VALIDATION_REPORT: VrfValidationReport = {
  issues: [],
  commitBlocked: false,
  counts: { error: 0, warning: 0, advisory: 0, information: 0 },
};

type RatioRange = Pick<PipeRoutingSettings, 'connectionRatioMinPercent' | 'connectionRatioMaxPercent'>;
const DEFAULT_RATIO_RANGE: RatioRange = {
  connectionRatioMinPercent: DEFAULT_PIPE_ROUTING_SETTINGS.connectionRatioMinPercent,
  connectionRatioMaxPercent: DEFAULT_PIPE_ROUTING_SETTINGS.connectionRatioMaxPercent,
};

/** Pure bridge used by the hook and focused integration tests. `ratioRange`: the connection ratio's range (the project's routing settings). */
export function validateHvacElementsAsVrf(
  elements: readonly HvacElement[],
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
  ratioRange: RatioRange = DEFAULT_RATIO_RANGE,
): VrfValidationReport {
  const document = buildVrfDocumentFromHvacElements(elements, {
    activeRuleProfileId: profile.id,
    defaultManufacturer: profile.manufacturer,
    defaultFamily: profile.family,
    defaultRefrigerant: profile.refrigerants[0] ?? 'unspecified',
  });
  const report = validateVrfNetwork(buildVrfValidationSnapshot(document, profile), profile);
  // An outdoor unit too small or too large for the indoor units it serves: a warning on the outdoor unit.
  const ratios = connectionRatioProblems(elements, ratioRange).map((ratio): VrfValidationIssue => ({
    id: `CONNECTION_RATIO:${ratio.outdoorId}`, code: 'CONNECTION_RATIO', level: 'warning', entityId: ratio.outdoorId,
    message: connectionRatioMessage(ratio),
    suggestedFix: ratio.percent > ratio.maxPercent ? 'Use a larger outdoor unit, or split the indoor units over two systems.' : 'Use a smaller outdoor unit, or add indoor units to the system.',
  }));
  if (!ratios.length) return report;
  return { ...report, issues: [...report.issues, ...ratios], counts: { ...report.counts, warning: report.counts.warning + ratios.length } };
}

/**
 * Debounced production validator. HvacElement remains the persisted source;
 * validation consumes a fresh immutable semantic projection after each edit.
 */
export function useVrfLiveValidation(
  elements: readonly HvacElement[],
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
  ratioRange: RatioRange = DEFAULT_RATIO_RANGE,
): VrfValidationReport {
  const [report, setReport] = useState<VrfValidationReport>(() => {
    try {
      return validateHvacElementsAsVrf(elements, profile, ratioRange);
    } catch {
      return EMPTY_VRF_VALIDATION_REPORT;
    }
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setReport(validateHvacElementsAsVrf(elements, profile, ratioRange));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown validation error.';
        setReport({
          issues: [{
            id: 'VALIDATION_ENGINE:network',
            code: 'VALIDATION_ENGINE',
            level: 'warning',
            message: `VRF validation could not complete: ${message}`,
          }],
          commitBlocked: false,
          counts: { error: 0, warning: 1, advisory: 0, information: 0 },
        });
      }
    }, VRF_VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // (The range's two numbers, not the object: a new settings object with the same range validates nothing again.)
  }, [elements, profile, ratioRange.connectionRatioMinPercent, ratioRange.connectionRatioMaxPercent]);

  return report;
}
