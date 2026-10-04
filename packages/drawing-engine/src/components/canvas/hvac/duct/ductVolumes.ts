/**
 * Duct bodies as boxes, for clash checks against pipes and other ducts. Every
 * piece of a run's fabrication plan becomes one or more oriented boxes along
 * its centreline (arcs, offsets and risers in short segments): outside the
 * sheet and its insulation, width held horizontal. Pipes are the pipe
 * engine's insulated tubes (capsules), so a duct-to-pipe clash is a
 * segment-to-box distance below the tube radius; duct to duct is a
 * separating-axis overlap. Body interference only (not flanges or hangers).
 * Air terminals add their plenum box above the ceiling face.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { getDuctRunPlan, type DuctFabricationPlan, type DuctPiece } from './ductFabricationPlanner';
import { frameToWorld, sampleArc } from './ductGeometry';
import type { DuctDesignSettings } from './ductSettings';
import { isDuctTerminalElement, readDuctTerminalSpec, terminalSpigotPort } from './ductTerminals';
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
  if (piece.kind === 'flex' && piece.flex) {
    // Every few samples along the runout: short boxes hugging the curve.
    const points = piece.flex.points.filter((_, index, all) => index % 4 === 0 || index === all.length - 1);
    return { points };
  }
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
    const skin = piece.kind === 'flex' ? (piece.flex?.jacketMm ?? 0) : t + plan.insulationMm;
    const halfWidth = width / 2 + skin;
    const halfHeight = height / 2 + skin;
    for (let index = 1; index < line.points.length; index += 1) {
      const next = box(plan.elementId, piece.mark, line.points[index - 1]!, line.points[index]!, halfWidth, halfHeight, line.across);
      if (next) boxes.push(next);
    }
  }
  BOX_CACHE.set(plan, boxes);
  return boxes;
}

/** An air terminal's plenum box, above its face (the face sits in the ceiling). */
export function terminalBoxOf(element: HvacElement): DuctBox | null {
  const spec = readDuctTerminalSpec(element);
  if (!spec) return null;
  const radians = ((element.rotation ?? 0) * Math.PI) / 180;
  const axisX = { x: Math.cos(radians), y: Math.sin(radians) };
  const axisY = { x: -Math.sin(radians), y: Math.cos(radians) };
  const centre = {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
    z: element.elevation + spec.faceHeightMm + spec.plenumHeightMm / 2,
  };
  const half = spec.plenumWidthMm / 2;
  return box(element.id, 'plenum box',
    { x: centre.x - axisX.x * half, y: centre.y - axisX.y * half, z: centre.z },
    { x: centre.x + axisX.x * half, y: centre.y + axisX.y * half, z: centre.z },
    spec.plenumDepthMm / 2, spec.plenumHeightMm / 2, axisY);
}

/** Terminal face, plenum and projecting neck share the renderer's local frame. */
export function terminalBoxesOf(element: HvacElement): DuctBox[] {
  const spec = readDuctTerminalSpec(element);
  const plenum = terminalBoxOf(element);
  if (!spec || !plenum) return [];
  const centre = { ...plenum.centre, z: element.elevation + spec.faceHeightMm / 2 };
  const half = spec.faceWidthMm / 2;
  const face = box(element.id, 'terminal face', add(centre, scale(plenum.axisT, -half)),
    add(centre, scale(plenum.axisT, half)), spec.faceDepthMm / 2, spec.faceHeightMm / 2, plenum.axisN);
  const port = terminalSpigotPort(element);
  const neck = port ? box(element.id, 'terminal neck',
    { x: port.lip.x - port.normal.x * spec.spigotLengthMm, y: port.lip.y - port.normal.y * spec.spigotLengthMm, z: port.lip.z },
    port.lip, spec.neckDiameterMm / 2, spec.neckDiameterMm / 2) : null;
  return [plenum, ...face ? [face] : [], ...neck ? [neck] : []];
}

/** Equipment casing envelope in world mm, rotated about its footprint centre.
 * Port fittings, service-access zones and branch-kit fittings need their own
 * geometry; a branch kit's nominal placement box is not its physical body. */
