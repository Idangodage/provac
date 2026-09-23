import { describe, expect, it } from 'vitest';

import type { PipeRouteNode3D } from './pipeRoute3d';
import { buildPipeSkeleton, decimatePipeRoute, skeletonLegIndexForSource } from './pipeSkeleton';

/** Samples a filleted corner the way the fabrication builders emit one. */
function tessellatedCorner(radiusMm: number, divisions = 24): PipeRouteNode3D[] {
  // (0,0) -> (1000,0) -> (1000,1000) with a constant-radius fillet at (1000,0).
  const entry = { x: 1000 - radiusMm, y: 0, z: 0 };
  const centre = { x: 1000 - radiusMm, y: radiusMm };
  const arc: PipeRouteNode3D[] = [];
  for (let step = 1; step < divisions; step += 1) {
    const angle = -Math.PI / 2 + (step / divisions) * (Math.PI / 2);
    arc.push({ x: centre.x + Math.cos(angle) * radiusMm, y: centre.y + Math.sin(angle) * radiusMm, z: 0 });
  }
  return [
    { x: 0, y: 0, z: 0 },
    entry,
    ...arc,
    { x: 1000, y: radiusMm, z: 0 },
    { x: 1000, y: 1000, z: 0 },
  ];
}

describe('decimatePipeRoute', () => {
  it('leaves an already sharp route untouched', () => {
    const nodes: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 1000, z: 0 },
    ];
    const result = decimatePipeRoute(nodes);
    expect(result.decimated).toBe(false);
    expect(result.nodes).toEqual(nodes);
  });

  it('collapses a sampled fillet back to one sharp corner and recovers its radius', () => {
    const result = decimatePipeRoute(tessellatedCorner(50));
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[1]!.x).toBeCloseTo(1000, 3);
    expect(result.nodes[1]!.y).toBeCloseTo(0, 3);
    expect(result.radii[1]!).toBeCloseTo(50, 1);
    expect(result.decimated).toBe(true);
  });

  it('preserves the stored endpoints exactly — a weld is not a fitted quantity', () => {
    const source = tessellatedCorner(50);
    const result = decimatePipeRoute(source);
    expect(result.nodes[0]).toEqual(source[0]);
    expect(result.nodes.at(-1)).toEqual(source.at(-1));
  });

  it('recovers a riser corner in 3D, not only in plan', () => {
    const nodes: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2600 },
      { x: 1000, y: 0, z: 1400 }, { x: 2000, y: 0, z: 1400 },
    ];
    const result = decimatePipeRoute(nodes);
    expect(result.nodes).toHaveLength(4);
    expect(result.nodes[1]!.z).toBeCloseTo(2600, 6);
    expect(result.nodes[2]!.z).toBeCloseTo(1400, 6);
  });

  it('keeps a route with no recoverable legs rather than inventing geometry', () => {
    const jitter: PipeRouteNode3D[] = [
      { x: 0, y: 0, z: 0 }, { x: 3, y: 1, z: 0 }, { x: 6, y: -1, z: 0 },
    ];
    expect(decimatePipeRoute(jitter).nodes).toHaveLength(3);
  });
});

describe('buildPipeSkeleton', () => {
  it('derives one joint per real fitting from a tessellated route', () => {
    const skeleton = buildPipeSkeleton(tessellatedCorner(50), { defaultBendRadiusMm: 30 });
    expect(skeleton.legs).toHaveLength(2);
    expect(skeleton.joints).toHaveLength(1);
    expect(skeleton.joints[0]!.angleDeg).toBeCloseTo(90, 3);
    expect(skeleton.joints[0]!.filleted).toBe(true);
    expect(skeleton.joints[0]!.radiusMm).toBeCloseTo(50, 1);
    // A 90-degree turn at r=50 consumes r*tan(45) = 50mm of each straight.
    expect(skeleton.joints[0]!.takeoffMm).toBeCloseTo(50, 1);
  });

  it('classifies a plan bend and a riser bend by their turn planes', () => {
    const skeleton = buildPipeSkeleton([
      { x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2600 },
      { x: 1000, y: 0, z: 1400 }, { x: 2000, y: 0, z: 1400 },
    ]);
    // A riser turns in a vertical plane, so its plane normal is horizontal.
    expect(Math.abs(skeleton.joints[0]!.planeNormal.z)).toBeLessThan(0.01);
    expect(Math.abs(skeleton.joints[1]!.planeNormal.z)).toBeLessThan(0.01);
  });

  it('gives a recovered leg the strictest material it covers', () => {
    const skeleton = buildPipeSkeleton(tessellatedCorner(50), {
      // The first straight is flexible; the arc chords beside it are hard.
      materials: Array.from({ length: 30 }, (_, index) => (index === 0 ? 'flexible' : 'hard')),
    });
    expect(skeleton.legs[0]!.material).toBe('hard');
  });

  it('maps a source segment index onto the design leg that covers it', () => {
    const skeleton = buildPipeSkeleton(tessellatedCorner(50));
    expect(skeletonLegIndexForSource(skeleton, 0)).toBe(0);
    expect(skeletonLegIndexForSource(skeleton, skeleton.sourceIndices[1]! + 1)).toBe(1);
  });
});
