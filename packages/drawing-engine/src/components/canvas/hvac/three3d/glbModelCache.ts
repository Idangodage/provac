"use client";

/**
 * Async GLB model cache for the 3D projection layer.
 *
 * `buildHvacElementMesh` is synchronous, but glTF loading is async, so real
 * catalog models (converted from the manufacturer IFC → GLB, in millimetres,
 * Z-up) are loaded ONCE here and cached. The projection layer preloads every
 * referenced model and rebuilds the scene when a load settles; the builder then
 * clones the cached scene synchronously.
 *
 * Instances are FULLY cloned (geometry + materials), because the projection
 * layer disposes geometry and mutates materials on every rebuild — sharing them
 * with the cache source would dispose/recolour the master copy.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type CacheEntry = { status: "loading" | "loaded" | "error"; scene?: THREE.Group };

const cache = new Map<string, CacheEntry>();
let loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
  }
  return loader;
}

/** Kicks off a load if this URL has not been requested yet. Idempotent.
 * `onSettled` fires once when THIS call's load finishes (success or error). */
export function preloadGlb(url: string, onSettled?: () => void): void {
  if (cache.has(url)) {
    return;
  }
  cache.set(url, { status: "loading" });
  getLoader().load(
    url,
    (gltf) => {
      cache.set(url, { status: "loaded", scene: gltf.scene });
      onSettled?.();
    },
    undefined,
    () => {
      cache.set(url, { status: "error" });
      onSettled?.();
    },
  );
}

function getLoadedGlb(url: string): THREE.Group | null {
  const entry = cache.get(url);
  return entry?.status === "loaded" && entry.scene ? entry.scene : null;
}

/**
 * Returns a positioned, fully-independent clone of the cached model, or null if
 * it is not loaded yet. Local frame: footprint centre at (0,0), bottom face at
 * z=0 — so the caller places the group at the plan centre with z = elevation
 * (which the app defines as the height of the unit's bottom face). The source
 * GLB is mm + Z-up, matching the scene, so no rescale/reorientation is needed.
 */
export function instantiateGlbModel(url: string): THREE.Group | null {
  const src = getLoadedGlb(url);
  if (!src) {
    return null;
  }
  const model = src.clone(true);
  model.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
      if (mesh.geometry) {
        mesh.geometry = mesh.geometry.clone();
      }
      if (mesh.material) {
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => m.clone())
          : mesh.material.clone();
      }
    }
  });

  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) {
    return null;
  }
  const center = box.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -center.y, -box.min.z);

  const wrap = new THREE.Group();
  wrap.name = "glb-model";
  wrap.add(model);
  return wrap;
}
