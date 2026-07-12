import {
  resolveViewManipulationPolicy,
  type InteractionViewMode,
  type ManipulationAxis,
} from '../../../vrf/interaction/view-manipulation-policy';

export interface KeyboardNudgeDelta {
  dx: number;
  dy: number;
  dz: number;
}

function alongAxis(axis: ManipulationAxis, amount: number): KeyboardNudgeDelta {
  return {
    dx: axis === 'x' ? amount : 0,
    dy: axis === 'y' ? amount : 0,
    dz: axis === 'z' ? amount : 0,
  };
}

/** Map screen-arrow intent onto the canonical axes exposed by the active view. */
export function resolveKeyboardNudgeDelta(
  key: string,
  altKey: boolean,
  stepMm: number,
  viewMode: InteractionViewMode,
): KeyboardNudgeDelta | null {
  if (!key.startsWith('Arrow')) return null;
  const policy = resolveViewManipulationPolicy(viewMode);

  if (altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const depthAxis = policy.lockedAxis ?? 'z';
    return alongAxis(depthAxis, key === 'ArrowUp' ? stepMm : -stepMm);
  }

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const horizontalAxis: ManipulationAxis = policy.view === 'side' ? 'y' : 'x';
    return alongAxis(horizontalAxis, key === 'ArrowRight' ? stepMm : -stepMm);
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (policy.view === 'front' || policy.view === 'side') {
      return alongAxis('z', key === 'ArrowUp' ? stepMm : -stepMm);
    }
    return alongAxis('y', key === 'ArrowDown' ? stepMm : -stepMm);
  }

  return null;
}
