import { describe, expect, it } from 'vitest';

import type { AutoDuctRequest } from './ductAutoLayout';
import { sameAutoDuctInputs } from './ductAutoWorkflow';
import { parseDuctNumber } from './ductNumericValue';
import type { DuctSystemSizing } from './ductTypes';

const request: AutoDuctRequest = {
  unitId: 'unit', terminalIds: ['a', 'b'], fanSpeed: 'hi', airflowM3h: null,
  layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false,
};
const basis: DuctSystemSizing = {
  method: 'constant-friction', drive: 'friction', mainVelocityMs: 5.1, frictionPaPerM: 0.8,
  maxVelocity: { trunk: 6, branch: 5, runout: 3 }, fanSpeed: 'hi', airflowM3h: null,
};

describe('auto duct preview input matching', () => {
  it('allows reordered terminal selections and default shape without invalidating the preview', () => {
    expect(sameAutoDuctInputs(request, { ...request, terminalIds: ['b', 'a', 'a'], shape: 'optimal' })).toBe(true);
  });

  it.each([
    { airflowM3h: 1000 }, { fanSpeed: 'lo' as const }, { layout: 'trunk' as const },
    { shape: 'round' as const }, { services: { supply: false, return: true } },
    { terminalIds: ['a'] }, { rebuildExisting: true }, { terminalAirflows: { a: 200 } },
  ])('requires regeneration when a routing or airflow input changes: %j', (change) => {
    expect(sameAutoDuctInputs(request, { ...request, ...change })).toBe(false);
  });

  it('matches terminal airflow edits independent of entry order, while retaining explicit share resets', () => {
    const left = { ...request, terminalAirflows: { a: 150, b: null } };
    expect(sameAutoDuctInputs(left, { ...request, terminalAirflows: { b: null, a: 150 } })).toBe(true);
    expect(sameAutoDuctInputs(left, { ...request, terminalAirflows: { a: 150 } })).toBe(false);
  });

  it('compares the driving sizing value and all velocity caps, allowing derived rounding', () => {
    const left = { ...request, sizing: { supply: basis } };
    expect(sameAutoDuctInputs(left, { ...request, sizing: { supply: { ...basis, mainVelocityMs: 5.10000001 } } })).toBe(true);
    expect(sameAutoDuctInputs(left, { ...request, sizing: { supply: { ...basis, frictionPaPerM: 1 } } })).toBe(false);
    expect(sameAutoDuctInputs(left, { ...request, sizing: { supply: { ...basis, maxVelocity: { ...basis.maxVelocity, branch: 4 } } } })).toBe(false);
    expect(sameAutoDuctInputs(left, request)).toBe(false);
  });
});

describe('duct numeric editing', () => {
  it('preserves design precision without step quantisation', () => {
    expect(parseDuctNumber('0.82375', 0.1, 5)).toEqual({ valid: true, value: 0.82375 });
    expect(parseDuctNumber('1.2e3', 0.01, 50000)).toEqual({ valid: true, value: 1200 });
  });

  it('only treats a blank as automatic airflow when the field allows it', () => {
    expect(parseDuctNumber('', 0.01, 50000, true)).toEqual({ valid: true, value: null });
    expect(parseDuctNumber('', 0.1, 5).valid).toBe(false);
  });

  it.each(['0', '-1', '50001', 'Infinity', 'NaN', '1200m3/h', '1e', '0x100'])('rejects invalid airflow %s instead of clamping or falling back', (value) => {
    expect(parseDuctNumber(value, 0.01, 50000, true).valid).toBe(false);
  });
});
