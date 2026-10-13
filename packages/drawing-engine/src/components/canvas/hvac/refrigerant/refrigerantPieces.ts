/**
 * The pieces of a refrigerant line, as its segment card shows them: the stub
 * at a unit or branch-kit port, the straights and risers between fittings, and
 * the bends (copper socket elbows or formed bends), in path order. Pieces are
 * keyed on the line's design (pipeDesignModel): its leg and joint ids are
 * persisted once the line is first edited, so a piece keeps its key across an
 * edit that keeps its leg or joint (a resize, a raise, a re-angle).
 *
 * Each piece carries its own centreline in model space (mm, z up): a straight
 * trimmed where the fittings either side take over, a bend's arc with its
 * sockets, a port stub's straight. The plan and the 3D views outline exactly
 * that, and find a piece under the pointer from it.
 *
 * PURE: elements in, pieces out.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { resolveCopperSocketElbow, usesCopperSocketElbows } from '../copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from '../fieldPipeBends';
import { readPipeDesign, type PipeDesign, type PipeDesignJoint } from '../pipeDesignModel';
import type { PipePortFrame, Vec3 } from '../pipePortFrame';
import {
  isRefrigerantPipeElementType,
  resolveRefrigerantPipePairSpec,
  resolveRefrigerantPipeSpec,
} from '../refrigerantPipePairModel';
import type { SegmentFocus } from '../segments/segmentUiStore';

export type RefrigerantPieceKind = 'port' | 'straight' | 'riser' | 'bend';

export interface RefrigerantPiece {
  /** `port:start` | `port:end` | `leg:<legId>` | `joint:<jointId>`. */
  key: string;
  kind: RefrigerantPieceKind;
  /** Its number among the line's pieces of its kind, from the line's start (1-based): "Straight 3". */
  ordinal: number;
  legId: string | null;
  /** The design leg it is (or the port stub's leg). */
  legIndex: number | null;
  joint: PipeDesignJoint | null;
  endpoint: 'start' | 'end' | null;
  /** Its centreline in path order (model mm, z up). */
  path: Vec3[];
  lengthMm: number;
  /** A bend's turn (deg). */
  angleDeg: number | null;
  /** A bend's centreline radius, and the straight each of its ends takes from the legs (mm). */
  radiusMm: number | null;
  takeoffMm: number | null;
  /** A bend's catalogue part, when it is a catalogued copper socket elbow. */
  catalogueModel: string | null;
}

export interface RefrigerantLine {
  elementId: string;
  lineKind: 'gas' | 'liquid' | 'pair';
  design: PipeDesign;
  /** Copper tube outside diameter, insulation, insulated outside diameter (mm). */
  tubeOdMm: number;
  insulationMm: number;
  outsideDiameterMm: number;
  /** The plan outline's half width: a line's insulated radius; a pair's two lines and their spacing (mm). */
  halfWidthMm: number;
  socketElbows: boolean;
  pieces: RefrigerantPiece[];
}

const EPSILON = 1e-9;
/** A turn below this is a pass-through (a material change on a straight), not a fitting. */
const MIN_BEND_DEG = 1;
/** A leg this steep (its rise over its length) is a riser. */
const RISER_SINE = 0.7;
/** A straight shorter than this between two fittings is not offered as a piece (mm). */
const MIN_STRAIGHT_MM = 1;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 | null => {
  const n = norm(a);
  return n > EPSILON ? scale(a, 1 / n) : null;
};
const distance = (a: Vec3, b: Vec3) => norm(sub(a, b));

function pathLength(path: readonly Vec3[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += distance(path[index - 1]!, path[index]!);
  return total;
}

/** Rotate `v` about the unit `axis` by `angle` (rad), Rodrigues. */
function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  return add(add(scale(v, c), scale(cross(axis, v), Math.sin(angle))), scale(axis, dot(axis, v) * (1 - c)));
}

/**
 * A bend's centreline: the socket (or tangent) straight into it, its arc, the
 * straight out of it. `face` is how far each end reaches from the corner; the
 * arc itself takes `radius · tan(θ/2)` of that.
 */
