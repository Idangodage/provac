import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyModelToWorldBasis, assertCanonicalModelRoot } from '../modelSpace';

import { measureUnrevealedContentBounds } from './hybridScenePresentation';
import { resolveOrthographicFit } from './hybridViewportFit';
import { wallRiseForPolar } from './planSheetTransform';

describe('shared scene height reveal', () => {
  function scene() {
    const basis = new THREE.Group();
    applyModelToWorldBasis(basis);
    const reveal = new THREE.Group();
    const root = new THREE.Group();
    basis.add(reveal);
    reveal.add(root);
    const unit = new THREE.Mesh(new THREE.BoxGeometry(600, 600, 250));
    unit.position.set(1600, 1200, 2600);
    root.add(unit);
    const port = new THREE.Object3D();
    port.position.set(300, 0, 0);
    unit.add(port);
    const pipe = new THREE.Group();
    pipe.position.set(1900, 1200, 2600);
    root.add(pipe);
    return { basis, reveal, root, unit, port, pipe };
  }

  it('keeps pipe ends attached to equipment ports throughout either direction', () => {
    const { basis, reveal, root, port, pipe, unit } = scene();
    const physicalPosition = unit.position.clone();
    const samples = Array.from({ length: 60 }, (_, i) => i / 60);
    for (const polar of [...samples, ...samples.reverse()]) {
      reveal.scale.z = Math.max(0.002, wallRiseForPolar(polar));
      basis.updateMatrixWorld(true);
      expect(port.getWorldPosition(new THREE.Vector3()).distanceTo(
        pipe.getWorldPosition(new THREE.Vector3()),
      )).toBeLessThan(1e-8);
      expect(unit.position.equals(physicalPosition)).toBe(true);
      expect(() => assertCanonicalModelRoot(root, 'reveal test')).not.toThrow();
    }
  });

  it('fits newly loaded equipment to full height at every reveal stage', () => {
    const { reveal, root, unit } = scene();
    const bounds = new THREE.Box3();
    let referenceZoom: number | undefined;
    for (const heightScale of [1, 0.5, 0.002, 0.8]) {
      reveal.scale.z = heightScale;
      measureUnrevealedContentBounds(reveal, [root], bounds);
      expect(bounds.min.z).toBe(2475);
      expect(bounds.max.z).toBe(2725);
      const fit = resolveOrthographicFit(bounds, { width: 1200, height: 800 }, 'iso')!;
      referenceZoom ??= fit.zoom;
      expect(fit.zoom).toBe(referenceZoom);
      expect(reveal.scale.z).toBe(heightScale);
      expect(unit.getWorldPosition(new THREE.Vector3()).z).toBeCloseTo(2600 * heightScale);
    }
  });
});
