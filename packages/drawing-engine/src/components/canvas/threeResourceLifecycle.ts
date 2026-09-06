import * as THREE from "three";

/**
 * Three.js does not release GPU allocations when an Object3D is detached.
 * Keep ownership explicit so per-document instances can be reclaimed without
 * accidentally disposing shared material/texture caches.
 */
const ownedMaterials = new WeakSet<THREE.Material>();
const ownedTextures = new WeakSet<THREE.Texture>();
const disposedMaterials = new WeakSet<THREE.Material>();
const disposedTextures = new WeakSet<THREE.Texture>();

function materialTextures(material: THREE.Material): THREE.Texture[] {
  const textures: THREE.Texture[] = [];
  Object.values(material).forEach((value) => {
    if (value instanceof THREE.Texture) textures.push(value);
  });
  return textures;
}

export function markMaterialOwned(
  material: THREE.Material,
  options: { textures?: boolean } = {},
): THREE.Material {
  ownedMaterials.add(material);
  if (options.textures) {
    materialTextures(material).forEach((texture) => ownedTextures.add(texture));
  }
  return material;
}

export function markObjectMaterialsOwned(
  object: THREE.Object3D,
  options: { textures?: boolean } = {},
): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments)) {
      return;
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => markMaterialOwned(material, options));
  });
}

export function disposeOwnedMaterial(material: THREE.Material): void {
  if (!ownedMaterials.has(material) || disposedMaterials.has(material)) return;
  materialTextures(material).forEach((texture) => {
    if (!ownedTextures.has(texture) || disposedTextures.has(texture)) return;
    disposedTextures.add(texture);
    texture.dispose();
  });
  disposedMaterials.add(material);
  material.dispose();
}

/** Dispose unique instance-owned resources exactly once. Shared materials stay live. */
export function disposeObject3DResources(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments)) {
      return;
    }
    if (child.geometry) geometries.add(child.geometry);
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    childMaterials.forEach((material) => {
      if (!ownedMaterials.has(material)) return;
      materials.add(material);
    });
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach(disposeOwnedMaterial);
}