function bendPath(corner: Vec3, incoming: Vec3, outgoing: Vec3, angleRad: number, radiusMm: number, faceMm: number): Vec3[] {
  const tangent = Math.min(faceMm, radiusMm * Math.tan(angleRad / 2));
  const radius = angleRad > EPSILON ? tangent / Math.tan(angleRad / 2) : 0;
  const start = sub(corner, scale(incoming, faceMm));
  const end = add(corner, scale(outgoing, faceMm));
  const axis = unit(cross(incoming, outgoing));
  if (!axis || radius <= EPSILON) return [start, corner, end];
  // Towards the arc's centre from where it starts: the part of `outgoing` across `incoming`.
  const inward = unit(sub(outgoing, scale(incoming, dot(incoming, outgoing))));
  if (!inward) return [start, corner, end];
  const arcStart = sub(corner, scale(incoming, tangent));
  const centre = add(arcStart, scale(inward, radius));
  const steps = Math.max(4, Math.ceil((angleRad * 180) / Math.PI / 7.5));
  const arc: Vec3[] = [];
  for (let index = 0; index <= steps; index += 1) arc.push(add(centre, rotate(sub(arcStart, centre), axis, (angleRad * index) / steps)));
  const path = [...(faceMm - tangent > 0.5 ? [start] : []), ...arc, ...(faceMm - tangent > 0.5 ? [end] : [])];
  return path;
}

interface Fitting {
  joint: PipeDesignJoint;
  angleRad: number;
  radiusMm: number;
  faceMm: number;
  catalogueModel: string | null;
}

function lineDimensions(element: HvacElement): Pick<RefrigerantLine, 'lineKind' | 'tubeOdMm' | 'insulationMm' | 'outsideDiameterMm' | 'halfWidthMm'> {
  if (element.type === 'refrigerant-pipe-pair') {
    const spec = resolveRefrigerantPipePairSpec(element.properties);
    const spacing = typeof element.properties.pairCenterSpacingMm === 'number' && Number.isFinite(element.properties.pairCenterSpacingMm)
      ? element.properties.pairCenterSpacingMm
      : (spec.gasOuterDiameterMm + spec.liquidOuterDiameterMm) / 2 + spec.pipeGapMm;
    return {
      lineKind: 'pair',
      tubeOdMm: spec.gasPipeDiameterMm,
      insulationMm: spec.insulationThicknessMm,
      outsideDiameterMm: spec.gasOuterDiameterMm,
      halfWidthMm: spacing / 2 + Math.max(spec.gasOuterDiameterMm, spec.liquidOuterDiameterMm) / 2,
    };
  }
  const spec = resolveRefrigerantPipeSpec(element.properties);
  return {
    lineKind: spec.lineKind,
    tubeOdMm: spec.pipeDiameterMm,
    insulationMm: spec.insulationThicknessMm,
    outsideDiameterMm: spec.outerDiameterMm,
    halfWidthMm: spec.outerDiameterMm / 2,
  };
}

