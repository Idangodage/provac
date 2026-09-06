import { DoubleSide, type BufferGeometry } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

import { markMaterialOwned } from '../threeResourceLifecycle';

/** Screen-space strokes use the same CSS-pixel width as the plan renderer. */
export function createWallOutline(
  source: BufferGeometry,
  style: { color: string; opacity: number; widthPx: number },
): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  const positions = source.getAttribute('position');
  const coordinates = new Float32Array(positions.count * 3);
  for (let index = 0; index < positions.count; index += 1) {
    coordinates[index * 3] = positions.getX(index);
    coordinates[index * 3 + 1] = positions.getY(index);
    coordinates[index * 3 + 2] = positions.getZ(index);
  }
  geometry.setPositions(coordinates);
  const material = new LineMaterial({
    color: style.color,
    linewidth: style.widthPx,
    worldUnits: false,
    transparent: style.opacity < 1,
    opacity: style.opacity,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    // The hybrid model basis reflects Y. LineSegments2 builds its stroke
    // quads in camera space, so model winding must not cull those quads.
    side: DoubleSide,
  });
  markMaterialOwned(material);
  // LineSegments2 updates material.resolution from the renderer viewport on
  // every draw. It therefore handles resize, device pixel ratio and postfx.
  return new LineSegments2(geometry, material);
}

/** A world-anchored face tangent, independent of polygon winding or splits. */
export function wallSideTextureU(x: number, y: number, nx: number, ny: number): number {
  let tx = -ny;
  let ty = nx;
  const length = Math.hypot(tx, ty);
  if (length < 1e-9) return x;
  tx /= length;
  ty /= length;
  if (tx < -1e-9 || (Math.abs(tx) <= 1e-9 && ty < 0)) {
    tx = -tx;
    ty = -ty;
  }
  return x * tx + y * ty;
}

/** Both Three wall renderers address the shared material tile in model mm. */
export function applyWallTextureCoordinates(geometry: BufferGeometry): void {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    if (Math.abs(normals.getZ(index)) > 0.5) {
      uv.setXY(index, x, y);
    } else {
      uv.setXY(index, wallSideTextureU(x, y, normals.getX(index), normals.getY(index)), positions.getZ(index));
    }
  }
  uv.needsUpdate = true;
}
