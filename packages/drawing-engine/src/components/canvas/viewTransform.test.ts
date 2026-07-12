import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../types';

import { viewportToViewTransform, worldToScreen } from './coordinateTransform';
import { MM_TO_PX } from './scale';
import {
  buildViewportTransform,
  viewTransformToFabricMatrix,
  viewTransformToKonvaLayer,
} from './viewTransform';

const cases: Array<{ zoom: number; pan: Point2D }> = [
  { zoom: 1, pan: { x: 0, y: 0 } },
  { zoom: 0.25, pan: { x: 120, y: -45 } },
  { zoom: 4.2, pan: { x: -300.5, y: 88.25 } },
  { zoom: 2.37, pan: { x: 17.3, y: 902.1 } },
];

const worldPoints: Point2D[] = [
  { x: 0, y: 0 },
  { x: 1000, y: -2500 },
  { x: -750.25, y: 333.5 },
];

/** Apply a Fabric TMat2D [a,b,c,d,e,f] to a point. */
function applyMatrix(m: readonly number[], pt: Point2D): Point2D {
  return { x: m[0]! * pt.x + m[2]! * pt.y + m[4]!, y: m[1]! * pt.x + m[3]! * pt.y + m[5]! };
}

describe('viewTransform — single canonical transform', () => {
  it('Fabric matrix reproduces the legacy inline [z,0,0,z,-pan*z] exactly', () => {
    for (const { zoom, pan } of cases) {
      const legacy = [zoom, 0, 0, zoom, -pan.x * zoom, -pan.y * zoom];
      const built = buildViewportTransform(zoom, pan);
      for (let i = 0; i < 6; i += 1) {
        expect(built[i]).toBeCloseTo(legacy[i]!, 9);
      }
    }
  });

  it('Konva layer transform reproduces the legacy inline stage offset/scale', () => {
    for (const { zoom, pan } of cases) {
      const layer = viewTransformToKonvaLayer(viewportToViewTransform(zoom, pan));
      expect(layer.x).toBeCloseTo(-pan.x * zoom, 9);
      expect(layer.y).toBeCloseTo(-pan.y * zoom, 9);
      expect(layer.scaleX).toBeCloseTo(zoom, 9);
      expect(layer.scaleY).toBeCloseTo(zoom, 9);
    }
  });

  it('Fabric matrix (on scene px) agrees with worldToScreen (on world mm)', () => {
    for (const { zoom, pan } of cases) {
      const view = viewportToViewTransform(zoom, pan);
      const matrix = viewTransformToFabricMatrix(view);
      for (const w of worldPoints) {
        const scenePx = { x: w.x * MM_TO_PX, y: w.y * MM_TO_PX };
        const viaMatrix = applyMatrix(matrix, scenePx);
        const viaTransform = worldToScreen(w, view);
        expect(viaMatrix.x).toBeCloseTo(viaTransform.x, 6);
        expect(viaMatrix.y).toBeCloseTo(viaTransform.y, 6);
      }
    }
  });

  it('Fabric and Konva agree: same scale and translation from one transform', () => {
    for (const { zoom, pan } of cases) {
      const view = viewportToViewTransform(zoom, pan);
      const matrix = viewTransformToFabricMatrix(view);
      const layer = viewTransformToKonvaLayer(view);
      expect(layer.scaleX).toBeCloseTo(matrix[0]!, 9); // a == scaleX
      expect(layer.scaleY).toBeCloseTo(matrix[3]!, 9); // d == scaleY
      expect(layer.x).toBeCloseTo(matrix[4]!, 9); // e == translateX
      expect(layer.y).toBeCloseTo(matrix[5]!, 9); // f == translateY
    }
  });

  it('clamps non-finite / near-zero zoom safely', () => {
    expect(() => buildViewportTransform(0, { x: 0, y: 0 })).not.toThrow();
    const view = viewportToViewTransform(Number.NaN, { x: 5, y: 5 });
    expect(Number.isFinite(view.zoom)).toBe(true);
    expect(view.zoom).toBeGreaterThan(0);
  });
});