/** The straight a port reserves before the first fitting, when its end is held by a unit or a branch kit (mm). */
function portStubMm(port: PipePortFrame): number | null {
  if (port.kind !== 'unit-port' && port.kind !== 'branch-kit') return null;
  const value = port.straightApproachMm.value;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const LINE_CACHE = new WeakMap<HvacElement, WeakMap<readonly HvacElement[], RefrigerantLine | null>>();

/** A refrigerant line's pieces (null for anything else, or a line too short to describe). */
export function refrigerantLineOf(element: HvacElement, scene: readonly HvacElement[]): RefrigerantLine | null {
  let byScene = LINE_CACHE.get(element);
  if (!byScene) {
    byScene = new WeakMap();
    LINE_CACHE.set(element, byScene);
  }
  if (byScene.has(scene)) return byScene.get(scene)!;
  const line = buildLine(element, scene);
  byScene.set(scene, line);
  return line;
}

function buildLine(element: HvacElement, scene: readonly HvacElement[]): RefrigerantLine | null {
  if (!isRefrigerantPipeElementType(element.type)) return null;
  const design = readPipeDesign(element, scene);
  const { nodes, legs } = design;
  if (nodes.length < 2 || legs.length !== nodes.length - 1) return null;
  const dimensions = lineDimensions(element);
  const socketElbows = usesCopperSocketElbows(element.properties);
  const formedRadius = resolveFieldPipeBendRadiusMm(dimensions.outsideDiameterMm, element.properties.bendRadiusFactor);
  const jointAt = new Map(design.joints.map((joint) => [joint.nodeId, joint]));
  const lengths = legs.map((leg) => leg.lengthMm);

  // The fitting at each interior corner, and how far it reaches along the legs either side.
  const fittings = new Map<number, Fitting>();
  for (let index = 1; index < nodes.length - 1; index += 1) {
    const joint = jointAt.get(nodes[index]!.id);
    const incoming = legs[index - 1]!.direction;
    const outgoing = legs[index]!.direction;
    const angleRad = Math.acos(Math.max(-1, Math.min(1, dot(incoming, outgoing))));
    if (!joint || (angleRad * 180) / Math.PI < MIN_BEND_DEG) continue;
    const angleDeg = Math.round((angleRad * 180) / Math.PI);
    const elbow = socketElbows && (Math.abs(angleDeg - 90) <= 1 || Math.abs(angleDeg - 45) <= 1)
      ? resolveCopperSocketElbow(dimensions.tubeOdMm, Math.abs(angleDeg - 90) <= 1 ? 90 : 45) : null;
    const radiusMm = elbow?.centerlineRadiusMm ?? (joint.radiusMm.value > EPSILON ? joint.radiusMm.value : formedRadius);
    const wanted = elbow?.centerToFaceMm ?? radiusMm * Math.tan(angleRad / 2);
    fittings.set(index, { joint, angleRad, radiusMm, faceMm: wanted, catalogueModel: elbow?.catalogueModel ?? null });
  }
  // Two fittings never overlap on one leg: each takes at most half of it (the rest of a short leg stays a straight).
  for (const [index, fitting] of fittings) {
    const room = Math.min(lengths[index - 1]! * (fittings.has(index - 1) ? 0.5 : 1), lengths[index]! * (fittings.has(index + 1) ? 0.5 : 1));
    fitting.faceMm = Math.max(0, Math.min(fitting.faceMm, room));
  }

  const startStub = portStubMm(design.ports.start);
  const endStub = portStubMm(design.ports.end);
  const pieces: RefrigerantPiece[] = [];
  const ordinals = { port: 0, straight: 0, riser: 0, bend: 0 };
  const push = (piece: Omit<RefrigerantPiece, 'ordinal' | 'lengthMm'>) => {
    ordinals[piece.kind] += 1;
    pieces.push({ ...piece, ordinal: ordinals[piece.kind], lengthMm: pathLength(piece.path) });
  };
  const blank = { legId: null, legIndex: null, joint: null, endpoint: null, angleDeg: null, radiusMm: null, takeoffMm: null, catalogueModel: null };
  const lastLeg = legs.length - 1;
  // How much of each end of each leg the fittings (and the port stubs) take.
  const taken = legs.map((_, index) => ({
    start: fittings.get(index)?.faceMm ?? 0,
    end: fittings.get(index + 1)?.faceMm ?? 0,
  }));
  if (startStub !== null) {
    const leg = legs[0]!;
    const reach = Math.max(0, Math.min(startStub, leg.lengthMm - taken[0]!.end));
    if (reach > MIN_STRAIGHT_MM) {
      push({ ...blank, key: 'port:start', kind: 'port', legId: leg.id, legIndex: 0, endpoint: 'start',
        path: [nodes[0]!, add(nodes[0]!, scale(leg.direction, reach))] });
      taken[0]!.start = reach;
    }
  }
  let endPort: Omit<RefrigerantPiece, 'ordinal' | 'lengthMm'> | null = null;
  if (endStub !== null) {
    const leg = legs[lastLeg]!;
    const reach = Math.max(0, Math.min(endStub, leg.lengthMm - taken[lastLeg]!.start));
    if (reach > MIN_STRAIGHT_MM) {
      endPort = { ...blank, key: 'port:end', kind: 'port', legId: leg.id, legIndex: lastLeg, endpoint: 'end',
        path: [sub(nodes[lastLeg + 1]!, scale(leg.direction, reach)), nodes[lastLeg + 1]!] };
      taken[lastLeg]!.end = reach;
    }
  }
  legs.forEach((leg, index) => {
    const from = nodes[index]!;
    const to = nodes[index + 1]!;
    const { start, end } = taken[index]!;
    if (leg.lengthMm - start - end > MIN_STRAIGHT_MM) {
      push({ ...blank, key: `leg:${leg.id}`, kind: Math.abs(leg.direction.z) >= RISER_SINE ? 'riser' : 'straight', legId: leg.id, legIndex: index,
        path: [add(from, scale(leg.direction, start)), sub(to, scale(leg.direction, end))] });
    }
    const fitting = fittings.get(index + 1);
    if (fitting) {
      const next = legs[index + 1]!;
      push({ ...blank, key: `joint:${fitting.joint.id}`, kind: 'bend', joint: fitting.joint,
        path: bendPath(to, leg.direction, next.direction, fitting.angleRad, fitting.radiusMm, fitting.faceMm),
        angleDeg: (fitting.angleRad * 180) / Math.PI, radiusMm: fitting.radiusMm, takeoffMm: fitting.faceMm, catalogueModel: fitting.catalogueModel });
    }
  });
  if (endPort) push(endPort);
  return { elementId: element.id, design, ...dimensions, socketElbows, pieces };
}

export function refrigerantPieceOf(line: RefrigerantLine, key: string): RefrigerantPiece | null {
  return line.pieces.find((piece) => piece.key === key) ?? null;
}

export function neighbourPiece(line: RefrigerantLine, key: string, step: -1 | 1): RefrigerantPiece | null {
  const index = line.pieces.findIndex((piece) => piece.key === key);
  return index < 0 ? null : line.pieces[index + step] ?? null;
}

// ---------------------------------------------------------------------------------------------------- picking

const xy = (point: Vec3): Point2D => ({ x: point.x, y: point.y });

/** The piece's plan polyline (its path seen from above, repeats dropped). */
export function piecePlanPath(piece: RefrigerantPiece): Point2D[] {
  const out: Point2D[] = [];
  for (const point of piece.path) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.5) out.push(xy(point));
  }
  return out;
}

