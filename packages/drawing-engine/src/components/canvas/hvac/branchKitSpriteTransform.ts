import type { Point2D } from '../../../types';

/** Measured tube-end centers in the source image, as fractions of its bounds. */
export const BRANCH_SPRITE_SOCKETS = {
  gas: { inlet: { x: 0.0102, y: 0.2302 }, run: { x: 0.9898, y: 0.1453 }, branch: { x: 0.9791, y: 0.8932 } },
  liquid: { inlet: { x: 0.013, y: 0.1762 }, run: { x: 0.987, y: 0.1173 }, branch: { x: 0.9736, y: 0.8827 } },
} as const;

/** Register all three visible sockets to the physical model. Images may adapt
 * to a model; a semantic connection must never move to fit a decorative image. */
export function branchKitSpriteTransform(
  line: 'gas' | 'liquid',
  aspect: number,
  ports: { inlet: Point2D; run: Point2D; branch: Point2D },
): [number, number, number, number, number, number] {
  const anchors = BRANCH_SPRITE_SOCKETS[line];
  const width = 1000;
  const height = width * aspect;
  const sx = (anchors.run.x - anchors.inlet.x) * width;
  const sy = (anchors.run.y - anchors.inlet.y) * height;
  const bx = (anchors.branch.x - anchors.inlet.x) * width;
  const by = (anchors.branch.y - anchors.inlet.y) * height;
  const determinant = sx * by - sy * bx;
  const rx = ports.run.x - ports.inlet.x;
  const ry = ports.run.y - ports.inlet.y;
  const tx = ports.branch.x - ports.inlet.x;
  const ty = ports.branch.y - ports.inlet.y;
  const a = (rx * by - tx * sy) / determinant;
  const b = (ry * by - ty * sy) / determinant;
  const c = (tx * sx - rx * bx) / determinant;
  const d = (ty * sx - ry * bx) / determinant;
  const ix = anchors.inlet.x * width;
  const iy = anchors.inlet.y * height;
  return [a, b, c, d, ports.inlet.x - a * ix - c * iy, ports.inlet.y - b * ix - d * iy];
}
