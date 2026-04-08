/**
 * Object Pool Manager
 * 
 * Reuses Three.js objects (geometries, meshes, groups) instead of
 * creating and disposing them on every scene rebuild. This prevents
 * GPU memory fragmentation and reduces GC pressure.
 */

import * as THREE from 'three';

type PoolKey = string;

interface PoolEntry<T> {
  object: T;
  inUse: boolean;
  lastUsed: number;
}

export class ObjectPoolManager {
  private geometryPool = new Map<PoolKey, PoolEntry<THREE.BufferGeometry>[]>();
  private groupPool: PoolEntry<THREE.Group>[] = [];
  private maxIdleTime = 30_000; // 30 seconds before disposal

  /**
   * Get or create a geometry for the given key.
   * If a matching idle geometry exists, reuse it; otherwise create via factory.
   */
  getGeometry(key: PoolKey, factory: () => THREE.BufferGeometry): THREE.BufferGeometry {
    const pool = this.geometryPool.get(key);
    if (pool) {
      const idle = pool.find((entry) => !entry.inUse);
      if (idle) {
        idle.inUse = true;
        idle.lastUsed = Date.now();
        return idle.object;
      }
    }

    const geo = factory();
    if (!this.geometryPool.has(key)) {
      this.geometryPool.set(key, []);
    }
    this.geometryPool.get(key)!.push({
      object: geo,
      inUse: true,
      lastUsed: Date.now(),
    });
    return geo;
  }

  /**
   * Get or create a Group from the pool.
   */
  getGroup(): THREE.Group {
    const idle = this.groupPool.find((entry) => !entry.inUse);
    if (idle) {
      idle.inUse = true;
      idle.lastUsed = Date.now();
      // Clear any existing children
      while (idle.object.children.length > 0) {
        idle.object.remove(idle.object.children[0]);
      }
      idle.object.position.set(0, 0, 0);
      idle.object.rotation.set(0, 0, 0);
      idle.object.scale.set(1, 1, 1);
      idle.object.name = '';
      return idle.object;
    }

    const group = new THREE.Group();
    this.groupPool.push({
      object: group,
      inUse: true,
      lastUsed: Date.now(),
    });
    return group;
  }

  /**
   * Release a geometry back to the pool.
   */
  releaseGeometry(key: PoolKey, geo: THREE.BufferGeometry): void {
    const pool = this.geometryPool.get(key);
    if (!pool) return;
    const entry = pool.find((e) => e.object === geo);
    if (entry) {
      entry.inUse = false;
      entry.lastUsed = Date.now();
    }
  }

  /**
   * Release a group back to the pool.
   */
  releaseGroup(group: THREE.Group): void {
    const entry = this.groupPool.find((e) => e.object === group);
    if (entry) {
      entry.inUse = false;
      entry.lastUsed = Date.now();
    }
  }

  /**
   * Release all objects (mark as idle). Call at the start of a scene rebuild.
   */
  releaseAll(): void {
    for (const [, pool] of this.geometryPool) {
      pool.forEach((entry) => { entry.inUse = false; });
    }
    this.groupPool.forEach((entry) => { entry.inUse = false; });
  }

  /**
   * Dispose idle objects that haven't been used recently.
   */
  gc(): { disposed: number } {
    const now = Date.now();
    let disposed = 0;

    for (const [key, pool] of this.geometryPool) {
      const remaining: PoolEntry<THREE.BufferGeometry>[] = [];
      for (const entry of pool) {
        if (!entry.inUse && now - entry.lastUsed > this.maxIdleTime) {
          entry.object.dispose();
          disposed++;
        } else {
          remaining.push(entry);
        }
      }
      if (remaining.length === 0) {
        this.geometryPool.delete(key);
      } else {
        this.geometryPool.set(key, remaining);
      }
    }

    const remainingGroups: PoolEntry<THREE.Group>[] = [];
    for (const entry of this.groupPool) {
      if (!entry.inUse && now - entry.lastUsed > this.maxIdleTime) {
        disposed++;
      } else {
        remainingGroups.push(entry);
      }
    }
    this.groupPool = remainingGroups;

    return { disposed };
  }

  /**
   * Dispose everything.
   */
  dispose(): void {
    for (const [, pool] of this.geometryPool) {
      pool.forEach((entry) => entry.object.dispose());
    }
    this.geometryPool.clear();
    this.groupPool = [];
  }

  /**
   * Get pool stats for debugging.
   */
  getStats(): { geometries: number; groups: number; inUse: number } {
    let geoCount = 0;
    let inUse = 0;
    for (const [, pool] of this.geometryPool) {
      geoCount += pool.length;
      inUse += pool.filter((e) => e.inUse).length;
    }
    return {
      geometries: geoCount,
      groups: this.groupPool.length,
      inUse: inUse + this.groupPool.filter((e) => e.inUse).length,
    };
  }
}
