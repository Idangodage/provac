import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";


import {
  getUniqueHvacModelUrls,
  instantiateGlbModel,
  preloadGlb,
  unplacedMeshIndices,
} from "./glbModelCache";

/** The real catalog file (read at test time; the package has no Node typings). */
async function readFdum22Glb(): Promise<ArrayBuffer> {
  const fs = (await import(/* @vite-ignore */ `node:${"fs"}`)) as { readFileSync(path: URL): Uint8Array };
  const bytes = fs.readFileSync(new URL("../../../../../../../apps/web/public/models/vrf/maco-vrf-fdum22kxe6f-w.glb", import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GLB model preloading", () => {
  it("collects stable, unique non-empty HVAC model URLs", () => {
    expect(getUniqueHvacModelUrls([
      { properties: { modelUrl: "/models/b.glb" } },
      { properties: { modelUrl: " /models/a.glb " } },
      { properties: { modelUrl: "/models/b.glb" } },
      { properties: { modelUrl: "" } },
      { properties: {} },
    ])).toEqual([
      "/models/a.glb",
      "/models/b.glb",
    ]);
  });

  it("loads a URL once and notifies every subscriber when it settles", async () => {
    const url = "/models/test-concurrent-subscribers.glb";
    let finish: () => void = () => {
      throw new Error("GLTFLoader.load was not invoked");
    };
    const loadSpy = vi.spyOn(GLTFLoader.prototype, "load").mockImplementation(
      (_url, onLoad) => {
        finish = () => onLoad({
          scene: new THREE.Group(),
        } as GLTF);
      },
    );
    const first = vi.fn();
    const second = vi.fn();

    preloadGlb(url, first);
    preloadGlb(url, second);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    finish();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    const alreadySettled = vi.fn();
    preloadGlb(url, alreadySettled);
    await Promise.resolve();
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(alreadySettled).toHaveBeenCalledTimes(1);
  });

  it("places the meshes an IFC export leaves unplaced (the FDUM22 body)", async () => {
    const buffer = await readFdum22Glb();
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, new DataView(buffer).getUint32(12, true))));
    // Seven parts over one vertex buffer; the only node places the last one.
    expect(unplacedMeshIndices(json)).toEqual([0, 1, 2, 3, 4, 5]);

    const url = "/models/test-fdum22.glb";
    vi.spyOn(GLTFLoader.prototype, "load").mockImplementation(function (this: GLTFLoader, _url, onLoad, _progress, onError) {
      this.parse(buffer, "", onLoad as (gltf: GLTF) => void, onError as (error: unknown) => void);
    });
    await new Promise<void>((resolve) => preloadGlb(url, resolve));
    const model = instantiateGlbModel(url)!;
    let meshes = 0;
    model.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes += 1; });
    expect(meshes).toBe(7);
    const box = new THREE.Box3().setFromObject(model);
    expect(box.max.z - box.min.z).toBeCloseTo(300, 3);
    expect(box.max.x - box.min.x).toBeCloseTo(1084, 3);
  });
});
