import { describe, expect, it } from 'vitest';

import {
  resolveViewManipulationPolicy,
  type InteractionViewMode,
} from './view-manipulation-policy';

describe('view manipulation policy', () => {
  it.each<{
    mode: InteractionViewMode;
    view: 'plan' | 'front' | 'side' | 'iso' | '3d';
    locked: 'x' | 'y' | 'z' | null;
    plane: 'xy' | 'xz' | 'yz' | 'camera-facing';
    axes: Array<'x' | 'y' | 'z'>;
    planes: Array<'xy' | 'xz' | 'yz'>;
  }>([
    { mode: 'plan-2d', view: 'plan', locked: 'z', plane: 'xy', axes: ['x', 'y'], planes: ['xy'] },
    { mode: 'front-elevation-2d', view: 'front', locked: 'y', plane: 'xz', axes: ['x', 'z'], planes: ['xz'] },
    { mode: 'side-elevation-2d', view: 'side', locked: 'x', plane: 'yz', axes: ['y', 'z'], planes: ['yz'] },
    { mode: 'isometric', view: 'iso', locked: null, plane: 'xy', axes: ['x', 'y', 'z'], planes: ['xy', 'xz', 'yz'] },
    { mode: 'perspective-3d', view: '3d', locked: null, plane: 'camera-facing', axes: ['x', 'y', 'z'], planes: ['xy', 'xz', 'yz'] },
  ])('$mode maps to the expected construction plane and handles', ({
    mode,
    view,
    locked,
    plane,
    axes,
    planes,
  }) => {
    const policy = resolveViewManipulationPolicy(mode);
    expect(policy.view).toBe(view);
    expect(policy.lockedAxis).toBe(locked);
    expect(policy.defaultDragPlane).toBe(plane);
    expect(policy.exposedAxes).toEqual(axes);
    expect(policy.exposedPlanes).toEqual(planes);
  });

  it('keeps legacy view names on the same canonical policies', () => {
    expect(resolveViewManipulationPolicy('elevation-2d'))
      .toEqual(resolveViewManipulationPolicy('front-elevation-2d'));
    expect(resolveViewManipulationPolicy('section'))
      .toEqual(resolveViewManipulationPolicy('side-elevation-2d'));
    expect(resolveViewManipulationPolicy('orthographic-3d'))
      .toEqual(resolveViewManipulationPolicy('isometric'));
    expect(resolveViewManipulationPolicy('oblique'))
      .toEqual(resolveViewManipulationPolicy('isometric'));
  });

  it('returns defensive axis and plane arrays', () => {
    const first = resolveViewManipulationPolicy('plan-2d');
    (first.exposedAxes as Array<'x' | 'y' | 'z'>).push('z');
    expect(resolveViewManipulationPolicy('plan-2d').exposedAxes).toEqual(['x', 'y']);
  });
});
