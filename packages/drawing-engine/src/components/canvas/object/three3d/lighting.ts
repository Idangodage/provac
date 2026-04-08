/**
 * Three-point lighting rig for furniture 3D rendering.
 *
 * Shadow casting is disabled by default to reduce GPU load.
 * Only the singleton thumbnail renderer uses this — the isometric
 * scene has its own lighter ambient+directional setup.
 */

import * as THREE from 'three';

export function createLightingRig(enableShadows = false): THREE.Group {
  const group = new THREE.Group();

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  group.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(5, 8, 6);
  if (enableShadows) {
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(256, 256); // Reduced from 512
    keyLight.shadow.bias = -0.001;
  }
  group.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xDDE8F0, 0.3);
  fillLight.position.set(-4, 3, -2);
  group.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xFFEEDD, 0.2);
  rimLight.position.set(0, 2, -6);
  group.add(rimLight);

  return group;
}
