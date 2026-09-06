import * as fabric from 'fabric';
import { describe, expect, it } from 'vitest';

import { MM_TO_PX } from '../scale';

import { anchorWallPatternToModel, wallPatternTransform } from './wallPatternPlacement';

describe('wall pattern placement', () => {
  const repeatMm = 400;
  const tilePixels = 96;
  const prototype = new fabric.Pattern({
    source: { width: tilePixels, height: tilePixels } as HTMLCanvasElement,
    patternTransform: wallPatternTransform(repeatMm, tilePixels),
  });

  it('keeps the same world-space phase across separate paths and junction overlays', () => {
    const worldPoint = { x: 1435 * MM_TO_PX, y: -710 * MM_TO_PX };
    for (const bounds of [
      { width: 6000, height: 700, pathOffset: new fabric.Point(3400, 900) },
      { width: 400, height: 1600, pathOffset: new fabric.Point(5800, -400) },
    ]) {
      const placed = anchorWallPatternToModel(prototype, bounds) as fabric.Pattern;
      const localX = worldPoint.x - bounds.pathOffset.x;
      const localY = worldPoint.y - bounds.pathOffset.y;
      const tileX = (localX + bounds.width / 2 - placed.offsetX) / placed.patternTransform![0];
      const tileY = (localY + bounds.height / 2 - placed.offsetY) / placed.patternTransform![3];
      expect(tileX / tilePixels).toBeCloseTo(1435 / repeatMm, 10);
      expect(tileY / tilePixels).toBeCloseTo(-710 / repeatMm, 10);
    }
    expect(prototype.offsetX).toBe(0);
    expect(prototype.offsetY).toBe(0);
  });

  it('scales with the drawing and keeps a 400 mm physical tile at every zoom', () => {
    const transform = wallPatternTransform(repeatMm, tilePixels);
    for (const zoom of [0.015, 0.1, 1, 4]) {
      const screenRepeat = tilePixels * transform[0] * zoom;
      expect(screenRepeat / (MM_TO_PX * zoom)).toBeCloseTo(repeatMm, 10);
    }
  });

  it('leaves analytical solid fills unchanged and does not share mutable placement', () => {
    const shape = { width: 200, height: 100, pathOffset: new fabric.Point(1100, 600) };
    expect(anchorWallPatternToModel('#aabbcc', shape)).toBe('#aabbcc');
    const placed = anchorWallPatternToModel(prototype, shape) as fabric.Pattern;
    placed.patternTransform![0] = 99;
    expect(prototype.patternTransform![0]).not.toBe(99);
    expect(placed.source).toBe(prototype.source);
  });
});
