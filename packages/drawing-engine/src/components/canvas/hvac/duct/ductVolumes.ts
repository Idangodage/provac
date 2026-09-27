/**
 * Duct bodies as boxes, for clash checks against pipes and other ducts. Every
 * piece of a run's fabrication plan becomes one or more oriented boxes along
 * its centreline (arcs, offsets and risers in short segments): outside the
 * sheet and its insulation, width held horizontal. Pipes are the pipe
 * engine's insulated tubes (capsules), so a duct-to-pipe clash is a
 * segment-to-box distance below the tube radius; duct to duct is a
 * separating-axis overlap. Body interference only (not flanges or hangers).
 */
import type { HvacElement, Point2D } from '../../../../types';

import { getDuctRunPlan, type DuctFabricationPlan, type DuctPiece } from './ductFabricationPlanner';
import { frameToWorld, sampleArc } from './ductGeometry';
import type { DuctDesignSettings } from './ductSettings';
import { ductParentRunId, isDuctElement, readDuctRunSpec, type DuctPoint3 } from './ductTypes';

export interface Vec3 { x: number; y: number; z: number }

export interface DuctBox {
  elementId: string;
  mark: string;
  centre: Vec3;
  /** Unit axes: along the duct, across it (horizontal) and up its section. */
  axisT: Vec3;
  axisN: Vec3;
  axisU: Vec3;
  halfLength: number;
  halfWidth: number;
  halfHeight: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

function box(elementId: string, mark: string, a: Vec3, b: Vec3, halfWidth: number, halfHeight: number, across?: Point2D): DuctBox | null {
  const along = sub(b, a);
  const length = norm(along);
  if (length < 1) return null;
  const axisT = scale(along, 1 / length);
  const plan = Math.hypot(axisT.x, axisT.y);
  const n2 = across ?? (plan > 1e-6 ? { x: -axisT.y / plan, y: axisT.x / plan } : { x: 1, y: 0 });
  const axisN: Vec3 = { x: n2.x, y: n2.y, z: 0 };
  const u = cross(axisT, axisN);
  const axisU = scale(u, 1 / (norm(u) || 1));
  const centre = scale(add(a, b), 0.5);
  const halfLength = length / 2;
  // Bounds of the box: each axis contributes |axis component| × half size.
  const extent = (k: 'x' | 'y' | 'z') => Math.abs(axisT[k]) * halfLength + Math.abs(axisN[k]) * halfWidth + Math.abs(axisU[k]) * halfHeight;
  return {
    elementId, mark, centre, axisT, axisN, axisU, halfLength, halfWidth, halfHeight,
    bounds: {
      minX: centre.x - extent('x'), maxX: centre.x + extent('x'),
      minY: centre.y - extent('y'), maxY: centre.y + extent('y'),
      minZ: centre.z - extent('z'), maxZ: centre.z + extent('z'),
    },
  };
}

/** A piece's centreline as 3D points, and the width axis to hold (vertical-plane pieces). */
function pieceCentreline(piece: DuctPiece): { points: Vec3[]; across?: Point2D } | null {
  if (piece.frame) {
    const frame = piece.frame;
    const across = { x: -frame.heading.y, y: frame.heading.x };
    if (piece.kind === 'elbow' && piece.elbow) {
      const elbow = piece.elbow;
      const local = elbow.style === 'square-vaned' ? [elbow.startPoint, elbow.corner, elbow.endPoint]
        : [elbow.startPoint, ...sampleArc(elbow, elbow.centrelineRadiusMm, 6), elbow.endPoint];
      return { points: local.map((point) => frameToWorld(frame, point)), across };
    }
    if (piece.kind === 'offset' && piece.offset) return { points: piece.offset.centreline.map((point) => frameToWorld(frame, point)), across };
    return null;
  }
  if (piece.vertical) {
    return { points: [{ ...piece.start, z: piece.centreZ }, { ...piece.end, z: piece.endCentreZ }], across: { x: -piece.direction.y, y: piece.direction.x } };
  }
  const at = (point: Point2D, z: number): DuctPoint3 => ({ x: point.x, y: point.y, z });
  if (piece.kind === 'elbow' && piece.elbow) {
    const elbow = piece.elbow;
    const plan = elbow.style === 'square-vaned' ? [elbow.startPoint, elbow.corner, elbow.endPoint]
      : [elbow.startPoint, ...sampleArc(elbow, elbow.centrelineRadiusMm, 6), elbow.endPoint];
    return { points: plan.map((point) => at(point, piece.centreZ)) };
  }
  if (piece.kind === 'offset' && piece.offset) return { points: piece.offset.centreline.map((point) => at(point, piece.centreZ)) };
  if (piece.kind === 'end-cap' || piece.kind === 'split') return null;
  // A flat-bottom transition: the bigger section, centred on the bigger end.
  const z = piece.kind === 'transition' && !piece.vertical ? piece.bottomZ + Math.max(piece.heightMm, piece.endHeightMm) / 2 : piece.centreZ;
  return { points: [at(piece.start, z), at(piece.end, z)] };
}

const BOX_CACHE = new WeakMap<DuctFabricationPlan, DuctBox[]>();

/** The run's body as boxes (outside the sheet and insulation). Cached per plan. */
export function ductBoxesOf(plan: DuctFabricationPlan): DuctBox[] {
  const cached = BOX_CACHE.get(plan);
  if (cached) return cached;
  const boxes: DuctBox[] = [];
  for (const piece of plan.pieces) {
    const line = pieceCentreline(piece);
    if (!line) continue;
    const t = piece.sheetThicknessMm ?? 1;
    const round = piece.diameterMm !== undefined;
    const width = round ? Math.max(piece.diameterMm!, piece.endDiameterMm ?? piece.diameterMm!) : Math.max(piece.widthMm, piece.endWidthMm);
    const height = round ? width : Math.max(piece.heightMm, piece.endHeightMm);
    const halfWidth = width / 2 + t + plan.insulationMm;
    const halfHeight = height / 2 + t + plan.insulationMm;
    for (let index = 1; index < line.points.length; index += 1) {
      const next = box(plan.elementId, piece.mark, line.points[index - 1]!, line.points[index]!, halfWidth, halfHeight, line.across);
      if (next) boxes.push(next);
    }
  }
  BOX_CACHE.set(plan, boxes);
  return boxes;
}

export function ductBoxesInScene(elements: readonly HvacElement[], settings: DuctDesignSettings): DuctBox[] {
  const boxes: DuctBox[] = [];
  for (const element of elements) {
    if (!isDuctElement(element)) continue;
    const plan = getDuctRunPlan(element, elements, settings);
    if (plan) boxes.push(...ductBoxesOf(plan));
  }
  return boxes;
}

function boundsOverlap(a: DuctBox['bounds'], b: DuctBox['bounds'], margin = 0): boolean {
  return a.minX <= b.maxX + margin && b.minX <= a.maxX + margin && a.minY <= b.maxY + margin && b.minY <= a.maxY + margin
    && a.minZ <= b.maxZ + margin && b.minZ <= a.maxZ + margin;
}

/** Distance from a point to the box (0 inside). */
function pointBoxDistance(point: Vec3, target: DuctBox): number {
  const d = sub(point, target.centre);
  const outside = (value: number, half: number) => Math.max(0, Math.abs(value) - half);
  return Math.hypot(outside(dot(d, target.axisT), target.halfLength), outside(dot(d, target.axisN), target.halfWidth), outside(dot(d, target.axisU), target.halfHeight));
}

/**
 * Distance from a segment to a box: the distance to a convex set is convex
 * along a line, so a golden-section search over the segment finds it.
 */
export function segmentBoxDistance(a: Vec3, b: Vec3, target: DuctBox): { distance: number; point: Vec3 } {
  const at = (s: number) => add(a, scale(sub(b, a), s));
  const ratio = (Math.sqrt(5) - 1) / 2;
  let lo = 0;
  let hi = 1;
  let x1 = hi - ratio * (hi - lo);
  let x2 = lo + ratio * (hi - lo);
  let f1 = pointBoxDistance(at(x1), target);
  let f2 = pointBoxDistance(at(x2), target);
  for (let step = 0; step < 48 && hi - lo > 1e-6; step += 1) {
    if (f1 <= f2) {
      hi = x2; x2 = x1; f2 = f1; x1 = hi - ratio * (hi - lo); f1 = pointBoxDistance(at(x1), target);
    } else {
      lo = x1; x1 = x2; f1 = f2; x2 = lo + ratio * (hi - lo); f2 = pointBoxDistance(at(x2), target);
    }
  }
  const candidates = [0, 1, (lo + hi) / 2].map((s) => ({ s, d: pointBoxDistance(at(s), target) }));
  const best = candidates.reduce((min, candidate) => (candidate.d < min.d ? candidate : min));
  return { distance: best.d, point: at(best.s) };
}

/** Separating-axis overlap of two boxes (penetration beyond `toleranceMm`). */
export function boxesOverlap(a: DuctBox, b: DuctBox, toleranceMm = 1): boolean {
  if (!boundsOverlap(a.bounds, b.bounds, -toleranceMm)) return false;
  const axesA = [a.axisT, a.axisN, a.axisU];
  const axesB = [b.axisT, b.axisN, b.axisU];
  const halfA = [a.halfLength, a.halfWidth, a.halfHeight];
  const halfB = [b.halfLength, b.halfWidth, b.halfHeight];
  const d = sub(b.centre, a.centre);
  const candidates: Vec3[] = [...axesA, ...axesB];
  for (const u of axesA) for (const v of axesB) {
    const c = cross(u, v);
    if (norm(c) > 1e-6) candidates.push(scale(c, 1 / norm(c)));
  }
  for (const axis of candidates) {
    const ra = axesA.reduce((total, u, index) => total + halfA[index]! * Math.abs(dot(u, axis)), 0);
    const rb = axesB.reduce((total, v, index) => total + halfB[index]! * Math.abs(dot(v, axis)), 0);
    if (Math.abs(dot(d, axis)) >= ra + rb - toleranceMm) return false;
  }
  return true;
}

export interface DuctClash {
  ductId: string;
  mark: string;
  otherId: string;
  kind: 'pipe' | 'duct';
  service?: string;
  point: Vec3;
}

/** Runs that meet by design (a branch and its parent) never clash with each other. */
function connected(a: HvacElement, b: HvacElement): boolean {
  const specA = readDuctRunSpec(a);
  const specB = readDuctRunSpec(b);
  return (specA ? ductParentRunId(specA) === b.id : false) || (specB ? ductParentRunId(specB) === a.id : false);
}

/**
 * Every duct body clash in the scene: against the pipe engine's insulated
 * tubes (refrigerant and condensate), and against other duct runs.
 */
export function findDuctClashes(
  elements: readonly HvacElement[],
  settings: DuctDesignSettings,
  pipeLanes: ReadonlyArray<{ elementId: string; service: string; radiusMm: number; segments: ReadonlyArray<{ a: Vec3; b: Vec3 }> }>,
): DuctClash[] {
  const ducts = elements.filter(isDuctElement);
  if (ducts.length === 0) return [];
  const boxesByRun = new Map<string, DuctBox[]>();
  for (const duct of ducts) {
    const plan = getDuctRunPlan(duct, elements, settings);
    if (plan) boxesByRun.set(duct.id, ductBoxesOf(plan));
  }
  const clashes: DuctClash[] = [];
  const seen = new Set<string>();
  for (const [ductId, boxes] of boxesByRun) {
    for (const lane of pipeLanes) {
      const key = `${ductId}|${lane.elementId}`;
      for (const target of boxes) {
        if (seen.has(key)) break;
        for (const segment of lane.segments) {
          const sb = {
            minX: Math.min(segment.a.x, segment.b.x) - lane.radiusMm, maxX: Math.max(segment.a.x, segment.b.x) + lane.radiusMm,
            minY: Math.min(segment.a.y, segment.b.y) - lane.radiusMm, maxY: Math.max(segment.a.y, segment.b.y) + lane.radiusMm,
            minZ: Math.min(segment.a.z, segment.b.z) - lane.radiusMm, maxZ: Math.max(segment.a.z, segment.b.z) + lane.radiusMm,
          };
          if (!boundsOverlap(target.bounds, sb)) continue;
          const hit = segmentBoxDistance(segment.a, segment.b, target);
          if (hit.distance < lane.radiusMm - 0.5) {
            seen.add(key);
            clashes.push({ ductId, mark: target.mark, otherId: lane.elementId, kind: 'pipe', service: lane.service, point: hit.point });
            break;
          }
        }
      }
    }
  }
  const runs = [...boxesByRun.keys()];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = ducts.find((duct) => duct.id === runs[i])!;
      const b = ducts.find((duct) => duct.id === runs[j])!;
      if (connected(a, b)) continue;
      search: for (const boxA of boxesByRun.get(a.id)!) {
        for (const boxB of boxesByRun.get(b.id)!) {
          if (boxesOverlap(boxA, boxB)) {
            clashes.push({ ductId: a.id, mark: boxA.mark, otherId: b.id, kind: 'duct', point: scale(add(boxA.centre, boxB.centre), 0.5) });
            break search;
          }
        }
      }
    }
  }
  return clashes;
}
