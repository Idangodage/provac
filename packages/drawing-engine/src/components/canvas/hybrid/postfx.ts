/**
 * One solid scene render and a shared-depth outline composite. Hover and
 * selection draw only their proxies; neither redraws the full model for depth.
 */
import {
  EffectComposer,
  EffectPass,
  RenderPass,
} from "postprocessing";
import * as THREE from "three";

import { HybridOutlineEffect } from './hybridOutlineEffect';

export const SELECTION_ACCENT = 0x4f8cff;

export class HybridPostFX {
  private readonly composer: EffectComposer;
  private readonly outline: HybridOutlineEffect;
  private hoverCount = 0;
  private selectionCount = 0;

  /** Plain rendering is identical when neither outline has a selection. */
  get hasOutlines(): boolean {
    return this.hoverCount > 0 || this.selectionCount > 0;
  }

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer, { multisampling: 4 });
    this.composer.addPass(new RenderPass(scene, camera));

    this.outline = new HybridOutlineEffect(scene, camera, SELECTION_ACCENT);
    this.composer.addPass(new EffectPass(camera, this.outline));
  }

  setHover(objects: THREE.Object3D[]): void {
    this.hoverCount = objects.length;
    this.outline.hover.set(objects);
  }

  setSelection(objects: THREE.Object3D[]): void {
    this.selectionCount = objects.length;
    this.outline.selected.set(objects);
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height, false);
  }

  render(delta: number): void {
    this.composer.render(delta);
  }

  dispose(): void {
    this.composer.dispose();
  }
}

/** Invisible-but-outlineable proxy material (reference PROXY_MATERIAL). */
export const OUTLINE_PROXY_MATERIAL = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});
