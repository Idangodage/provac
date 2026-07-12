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

export const VRF_VALIDATION_DEBOUNCE_MS = 125;

export const EMPTY_VRF_VALIDATION_REPORT: VrfValidationReport = {
  issues: [],
  commitBlocked: false,
  counts: { error: 0, warning: 0, advisory: 0, information: 0 },
};

/** Pure bridge used by the hook and focused integration tests. */
export function validateHvacElementsAsVrf(
  elements: readonly HvacElement[],
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
): VrfValidationReport {
  const document = buildVrfDocumentFromHvacElements(elements, {
    activeRuleProfileId: profile.id,
    defaultManufacturer: profile.manufacturer,
    defaultFamily: profile.family,
    defaultRefrigerant: profile.refrigerants[0] ?? 'unspecified',
  });
  return validateVrfNetwork(buildVrfValidationSnapshot(document, profile), profile);
}

/**
 * Debounced production validator. HvacElement remains the persisted source;
 * validation consumes a fresh immutable semantic projection after each edit.
 */
export function useVrfLiveValidation(
  elements: readonly HvacElement[],
  profile: ManufacturerRuleProfile = PROJECT_FALLBACK_RULE_PROFILE,
): VrfValidationReport {
  const [report, setReport] = useState<VrfValidationReport>(() => {
    try {
      return validateHvacElementsAsVrf(elements, profile);
    } catch {
      return EMPTY_VRF_VALIDATION_REPORT;
    }
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setReport(validateHvacElementsAsVrf(elements, profile));
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
  }, [elements, profile]);

  return report;
}