export function equipmentBoxOf(element: HvacElement): DuctBox | null {
  if (['duct', 'diffuser', 'return-grille', 'refrigerant-pipe', 'refrigerant-pipe-pair',
    'condensate-pipe', 'condensate-gully', 'refrigerant-branch-kit'].includes(element.type)) return null;
  if (![element.width, element.depth, element.height, element.elevation, element.position.x, element.position.y].every(Number.isFinite)
    || element.width <= 0 || element.depth <= 0 || element.height <= 0) return null;
  const angle = (element.rotation ?? 0) * Math.PI / 180;
  const along = { x: Math.cos(angle), y: Math.sin(angle), z: 0 };
  const across = { x: -along.y, y: along.x };
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2,
    z: element.elevation + element.height / 2 };
  return box(element.id, 'equipment casing', add(centre, scale(along, -element.width / 2)),
    add(centre, scale(along, element.width / 2)), element.depth / 2, element.height / 2, across);
}

export function equipmentBoxesInScene(elements: readonly HvacElement[]): DuctBox[] {
  return elements.flatMap(element => { const body = equipmentBoxOf(element); return body ? [body] : []; });
}

/** Every duct body and air-terminal box in the scene (the pipe engine's obstacles). */
export function ductBoxesInScene(elements: readonly HvacElement[], settings: DuctDesignSettings): DuctBox[] {
  const boxes: DuctBox[] = [];
  for (const element of elements) {
    if (isDuctTerminalElement(element)) {
      boxes.push(...terminalBoxesOf(element));
      continue;
    }
    if (!isDuctElement(element)) continue;
    const plan = getDuctRunPlan(element, elements, settings);
    if (plan) boxes.push(...ductBoxesOf(plan));
  }
  return boxes;
}

/** Shared physical envelopes for pipe, drain and duct coordination. */
export function solidBoxesInScene(elements: readonly HvacElement[], settings: DuctDesignSettings): DuctBox[] {
  return [...ductBoxesInScene(elements, settings), ...equipmentBoxesInScene(elements)];
}

function boundsOverlap(a: DuctBox['bounds'], b: DuctBox['bounds'], margin = 0): boolean {
  return a.minX <= b.maxX + margin && b.minX <= a.maxX + margin && a.minY <= b.maxY + margin && b.minY <= a.maxY + margin
    && a.minZ <= b.maxZ + margin && b.minZ <= a.maxZ + margin;
}

/** Distance from a point to the box (0 inside). */
export function pointBoxDistance(point: Vec3, target: DuctBox): number {
  const d = sub(point, target.centre);
  const outside = (value: number, half: number) => Math.max(0, Math.abs(value) - half);
  return Math.hypot(outside(dot(d, target.axisT), target.halfLength), outside(dot(d, target.axisN), target.halfWidth), outside(dot(d, target.axisU), target.halfHeight));
}

/**
 * Exact distance from a segment to an oriented box. In box coordinates the
 * squared distance is sum(max(abs(a_i + t*d_i) - h_i, 0)^2). Its active terms
 * change only at the six slab crossings. On each interval its derivative is
 * linear, so its stationary point and endpoints give the exact minimum.
 */
