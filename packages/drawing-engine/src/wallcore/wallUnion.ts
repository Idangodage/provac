/**
 * Polygon booleans for wall bodies: union and difference on a 0.01 mm integer
 * grid. Clipper's integer arithmetic cannot fail on the nearly-collinear edges
 * wall junctions are full of; the float clipper inside turf can throw on them
 * or silently return the wrong area.
 *
 * Callers stay synchronous. Clipper's plain-JS build (the WASM one compiles
 * truly asynchronously) is ready a few microtask turns after this module loads,
 * before anything can ask for a union. Should it ever be unavailable the
 * functions still answer, with `exact: false`.
 */
// (The web app's type check reads only what is imported, so the declaration has to be named here.)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./clipperWebBuild.d.ts" />
import type { IntPoint } from 'js-angusj-clipper/web/IntPoint';
import type { PolyNode } from 'js-angusj-clipper/web/PolyNode';
import { clipToPolyTree } from 'js-angusj-clipper/web/clipFunctions.js';
import { ClipType, PolyFillType } from 'js-angusj-clipper/web/enums.js';
import type { NativeClipperLibInstance } from 'js-angusj-clipper/web/native/NativeClipperLibInstance';
import createClipperModule from 'js-angusj-clipper/web/wasm/clipper.js';

import { CLIP_GRID_PER_MM, MIN_CLIP_RING_WIDTH_MM } from './tolerances';
import type { Vec2 } from './vec2';

/** One polygon: outer ring first (positive area), then its holes (negative). Rings are open. */
export type WallPolygon = Vec2[][];

export interface WallPolygonSet {
  polygons: WallPolygon[];
  /**
   * False only when Clipper could not answer: `polygons` are then the input
   * rings, wound the same way, so they may overlap and must fill non-zero.
   */
  exact: boolean;
}

type Ring = readonly Vec2[];

const clipper = {} as NativeClipperLibInstance;
let clipperReady = false;
void createClipperModule(clipper).then(
  () => {
    clipperReady = true;
  },
  () => {
    clipperReady = false;
  },
);

function toPath(ring: Ring): IntPoint[] {
  const path: IntPoint[] = [];
  for (const point of ring) {
    const x = Math.round(point[0] * CLIP_GRID_PER_MM);
    const y = Math.round(point[1] * CLIP_GRID_PER_MM);
    const last = path[path.length - 1];
    if (!last || last.x !== x || last.y !== y) path.push({ x, y });
  }
  const first = path[0];
  const last = path[path.length - 1];
  if (path.length > 1 && first!.x === last!.x && first!.y === last!.y) path.pop();
  return path;
}

function pathArea(path: readonly Readonly<IntPoint>[]): number {
  let doubled = 0;
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    doubled += a.x * b.y - b.x * a.y;
  }
  return doubled / 2;
}

function pathPerimeter(path: readonly Readonly<IntPoint>[]): number {
  let length = 0;
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i]!;
    const b = path[(i + 1) % path.length]!;
    length += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return length;
}

/** Hairlines left where two edges meet one grid step apart: nothing physical. */
function isDebris(path: readonly Readonly<IntPoint>[]): boolean {
  const meanWidth = (2 * Math.abs(pathArea(path))) / Math.max(pathPerimeter(path), 1);
  return meanWidth < MIN_CLIP_RING_WIDTH_MM * CLIP_GRID_PER_MM;
}

function ringFromPath(path: readonly Readonly<IntPoint>[]): Vec2[] {
  return path.map((point): Vec2 => [point.x / CLIP_GRID_PER_MM, point.y / CLIP_GRID_PER_MM]);
}

function collectPolygons(outers: readonly PolyNode[], into: WallPolygon[]): void {
  for (const outer of outers) {
    const polygon: WallPolygon = [ringFromPath(outer.contour)];
    for (const hole of outer.childs) {
      if (!isDebris(hole.contour)) polygon.push(ringFromPath(hole.contour));
      collectPolygons(hole.childs, into); // an island standing inside a hole
    }
    if (!isDebris(outer.contour)) into.push(polygon);
  }
}

function runClipper(
  clipType: ClipType,
  subject: readonly (readonly IntPoint[])[],
  clip: readonly (readonly IntPoint[])[] = [],
): WallPolygon[] | null {
  if (!clipperReady) return null;
  try {
    const tree = clipToPolyTree(clipper, {
      clipType,
      subjectInputs: subject.map((data) => ({ data, closed: true })),
      clipInputs: clip.map((data) => ({ data })),
      subjectFillType: PolyFillType.NonZero,
      clipFillType: PolyFillType.NonZero,
    });
    const polygons: WallPolygon[] = [];
    collectPolygons(tree.childs, polygons);
    return polygons;
  } catch {
    return null;
  }
}

function positiveRing(ring: Ring): Vec2[] {
  return pathArea(toPath(ring)) < 0 ? [...ring].reverse() : [...ring];
}

/**
 * Union of closed rings, whatever their winding. Rings too small to survive the
 * grid are ignored.
 */
export function unionWallRings(rings: readonly Ring[]): WallPolygonSet {
  const paths = rings
    .map((ring) => {
      const path = toPath(ring);
      return pathArea(path) < 0 ? path.reverse() : path;
    })
    .filter((path) => path.length >= 3 && pathArea(path) !== 0);
  if (paths.length === 0) return { polygons: [], exact: true };
  let polygons = runClipper(ClipType.Union, paths);
  // Clipper can rarely hand back two polygons sharing an edge, which would draw a false seam; a second pass joins them.
  if (polygons && polygons.length > 1) polygons = runClipper(ClipType.Union, polygons.flat().map(toPath)) ?? polygons;
  return polygons
    ? { polygons, exact: true }
    : { polygons: rings.map((ring) => [positiveRing(ring)]), exact: false };
}

/** `subject` minus `clip`; holes count because outer and hole rings wind oppositely. */
export function subtractWallPolygons(
  subject: readonly WallPolygon[],
  clip: readonly WallPolygon[],
): WallPolygonSet {
  const paths = (polygons: readonly WallPolygon[]) =>
    polygons.flat().map(toPath).filter((path) => path.length >= 3 && pathArea(path) !== 0);
  const polygons = runClipper(ClipType.Difference, paths(subject), paths(clip));
  return polygons
    ? { polygons, exact: true }
    : { polygons: subject.map((polygon) => polygon.map((ring) => [...ring])), exact: false };
}

/** Signed-free area of a polygon set: outers minus holes, in mm². */
export function wallPolygonsArea(polygons: readonly WallPolygon[]): number {
  let total = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      let doubled = 0;
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        doubled += a[0] * b[1] - b[0] * a[1];
      }
      total += (index === 0 ? 1 : -1) * Math.abs(doubled / 2);
    });
  }
  return total;
}
