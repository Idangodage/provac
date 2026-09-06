import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  resolveOrthographicFit,
  resolveOrthographicFitForPose,
} from './hybridViewportFit';
import type { HybridCameraView } from './hybridViewportMath';

function corners(bounds: THREE.Box3): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        result.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  return result;
}

describe('resolveOrthographicFit', () => {
  const bounds = new THREE.Box3(
    new THREE.Vector3(-4700, -1950, 0),
    new THREE.Vector3(4700, 1950, 3200),
  );
  const viewport = { width: 1300, height: 650 };

  it.each<HybridCameraView>(['plan', 'front', 'side', 'iso'])(
    'keeps all eight bounds corners visible in %s view',
    (view) => {
      const fit = resolveOrthographicFit(bounds, viewport, view, 24);
      expect(fit).not.toBeNull();
      for (const corner of corners(bounds)) {
        const relative = corner.sub(fit!.target);
        const screenX = viewport.width / 2
          + relative.dot(fit!.screenRight) * fit!.zoom;
        const screenY = viewport.height / 2
          - relative.dot(fit!.screenUp) * fit!.zoom;
        expect(screenX).toBeGreaterThanOrEqual(fit!.paddingPx - 1e-6);
        expect(screenX).toBeLessThanOrEqual(viewport.width - fit!.paddingPx + 1e-6);
        expect(screenY).toBeGreaterThanOrEqual(fit!.paddingPx - 1e-6);
        expect(screenY).toBeLessThanOrEqual(viewport.height - fit!.paddingPx + 1e-6);
      }
    },
  );

  it('centres on the complete 3D bounds rather than the floor plane', () => {
    const fit = resolveOrthographicFit(bounds, viewport, 'front', 24);
    expect(fit?.target.toArray()).toEqual([0, 0, 1600]);
  });

  it('returns null for empty content and clamps padding on tiny viewports', () => {
    expect(resolveOrthographicFit(new THREE.Box3(), viewport, 'plan')).toBeNull();
    const fit = resolveOrthographicFit(bounds, { width: 20, height: 10 }, 'iso', 50);
    expect(fit?.paddingPx).toBeLessThan(5);
    expect(fit?.zoom).toBeGreaterThan(0);
  });

  it('fits an arbitrary live orbit without substituting the canonical iso basis', () => {
    const pose = {
      polar: THREE.MathUtils.degToRad(58),
      azimuth: THREE.MathUtils.degToRad(20),
    };
    const fit = resolveOrthographicFitForPose(bounds, viewport, pose, 24);
    expect(fit).not.toBeNull();
    for (const corner of corners(bounds)) {
      const relative = corner.sub(fit!.target);
      const screenX = viewport.width / 2
        + relative.dot(fit!.screenRight) * fit!.zoom;
      const screenY = viewport.height / 2
        - relative.dot(fit!.screenUp) * fit!.zoom;
      expect(screenX).toBeGreaterThanOrEqual(fit!.paddingPx - 1e-6);
      expect(screenX).toBeLessThanOrEqual(viewport.width - fit!.paddingPx + 1e-6);
      expect(screenY).toBeGreaterThanOrEqual(fit!.paddingPx - 1e-6);
      expect(screenY).toBeLessThanOrEqual(viewport.height - fit!.paddingPx + 1e-6);
    }
    expect(fit?.spanX).not.toBeCloseTo(
      resolveOrthographicFit(bounds, viewport, 'iso', 24)!.spanX,
    );
  });
});
