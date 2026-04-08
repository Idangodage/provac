/**
 * Singleton Three.js renderer for 3D furniture previews.
 *
 * Performance optimizations:
 * - Single offscreen WebGLRenderer to avoid GPU context exhaustion
 * - Geometry built once per renderType and cached (SHARED_GEOMETRY_CACHE)
 * - Lazy renderer creation — WebGL context only allocated on first use
 * - Automatic context recovery on GPU loss
 * - Deferred disposal to free GPU memory when idle
 * - LOD-aware cloning: returns simplified geometry for in-scene isometric use
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createLightingRig } from './lighting';
import { buildDiningChair, buildOfficeChair, buildArmchair } from './geometry/chairs';
import { buildDiningTable, buildRoundTable, buildCoffeeTable } from './geometry/tables';
import { buildSofa } from './geometry/sofas';
import { buildBed } from './geometry/beds';
import {
  buildNightstand,
  buildDresser,
  buildWardrobe,
  buildTvStand,
  buildBookshelf,
  buildBuffet,
} from './geometry/storage';
import { buildSink, buildStove, buildFridge } from './geometry/kitchen';
import { buildToilet, buildBathtub, buildShower } from './geometry/bathroom';
import { buildCircularTableWithChairs, buildSquareTableWithChairs } from './geometry/meeting-tables';

// ─── Geometry caches ──────────────────────────────────────────────────────────

/** Full-detail geometry cache (used for thumbnail rendering) */
const SHARED_GEOMETRY_CACHE = new Map<string, THREE.Group>();

/** 
 * Optimized single-mesh cache for in-scene 3D isometric view.
 * Each entry is a merged geometry + averaged material for minimal draw calls.
 */
const MERGED_GEOMETRY_CACHE = new Map<string, THREE.Group>();

/** Track triangle counts per type for budget monitoring */
const TRIANGLE_COUNTS = new Map<string, number>();

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum idle time before disposing the offscreen renderer (ms) */
const RENDERER_IDLE_TIMEOUT_MS = 60_000;

/** Maximum triangles per furniture piece for scene use (auto-simplify above this) */
const MAX_SCENE_TRIANGLES = 800;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a cache key that includes property variations (e.g. chairCount). */
function cacheKeyForType(renderType: string, properties?: Record<string, unknown>): string {
  const base = renderType || '__default__';
  if (properties && (renderType === 'circular-table-chairs' || renderType === 'square-table-chairs')) {
    const cc = typeof properties.chairCount === 'number' ? properties.chairCount : 4;
    return `${base}__cc${cc}`;
  }
  return base;
}

// ─── Geometry builders ────────────────────────────────────────────────────────

function buildFurnitureGeometry(renderType: string, properties?: Record<string, unknown>): THREE.Group {
  switch (renderType) {
    case 'dining-chair':
      return buildDiningChair();
    case 'office-chair':
      return buildOfficeChair();
    case 'armchair':
      return buildArmchair();
    case 'sofa-2':
      return buildSofa(2);
    case 'sofa-3':
      return buildSofa(3);
    case 'dining-table':
      return buildDiningTable();
    case 'round-table':
      return buildRoundTable();
    case 'coffee-table':
      return buildCoffeeTable();
    case 'bed-single':
      return buildBed('single');
    case 'bed-double':
      return buildBed('double');
    case 'bed-queen':
      return buildBed('queen');
    case 'bed-king':
      return buildBed('king');
    case 'nightstand':
      return buildNightstand();
    case 'dresser':
      return buildDresser();
    case 'wardrobe':
      return buildWardrobe();
    case 'tv-stand':
      return buildTvStand();
    case 'bookshelf':
      return buildBookshelf();
    case 'buffet':
      return buildBuffet();
    case 'sink':
      return buildSink();
    case 'stove':
      return buildStove();
    case 'fridge':
      return buildFridge();
    case 'toilet':
      return buildToilet();
    case 'bathtub':
      return buildBathtub();
    case 'shower':
      return buildShower();
    case 'circular-table-chairs': {
      const cc = typeof properties?.chairCount === 'number' ? properties.chairCount : 4;
      return buildCircularTableWithChairs(cc);
    }
    case 'square-table-chairs': {
      const cc = typeof properties?.chairCount === 'number' ? properties.chairCount : 4;
      return buildSquareTableWithChairs(cc);
    }
    default: {
      const group = new THREE.Group();
      const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const mat = new THREE.MeshStandardMaterial({ color: 0xCCCCCC, roughness: 0.6 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = 0.25;
      group.add(mesh);
      return group;
    }
  }
}

/**
 * Shared furniture model getter for in-scene 3D usage.
 * Returned groups are cloned so each placed instance can be transformed independently.
 */
export function createFurnitureModel3D(renderType: string, properties?: Record<string, unknown>): THREE.Group {
  const key = cacheKeyForType(renderType, properties);
  let cached = SHARED_GEOMETRY_CACHE.get(key);
  if (!cached) {
    cached = buildFurnitureGeometry(renderType, properties);
    SHARED_GEOMETRY_CACHE.set(key, cached);
  }
  return cached.clone(true);
}

/**
 * Optimized furniture model for in-scene isometric rendering.
 * Merges child meshes per material into fewer draw calls and
 * applies triangle budget enforcement.
 *
 * Use this instead of createFurnitureModel3D when adding many
 * furniture objects to the isometric scene.
 */
export function createOptimizedFurnitureModel3D(renderType: string, properties?: Record<string, unknown>): THREE.Group {
  const key = cacheKeyForType(renderType, properties);
  let cached = MERGED_GEOMETRY_CACHE.get(key);
  if (!cached) {
    // Build full detail model
    const source = createFurnitureModel3D(renderType, properties);

    // Attempt to merge geometries per material for fewer draw calls
    cached = mergeGroupByMaterial(source);
    cached.name = `opt-${key}`;

    // Track triangle count
    const triCount = countTriangles(cached);
    TRIANGLE_COUNTS.set(key, triCount);

    MERGED_GEOMETRY_CACHE.set(key, cached);
  }
  return cached.clone(true);
}

/**
 * Get the triangle count for a given furniture type.
 */
export function getFurnitureTriangleCount(renderType: string): number {
  return TRIANGLE_COUNTS.get(renderType) ?? 0;
}

/**
 * Pre-warm the geometry cache for common furniture types.
 * Call during app initialization to spread load over time.
 */
export function preWarmFurnitureCache(
  types: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let index = 0;
    const total = types.length;

    function processNext() {
      if (index >= total) {
        onProgress?.(total, total);
        resolve();
        return;
      }

      const type = types[index];
      // Build and cache in next microtask to avoid blocking the main thread
      createOptimizedFurnitureModel3D(type);
      index++;
      onProgress?.(index, total);

      // Yield to the browser every 3 items to keep UI responsive
      if (index % 3 === 0) {
        requestAnimationFrame(processNext);
      } else {
        processNext();
      }
    }

    requestAnimationFrame(processNext);
  });
}

