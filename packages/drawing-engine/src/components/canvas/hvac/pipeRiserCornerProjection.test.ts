import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { findRiserCornerPlanMatches, findSampledQuarterTurns, restoreRiserCornerPlanProjection } from './pipeRiserCornerProjection';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { filletPolyline } from './pipeTopology';
import { buildRefrigerantPipePairElement, buildRefrigerantPipePairVisual } from './refrigerantPipePairModel';

function roundedLane(offsetMm = 0, angles = Array.from({ length: 25 }, (_, index) => index * Math.PI / 48)): Point2D[] {
  const radius = 60 - offsetMm;
  return [
    { x: -300, y: offsetMm },
    ...angles.map((angle) => ({ x: -60 + radius * Math.sin(angle), y: 60 - radius * Math.cos(angle) })),
    { x: -offsetMm, y: 300 },
  ];
}

const riseAndTurn: PipeRouteNode3D[] = [
  { x: -300, y: 0, z: 100 },
  { x: 0, y: 0, z: 100 },
  { x: 0, y: 0, z: 400 },
  { x: 0, y: 300, z: 400 },
];

function rotate<T extends Point2D>(point: T, angle: number): T {
  return {
    ...point,
    x: point.x * Math.cos(angle) - point.y * Math.sin(angle) + 1234,
    y: point.x * Math.sin(angle) + point.y * Math.cos(angle) - 5678,
  };
}

