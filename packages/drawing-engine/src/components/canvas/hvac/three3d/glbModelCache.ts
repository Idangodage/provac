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

import type { HvacElement } from "../../../../types";
import { markMaterialOwned } from "../../threeResourceLifecycle";

type CacheEntry = {
  status: "loading" | "loaded" | "error";
  scene?: THREE.Group;
  listeners: Set<() => void>;
};

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
  const existing = cache.get(url);
  if (existing) {
    if (onSettled) {
      if (existing.status === "loading") {
        existing.listeners.add(onSettled);
      } else {
        queueMicrotask(onSettled);
      }
    }
    return;
  }
  const listeners = new Set<() => void>();
  if (onSettled) listeners.add(onSettled);
  const entry: CacheEntry = { status: "loading", listeners };
  cache.set(url, entry);
  const settle = (status: "loaded" | "error", scene?: THREE.Group): void => {
    entry.status = status;
    entry.scene = scene;
    const pending = [...entry.listeners];
    entry.listeners.clear();
    pending.forEach((listener) => listener());
  };
  getLoader().load(
    url,
    (gltf) => {
      settle("loaded", gltf.scene);
    },
    undefined,
    () => {
      settle("error");
    },
  );
}

/** Stable unique catalog model URLs referenced by the current HVAC scene. */
export function getUniqueHvacModelUrls(
  elements: readonly Pick<HvacElement, "properties">[],
): string[] {
  const urls = new Set<string>();
  elements.forEach((element) => {
    const value = element.properties?.modelUrl;
    if (typeof value !== "string") return;
    const url = value.trim();
    if (url) urls.add(url);
  });
  return [...urls].sort();
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
          ? mesh.material.map((m) => markMaterialOwned(m.clone()))
          : markMaterialOwned(mesh.material.clone());
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
