import * as THREE from 'three';

/** Toolbar motion is deliberately separate from the short input damping. */
export const HYBRID_VIEW_TRANSITION_SECONDS = 0.5;

export interface HybridViewTransitionPose {
  azimuth: number;
  polar: number;
  distance: number;
  zoom: number;
  target: THREE.Vector3;
  focalOffset: THREE.Vector3;
}

/** Keep rotation continuous even after the user has orbited several turns. */
export function nearestEquivalentAzimuth(from: number, to: number): number {
  return from + THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
}

/**
 * Quintic easing has zero velocity and acceleration at either end. Zoom is
 * interpolated logarithmically so equal progress means equal scale change.
 * Sampling is independent of frame rate and finishes at the exact endpoint.
 */
export function sampleHybridViewTransition(
  from: HybridViewTransitionPose,
  to: HybridViewTransitionPose,
  progress: number,
): HybridViewTransitionPose {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  return {
    azimuth: THREE.MathUtils.lerp(from.azimuth, nearestEquivalentAzimuth(from.azimuth, to.azimuth), eased),
    polar: THREE.MathUtils.lerp(from.polar, to.polar, eased),
    distance: THREE.MathUtils.lerp(from.distance, to.distance, eased),
    zoom: t === 1 ? to.zoom : Math.exp(THREE.MathUtils.lerp(Math.log(from.zoom), Math.log(to.zoom), eased)),
    target: from.target.clone().lerp(to.target, eased),
    focalOffset: from.focalOffset.clone().lerp(to.focalOffset, eased),
  };
}
