import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { disposeObject3DResources } from '../threeResourceLifecycle';

import { applyWallTextureCoordinates, createWallOutline, wallSideTextureU } from './wallThreeVisual';

describe('shared wall model graphics', () => {
  it('keeps outlines at the plan stroke width when the viewport changes and releases owned resources', () => {
    const source = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 2700), new THREE.Vector3(4000, 0, 2700)]);
    const outline = createWallOutline(source, { color: '#26323f', opacity: 1, widthPx: 1.7 });
    expect(outline.material.linewidth).toBe(1.7);
    expect(outline.material.worldUnits).toBe(false);
    expect(outline.material.toneMapped).toBe(false);
    const reflectedBasis = new THREE.Group();
    reflectedBasis.scale.y = -1;
    reflectedBasis.add(outline);
    reflectedBasis.updateMatrixWorld(true);
    expect(outline.matrixWorld.determinant()).toBe(-1);
    expect(outline.material.side).toBe(THREE.DoubleSide);
    expect(outline.material.color.getHexString()).toBe('26323f');
    for (const [width, height] of [[800, 600], [1600, 1000]]) {
      outline.onBeforeRender({ getViewport: (viewport: THREE.Vector4) => viewport.set(0, 0, width!, height!) } as THREE.WebGLRenderer);
      expect(outline.material.resolution.toArray()).toEqual([width, height]);
      expect(outline.material.linewidth).toBe(1.7);
    }
    const disposeGeometry = vi.spyOn(outline.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(outline.material, 'dispose');
    const disposeSource = vi.spyOn(source, 'dispose');
    disposeObject3DResources(outline);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(disposeSource).not.toHaveBeenCalled();
    source.dispose();
  });

  it('anchors diagonal face patterns to world coordinates regardless of wall direction', () => {
    const nx = Math.SQRT1_2;
    const ny = -Math.SQRT1_2;
    const start = wallSideTextureU(1000, 1000, nx, ny);
    const continuation = wallSideTextureU(2000, 2000, nx, ny);
    expect(continuation - start).toBeCloseTo(Math.hypot(1000, 1000));
    expect(wallSideTextureU(2000, 2000, -nx, -ny)).toBeCloseTo(continuation);
  });

  it('uses the same model-mm cap/side UVs for extruded legacy walls', () => {
    const shape = new THREE.Shape([new THREE.Vector2(1000, 2000), new THREE.Vector2(3000, 4000), new THREE.Vector2(2900, 4100), new THREE.Vector2(900, 2100)]);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 2700, bevelEnabled: false });
    geometry.translate(0, 0, 350);
    applyWallTextureCoordinates(geometry);
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    for (let index = 0; index < positions.count; index += 1) {
      if (Math.abs(normals.getZ(index)) > 0.5) {
        expect(uv.getX(index)).toBe(positions.getX(index));
        expect(uv.getY(index)).toBe(positions.getY(index));
      } else {
        expect(uv.getX(index)).toBeCloseTo(wallSideTextureU(positions.getX(index), positions.getY(index), normals.getX(index), normals.getY(index)), 3);
        expect(uv.getY(index)).toBe(positions.getZ(index));
      }
    }
    geometry.dispose();
  });
});
