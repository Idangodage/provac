/**
 * Post-processing for the hybrid scene — faithful port of the reference app's
 * `engine/renderer/postfx.ts`: EffectComposer (MSAA 4) with a RenderPass and
 * ONE EffectPass hosting two OutlineEffects. Hover reads soft (edgeStrength
 * 2.5 @ 50% opacity), selection strong (edgeStrength 6); both use the shared
 * accent 0x4f8cff with xRay so outlines read through occluders.
 */
import {
  BlendFunction,
  EffectComposer,
  EffectPass,
  OutlineEffect,
  RenderPass,
} from "postprocessing";
import * as THREE from "three";

export const SELECTION_ACCENT = 0x4f8cff;

export class HybridPostFX {
  private readonly composer: EffectComposer;
  private readonly hoverOutline: OutlineEffect;
  private readonly selectionOutline: OutlineEffect;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer, { multisampling: 4 });
    this.composer.addPass(new RenderPass(scene, camera));

    this.hoverOutline = new OutlineEffect(scene, camera, {
      blendFunction: BlendFunction.SCREEN,
      edgeStrength: 3.5,
      visibleEdgeColor: SELECTION_ACCENT,
      hiddenEdgeColor: SELECTION_ACCENT,
      // FULL-resolution outline buffer (default 0.5 half-res upscales into
      // broken/aliased thin lines) + MSAA so the edge stays sharp & continuous.
      resolutionScale: 1,
      multisampling: 4,
      blur: false,
      xRay: false,
    });
    this.hoverOutline.blendMode.opacity.value = 0.55;

    this.selectionOutline = new OutlineEffect(scene, camera, {
      blendFunction: BlendFunction.SCREEN,
      edgeStrength: 8,
      visibleEdgeColor: SELECTION_ACCENT,
      hiddenEdgeColor: SELECTION_ACCENT,
      resolutionScale: 1,
      multisampling: 4,
      blur: false,
      // xRay off → ONE solid silhouette (no visible/hidden split that breaks
      // the line where the wall self-occludes at grazing angles).
      xRay: false,
    });

    this.composer.addPass(new EffectPass(camera, this.hoverOutline, this.selectionOutline));
  }

  setHover(objects: THREE.Object3D[]): void {
    this.hoverOutline.selection.set(objects);
  }

  setSelection(objects: THREE.Object3D[]): void {
    this.selectionOutline.selection.set(objects);
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
