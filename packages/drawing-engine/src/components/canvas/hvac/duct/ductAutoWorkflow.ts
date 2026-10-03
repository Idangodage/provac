import type { AutoDuctRequest } from './ductAutoLayout';
import type { DuctSystemSizing } from './ductTypes';

function sizingInput(basis: DuctSystemSizing | undefined) {
  if (!basis) return null;
  // The linked field is derived, so only compare the value the designer controls.
  return [basis.drive, basis.drive === 'velocity' ? basis.mainVelocityMs : basis.frictionPaPerM,
    basis.maxVelocity.trunk, basis.maxVelocity.branch, basis.maxVelocity.runout];
}

/** Compare card inputs with the request actually used for the visible preview. */
export function sameAutoDuctInputs(left: AutoDuctRequest, right: AutoDuctRequest): boolean {
  const input = (request: AutoDuctRequest) => [
    request.unitId, [...new Set(request.terminalIds)].sort(), request.fanSpeed, request.airflowM3h ?? null,
    request.layout, request.shape ?? 'optimal', request.services.supply, request.services.return,
    request.rebuildExisting,
    sizingInput(request.sizing?.supply), sizingInput(request.sizing?.return),
    Object.entries(request.terminalAirflows ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ];
  return JSON.stringify(input(left)) === JSON.stringify(input(right));
}