export function segmentBoxDistance(a: Vec3, b: Vec3, target: DuctBox): { distance: number; point: Vec3 } {
  const axes = [target.axisT, target.axisN, target.axisU];
  const half = [target.halfLength, target.halfWidth, target.halfHeight];
  const origin = axes.map(axis => dot(sub(a, target.centre), axis));
  const delta = axes.map(axis => dot(sub(b, a), axis));
  const cuts = [0, 1];
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(delta[axis]!) < 1e-12) continue;
    for (const sign of [-1, 1]) {
      const t = (sign * half[axis]! - origin[axis]!) / delta[axis]!;
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((x, y) => x - y);
  let bestT = 0;
  let bestSquared = Number.POSITIVE_INFINITY;
  const consider = (t: number) => {
    const squared = origin.reduce((sum, value, axis) => sum + Math.max(0, Math.abs(value + t * delta[axis]!) - half[axis]!) ** 2, 0);
    if (squared < bestSquared) { bestSquared = squared; bestT = t; }
  };
  cuts.forEach(consider);
  for (let index = 1; index < cuts.length; index += 1) {
    const lo = cuts[index - 1]!; const hi = cuts[index]!; const middle = (lo + hi) / 2;
    let numerator = 0; let denominator = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = origin[axis]! + middle * delta[axis]!;
      if (Math.abs(value) <= half[axis]!) continue;
      numerator += delta[axis]! * (origin[axis]! - Math.sign(value) * half[axis]!);
      denominator += delta[axis]! ** 2;
    }
    if (denominator > 0) consider(Math.max(lo, Math.min(hi, -numerator / denominator)));
  }
  return { distance: Math.sqrt(bestSquared), point: add(a, scale(sub(b, a), bestT)) };
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
  /** The duct run or air terminal whose solid envelope is obstructed. */
  ductId: string;
  mark: string;
  otherId: string;
  kind: 'pipe' | 'duct' | 'terminal' | 'equipment';
  service?: string;
  point: Vec3;
}

/** Only the planned attachment may overlap its parent; downstream loops remain solid. */
function attachmentContact(plan: DuctFabricationPlan, candidate: DuctBox, parentId: string): boolean {
  if (ductParentRunId(plan.spec) !== parentId || !plan.tap) return false;
  const piece = plan.pieces.find(item => item.mark === candidate.mark);
  const start = plan.spec.path[0];
  return piece?.kind === 'takeoff' && !!start
    && Math.hypot(start.x - plan.tap.wallPoint.x, start.y - plan.tap.wallPoint.y) <= 5;
}

/** Carve only the initial straight collar corridor out of its owning casing.
 * A connected run coming back through that same unit is still an obstruction. */
function afterUnitCollar(candidate: DuctBox, plan: DuctFabricationPlan, body: DuctBox): DuctBox | null {
  const port = plan.startPort;
  if (!port || port.unitId !== body.elementId || plan.spec.start.kind !== 'unit-port') return candidate;
  const piece = plan.pieces.find(item => item.mark === candidate.mark);
  if (piece?.legIndex !== 0 || piece.widthMm > port.widthMm + 1 || piece.heightMm > port.heightMm + 1) return candidate;
  const normal = { ...port.normal, z: 0 };
  if (dot(candidate.axisT, normal) < 1 - 1e-8) return candidate;
  const start = add(candidate.centre, scale(candidate.axisT, -candidate.halfLength));
  const startStation = dot(sub(start, port.lip), normal);
  if (startStation < -1 || norm(sub(sub(start, port.lip), scale(normal, startStation))) > 1) return candidate;
  const axes = [body.axisT, body.axisN, body.axisU];
  const halves = [body.halfLength, body.halfWidth, body.halfHeight];
  let exit = Number.POSITIVE_INFINITY;
  for (let index = 0; index < axes.length; index += 1) {
    const coordinate = dot(sub(port.lip, body.centre), axes[index]!);
    if (Math.abs(coordinate) > halves[index]! + 1) return candidate;
    const advance = dot(normal, axes[index]!);
    if (Math.abs(advance) > 1e-8) exit = Math.min(exit, (Math.sign(advance) * halves[index]! - coordinate) / advance);
  }
  // A stored port buried deeper than its actual collar is not an intentional
  // connection through the casing, even when it belongs to this unit.
  if (!Number.isFinite(exit) || exit > port.collarDepthMm + 1 || exit <= startStation) return candidate;
  const trim = Math.min(candidate.halfLength * 2, exit - startStation);
  return box(candidate.elementId, candidate.mark, add(start, scale(normal, trim)),
    add(candidate.centre, scale(candidate.axisT, candidate.halfLength)), candidate.halfWidth, candidate.halfHeight, candidate.axisN);
}

/**
 * Every duct body clash in the scene: against the pipe engine's insulated
 * tubes (refrigerant and condensate), against other duct runs, and against
 * terminal and equipment bodies. Explicit connections receive local socket
 * allowances, never a blanket exemption for the connected elements.
 */
