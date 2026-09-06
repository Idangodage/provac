import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  disposeObject3DResources,
  markMaterialOwned,
} from './threeResourceLifecycle';

describe('Three resource lifecycle', () => {
  it('disposes shared instance-owned resources exactly once', () => {
    const texture = new THREE.Texture();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    const textureDispose = vi.spyOn(texture, 'dispose');
    markMaterialOwned(material, { textures: true });

    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    disposeObject3DResources(root);

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose shared cache materials', () => {
    const material = new THREE.MeshBasicMaterial();
    const materialDispose = vi.spyOn(material, 'dispose');
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));

    disposeObject3DResources(root);

    expect(materialDispose).not.toHaveBeenCalled();
  });
});