describe('riser corner plan projection', () => {
  it('restores both physical lanes built by the paired pipe model', () => {
    const plan = [{ x: 100, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 1100 }];
    const guide = [{ ...plan[0]!, z: 2300 }, { ...plan[1]!, z: 2300 },
      { ...plan[1]!, z: 2600 }, { ...plan[2]!, z: 2600 }];
    const built = buildRefrigerantPipePairElement(plan, {
      gasPipeDiameterMm: 15.875, liquidPipeDiameterMm: 9.525, elevationMm: 2300, bendRadiusFactor: 1,
    });
    const visual = buildRefrigerantPipePairVisual(built as never);
    for (const lane of [visual.gasContinuousOuterPoints, visual.liquidContinuousOuterPoints]) {
      expect(findRiserCornerPlanMatches(lane, guide)).toHaveLength(1);
      const restored = restoreRiserCornerPlanProjection(lane, guide);
      expect(findSampledQuarterTurns(restored)).toHaveLength(0);
      expect(findRiserCornerPlanMatches(restored, guide)).toHaveLength(1);
      expect(restored[0]).toBe(lane[0]);
      expect(restored[restored.length - 1]).toBe(lane[lane.length - 1]);
    }
  });

  it('restores a sampled 90-degree elbow to its tangent intersection at an authored rise', () => {
    const plan = roundedLane();
    const restored = restoreRiserCornerPlanProjection(plan, riseAndTurn);
    expect(restored).toHaveLength(3);
    expect(restored[0]).toBe(plan[0]);
    expect(restored[2]).toBe(plan[plan.length - 1]);
    expect(restored[1]!.x).toBeCloseTo(0, 8);
    expect(restored[1]!.y).toBeCloseTo(0, 8);
    expect(plan).toHaveLength(27);
  });

  it.each([-25, 25])('keeps the physical corner of a parallel lane offset by %s mm', (offset) => {
    const restored = restoreRiserCornerPlanProjection(roundedLane(offset), riseAndTurn);
    expect(restored).toHaveLength(3);
    expect(restored[1]!.x).toBeCloseTo(-offset, 8);
    expect(restored[1]!.y).toBeCloseTo(offset, 8);
    const matches = findRiserCornerPlanMatches(restored, riseAndTurn);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ guideStartIndex: 1, guideEndIndex: 2, startIndex: 1, endIndex: 1, radiusMm: 0 });
    expect(matches[0]!.corner).toBe(restored[1]);
  });

  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.72])('recognizes rotated and reversed routes at rotation %s', (angle) => {
    const plan = roundedLane(15).map((point) => rotate(point, angle)).reverse();
    const guide = riseAndTurn.map((point) => rotate(point, angle)).reverse();
    const restored = restoreRiserCornerPlanProjection(plan, guide);
    const corner = rotate({ x: -15, y: 15 }, angle);
    expect(restored).toHaveLength(3);
    expect(restored[1]!.x).toBeCloseTo(corner.x, 8);
    expect(restored[1]!.y).toBeCloseTo(corner.y, 8);
    expect(findRiserCornerPlanMatches(restored, guide)).toHaveLength(1);
  });

  it('recognizes a circular arc even when its samples are not equally spaced', () => {
    const turns = findSampledQuarterTurns(roundedLane(0, [0, 0.1, 0.4, 1.1, Math.PI / 2]));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.radiusMm).toBeCloseTo(60);
  });

  it('preserves sharp plan corners while exposing their vertical stack match', () => {
    const plan = [{ x: -300, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 300 }];
    expect(restoreRiserCornerPlanProjection(plan, riseAndTurn)).toBe(plan);
    expect(findRiserCornerPlanMatches(plan, riseAndTurn)).toHaveLength(1);
  });

  it('preserves ordinary plan elbows when there is no corresponding vertical stack', () => {
    const plan = roundedLane();
    const guide = riseAndTurn.map((node) => ({ ...node, z: 100 }));
    expect(findSampledQuarterTurns(plan)).toHaveLength(1);
    expect(restoreRiserCornerPlanProjection(plan, guide)).toBe(plan);
  });

  it('does not flatten a curved or noncircular custom gather', () => {
    const plan = roundedLane();
    plan[12] = { x: plan[12]!.x + 1, y: plan[12]!.y };
    expect(findSampledQuarterTurns(plan)).toHaveLength(0);
    expect(restoreRiserCornerPlanProjection(plan, riseAndTurn)).toBe(plan);
  });

  it('does not flatten a custom diagonal port gather', () => {
    const plan = [
      { x: -300, y: 0 }, { x: -60, y: 0 }, { x: -20, y: 20 }, { x: 0, y: 60 }, { x: 0, y: 300 },
    ];
    expect(findSampledQuarterTurns(plan)).toHaveLength(0);
    expect(restoreRiserCornerPlanProjection(plan, riseAndTurn)).toBe(plan);
  });

  it('does not flatten an arc whose samples turn back on themselves', () => {
    const plan = roundedLane(0, [0, 0.2, 0.8, 0.4, 1.3, Math.PI / 2]);
    expect(findSampledQuarterTurns(plan)).toHaveLength(0);
    expect(restoreRiserCornerPlanProjection(plan, riseAndTurn)).toBe(plan);
  });

  it('keeps a similar elbow that is displaced along the guide trunk', () => {
    const plan = roundedLane().map((point) => ({ x: point.x + 150, y: point.y }));
    expect(findSampledQuarterTurns(plan)).toHaveLength(1);
    expect(restoreRiserCornerPlanProjection(plan, riseAndTurn)).toBe(plan);
  });

  it('keeps an unrelated matching corner beyond both adjacent guide spans', () => {
    const plan = roundedLane().map((point) => ({ x: point.x - 1000, y: point.y + 1000 }));
    expect(findSampledQuarterTurns(plan)).toHaveLength(1);
    expect(restoreRiserCornerPlanProjection(plan, riseAndTurn)).toBe(plan);
  });

  it('keeps a plan elbow if the incoming guide is inclined', () => {
    const plan = roundedLane();
    const guide = riseAndTurn.map((node, index) => ({ ...node, z: index === 0 ? 50 : node.z }));
    expect(restoreRiserCornerPlanProjection(plan, guide)).toBe(plan);
  });

  it('restores multiple riser corners and preserves intervening route shape', () => {
    const sharp = [{ x: -300, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 600 }, { x: 400, y: 600 }];
    const guide = [
      { ...sharp[0]!, z: 100 }, { ...sharp[1]!, z: 100 }, { ...sharp[1]!, z: 400 },
      { ...sharp[2]!, z: 400 }, { ...sharp[2]!, z: 700 }, { ...sharp[3]!, z: 700 },
    ];
    const restored = restoreRiserCornerPlanProjection(filletPolyline(sharp, 50), guide);
    expect(restored).toHaveLength(4);
    restored.forEach((point, index) => {
      expect(point.x).toBeCloseTo(sharp[index]!.x, 8);
      expect(point.y).toBeCloseTo(sharp[index]!.y, 8);
    });
    expect(findRiserCornerPlanMatches(restored, guide).map(({ guideStartIndex, guideEndIndex }) => [guideStartIndex, guideEndIndex]))
      .toEqual([[1, 2], [3, 4]]);
  });

  it('preserves a separate plan elbow that carries no rise', () => {
    const sharp = [{ x: -300, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 600 }, { x: 400, y: 600 }];
    const guide = [
      { ...sharp[0]!, z: 100 }, { ...sharp[1]!, z: 100 }, { ...sharp[1]!, z: 400 },
      { ...sharp[2]!, z: 400 }, { ...sharp[3]!, z: 400 },
    ];
    const plan = filletPolyline(sharp, 50);
    const originalTurns = findSampledQuarterTurns(plan);
    const restored = restoreRiserCornerPlanProjection(plan, guide);
    expect(findSampledQuarterTurns(restored)).toHaveLength(1);
    const secondArc = originalTurns[1]!;
    expect(restored.slice(2)).toEqual(plan.slice(secondArc.startIndex));
  });

  it('returns an unchanged empty or degenerate route', () => {
    const empty: Point2D[] = [];
    const vertical = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    expect(restoreRiserCornerPlanProjection(empty, riseAndTurn)).toBe(empty);
    expect(restoreRiserCornerPlanProjection(vertical, riseAndTurn)).toBe(vertical);
    expect(findSampledQuarterTurns(vertical)).toEqual([]);
  });
});
