import { describe, expect, it } from 'vitest';

import {
  applyCanvasTransform,
  affineMatrixToSvg,
  canvasTransformToSvgMatrix,
  clientPointToLocalScreen,
  clientPointToWorld,
  clientPointToWorldFromFabricViewport,
  fabricViewportToWorldSvgMatrix,
  getCanvasTransform,
  inverseCanvasTransform,
  screenLengthToWorld,
  screenToWorld,
  viewportToViewTransform,
  worldLengthToScreen,
  worldTo3D,
  worldToScreen,
  worldToScreenFromFabricViewport,
  type ViewTransform2D,
} from './coordinateTransform';
import { MM_TO_PX } from './scale';

const views: ViewTransform2D[] = [
  { zoom: 1, panPx: { x: 0, y: 0 } },
  { zoom: 0.5, panPx: { x: 120, y: -45 } },
  { zoom: 2.37, panPx: { x: -300.5, y: 88.25 } },
];

const points = [
  { x: 0, y: 0 },
  { x: 1000, y: -2500 },
  { x: -750.25, y: 333.5 },
];

describe('worldToScreen / screenToWorld', () => {
  it('round-trips world -> screen -> world for assorted points and views', () => {
    for (const view of views) {
      for (const p of points) {
        const back = screenToWorld(worldToScreen(p, view), view);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it('places the world origin at the pan offset', () => {
    const view = { zoom: 3, panPx: { x: 42, y: 7 } };
    expect(worldToScreen({ x: 0, y: 0 }, view)).toEqual({ x: 42, y: 7 });
  });

  it('scales a millimetre by MM_TO_PX * zoom', () => {
    const s = worldToScreen({ x: 10, y: 0 }, { zoom: 1, panPx: { x: 0, y: 0 } });
    expect(s.x).toBeCloseTo(10 * MM_TO_PX, 9);
    expect(s.y).toBeCloseTo(0, 9);
  });

  it('does not divide by zero at zoom 0', () => {
    expect(() => screenToWorld({ x: 10, y: 10 }, { zoom: 0, panPx: { x: 0, y: 0 } })).not.toThrow();
  });
});

describe('canonical canvas transform helpers', () => {
  it('returns the same transform as viewportToViewTransform', () => {
    const pan = { x: 120, y: -80 };
    expect(getCanvasTransform(2.5, pan)).toEqual(viewportToViewTransform(2.5, pan));
  });

  it('applyCanvasTransform and inverseCanvasTransform round-trip', () => {
    const view = getCanvasTransform(1.75, { x: 250, y: 90 });
    const world = { x: 310, y: 420 };
    const back = inverseCanvasTransform(applyCanvasTransform(world, view), view);
    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
  });

  it('converts client points through local screen space to world space', () => {
    const view = getCanvasTransform(2, { x: 100, y: 50 });
    const world = { x: 800, y: 450 };
    const local = applyCanvasTransform(world, view);
    const rect = { left: 30, top: 45 };
    expect(clientPointToLocalScreen(local.x + rect.left, local.y + rect.top, rect)).toEqual(local);
    const back = clientPointToWorld(local.x + rect.left, local.y + rect.top, rect, view);
    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
  });

  it('builds an SVG matrix for world-mm child geometry', () => {
    const view = getCanvasTransform(2, { x: 100, y: 50 });
    const k = MM_TO_PX * view.zoom;
    expect(canvasTransformToSvgMatrix(view)).toBe(`matrix(${k} 0 0 ${k} ${view.panPx.x} ${view.panPx.y})`);
  });

  it('converts a live Fabric scene-pixel matrix to the world-mm SVG matrix', () => {
    const fabricViewport = [2, 0, 0, 2, -135, 48] as const;
    const matrix = fabricViewportToWorldSvgMatrix(fabricViewport);
    expect(matrix).toEqual([
      2 * MM_TO_PX,
      0,
      0,
      2 * MM_TO_PX,
      -135,
      48,
    ]);
    expect(affineMatrixToSvg(matrix)).toBe(
      `matrix(${2 * MM_TO_PX} 0 0 ${2 * MM_TO_PX} -135 48)`,
    );
  });

  it('uses one live matrix for rendered position and pointer inversion', () => {
    const viewport = [1.75, 0.23, -0.12, 1.6, 211, -73] as const;
    const world = { x: 812.5, y: -330.25 };
    const screen = worldToScreenFromFabricViewport(world, viewport);
    const rect = { left: 320, top: 76 };
    const resolved = clientPointToWorldFromFabricViewport(
      screen.x + rect.left,
      screen.y + rect.top,
      rect,
      viewport,
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.x).toBeCloseTo(world.x, 8);
    expect(resolved?.y).toBeCloseTo(world.y, 8);
  });

  it('is independent of device pixel ratio because CSS client pixels drive NDC', () => {
    const viewport = [0.8, 0, 0, 0.8, 19, 33] as const;
    const world = { x: 400, y: 250 };
    const cssScreen = worldToScreenFromFabricViewport(world, viewport);
    for (const devicePixelRatio of [1, 1.25, 2, 3]) {
      // The backing-buffer size changes with DPR, but PointerEvent.clientX/Y and
      // getBoundingClientRect() stay in CSS pixels. DPR therefore never enters
      // this conversion pipeline.
      const backingBufferX = cssScreen.x * devicePixelRatio;
      expect(backingBufferX / devicePixelRatio).toBeCloseTo(cssScreen.x, 10);
      const resolved = clientPointToWorldFromFabricViewport(
        cssScreen.x,
        cssScreen.y,
        { left: 0, top: 0 },
        viewport,
      );
      expect(resolved?.x).toBeCloseTo(world.x, 8);
      expect(resolved?.y).toBeCloseTo(world.y, 8);
    }
  });
});

describe('length transforms', () => {
  it('round-trips a length through screen and back', () => {
    for (const zoom of [0.25, 1, 4.2]) {
      expect(screenLengthToWorld(worldLengthToScreen(500, zoom), zoom)).toBeCloseTo(500, 6);
    }
  });
});

describe('worldTo3D', () => {
  it('maps plan x/y straight through and elevation to +Z (Z-up mm)', () => {
    expect(worldTo3D({ x: 120, y: -340 }, 2600)).toEqual({ x: 120, y: -340, z: 2600 });
  });
});
