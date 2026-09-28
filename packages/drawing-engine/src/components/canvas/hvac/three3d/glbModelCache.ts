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
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

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

/** Meshes the file defines but no node places (an IFC → GLB converter fault). */
export function unplacedMeshIndices(json: { meshes?: unknown[]; nodes?: Array<{ mesh?: number }> } | undefined): number[] {
  if (!json?.meshes) return [];
  const placed = new Set((json.nodes ?? []).flatMap((node) => (node.mesh !== undefined ? [node.mesh] : [])));
  return json.meshes.map((_, index) => index).filter((index) => !placed.has(index));
}

/**
 * The MEPcontent IFC → GLB export writes every part of a unit as its own mesh
 * over one shared vertex buffer, but places only the LAST mesh in the scene —
 * the rest of the body never renders (a ducted unit showed as a small block).
 * Place the unplaced meshes where the placed one sits (same parent, same node
 * transform), so the whole model renders.
 */
async function placeUnplacedMeshes(gltf: GLTF, indices: number[]): Promise<void> {
  let host: THREE.Object3D | null = null;
  gltf.scene.traverse((object) => {
    if (!host && (object as THREE.Mesh).isMesh) host = object;
  });
  if (!host) return;
  const anchor = host as THREE.Object3D;
  const parts = await Promise.all(indices.map((index) => gltf.parser.getDependency("mesh", index) as Promise<THREE.Object3D>));
  anchor.updateMatrix();
  for (const part of parts) {
    part.applyMatrix4(anchor.matrix);
    (anchor.parent ?? gltf.scene).add(part);
  }
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
      const unplaced = unplacedMeshIndices(gltf.parser?.json as Parameters<typeof unplacedMeshIndices>[0]);
      if (unplaced.length === 0) {
        settle("loaded", gltf.scene);
        return;
      }
      placeUnplacedMeshes(gltf, unplaced).then(
        () => settle("loaded", gltf.scene),
        () => settle("loaded", gltf.scene),
      );
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
