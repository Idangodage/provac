import { useEffect, useState } from 'react';

import type { HvacElement, Room } from '../../../types';
import type { VrfValidationReport } from '../../../vrf/rules';
import { checkAirSystems } from '../hvac/duct/ductAirSystemChecks';
import type { DuctDesignSettings } from '../hvac/duct/ductSettings';
import { isDuctTerminalElement } from '../hvac/duct/ductTerminals';
import { isDuctElement } from '../hvac/duct/ductTypes';
import { validateDuctRuns } from '../hvac/duct/ductValidation';

export const DUCT_VALIDATION_DEBOUNCE_MS = 125;

const EMPTY: VrfValidationReport = { issues: [], commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };
const NO_ROOMS: ReadonlyArray<Pick<Room, 'id' | 'vertices' | 'name'>> = [];

/**
 * Debounced duct design checks (DU_*) with the air-system checks; silent (and
 * free) until a duct or an air terminal exists.
 */
export function useDuctLiveValidation(
  elements: readonly HvacElement[],
  settings: DuctDesignSettings,
  rooms: ReadonlyArray<Pick<Room, 'id' | 'vertices' | 'name'>> = NO_ROOMS,
): VrfValidationReport {
  const [report, setReport] = useState<VrfValidationReport>(EMPTY);
  useEffect(() => {
    if (!elements.some((element) => isDuctElement(element) || isDuctTerminalElement(element))) {
      setReport((current) => (current.issues.length ? EMPTY : current));
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        setReport(validateDuctRuns(elements, settings, checkAirSystems(elements, settings, rooms)));
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
  }, [elements, settings, rooms]);
  return report;
}
