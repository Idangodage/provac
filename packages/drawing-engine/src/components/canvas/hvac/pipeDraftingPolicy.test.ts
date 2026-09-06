import { describe, expect, it } from 'vitest';

import { canOfferPipeBranch, resolvePipeFinishAction } from './pipeDraftingPolicy';

describe('pipe drawing completion', () => {
  it('accepts the displayed fitting instead of silently committing a crossing', () => {
    expect(resolvePipeFinishAction('valid')).toBe('branch');
    expect(resolvePipeFinishAction('needs-nudge')).toBe('branch');
    expect(resolvePipeFinishAction('invalid')).toBe('blocked');
    expect(resolvePipeFinishAction(null)).toBe('route');
  });

  it('offers coordinated branching from unit ports and continued paired runs on the plan plane', () => {
    const options = { planRouting: true, lineMode: 'pair' as const, hasStart: true, hasEndpointSnap: false, freePointer: false };
    expect(canOfferPipeBranch(options)).toBe(true);
    expect(canOfferPipeBranch({ ...options, lineMode: 'gas' })).toBe(false);
    expect(canOfferPipeBranch({ ...options, lineMode: 'liquid' })).toBe(false);
    expect(canOfferPipeBranch({ ...options, hasEndpointSnap: true })).toBe(false);
    expect(canOfferPipeBranch({ ...options, freePointer: true })).toBe(false);
    expect(canOfferPipeBranch({ ...options, planRouting: false })).toBe(false);
  });
});