function distanceToPolyline2D(point: Point2D, polyline: readonly Point2D[]): number {
  if (polyline.length === 1) return Math.hypot(point.x - polyline[0]!.x, point.y - polyline[0]!.y);
  let best = Infinity;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1]!;
    const b = polyline[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared > EPSILON ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
    best = Math.min(best, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return best;
}

/** How far a model point is from a centreline (mm). */
export function distanceToPath(point: Vec3, polyline: readonly Vec3[]): number {
  if (polyline.length === 1) return distance(point, polyline[0]!);
  let best = Infinity;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1]!;
    const ab = sub(polyline[index]!, a);
    const squared = dot(ab, ab);
    const t = squared > EPSILON ? Math.max(0, Math.min(1, dot(sub(point, a), ab) / squared)) : 0;
    best = Math.min(best, distance(point, add(a, scale(ab, t))));
  }
  return best;
}

/** Where pieces overlap in plan (a riser under its bends), the smaller fitting wins. */
const PICK_PRIORITY: Record<RefrigerantPieceKind, number> = { riser: 0, bend: 1, port: 2, straight: 3 };

/** The piece under a plan point, within the line's half width and `toleranceMm` of it, or null. */
export function refrigerantPieceAtPlanPoint(line: RefrigerantLine, point: Point2D, toleranceMm = 0): RefrigerantPiece | null {
  const reach = line.halfWidthMm + toleranceMm;
  let best: { piece: RefrigerantPiece; distance: number } | null = null;
  for (const piece of line.pieces) {
    const d = distanceToPolyline2D(point, piecePlanPath(piece));
    if (d > reach) continue;
    if (!best || d < best.distance - 1 || (Math.abs(d - best.distance) <= 1 && PICK_PRIORITY[piece.kind] < PICK_PRIORITY[best.piece.kind])) {
      best = { piece, distance: d };
    }
  }
  return best?.piece ?? null;
}

