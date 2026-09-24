import { useEffect, useState } from 'react';

import type { HvacElement } from '../../../types';
import type { VrfValidationReport } from '../../../vrf/rules';
import type { CondensateDesignSettings } from '../hvac/condensate/condensateSettings';
import { isCondensateElement } from '../hvac/condensate/condensateTypes';
import { validateCondensateNetwork } from '../hvac/condensate/condensateValidation';
import type { PipeRoutingSettings } from '../hvac/pipeRoutingSettings';

export const CONDENSATE_VALIDATION_DEBOUNCE_MS = 125;

const EMPTY: VrfValidationReport = { issues: [], commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };

/** Debounced condensate design checks; silent (and free) until condensate exists. */
export function useCondensateLiveValidation(
  elements: readonly HvacElement[],
  settings: CondensateDesignSettings,
  routingSettings: PipeRoutingSettings,
): VrfValidationReport {
  const [report, setReport] = useState<VrfValidationReport>(EMPTY);
  useEffect(() => {
    if (!elements.some(isCondensateElement)) {
      setReport((current) => (current.issues.length ? EMPTY : current));
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        setReport(validateCondensateNetwork(elements, { settings, routingSettings }));
      } catch (error) {
        setReport({
          issues: [{
            id: 'CD_ENGINE:network',
            code: 'CD_ENGINE',
            level: 'warning',
            message: `Condensate checks could not complete: ${error instanceof Error ? error.message : 'unknown error'}`,
          }],
          commitBlocked: false,
          counts: { error: 0, warning: 1, advisory: 0, information: 0 },
        });
      }
    }, CONDENSATE_VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [elements, settings, routingSettings]);
  return report;
}
