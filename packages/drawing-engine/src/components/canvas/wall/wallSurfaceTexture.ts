import * as THREE from 'three';

import type { WallSurfaceVisual } from '../../../attributes';

import { createWallSurfacePatternCanvas } from './wallPatternCanvas';

const surfaceTextureCache = new Map<string, THREE.CanvasTexture>();

/**
 * Real-world, model-anchored texture used by both wall 3D renderers. Geometry
 * UVs are expressed in millimetres, so 1 / repeatMm preserves scale through
 * zoom, orbit and the plan-to-3D rise animation.
 */
export function getWallSurfaceTexture(style: {
  key: string;
  materialId: string;
  surface: WallSurfaceVisual;
}): THREE.CanvasTexture | null {
  const key = `${style.key}|${style.surface.repeatMm}|${style.surface.patternOpacity}`;
  const cached = surfaceTextureCache.get(key);
  if (cached) return cached;

  const canvas = createWallSurfacePatternCanvas(style.surface);
  if (!canvas) return null;

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `wall-surface-${style.materialId}`;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / style.surface.repeatMm, 1 / style.surface.repeatMm);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  surfaceTextureCache.set(key, texture);
  return texture;
}
