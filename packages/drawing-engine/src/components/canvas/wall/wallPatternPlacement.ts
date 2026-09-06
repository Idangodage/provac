import * as fabric from 'fabric';

import { MM_TO_PX } from '../scale';

/** Texture pixels -> drawing pixels. Camera zoom must not change material size. */
export function wallPatternTransform(repeatMm: number, tilePixels: number): fabric.TMat2D {
  const scale = repeatMm * MM_TO_PX / tilePixels;
  return [scale, 0, 0, scale, 0, 0];
}

/**
 * Fabric fills start at each object's local bounding box. Offset that box
 * back to model (0,0), matching world-XY cap UVs in Three. Each object owns
 * its placement while sharing the cached raster; changing a junction's
 * bounding box cannot move the brick courses on neighboring walls.
 */
export function anchorWallPatternToModel(
  fill: string | fabric.Pattern,
  shape: Pick<fabric.Path, 'width' | 'height' | 'pathOffset'>,
): string | fabric.Pattern {
  if (typeof fill === 'string') return fill;
  return new fabric.Pattern({
    source: fill.source,
    repeat: 'repeat',
    patternTransform: fill.patternTransform ? [...fill.patternTransform] : undefined,
    offsetX: shape.width / 2 - shape.pathOffset.x,
    offsetY: shape.height / 2 - shape.pathOffset.y,
  });
}
