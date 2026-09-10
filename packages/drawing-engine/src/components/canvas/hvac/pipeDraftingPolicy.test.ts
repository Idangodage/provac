import { describe, expect, it } from 'vitest';

import { canOfferPipeBranch, constrainPipeDraftDelta, resolvePipeDraftAngleMode, resolvePipeFinishAction } from './pipeDraftingPolicy';

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

describe('drawing direction in plane coordinates', () => {
  it('uses the same material defaults in XY and arbitrary workplanes', () => {
    expect(resolvePipeDraftAngleMode('auto', 'hard')).toBe('diagonal');
    expect(resolvePipeDraftAngleMode('auto', 'flexible')).toBe('free');
    const delta = { x: 600, y: 800 };
    const diagonal = constrainPipeDraftDelta(delta, { angleMode: 'auto', material: 'hard' })!;
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1000, 8);
    expect(diagonal.x).toBeCloseTo(diagonal.y, 8);
    expect(constrainPipeDraftDelta(delta, { angleMode: 'auto', material: 'flexible' })).toEqual(delta);
  });

  it('gives temporary free placement and orthogonal overrides predictable priority', () => {
    const delta = { x: -600, y: 800 };
    expect(constrainPipeDraftDelta(delta, { angleMode: 'free', material: 'flexible', shift: true })).toEqual({ x: 0, y: 800 });
    expect(constrainPipeDraftDelta(delta, { angleMode: 'ortho', material: 'hard', shift: true, alt: true })).toEqual(delta);
    expect(constrainPipeDraftDelta({ x: -1000, y: 100 }, { angleMode: 'ortho', material: 'hard' })).toEqual({ x: -1000, y: 0 });
  });

  it('handles coincident and nonfinite pointer deltas without unstable movement', () => {
    expect(constrainPipeDraftDelta({ x: 0, y: 0 }, { angleMode: 'diagonal', material: 'hard' })).toEqual({ x: 0, y: 0 });
    expect(constrainPipeDraftDelta({ x: Infinity, y: 0 }, { angleMode: 'free', material: 'hard' })).toBeNull();
    expect(constrainPipeDraftDelta({ x: 0, y: NaN }, { angleMode: 'ortho', material: 'hard' })).toBeNull();
  });
});