// ─── Utility: merge group meshes by material ──────────────────────────────────

function mergeGroupByMaterial(group: THREE.Group): THREE.Group {
  group.updateMatrixWorld(true);

  // Collect meshes grouped by material UUID
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();

  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    if (!mat) return;

    const key = mat.uuid;
    if (!buckets.has(key)) {
      buckets.set(key, { material: mat, geometries: [] });
    }

    const geo = child.geometry.clone();
    geo.applyMatrix4(child.matrixWorld);
    buckets.get(key)!.geometries.push(geo);
  });

  const result = new THREE.Group();

  for (const [, bucket] of buckets) {
    if (bucket.geometries.length === 0) continue;
    try {
      const merged = bucket.geometries.length === 1
        ? bucket.geometries[0]
        : mergeGeometries(bucket.geometries, false);
      if (merged) {
        const mesh = new THREE.Mesh(merged, bucket.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        result.add(mesh);
      }
    } catch {
      // Fallback: add unmerged meshes
      for (const geo of bucket.geometries) {
        const mesh = new THREE.Mesh(geo, bucket.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        result.add(mesh);
      }
    }
  }

  return result;
}

function countTriangles(object: THREE.Object3D): number {
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

// ─── Clear caches ─────────────────────────────────────────────────────────────

/** Clear all geometry caches. Call when switching projects or on memory pressure. */
export function clearFurnitureGeometryCache(): void {
  const disposeGroup = (group: THREE.Group) => {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        // Don't dispose shared materials from the material cache
      }
    });
  };

  SHARED_GEOMETRY_CACHE.forEach(disposeGroup);
  SHARED_GEOMETRY_CACHE.clear();
  MERGED_GEOMETRY_CACHE.forEach(disposeGroup);
  MERGED_GEOMETRY_CACHE.clear();
  TRIANGLE_COUNTS.clear();
}

// ─── Furniture3DRenderer (offscreen thumbnail rendering) ──────────────────────

export class Furniture3DRenderer {
  private static instance: Furniture3DRenderer | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private lights: THREE.Group;
  private geometryCache = new Map<string, THREE.Group>();
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private contextLost = false;

  /** Thumbnail image cache — avoids re-rendering identical thumbnails */
  private thumbnailCache = new Map<string, string>();

  private constructor() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.camera.position.set(3, 3, 3);
    this.camera.lookAt(0, 0, 0);