/** The piece nearest a model point (a pick on the line's surface in 3D), within `reachMm` of its centreline, or null. */
export function refrigerantPieceAtModelPoint(line: RefrigerantLine, point: Vec3, reachMm = line.outsideDiameterMm / 2 + 60): RefrigerantPiece | null {
  let best: { piece: RefrigerantPiece; distance: number } | null = null;
  for (const piece of line.pieces) {
    const d = distanceToPath(point, piece.path);
    if (d <= reachMm && (!best || d < best.distance)) best = { piece, distance: d };
  }
  return best?.piece ?? null;
}

/** The piece of a refrigerant line at a model point on it, as the segment focus of a view, or null. */
export function refrigerantFocusAtPoint(scene: readonly HvacElement[], runId: string, point: Vec3, view: '2d' | '3d'): SegmentFocus | null {
  const element = scene.find((candidate) => candidate.id === runId);
  const line = element ? refrigerantLineOf(element, scene) : null;
  const piece = line ? refrigerantPieceAtModelPoint(line, point) : null;
  return piece ? { domain: 'refrigerant', runId, key: piece.key, anchorMark: null, view } : null;
}

// ---------------------------------------------------------------------------------------------------- outlines

/** A point on the piece half way along it (where a leader line ends). */
export function pieceMidpoint(piece: RefrigerantPiece): Vec3 {
  const half = piece.lengthMm / 2;
  let walked = 0;
  for (let index = 1; index < piece.path.length; index += 1) {
    const a = piece.path[index - 1]!;
    const b = piece.path[index]!;
    const length = distance(a, b);
    if (walked + length >= half && length > EPSILON) return add(a, scale(sub(b, a), (half - walked) / length));
    walked += length;
  }
  return piece.path[0]!;
}

/** The piece as seen from above: a band of the line's width along it, or a disc for a riser. */
export function refrigerantPieceOutline(line: RefrigerantLine, piece: RefrigerantPiece): Point2D[] {
  const path = piecePlanPath(piece);
  const r = line.halfWidthMm;
  if (path.length < 2) {
    const centre = path[0] ?? xy(piece.path[0]!);
    return Array.from({ length: 28 }, (_, index) => {
      const angle = (index / 28) * Math.PI * 2;
      return { x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r };
    });
  }
  const normals = path.map((_, index) => {
    const a = path[Math.max(0, index - 1)]!;
    const b = path[Math.min(path.length - 1, index + 1)]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  });
  const left = path.map((point, index) => ({ x: point.x + normals[index]!.x * r, y: point.y + normals[index]!.y * r }));
  const right = path.map((point, index) => ({ x: point.x - normals[index]!.x * r, y: point.y - normals[index]!.y * r }));
  return [...left, ...right.reverse()];
}

/** Where the piece starts and stops in plan, for the brackets of a pinned piece; none for a riser (its disc says it all). */
export function refrigerantPieceEnds(line: RefrigerantLine, piece: RefrigerantPiece): Array<{ point: Point2D; direction: Point2D; halfWidthMm: number }> {
  const path = piecePlanPath(piece);
  if (path.length < 2) return [];
  const heading = (a: Point2D, b: Point2D) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  };
  return [
    { point: path[0]!, direction: heading(path[0]!, path[1]!), halfWidthMm: line.halfWidthMm },
    { point: path[path.length - 1]!, direction: heading(path[path.length - 2]!, path[path.length - 1]!), halfWidthMm: line.halfWidthMm },
  ];
}

/** The piece's box in model space, the line's outside radius round its centreline. */
export function refrigerantPieceBounds3D(line: RefrigerantLine, piece: RefrigerantPiece): { min: Vec3; max: Vec3 } {
  const r = line.outsideDiameterMm / 2;
  const xs = piece.path.map((point) => point.x);
  const ys = piece.path.map((point) => point.y);
  const zs = piece.path.map((point) => point.z);
  return {
    min: { x: Math.min(...xs) - r, y: Math.min(...ys) - r, z: Math.min(...zs) - r },
    max: { x: Math.max(...xs) + r, y: Math.max(...ys) + r, z: Math.max(...zs) + r },
  };
}
