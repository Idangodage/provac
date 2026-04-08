/**
 * PBR materials for 3D furniture rendering.
 *
 * Uses a shared material cache to prevent creating duplicate GPU resources.
 * Identical material configurations return the same instance, dramatically
 * reducing shader compilations and GPU memory pressure.
 *
 * IMPORTANT: Returned materials are shared — do NOT modify them after creation.
 * If you need a unique material, clone() it first.
 */

import * as THREE from 'three';

// ─── Shared material cache ────────────────────────────────────────────────────

interface CacheKey {
  type: string;
  color: number;
  roughness: number;
  metalness: number;
  extra?: string;
}

function makeCacheKey(k: CacheKey): string {
  return `${k.type}|${k.color.toString(16)}|${k.roughness}|${k.metalness}|${k.extra ?? ''}`;
}

const MATERIAL_CACHE = new Map<string, THREE.Material>();

function getCachedStandard(
  color: number,
  roughness: number,
  metalness: number,
  extra?: string,
): THREE.MeshStandardMaterial {
  const key = makeCacheKey({ type: 'std', color, roughness, metalness, extra });
  let mat = MATERIAL_CACHE.get(key);
  if (mat) return mat as THREE.MeshStandardMaterial;

  const newMat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  MATERIAL_CACHE.set(key, newMat);
  return newMat;
}

function getCachedPhysical(
  color: number,
  roughness: number,
  metalness: number,
  opts: { transparent?: boolean; opacity?: number; transmission?: number; ior?: number },
): THREE.MeshPhysicalMaterial {
  const extra = `${opts.transparent ? 1 : 0}|${opts.opacity ?? 1}|${opts.transmission ?? 0}|${opts.ior ?? 1.5}`;
  const key = makeCacheKey({ type: 'phy', color, roughness, metalness, extra });
  let mat = MATERIAL_CACHE.get(key);
  if (mat) return mat as THREE.MeshPhysicalMaterial;

  const newMat = new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    transmission: opts.transmission ?? 0,
    ior: opts.ior ?? 1.5,
  });
  MATERIAL_CACHE.set(key, newMat);
  return newMat;
}

// ─── Public API (signatures unchanged for backwards compatibility) ────────────

export function woodMaterial(color = 0x8B6914): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.7, 0.05);
}

export function fabricMaterial(color = 0x4A6FA5): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.92, 0.0);
}

export function leatherMaterial(color = 0x3B2F2F): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.55, 0.02);
}

export function chromeMaterial(): THREE.MeshStandardMaterial {
  return getCachedStandard(0xCCCCCC, 0.15, 0.9);
}

export function glassMaterial(): THREE.MeshPhysicalMaterial {
  return getCachedPhysical(0xCCDDEE, 0.05, 0.0, {
    transparent: true,
    opacity: 0.35,
    transmission: 0.8,
    ior: 1.5,
  });
}

export function ceramicMaterial(color = 0xF5F5F0): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.3, 0.02);
}

export function metalMaterial(color = 0x888888): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.4, 0.6);
}

export function mattressMaterial(color = 0xF0EDE5): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.85, 0.0);
}

export function counterTopMaterial(color = 0xD0C8B8): THREE.MeshStandardMaterial {
  return getCachedStandard(color, 0.35, 0.08);
}

// ─── Cache management ─────────────────────────────────────────────────────────

/** Number of unique materials in the shared cache. */
export function materialCacheSize(): number {
  return MATERIAL_CACHE.size;
}

/** Dispose all cached materials. Call only on app teardown. */
export function disposeMaterialCache(): void {
  MATERIAL_CACHE.forEach((mat) => mat.dispose());
  MATERIAL_CACHE.clear();
}
