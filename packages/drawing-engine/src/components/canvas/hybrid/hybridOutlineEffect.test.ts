import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { HybridOutlineEffect } from './hybridOutlineEffect';

function fixture() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xabcdef);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 100);
  const ordinary = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const hovered = new THREE.Mesh(ordinary.geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  const selected = new THREE.Mesh(ordinary.geometry, hovered.material);
  scene.add(ordinary, hovered, selected);
  const effect = new HybridOutlineEffect(scene, camera, 0x4f8cff);
  const depth = new THREE.DepthTexture(1200, 800);
  effect.setDepthTexture(depth);
  effect.setSize(1200, 800);
  const draws: { objects: THREE.Object3D[]; target: THREE.WebGLRenderTarget; material: THREE.ShaderMaterial }[] = [];
  let target: THREE.WebGLRenderTarget;
  const renderer = {
    shadowMap: { enabled: true, autoUpdate: true },
    getClearColor: (out: THREE.Color) => out.set(0xffffff),
    getClearAlpha: () => 1,
    setClearColor: vi.fn(),
    setClearAlpha: vi.fn(),
    setRenderTarget: (next: THREE.WebGLRenderTarget) => { target = next; },
    clear: vi.fn(),
    render: vi.fn((renderedScene: THREE.Scene, renderedCamera: THREE.Camera) => {
      draws.push({ objects: renderedScene.children.filter(object => object.layers.test(renderedCamera.layers)),
        target, material: renderedScene.overrideMaterial as THREE.ShaderMaterial });
    }),
  };
  const render = () => effect.update(renderer as unknown as THREE.WebGLRenderer);
  return { scene, camera, ordinary, hovered, selected, effect, depth, draws, renderer, render };
}

describe('hybrid outlines sharing solid scene depth', () => {
  it('draws only active proxies with the same scene depth, full resolution, and multisampling', () => {
    const f = fixture();
    f.effect.hover.set([f.hovered]);
    f.effect.selected.set([f.selected]);
    f.render();
    expect(f.draws.map(draw => draw.objects)).toEqual([[f.hovered], [f.selected]]);
    for (const draw of f.draws) {
      expect(draw.material.uniforms.depthBuffer!.value).toBe(f.depth);
      expect(draw.material.defines.DEPTH_PACKING).toBe(String(THREE.BasicDepthPacking));
      expect([draw.target.width, draw.target.height, draw.target.samples]).toEqual([1200, 800, 4]);
    }
    expect(f.camera.layers.mask).toBe(1);
    expect(f.scene.overrideMaterial).toBeNull();
    expect(f.renderer.shadowMap).toEqual({ enabled: true, autoUpdate: true });
    f.effect.dispose();
  });

  it('skips empty masks from the first frame and removes stale highlights without another scene draw', () => {
    const f = fixture();
    f.render();
    expect(f.draws).toHaveLength(0);
    f.effect.hover.add(f.hovered);
    f.render();
    expect(f.draws).toHaveLength(1);
    f.effect.hover.clear();
    f.render();
    expect(f.draws).toHaveLength(1);
    expect(f.effect.uniforms.get('hoverActive')!.value).toBe(false);
    expect(f.effect.uniforms.get('selectedActive')!.value).toBe(false);
    f.effect.dispose();
  });

  it('refreshes depth projection after clipping changes without recompiling it on unchanged frames', () => {
    const f = fixture();
    f.effect.selected.add(f.selected);
    f.render();
    const material = f.draws[0]!.material;
    const version = material.version;
    f.camera.position.x += 2;
    f.render();
    expect(material.version).toBe(version);
    f.camera.near = 3;
    f.camera.far = 350;
    f.camera.updateProjectionMatrix();
    f.render();
    expect(material.uniforms.cameraNear!.value).toBe(3);
    expect(material.uniforms.cameraFar!.value).toBe(350);
    expect(material.defines.PERSPECTIVE_CAMERA).toBeUndefined();
    f.effect.dispose();
  });

  it('restores the main scene and renderer when a proxy render fails', () => {
    const f = fixture();
    const background = f.scene.background;
    f.camera.layers.enable(3);
    const layers = f.camera.layers.mask;
    f.effect.selected.add(f.selected);
    f.renderer.render.mockImplementation(() => { throw new Error('context lost'); });
    expect(f.render).toThrow('context lost');
    expect(f.camera.layers.mask).toBe(layers);
    expect(f.scene.background).toBe(background);
    expect(f.scene.overrideMaterial).toBeNull();
    expect(f.renderer.shadowMap).toEqual({ enabled: true, autoUpdate: true });
    f.effect.dispose();
  });

  it('resizes owned masks and disposes them without disposing borrowed model geometry or depth', () => {
    const f = fixture();
    f.effect.hover.add(f.hovered);
    f.effect.selected.add(f.selected);
    f.render();
    const targets = f.draws.map(draw => draw.target);
    const released = targets.map(target => {
      const event = vi.fn();
      target.addEventListener('dispose', event);
      return event;
    });
    const geometryReleased = vi.fn();
    const depthReleased = vi.fn();
    f.ordinary.geometry.addEventListener('dispose', geometryReleased);
    f.depth.addEventListener('dispose', depthReleased);
    f.effect.setSize(640, 480);
    expect(targets.map(target => [target.width, target.height])).toEqual([[640, 480], [640, 480]]);
    released.forEach(event => event.mockClear());
    f.effect.dispose();
    released.forEach(event => expect(event).toHaveBeenCalledTimes(1));
    expect(geometryReleased).not.toHaveBeenCalled();
    expect(depthReleased).not.toHaveBeenCalled();
    expect(f.hovered.layers.mask).toBe(1);
    expect(f.selected.layers.mask).toBe(1);
  });
});