export function findDuctClashes(
  elements: readonly HvacElement[],
  settings: DuctDesignSettings,
  pipeLanes: ReadonlyArray<{ elementId: string; service: string; radiusMm: number; segments: ReadonlyArray<{ a: Vec3; b: Vec3 }> }>,
): DuctClash[] {
  const ducts = elements.filter(isDuctElement);
  const terminals = new Map<string, DuctBox[]>();
  for (const element of elements) {
    if (isDuctTerminalElement(element)) terminals.set(element.id, terminalBoxesOf(element));
  }
  if (ducts.length === 0 && terminals.size === 0) return [];
  const boxesByRun = new Map<string, DuctBox[]>();
  const plansByRun = new Map<string, DuctFabricationPlan>();
  for (const duct of ducts) {
    const plan = getDuctRunPlan(duct, elements, settings);
    if (plan) { boxesByRun.set(duct.id, ductBoxesOf(plan)); plansByRun.set(duct.id, plan); }
  }
  const clashes: DuctClash[] = [];
  const seen = new Set<string>();
  const bodies: Array<[string, DuctBox[]]> = [...boxesByRun, ...terminals];
  for (const [ductId, boxes] of bodies) {
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
      search: for (const boxA of boxesByRun.get(a.id)!) {
        for (const boxB of boxesByRun.get(b.id)!) {
          if (attachmentContact(plansByRun.get(a.id)!, boxA, b.id) || attachmentContact(plansByRun.get(b.id)!, boxB, a.id)) continue;
          if (boxesOverlap(boxA, boxB)) {
            clashes.push({ ductId: a.id, mark: boxA.mark, otherId: b.id, kind: 'duct', point: scale(add(boxA.centre, boxB.centre), 0.5) });
            break search;
          }
        }
      }
    }
  }
  for (const [runId, boxes] of boxesByRun) {
    const end = readDuctRunSpec(ducts.find((duct) => duct.id === runId)!)?.end;
    for (const [terminalId, terminalBodies] of terminals) {
      const serves = end?.kind === 'terminal' && end.terminalId === terminalId;
      for (const body of terminalBodies) {
        // The run meets the projecting socket, not the entire plenum or face.
        // Its final centreline ends at the neck lip, so only the final piece
        // (including a flexible runout) may share that connection envelope.
        const lastMark = plansByRun.get(runId)?.pieces.at(-1)?.mark;
        const hit = boxes.find(candidate => !(serves && body.mark === 'terminal neck' && candidate.mark === lastMark) && boxesOverlap(candidate, body));
        if (hit) { clashes.push({ ductId: runId, mark: hit.mark, otherId: terminalId, kind: 'terminal', point: scale(add(hit.centre, body.centre), 0.5) }); break; }
      }
    }
  }
  const equipment = equipmentBoxesInScene(elements);
  for (const [runId, boxes] of boxesByRun) {
    for (const body of equipment) {
      const plan = plansByRun.get(runId)!;
      const hit = boxes.find(candidate => { const outside = afterUnitCollar(candidate, plan, body); return outside && boxesOverlap(outside, body); });
      if (hit) clashes.push({ ductId: runId, mark: hit.mark, otherId: body.elementId, kind: 'equipment', point: scale(add(hit.centre, body.centre), 0.5) });
    }
  }
  const terminalEntries = [...terminals];
  for (let index = 0; index < terminalEntries.length; index += 1) {
    const [terminalId, boxes] = terminalEntries[index]!;
    const otherBodies: Array<[string, DuctBox[], 'equipment' | 'terminal']> = [
      ...equipment.map((body): [string, DuctBox[], 'equipment'] => [body.elementId, [body], 'equipment']),
      ...terminalEntries.slice(index + 1).map(([id, bodies]): [string, DuctBox[], 'terminal'] => [id, bodies, 'terminal']),
    ];
    for (const [otherId, bodies, kind] of otherBodies) {
      const hit = boxes.find(candidate => bodies.some(body => boxesOverlap(candidate, body)));
      if (hit) clashes.push({ ductId: terminalId, mark: hit.mark, otherId, kind, point: hit.centre });
    }
  }
  return clashes;
}
