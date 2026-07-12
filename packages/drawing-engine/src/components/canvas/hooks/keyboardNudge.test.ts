import { describe, expect, it } from 'vitest';

import { resolveKeyboardNudgeDelta } from './keyboardNudge';

describe('resolveKeyboardNudgeDelta', () => {
  it('maps plan arrows to XY and Alt+vertical to Z', () => {
    expect(resolveKeyboardNudgeDelta('ArrowRight', false, 10, 'plan-2d'))
      .toEqual({ dx: 10, dy: 0, dz: 0 });
    expect(resolveKeyboardNudgeDelta('ArrowUp', false, 10, 'plan-2d'))
      .toEqual({ dx: 0, dy: -10, dz: 0 });
    expect(resolveKeyboardNudgeDelta('ArrowUp', true, 10, 'plan-2d'))
      .toEqual({ dx: 0, dy: 0, dz: 10 });
  });

  it('maps front arrows to XZ and Alt+vertical to locked Y', () => {
    expect(resolveKeyboardNudgeDelta('ArrowLeft', false, 25, 'front-elevation-2d'))
      .toEqual({ dx: -25, dy: 0, dz: 0 });
    expect(resolveKeyboardNudgeDelta('ArrowUp', false, 25, 'front-elevation-2d'))
      .toEqual({ dx: 0, dy: 0, dz: 25 });
    expect(resolveKeyboardNudgeDelta('ArrowDown', true, 25, 'front-elevation-2d'))
      .toEqual({ dx: 0, dy: -25, dz: 0 });
  });

  it('maps side arrows to YZ and Alt+vertical to locked X', () => {
    expect(resolveKeyboardNudgeDelta('ArrowRight', false, 5, 'side-elevation-2d'))
      .toEqual({ dx: 0, dy: 5, dz: 0 });
    expect(resolveKeyboardNudgeDelta('ArrowDown', false, 5, 'side-elevation-2d'))
      .toEqual({ dx: 0, dy: 0, dz: -5 });
    expect(resolveKeyboardNudgeDelta('ArrowUp', true, 5, 'side-elevation-2d'))
      .toEqual({ dx: 5, dy: 0, dz: 0 });
  });

  it('keeps the established XY plus Alt-Z mapping in isometric view', () => {
    expect(resolveKeyboardNudgeDelta('ArrowDown', false, 10, 'isometric'))
      .toEqual({ dx: 0, dy: 10, dz: 0 });
    expect(resolveKeyboardNudgeDelta('ArrowDown', true, 10, 'isometric'))
      .toEqual({ dx: 0, dy: 0, dz: -10 });
  });
});
