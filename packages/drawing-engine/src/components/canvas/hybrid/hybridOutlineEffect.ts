import { BlendFunction, DepthComparisonMaterial, Effect, EffectAttribute, RenderPass, Selection } from 'postprocessing';
import * as THREE from 'three';

// The same visible silhouette stencil as OutlineMaterial, fused into the
// final composite so each outline needs only its small proxy draw. Selection
// proxies do not write depth in the preceding solid scene RenderPass.
const fragmentShader = `
uniform sampler2D hoverMask;
uniform sampler2D selectedMask;
uniform sampler2D focusMask;
uniform vec2 texelSize;
uniform vec3 accent;
uniform vec3 focusAccent;
uniform bool hoverActive;
uniform bool selectedActive;
uniform bool focusActive;
float visibleEdgeAt(sampler2D maskTexture, vec2 uv, float spread) {
  vec2 step = texelSize * spread;
  vec2 c0 = texture2D(maskTexture, uv + vec2(step.x, 0.0)).rg;
  vec2 c1 = texture2D(maskTexture, uv - vec2(step.x, 0.0)).rg;
  vec2 c2 = texture2D(maskTexture, uv + vec2(0.0, step.y)).rg;
  vec2 c3 = texture2D(maskTexture, uv - vec2(0.0, step.y)).rg;
  float edge = length(vec2(c0.x - c1.x, c2.x - c3.x) * 0.5);
  float visibility = min(min(c0.y, c1.y), min(c2.y, c3.y));
  return visibility < 0.999 ? edge * max(max(c0.x, c1.x), max(c2.x, c3.x)) : 0.0;
}
float visibleEdge(sampler2D maskTexture, vec2 uv) {
  vec2 c0 = texture2D(maskTexture, uv + vec2(texelSize.x, 0.0)).rg;
  vec2 c1 = texture2D(maskTexture, uv - vec2(texelSize.x, 0.0)).rg;
  vec2 c2 = texture2D(maskTexture, uv + vec2(0.0, texelSize.y)).rg;
  vec2 c3 = texture2D(maskTexture, uv - vec2(0.0, texelSize.y)).rg;
  float edge = length(vec2(c0.x - c1.x, c2.x - c3.x) * 0.5);
  float visibility = min(min(c0.y, c1.y), min(c2.y, c3.y));
  return visibility < 0.999 ? edge * texture2D(maskTexture, uv).r : 0.0;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 color = inputColor.rgb;
  float alpha = inputColor.a;
  if (hoverActive) {
    float edge = visibleEdge(hoverMask, uv) * 3.5;
    vec3 edgeColor = accent * edge;
    color = mix(color, color + edgeColor - min(color * edgeColor, 1.0), 0.55);
    alpha = mix(alpha, max(alpha, edge), 0.55);
  }
  if (selectedActive) {
    float edge = visibleEdge(selectedMask, uv) * 8.0;
    vec3 edgeColor = accent * edge;
    color = color + edgeColor - min(color * edgeColor, 1.0);
    alpha = max(alpha, edge);
  }
  if (focusActive) {
    // A thick edge: the mask's step sampled at one, two and three texels.
    float edge = clamp(max(max(visibleEdgeAt(focusMask, uv, 1.0), visibleEdgeAt(focusMask, uv, 2.0)), visibleEdgeAt(focusMask, uv, 3.0)) * 2.6, 0.0, 1.0);
    color = mix(color, focusAccent, edge);
    alpha = max(alpha, edge);
  }
  outputColor = vec4(color, alpha);
}`;

/** The focus outline's colour: a duct segment whose card is open (violet, as in plan). */
export const FOCUS_ACCENT = 0x7c3aed;

