/**
 * Material Pool — Shared PBR material cache for Three.js rendering.
 * 
 * Prevents creating duplicate materials for identical configurations.
 * Dramatically reduces GPU memory usage and shader compilation overhead
 * when many furniture objects share the same material parameters.
 */

import * as THREE from 'three';

interface MaterialConfig {
  type: 'standard' | 'physical';
  color: number;
  roughness: number;
  metalness: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /** Physical material properties */
  transmission?: number;
  ior?: number;
  /** Rendering hints */
  depthWrite?: boolean;
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
}

function configKey(config: MaterialConfig): string {
  return [
    config.type,
    config.color.toString(16),
    config.roughness.toFixed(3),
    config.metalness.toFixed(3),
    config.transparent ? '1' : '0',
    (config.opacity ?? 1).toFixed(2),
    config.side ?? THREE.FrontSide,
    (config.transmission ?? 0).toFixed(2),
    (config.ior ?? 1.5).toFixed(2),
  ].join('|');
}

export class MaterialPool {
  private static instance: MaterialPool | null = null;
  private cache = new Map<string, THREE.Material>();
  private refCounts = new Map<string, number>();

  static getInstance(): MaterialPool {
    if (!MaterialPool.instance) {
      MaterialPool.instance = new MaterialPool();
    }
    return MaterialPool.instance;
  }

  /**
   * Get or create a MeshStandardMaterial with the given parameters.
   * Returned materials are shared — do NOT modify them directly.
   */
  getStandard(params: {
    color?: number;
    roughness?: number;
    metalness?: number;
    transparent?: boolean;
    opacity?: number;
    side?: THREE.Side;
  }): THREE.MeshStandardMaterial {
    const config: MaterialConfig = {
      type: 'standard',
      color: params.color ?? 0xcccccc,
      roughness: params.roughness ?? 0.5,
      metalness: params.metalness ?? 0,
      transparent: params.transparent,
      opacity: params.opacity,
      side: params.side,
    };

    const key = configKey(config);
    let mat = this.cache.get(key);
    if (mat) {
      this.refCounts.set(key, (this.refCounts.get(key) ?? 0) + 1);
      return mat as THREE.MeshStandardMaterial;
    }

    const newMat = new THREE.MeshStandardMaterial({
      color: config.color,
      roughness: config.roughness,
      metalness: config.metalness,
      transparent: config.transparent ?? false,
      opacity: config.opacity ?? 1,
      side: config.side ?? THREE.FrontSide,
    });
    this.cache.set(key, newMat);
    this.refCounts.set(key, 1);
    return newMat;
  }

  /**
   * Get or create a MeshPhysicalMaterial (for glass, transmission, etc.)
   */
  getPhysical(params: {
    color?: number;
    roughness?: number;
    metalness?: number;
    transparent?: boolean;
    opacity?: number;
    transmission?: number;
    ior?: number;
  }): THREE.MeshPhysicalMaterial {
    const config: MaterialConfig = {
      type: 'physical',
      color: params.color ?? 0xcccccc,
      roughness: params.roughness ?? 0.5,
      metalness: params.metalness ?? 0,
      transparent: params.transparent,
      opacity: params.opacity,
      transmission: params.transmission,
      ior: params.ior,
    };

    const key = configKey(config);
    let mat = this.cache.get(key);
    if (mat) {
      this.refCounts.set(key, (this.refCounts.get(key) ?? 0) + 1);
      return mat as THREE.MeshPhysicalMaterial;
    }

    const newMat = new THREE.MeshPhysicalMaterial({
      color: config.color,
      roughness: config.roughness,
      metalness: config.metalness,
      transparent: config.transparent ?? false,
      opacity: config.opacity ?? 1,
      transmission: config.transmission ?? 0,
      ior: config.ior ?? 1.5,
    });
    this.cache.set(key, newMat);
    this.refCounts.set(key, 1);
    return newMat;
  }

  // ─── Convenience accessors matching original material names ───

  wood(color = 0x8B6914): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.7, metalness: 0.05 });
  }

  fabric(color = 0x4A6FA5): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.92, metalness: 0.0 });
  }

  leather(color = 0x3B2F2F): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.55, metalness: 0.02 });
  }

  chrome(): THREE.MeshStandardMaterial {
    return this.getStandard({ color: 0xCCCCCC, roughness: 0.15, metalness: 0.9 });
  }

  glass(): THREE.MeshPhysicalMaterial {
    return this.getPhysical({
      color: 0xCCDDEE,
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      opacity: 0.35,
      transmission: 0.8,
      ior: 1.5,
    });
  }

  ceramic(color = 0xF5F5F0): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.3, metalness: 0.02 });
  }

  metal(color = 0x888888): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.4, metalness: 0.6 });
  }

  mattress(color = 0xF0EDE5): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.85, metalness: 0.0 });
  }

  counterTop(color = 0xD0C8B8): THREE.MeshStandardMaterial {
    return this.getStandard({ color, roughness: 0.35, metalness: 0.08 });
  }

  /** Total number of unique materials in the pool */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict materials with zero references.
   * Call periodically to free GPU memory.
   */
  gc(): number {
    let freed = 0;
    for (const [key, count] of this.refCounts) {
      if (count <= 0) {
        const mat = this.cache.get(key);
        if (mat) {
          mat.dispose();
          freed++;
        }
        this.cache.delete(key);
        this.refCounts.delete(key);
      }
    }
    return freed;
  }

  /**
   * Dispose all materials. Call on app teardown.
   */
  dispose(): void {
    this.cache.forEach((mat) => mat.dispose());
    this.cache.clear();
    this.refCounts.clear();
    MaterialPool.instance = null;
  }
}
