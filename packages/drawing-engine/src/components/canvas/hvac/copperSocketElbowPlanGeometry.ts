import type { Point2D } from '../../../types';

import type { CopperSocketElbowPlacement } from './copperSocketElbowRoute';

export function copperSocketCupOutline(face: Point2D, stop: Point2D, direction: Point2D, radius: number): Point2D[] {
  // A vertical cup projects to its circular mouth in plan. Its projected
  // centreline has zero length, so the horizontal rectangular symbol collapses.
  if (Math.hypot(direction.x, direction.y) <= 1e-5) {
    return Array.from({ length: 24 }, (_, index) => ({
      x: face.x + radius * Math.cos(index * Math.PI / 12),
      y: face.y + radius * Math.sin(index * Math.PI / 12),
    }));
  }
  const normal = { x: -direction.y * radius, y: direction.x * radius };
  return [{ x: face.x + normal.x, y: face.y + normal.y }, { x: stop.x + normal.x, y: stop.y + normal.y },
    { x: stop.x - normal.x, y: stop.y - normal.y }, { x: face.x - normal.x, y: face.y - normal.y }];
}

/** Shared conservative projected cover. It does not alter the copper radius. */
export function copperSocketCoverOutline(fitting: CopperSocketElbowPlacement, radius: number): Point2D[] {
  const samples = fitting.path.flatMap(point => Array.from({ length: 16 }, (_, index) => ({
    x: point.x + radius * Math.cos(index * Math.PI / 8),
    y: point.y + radius * Math.sin(index * Math.PI / 8),
  }))).sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: Point2D, b: Point2D, c: Point2D) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const hull = (points: Point2D[]) => {
    const result: Point2D[] = [];
    for (const point of points) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...hull(samples), ...hull([...samples].reverse())];
}
