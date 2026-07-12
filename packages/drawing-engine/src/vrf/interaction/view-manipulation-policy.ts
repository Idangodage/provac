/**
 * Pure view -> manipulation policy.
 *
 * The policy contains no camera, renderer, or store state. It is the shared
 * contract used by pointer projection and future gizmos to decide which world
 * axes are mouse-editable and which construction plane a free drag starts on.
 */

export type InteractionViewMode =
  | 'plan-2d'
  | 'front-elevation-2d'
  | 'side-elevation-2d'
  /** Legacy alias for the front elevation. */
  | 'elevation-2d'
  /** Legacy section views use the side/YZ manipulation plane by default. */
  | 'section'
  | 'orthographic-3d'
  | 'isometric'
  | 'perspective-3d'
  | 'oblique';

export type ManipulationAxis = 'x' | 'y' | 'z';
export type ManipulationPlane = 'xy' | 'xz' | 'yz';
export type DefaultDragPlane = ManipulationPlane | 'camera-facing';
export type CanonicalManipulationView = 'plan' | 'front' | 'side' | 'iso' | '3d';

export interface ViewManipulationPolicy {
  view: CanonicalManipulationView;
  lockedAxis: ManipulationAxis | null;
  defaultDragPlane: DefaultDragPlane;
  exposedAxes: readonly ManipulationAxis[];
  exposedPlanes: readonly ManipulationPlane[];
}

const PLAN_POLICY: ViewManipulationPolicy = {
  view: 'plan',
  lockedAxis: 'z',
  defaultDragPlane: 'xy',
  exposedAxes: ['x', 'y'],
  exposedPlanes: ['xy'],
};

const FRONT_POLICY: ViewManipulationPolicy = {
  view: 'front',
  lockedAxis: 'y',
  defaultDragPlane: 'xz',
  exposedAxes: ['x', 'z'],
  exposedPlanes: ['xz'],
};

const SIDE_POLICY: ViewManipulationPolicy = {
  view: 'side',
  lockedAxis: 'x',
  defaultDragPlane: 'yz',
  exposedAxes: ['y', 'z'],
  exposedPlanes: ['yz'],
};

const ISO_POLICY: ViewManipulationPolicy = {
  view: 'iso',
  lockedAxis: null,
  // Axonometric work starts on the level construction plane. Explicit axis
  // and plane handles can override this without changing the view default.
  defaultDragPlane: 'xy',
  exposedAxes: ['x', 'y', 'z'],
  exposedPlanes: ['xy', 'xz', 'yz'],
};

const THREE_D_POLICY: ViewManipulationPolicy = {
  view: '3d',
  lockedAxis: null,
  defaultDragPlane: 'camera-facing',
  exposedAxes: ['x', 'y', 'z'],
  exposedPlanes: ['xy', 'xz', 'yz'],
};

function clonePolicy(policy: ViewManipulationPolicy): ViewManipulationPolicy {
  return {
    ...policy,
    exposedAxes: [...policy.exposedAxes],
    exposedPlanes: [...policy.exposedPlanes],
  };
}

export function resolveViewManipulationPolicy(
  viewMode: InteractionViewMode,
): ViewManipulationPolicy {
  switch (viewMode) {
    case 'plan-2d':
      return clonePolicy(PLAN_POLICY);
    case 'front-elevation-2d':
    case 'elevation-2d':
      return clonePolicy(FRONT_POLICY);
    case 'side-elevation-2d':
    case 'section':
      return clonePolicy(SIDE_POLICY);
    case 'orthographic-3d':
    case 'isometric':
    case 'oblique':
      return clonePolicy(ISO_POLICY);
    case 'perspective-3d':
      return clonePolicy(THREE_D_POLICY);
    default: {
      const exhaustive: never = viewMode;
      return exhaustive;
    }
  }
}
