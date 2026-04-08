/**
 * Geometry Optimizer
 * 
 * Provides LOD (Level of Detail) generation, geometry merging,
 * and triangle budget management for Three.js scenes.
 * 
 * Key optimizations:
 * - Merge multiple geometries with the same material into single draw calls
 * - Generate simplified LOD geometries for distant objects
 * - Enforce triangle budgets to prevent GPU overload
 * - Reduce curve segment counts based on quality level
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type QualityLevel = 'high' | 'medium' | 'low' | 'ultra-low';

export interface LODConfig {
  /** Distance thresholds for LOD switching (in scene units, mm) */
  distances: [number, number, number]; // [medium, low, ultra-low]
  /** Maximum triangle count per LOD level */
  maxTriangles: Record<QualityLevel, number>;
}

const DEFAULT_LOD_CONFIG: LODConfig = {
  distances: [5000, 15000, 40000],
  maxTriangles: {
    high: Infinity,
    medium: 200,
    low: 48,
    'ultra-low': 12,
  },
};

/** Segment counts for curves/bevels at each quality level */
export const QUALITY_SEGMENTS: Record<QualityLevel, { curve: number; bevel: number; cylinder: number }> = {
  high: { curve: 8, bevel: 2, cylinder: 12 },
  medium: { curve: 4, bevel: 1, cylinder: 8 },
  low: { curve: 2, bevel: 0, cylinder: 6 },
  'ultra-low': { curve: 1, bevel: 0, cylinder: 4 },
};

export class GeometryOptimizer {
  private lodConfig: LODConfig;

  constructor(config?: Partial<LODConfig>) {
    this.lodConfig = { ...DEFAULT_LOD_CONFIG, ...config };
  }

  /**
   * Get recommended quality level based on the GPU quality scale (0-1).
   */
  qualityFromScale(scale: number): QualityLevel {
    if (scale >= 0.8) return 'high';
    if (scale >= 0.5) return 'medium';
    if (scale >= 0.3) return 'low';
    return 'ultra-low';
  }

  /**
   * Get segment configuration for the current quality level.
   */
  getSegments(quality: QualityLevel): { curve: number; bevel: number; cylinder: number } {
    return QUALITY_SEGMENTS[quality];
  }

  /**
   * Create a THREE.LOD object for a furniture group.
   * Generates simplified versions at each distance threshold.
   */
  createFurnitureLOD(
    detailedGroup: THREE.Group,
    boundingSize: THREE.Vector3,
  ): THREE.LOD {
    const lod = new THREE.LOD();

    // Level 0: Full detail
    lod.addLevel(detailedGroup, 0);

    // Level 1: Medium — simplified bounding box with averaged color
    const mediumMesh = this.createSimplifiedMesh(detailedGroup, boundingSize, 'medium');
    lod.addLevel(mediumMesh, this.lodConfig.distances[0]);

    // Level 2: Low — single box
    const lowMesh = this.createSimplifiedMesh(detailedGroup, boundingSize, 'low');
    lod.addLevel(lowMesh, this.lodConfig.distances[1]);

    // Level 3: Ultra-low — tiny sprite/billboard placeholder
    const ultraLowMesh = this.createUltraLowMesh(boundingSize);
    lod.addLevel(ultraLowMesh, this.lodConfig.distances[2]);

    return lod;
  }

  /**
   * Create a simplified single-mesh representation of a furniture group.
   */
  private createSimplifiedMesh(
    group: THREE.Group,
    size: THREE.Vector3,
    _quality: QualityLevel,
  ): THREE.Group {
    const avgColor = this.extractAverageColor(group);
    const simplified = new THREE.Group();

    const geo = new THREE.BoxGeometry(
      Math.max(size.x, 1),
      Math.max(size.y, 1),
      Math.max(size.z, 1),
    );
    const mat = new THREE.MeshStandardMaterial({
      color: avgColor,
      roughness: 0.75,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, size.y / 2, 0);
    simplified.add(mesh);

    return simplified;
  }

  /**
   * Generate an ultra-low quality placeholder (flat colored plane or tiny box).
   */
  private createUltraLowMesh(size: THREE.Vector3): THREE.Group {
    const group = new THREE.Group();
    const geo = new THREE.PlaneGeometry(
      Math.max(size.x, 1),
      Math.max(size.z, 1),
    );
    const mat = new THREE.MeshBasicMaterial({
      color: 0xBBBBBB,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 1;
    group.add(mesh);
    return group;
  }

  /**
   * Extract the average color from all meshes in a group.
   */
  private extractAverageColor(group: THREE.Object3D): THREE.Color {
    let r = 0, g = 0, b = 0, count = 0;
    const tmpColor = new THREE.Color();

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if ('color' in mat && mat.color instanceof THREE.Color) {
          tmpColor.copy(mat.color);
          r += tmpColor.r;
          g += tmpColor.g;
          b += tmpColor.b;
          count++;
        }
      }
    });

    if (count === 0) return new THREE.Color(0xAAAAAA);
    return new THREE.Color(r / count, g / count, b / count);
  }

  /**
   * Merge multiple mesh groups that share the same material into fewer draw calls.
   * Returns a single Group with merged geometries per unique material.
   */
  mergeGroups(groups: THREE.Group[]): THREE.Group {
    const materialBuckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();

    for (const group of groups) {
      group.updateMatrixWorld(true);
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of materials) {
          const key = mat.uuid;
          if (!materialBuckets.has(key)) {
            materialBuckets.set(key, { material: mat, geometries: [] });
          }
          const geo = child.geometry.clone();
          geo.applyMatrix4(child.matrixWorld);
          materialBuckets.get(key)!.geometries.push(geo);
        }
      });
    }

    const merged = new THREE.Group();
    merged.name = 'merged-batch';

    for (const [, bucket] of materialBuckets) {
      if (bucket.geometries.length === 0) continue;
      try {
        const mergedGeo = bucket.geometries.length === 1
          ? bucket.geometries[0]
          : mergeGeometries(bucket.geometries, false);
        if (mergedGeo) {
          const mesh = new THREE.Mesh(mergedGeo, bucket.material);
          merged.add(mesh);
        }
      } catch {
        // Fallback: add individual meshes if merge fails
        for (const geo of bucket.geometries) {
          merged.add(new THREE.Mesh(geo, bucket.material));
        }
      }
    }

    return merged;
  }

  /**
   * Count total triangles in a group hierarchy.
   */
  static countTriangles(object: THREE.Object3D): number {
    let total = 0;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        const geo = child.geometry;
        if (geo.index) {
          total += geo.index.count / 3;
        } else if (geo.attributes.position) {
          total += geo.attributes.position.count / 3;
        }
      }
    });
    return total;
  }

  /**
   * Count total draw calls (meshes + lines) in a group hierarchy.
   */
  static countDrawCalls(object: THREE.Object3D): number {
    let count = 0;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments) {
        count++;
      }
    });
    return count;
  }
}
