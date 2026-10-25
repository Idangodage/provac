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

import { FOCUS_ACCENT, HybridOutlineEffect } from './hybridOutlineEffect';

export const SELECTION_ACCENT = 0x4f8cff;

export class HybridPostFX {
  private readonly composer: EffectComposer;
  private readonly outline: HybridOutlineEffect;
  private hoverCount = 0;
  private selectionCount = 0;
  private focusCount = 0;

  /** Plain rendering is identical when no outline has anything in it. */
  get hasOutlines(): boolean {
    return this.hoverCount > 0 || this.selectionCount > 0 || this.focusCount > 0;
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

  /** The thick violet outline of a duct segment whose card is open. */
  setFocus(objects: THREE.Object3D[]): void {
    this.focusCount = objects.length;
    this.outline.focus.set(objects);
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

/** The rings marking a focused duct segment's two ends (solid violet). */
export const FOCUS_RING_MATERIAL = new THREE.MeshBasicMaterial({ color: FOCUS_ACCENT });

/** The unit panel's network pointing at a stretch: a translucent sky wash over it (pinned, stronger), apart from the segment cards' violet. */
export const NETWORK_ACCENT = 0x0ea5e9;
const networkWash = (opacity: number) => new THREE.MeshBasicMaterial({
  color: NETWORK_ACCENT,
  transparent: true,
  opacity,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
export const NETWORK_HOVER_MATERIAL = networkWash(0.26);
export const NETWORK_PINNED_MATERIAL = networkWash(0.44);

/** A translucent violet wash over a focused duct segment's own surface (drawn just in front of it). */
export const FOCUS_OVERLAY_MATERIAL = new THREE.MeshBasicMaterial({
  color: FOCUS_ACCENT,
  transparent: true,
  opacity: 0.34,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -4,
});
