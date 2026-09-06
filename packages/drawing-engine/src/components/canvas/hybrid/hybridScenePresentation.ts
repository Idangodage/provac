import * as THREE from 'three';

/**
 * Read physical bounds independently of the temporary height reveal. Assets
 * can finish loading during a view change; fitting to their compressed height
 * would otherwise change the final framing depending on the loading time.
 */
export function measureUnrevealedContentBounds(
  revealLayer: THREE.Group,
  roots: readonly THREE.Object3D[],
  bounds: THREE.Box3,
): void {
  const heightScale = revealLayer.scale.z;
  revealLayer.scale.z = 1;
  try {
    revealLayer.updateWorldMatrix(true, true);
    bounds.makeEmpty();
    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      bounds.union(new THREE.Box3().setFromObject(root));
    }
  } finally {
    revealLayer.scale.z = heightScale;
    revealLayer.updateWorldMatrix(true, true);
  }
}
