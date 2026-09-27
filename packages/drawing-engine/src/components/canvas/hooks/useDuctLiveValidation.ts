import { useEffect, useState } from 'react';

import type { HvacElement } from '../../../types';
import type { VrfValidationReport } from '../../../vrf/rules';
import type { DuctDesignSettings } from '../hvac/duct/ductSettings';
import { isDuctElement } from '../hvac/duct/ductTypes';
import { validateDuctRuns } from '../hvac/duct/ductValidation';

export const DUCT_VALIDATION_DEBOUNCE_MS = 125;

const EMPTY: VrfValidationReport = { issues: [], commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };

/** Debounced duct design checks (DU_*); silent (and free) until a duct exists. */
export function useDuctLiveValidation(elements: readonly HvacElement[], settings: DuctDesignSettings): VrfValidationReport {
  const [report, setReport] = useState<VrfValidationReport>(EMPTY);
  useEffect(() => {
    if (!elements.some(isDuctElement)) {
      setReport((current) => (current.issues.length ? EMPTY : current));
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        setReport(validateDuctRuns(elements, settings));
      } catch (error) {
        setReport({
          issues: [{
            id: 'DU_ENGINE:runs',
            code: 'DU_ENGINE',
            level: 'warning',
            message: `Duct checks could not complete: ${error instanceof Error ? error.message : 'unknown error'}`,
          }],
          commitBlocked: false,
          counts: { error: 0, warning: 1, advisory: 0, information: 0 },
        });
      }
    }, DUCT_VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [elements, settings]);
  return report;
}