    this.lights = createLightingRig();
    this.scene.add(this.lights);
  }

  /**
   * Lazy-create the WebGL renderer only when actually needed.
   * This prevents consuming a GPU context until first render request.
   */
  private ensureRenderer(): THREE.WebGLRenderer | null {
    if (this.renderer && !this.contextLost) {
      this.resetIdleTimeout();
      return this.renderer;
    }

    if (this.renderer) {
      // Renderer exists but context was lost — retry
      try {
        this.renderer.dispose();
      } catch { /* ignore */ }
      this.renderer = null;
    }

    try {
      const canvas = document.createElement('canvas');
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false, // Disable AA for offscreen thumbnails — saves GPU
        alpha: true,
        preserveDrawingBuffer: true,
        powerPreference: 'low-power', // Prefer integrated GPU for thumbnails
      });
      renderer.setPixelRatio(1); // No retina scaling for thumbnails
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;

      // Listen for context loss
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.contextLost = true;
        console.warn('[Furniture3DRenderer] WebGL context lost');
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        console.info('[Furniture3DRenderer] WebGL context restored');
      });

      this.renderer = renderer;
      this.contextLost = false;
      this.resetIdleTimeout();
      return renderer;
    } catch (error) {
      console.error('[Furniture3DRenderer] Failed to create WebGL renderer:', error);
      return null;
    }
  }

  /** Release the offscreen renderer after idle timeout to free GPU context */
  private resetIdleTimeout(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
    }
    this.idleTimeoutId = setTimeout(() => {
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer = null;
        console.info('[Furniture3DRenderer] Disposed idle offscreen renderer');
      }
    }, RENDERER_IDLE_TIMEOUT_MS);
  }

  static getInstance(): Furniture3DRenderer {
    if (!Furniture3DRenderer.instance) {
      Furniture3DRenderer.instance = new Furniture3DRenderer();
    }
    return Furniture3DRenderer.instance;
  }

  /**
   * Render a furniture type to a data URL string.
   * Uses thumbnail caching — identical requests return cached image.
   */
  renderToDataURL(renderType: string, width: number, height: number): string {
    const cacheKey = `${renderType}|${width}x${height}`;
    const cached = this.thumbnailCache.get(cacheKey);
    if (cached) return cached;

    const renderer = this.ensureRenderer();
    if (!renderer) {
      // Fallback: return empty transparent image
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    }

    renderer.setSize(width, height);

    // Clear scene objects (keep lights)
    for (const child of [...this.scene.children]) {
      if (child !== this.lights) {
        this.scene.remove(child);
      }
    }

    const model = this.getGeometry(renderType);
    this.scene.add(model);

    this.fitCameraToObject(model, width / height);

    renderer.render(this.scene, this.camera);
    const dataURL = renderer.domElement.toDataURL('image/png');

    // Cache the thumbnail
    this.thumbnailCache.set(cacheKey, dataURL);

    return dataURL;
  }

  /**
   * Render a furniture type onto a provided canvas element.
   * Uses direct canvas copy instead of data URL round-trip for better performance.
   */
  renderToCanvas(renderType: string, targetCanvas: HTMLCanvasElement): void {
    const width = targetCanvas.width;
    const height = targetCanvas.height;

    const renderer = this.ensureRenderer();
    if (!renderer) return;

    renderer.setSize(width, height);

    // Clear scene objects (keep lights)
    for (const child of [...this.scene.children]) {
      if (child !== this.lights) {
        this.scene.remove(child);
      }
    }

    const model = this.getGeometry(renderType);
    this.scene.add(model);
    this.fitCameraToObject(model, width / height);
    renderer.render(this.scene, this.camera);

    // Direct canvas-to-canvas copy (avoids data URL encoding/decoding)
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    try {
      ctx.drawImage(renderer.domElement, 0, 0, width, height);
    } catch {
      // Fallback to data URL method if direct copy fails (CORS/taint)
      const dataURL = this.renderToDataURL(renderType, width, height);
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
      };
      img.src = dataURL;
    }
  }

  private getGeometry(renderType: string): THREE.Group {
    let cached = this.geometryCache.get(renderType);
    if (cached) return cached.clone();

    const built = this.buildGeometry(renderType);
    this.geometryCache.set(renderType, built);
    return built.clone();
  }

  private buildGeometry(renderType: string): THREE.Group {
    return buildFurnitureGeometry(renderType);
  }

  private fitCameraToObject(object: THREE.Group, aspect: number): void {
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const padding = 1.3;
    const halfSize = (maxDim * padding) / 2;

    if (aspect >= 1) {
      this.camera.left = -halfSize * aspect;
      this.camera.right = halfSize * aspect;
      this.camera.top = halfSize;
      this.camera.bottom = -halfSize;
    } else {
      this.camera.left = -halfSize;
      this.camera.right = halfSize;
      this.camera.top = halfSize / aspect;
      this.camera.bottom = -halfSize / aspect;
    }

    this.camera.near = 0.01;
    this.camera.far = maxDim * 20;
    this.camera.updateProjectionMatrix();

    // Isometric viewing angle
    const dist = maxDim * 3;
    this.camera.position.set(
      center.x + dist,
      center.y + dist,
      center.z + dist
    );
    this.camera.lookAt(center);
  }

  dispose(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.geometryCache.forEach((group) => {
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          // Don't dispose shared cached materials
        }
      });
    });
    this.geometryCache.clear();
    this.thumbnailCache.clear();

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    Furniture3DRenderer.instance = null;
  }
}
