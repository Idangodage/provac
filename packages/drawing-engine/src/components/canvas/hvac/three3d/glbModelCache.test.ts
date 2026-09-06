import * as THREE from "three";
import {
  GLTFLoader,
  type GLTF,
} from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getUniqueHvacModelUrls,
  preloadGlb,
} from "./glbModelCache";

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
});