/** Visible wall outlines sharing the depth already rendered for the solid scene. */
export class HybridOutlineEffect extends Effect {
  readonly hover = new Selection(undefined, 10);
  readonly selected = new Selection(undefined, 11);
  /** A thick violet outline: the duct segment whose card is open. */
  readonly focus = new Selection(undefined, 12);
  private readonly hoverTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  private readonly selectedTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  private readonly focusTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  private readonly maskMaterial = new DepthComparisonMaterial();
  private readonly maskPass: RenderPass;
  private depthReady = false;
  private cameraDepthScale = Number.NaN;
  private cameraDepthOffset = Number.NaN;

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera, accent: number) {
    super('HybridOutlineEffect', fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['hoverMask', new THREE.Uniform(null)],
        ['selectedMask', new THREE.Uniform(null)],
        ['focusMask', new THREE.Uniform(null)],
        ['texelSize', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['accent', new THREE.Uniform(new THREE.Color(accent))],
        ['focusAccent', new THREE.Uniform(new THREE.Color(FOCUS_ACCENT))],
        ['hoverActive', new THREE.Uniform(false)],
        ['selectedActive', new THREE.Uniform(false)],
        ['focusActive', new THREE.Uniform(false)],
      ]),
    });
    this.hoverTarget.texture.name = 'HybridOutline.Hover';
    this.selectedTarget.texture.name = 'HybridOutline.Selected';
    this.focusTarget.texture.name = 'HybridOutline.Focus';
    this.uniforms.get('hoverMask')!.value = this.hoverTarget.texture;
    this.uniforms.get('selectedMask')!.value = this.selectedTarget.texture;
    this.uniforms.get('focusMask')!.value = this.focusTarget.texture;
    // The proxy material is applied only during update below. Avoid cloning
    // override-material variants for a mask containing only plain wall meshes.
    this.maskPass = new RenderPass(scene, camera);
    this.maskPass.ignoreBackground = true;
    this.maskPass.skipShadowMapUpdate = true;
    this.maskPass.clearPass.overrideClearColor = new THREE.Color(0xffffff);
    this.maskPass.clearPass.overrideClearAlpha = 1;
  }

  override setDepthTexture(texture: THREE.Texture, packing: THREE.DepthPackingStrategies = THREE.BasicDepthPacking): void {
    this.maskMaterial.depthBuffer = texture;
    this.maskMaterial.depthPacking = packing;
    this.depthReady = Boolean(texture);
  }

  override update(renderer: THREE.WebGLRenderer): void {
    const hoverActive = this.depthReady && this.hover.size > 0;
    const selectedActive = this.depthReady && this.selected.size > 0;
    const focusActive = this.depthReady && this.focus.size > 0;
    this.uniforms.get('hoverActive')!.value = hoverActive;
    this.uniforms.get('selectedActive')!.value = selectedActive;
    this.uniforms.get('focusActive')!.value = focusActive;
    if (!hoverActive && !selectedActive && !focusActive) return;
    // This public compatibility method handles both perspective and ortho
    // cameras. It forwards to copyCameraSettings in postprocessing 6.x.
    const projection = this.camera.projectionMatrix.elements;
    if (projection[10] !== this.cameraDepthScale || projection[14] !== this.cameraDepthOffset) {
      this.maskMaterial.adoptCameraSettings(this.camera);
      this.cameraDepthScale = projection[10]!;
      this.cameraDepthOffset = projection[14]!;
    }
    const layers = this.camera.layers.mask;
    const background = this.scene.background;
    const overrideMaterial = this.scene.overrideMaterial;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const shadowEnabled = renderer.shadowMap.enabled;
    try {
      this.scene.overrideMaterial = this.maskMaterial;
      renderer.shadowMap.enabled = false;
      if (hoverActive) {
        this.maskPass.selection = this.hover;
        this.maskPass.render(renderer, this.hoverTarget, this.hoverTarget);
      }
      if (selectedActive) {
        this.maskPass.selection = this.selected;
        this.maskPass.render(renderer, this.selectedTarget, this.selectedTarget);
      }
      if (focusActive) {
        this.maskPass.selection = this.focus;
        this.maskPass.render(renderer, this.focusTarget, this.focusTarget);
      }
    } finally {
      this.camera.layers.mask = layers;
      this.scene.background = background;
      this.scene.overrideMaterial = overrideMaterial;
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.shadowMap.enabled = shadowEnabled;
    }
  }

  override setSize(width: number, height: number): void {
    this.hoverTarget.setSize(width, height);
    this.selectedTarget.setSize(width, height);
    this.focusTarget.setSize(width, height);
    this.uniforms.get('texelSize')!.value.set(1 / width, 1 / height);
  }

  override initialize(renderer: THREE.WebGLRenderer, alpha: boolean, frameBufferType: number): void {
    this.maskPass.initialize(renderer, alpha, frameBufferType);
  }

  override dispose(): void {
    this.hover.clear();
    this.selected.clear();
    this.focus.clear();
    this.hoverTarget.dispose();
    this.selectedTarget.dispose();
    this.focusTarget.dispose();
    this.maskPass.dispose();
    this.maskMaterial.dispose();
  }
}
