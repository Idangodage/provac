import { describe, it, expect } from 'vitest';

import {
  screenToWorld,
  worldToScreen,
  zoomAt,
  clampZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  type ViewTransform,
} from './transform';

/** Deterministic LCG so the property test is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const randIn = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

describe('invariant E — world↔screen round-trip', () => {
  it('screenToWorld(worldToScreen(p)) ≈ p for zoom in [0.05, 40]', () => {
    const r = rng(0xC0FFEE);
    for (let i = 0; i < 5000; i += 1) {
      const t: ViewTransform = {
        zoom: randIn(r, ZOOM_MIN, ZOOM_MAX),
        panX: randIn(r, -50_000, 50_000),
        panY: randIn(r, -50_000, 50_000),
      };
      const p = { x: randIn(r, -1_000_000, 1_000_000), y: randIn(r, -1_000_000, 1_000_000) };
      const back = screenToWorld(t, worldToScreen(t, p));
      // Tolerance scales with the coordinate magnitude (float precision), tiny.
      const eps = 1e-6 * (1 + Math.max(Math.abs(p.x), Math.abs(p.y)));
      expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(eps);
      expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(eps);
    }
  });

  it('worldToScreen(screenToWorld(q)) ≈ q for random screen points', () => {
    const r = rng(0xBADF00D);
    for (let i = 0; i < 5000; i += 1) {
      const t: ViewTransform = {
        zoom: randIn(r, ZOOM_MIN, ZOOM_MAX),
        panX: randIn(r, -50_000, 50_000),
        panY: randIn(r, -50_000, 50_000),
      };
      const q = { x: randIn(r, -5000, 5000), y: randIn(r, -5000, 5000) };
      const back = worldToScreen(t, screenToWorld(t, q));
      const eps = 1e-6 * (1 + Math.max(Math.abs(q.x), Math.abs(q.y)));
      expect(Math.abs(back.x - q.x)).toBeLessThanOrEqual(eps);
      expect(Math.abs(back.y - q.y)).toBeLessThanOrEqual(eps);
    }
  });

  it('cursor-anchored zoom keeps the anchored world point fixed on screen', () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i += 1) {
      const t: ViewTransform = {
        zoom: randIn(r, ZOOM_MIN, ZOOM_MAX),
        panX: randIn(r, -10_000, 10_000),
        panY: randIn(r, -10_000, 10_000),
      };
      const anchor = { x: randIn(r, 0, 1600), y: randIn(r, 0, 900) };
      const factor = randIn(r, 0.5, 2);
      const worldBefore = screenToWorld(t, anchor);
      const next = zoomAt(t, anchor, factor);
      const worldAfter = screenToWorld(next, anchor);
      const eps = 1e-6 * (1 + Math.max(Math.abs(worldBefore.x), Math.abs(worldBefore.y)));
      expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThanOrEqual(eps);
      expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThanOrEqual(eps);
    }
  });

  it('zoom stays clamped to [0.05, 40]', () => {
    expect(clampZoom(0.0001)).toBe(ZOOM_MIN);
    expect(clampZoom(9999)).toBe(ZOOM_MAX);
    const t: ViewTransform = { zoom: ZOOM_MAX, panX: 0, panY: 0 };
    expect(zoomAt(t, { x: 100, y: 100 }, 10).zoom).toBe(ZOOM_MAX);
  });
});
