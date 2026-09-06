import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildRefrigerantPipeVisual } from './refrigerantPipePairModel';

const add = (a: Point2D, b: Point2D): Point2D => ({ x: a.x + b.x, y: a.y + b.y });
const subtract = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Point2D, value: number): Point2D => ({ x: a.x * value, y: a.y * value });
const dot = (a: Point2D, b: Point2D): number => a.x * b.x + a.y * b.y;

/** Original vector formulation, retained as an independent ownership oracle. */
function originalOwner(start: Point2D, end: Point2D, original: Point2D[]): number {
  const midpoint = scale(add(start, end), 0.5);
  let best = 0; let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < original.length - 1; index += 1) {
    const source = original[index]!;
    const delta = subtract(original[index + 1]!, source);
    const squaredLength = dot(delta, delta);
    const t = squaredLength > 1e-12 ? Math.max(0, Math.min(1, dot(subtract(midpoint, source), delta) / squaredLength)) : 0;
    const offset = subtract(midpoint, add(source, scale(delta, t)));
    const squaredDistance = dot(offset, offset);
    if (squaredDistance < bestDistance) { best = index; bestDistance = squaredDistance; }
  }
  return best;
}

describe('catalogue fitting segment ownership', () => {
  it.each([0, 90, 180, 270])('matches original span selection and tie ordering after a %i-degree rotation', degrees => {
    const angle = degrees * Math.PI / 180;
    const transform = (p: Point2D) => ({ x: 1e6 + p.x * Math.cos(angle) - p.y * Math.sin(angle),
      y: -2e6 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const source = [{ x: 0, y: 0 }, ...Array.from({ length: 25 }, (_, index) => {
      const theta = -Math.PI / 2 + index * Math.PI / 48;
      return { x: 700 + Math.cos(theta) * 100, y: 100 + Math.sin(theta) * 100 };
    }), { x: 800, y: 900 }].map(transform);
    const materials = source.slice(1).map((_, index) => index % 3 ? 'flexible' : 'hard');
    const element: HvacElement = { id: 'ownership-fixture', type: 'refrigerant-pipe', rotation: 0,
      position: { x: 1e6, y: -2e6 }, width: 2000, depth: 2000, height: 70, elevation: 2400,
      mountType: 'ceiling', label: 'Gas pipe', supplyZoneRatio: 0,
      properties: { routePoints: source, authoredCenterlineRoute: source, pipeDiameterMm: 15.875,
        outerDiameterMm: 70, lineKind: 'gas', segmentMaterials: materials } };
    const snapshot = structuredClone(element);
    const visual = buildRefrigerantPipeVisual(element);
    expect(visual.outerPoints).not.toEqual(source);
    const actual = visual.segmentVisuals.flatMap(segment => segment.points.slice(1).map((end, index) => ({
      start: segment.points[index]!, end, owner: segment.index, material: segment.material, invalid: segment.invalidHardGeometry,
    })));
    expect(actual).toHaveLength(visual.outerPoints.length - 1);
    for (const edge of actual) {
      const expected = originalOwner(edge.start, edge.end, source);
      expect(edge.owner).toBe(expected);
      expect(edge.material).toBe(materials[expected]);
      expect(edge.invalid).toBe(false);
    }
    expect(element).toEqual(snapshot);
  });
});
