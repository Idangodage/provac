/**
 * 3D meshes for a duct run, read from the same fabrication plan the plan view
 * and the BOM use: every straight section, elbow and connector as a
 * rectangular sweep, a flange frame at every joint (TDC, Ductmate or angle),
 * the fabric band of the flexible connector and the end cap.
 *
 * World space (model millimetres, z up), like the condensate meshes; no CSG.
 * Geometry is merged per material so a run is a handful of meshes; materials
 * are shared and unowned, geometry is never shared (the lifecycle disposes it).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import type { HvacElement, Point2D } from '../../../../types';
import type { DuctElbow, DuctFabricationPlan, DuctJoint, DuctPiece } from '../duct/ductFabricationPlanner';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { flexPointAt, flexSupportStations, saggedFlexPoints } from '../duct/ductFlex';
import { frameToWorld, sampleArc } from '../duct/ductGeometry';
import { resolveDuctSettings, type DuctDesignSettings } from '../duct/ductSettings';
import { getDuctSupportPlan, type DuctSupportPlan } from '../duct/ductSupports';
import type { DuctPoint3 } from '../duct/ductTypes';

export const DUCT_3D_COLORS = {
  galvanised: '#b9c3cc',
  galvanisedError: '#e3a3a3',
  flange: '#8995a1',
  angle: '#5f6b77',
  fabric: '#34383e',
  cap: '#a6b1bb',
  damper: '#e2a42b',
  flexJacket: '#cdd2d7',
  support: '#6d5a45',
  rod: '#8a8f96',
  insulation: '#1f2226',
} as const;

const MATERIALS = new Map<string, THREE.MeshStandardMaterial>();

function material(color: string, metalness: number, roughness: number): THREE.MeshStandardMaterial {
  const key = `${color}|${metalness}|${roughness}`;
  let cached = MATERIALS.get(key);
  if (!cached) {
    cached = new THREE.MeshStandardMaterial({ color, metalness, roughness, side: THREE.DoubleSide });
    MATERIALS.set(key, cached);
  }
  return cached;
}

/** Plan path of a piece's centreline (necks included). */
function piecePath(piece: DuctPiece): Point2D[] {
  if (piece.kind === 'elbow' && piece.elbow) {
    const elbow = piece.elbow;
    if (elbow.style === 'radius') {
      return [elbow.startPoint, ...sampleArc(elbow, elbow.centrelineRadiusMm, 12), elbow.endPoint];
    }
    return [elbow.startPoint, elbow.corner, elbow.endPoint];
  }
  if (piece.kind === 'offset' && piece.offset) return [...piece.offset.centreline];
  return [piece.start, piece.end];
}

function dedupe(points: Point2D[]): Point2D[] {
  return points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y) > 1e-3);
}

export interface DuctSweepRing {
  point: Point2D;
  /** Plan direction the ring's width is measured along. */
  normal: Point2D;
  halfWidth: number;
  halfHeight: number;
  centreZ: number;
}

/** Open rectangular shell through explicit sections (lofts for transitions and shoes). */
export function sweepRectangularRings(rings: DuctSweepRing[]): THREE.BufferGeometry | null {
  if (rings.length < 2) return null;
  const corners = rings.map((ring) => {
    const side = (sign: number, up: number) => new THREE.Vector3(
      ring.point.x + ring.normal.x * ring.halfWidth * sign, ring.point.y + ring.normal.y * ring.halfWidth * sign, ring.centreZ + up * ring.halfHeight,
    );
    return [side(1, 1), side(-1, 1), side(-1, -1), side(1, -1)];
  });
  return shellFromCorners(corners);
}

function shellFromCorners(rings: THREE.Vector3[][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const pushQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };
  for (let index = 1; index < rings.length; index += 1) {
    const r0 = rings[index - 1]!;
    const r1 = rings[index]!;
    for (let face = 0; face < 4; face += 1) {
      const next = (face + 1) % 4;
      pushQuad(r0[face]!, r0[next]!, r1[next]!, r1[face]!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Open rectangular tube swept along a plan polyline at a fixed centre height.
 * Corners are mitred, so a square elbow's heel and throat come out exact.
 */
export function sweepRectangularTube(points: Point2D[], centreZ: number, halfWidth: number, halfHeight: number): THREE.BufferGeometry | null {
  const path = dedupe(points);
  if (path.length < 2) return null;
  const rings: THREE.Vector3[][] = path.map((point, index) => {
    const before = index > 0 ? path[index - 1]! : null;
    const after = index < path.length - 1 ? path[index + 1]! : null;
    const dIn = before ? unit2({ x: point.x - before.x, y: point.y - before.y }) : null;
    const dOut = after ? unit2({ x: after.x - point.x, y: after.y - point.y }) : null;
    const nIn = dIn ? { x: -dIn.y, y: dIn.x } : null;
    const nOut = dOut ? { x: -dOut.y, y: dOut.x } : null;
    let normal = nIn && nOut ? unit2({ x: nIn.x + nOut.x, y: nIn.y + nOut.y }) : (nIn ?? nOut)!;
    // Mitre: keep the side walls parallel to each leg through the corner.
    const reference = nIn ?? nOut!;
    const cosine = Math.max(0.2, normal.x * reference.x + normal.y * reference.y);
    normal = { x: normal.x / cosine, y: normal.y / cosine };
    const side = (sign: number, up: number) => new THREE.Vector3(
      point.x + normal.x * halfWidth * sign, point.y + normal.y * halfWidth * sign, centreZ + up * halfHeight,
    );
    return [side(1, 1), side(-1, 1), side(-1, -1), side(1, -1)];
  });
  return shellFromCorners(rings);
}

function unit2(v: Point2D): Point2D {
  const length = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / length, y: v.y / length };
}

/**
 * A duct's section frame along a 3D centreline: tangent t, width axis n
 * (always horizontal: square to the segment's plan direction, or `across` for
 * a path in a riser's vertical plane) and height axis u = t × n (up on a level
 * segment). The width stays horizontal through risers and their elbows.
 */
function segmentFrames(points: DuctPoint3[], across?: Point2D): Array<{ t: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3 }> {
  const frames: Array<{ t: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3 }> = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const t = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    const planLength = Math.hypot(t.x, t.y);
    const plan = across ? { x: across.y, y: -across.x } : planLength > 1e-6 ? { x: t.x / planLength, y: t.y / planLength } : { x: 1, y: 0 };
    const n = new THREE.Vector3(-plan.y, plan.x, 0);
    frames.push({ t, n, u: new THREE.Vector3().crossVectors(t, n).normalize() });
  }
  return frames;
}

function dedupe3(points: DuctPoint3[]): DuctPoint3[] {
  return points.filter((point, index) => index === 0
    || Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y, point.z - points[index - 1]!.z) > 1e-3);
}

/**
 * Section outline points around a 3D centreline, mitred at interior points
 * (each incoming ring is carried along its segment onto the bisector plane).
 */
function sectionRings(
  path: DuctPoint3[],
  outline: (index: number) => Array<[number, number]>,
  across?: Point2D,
): THREE.Vector3[][] {
  const frames = segmentFrames(path, across);
  return path.map((point, index) => {
    const incoming = frames[index - 1];
    const outgoing = frames[index];
    const frame = incoming ?? outgoing!;
    const centre = new THREE.Vector3(point.x, point.y, point.z);
    const bisector = incoming && outgoing ? incoming.t.clone().add(outgoing.t).normalize() : null;
    return outline(index).map(([a, b]) => {
      const offset = frame.n.clone().multiplyScalar(a).add(frame.u.clone().multiplyScalar(b));
      if (bisector && bisector.lengthSq() > 1e-9) {
        const along = -offset.dot(bisector) / Math.max(0.2, frame.t.dot(bisector));
        offset.add(frame.t.clone().multiplyScalar(along));
      }
      return centre.clone().add(offset);
    });
  });
}

/**
 * Open rectangular tube along a 3D centreline (risers, vertical elbows and
 * offsets, riser transitions), half sizes per point or constant.
 */
export function sweepRectangularPath3(
  points: DuctPoint3[],
  halves: { halfWidth: number; halfHeight: number } | Array<{ halfWidth: number; halfHeight: number }>,
  across?: Point2D,
): THREE.BufferGeometry | null {
  const path = Array.isArray(halves) ? points : dedupe3(points);
  if (path.length < 2) return null;
  const halfAt = (index: number) => (Array.isArray(halves) ? halves[index]! : halves);
  const rings = sectionRings(path, (index) => {
    const { halfWidth, halfHeight } = halfAt(index);
    return [[halfWidth, halfHeight], [-halfWidth, halfHeight], [-halfWidth, -halfHeight], [halfWidth, -halfHeight]];
  }, across);
  return shellFromCorners(rings);
}

/** Open circular tube along a 3D centreline, radius per point or constant. */
export function sweepCircularPath3(points: DuctPoint3[], radii: number | number[], across?: Point2D): THREE.BufferGeometry | null {
  const path = Array.isArray(radii) ? points : dedupe3(points);
  if (path.length < 2) return null;
  const rings = sectionRings(path, (index) => {
    const radius = Array.isArray(radii) ? radii[index]! : radii;
    const outline: Array<[number, number]> = [];
    for (let k = 0; k < ROUND_SEGMENTS; k += 1) {
      const phi = (2 * Math.PI * k) / ROUND_SEGMENTS;
      outline.push([radius * Math.cos(phi), radius * Math.sin(phi)]);
    }
    return outline;
  }, across);
  return ringShell(rings);
}

function ringShell(rings: THREE.Vector3[][]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let index = 1; index < rings.length; index += 1) {
    const r0 = rings[index - 1]!;
    const r1 = rings[index]!;
    for (let k = 0; k < r0.length; k += 1) {
      const next = (k + 1) % r0.length;
      for (const vertex of [r0[k]!, r0[next]!, r1[next]!, r0[k]!, r1[next]!, r1[k]!]) positions.push(vertex.x, vertex.y, vertex.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Box in a frame (axis along the duct, n across it, z up). */
export interface DuctRoundRing {
  point: Point2D;
  /** Centre height of the ring. */
  z: number;
  radius: number;
}

const ROUND_SEGMENTS = 24;

/**
 * Open circular tube through explicit rings (lofts for round reducers and
 * cones). Rings are square to the plan direction at their point; interior
 * rings are mitred (an ellipse on the bisector plane), so a gored elbow drawn
 * through its seam points shows its gores.
 */
export function sweepCircularRings(rings: DuctRoundRing[]): THREE.BufferGeometry | null {
  if (rings.length < 2) return null;
  const directionAt = (index: number): Point2D => {
    const before = index > 0 ? rings[index]!.point : null;
    const after = index + 1 < rings.length ? rings[index + 1]!.point : null;
    const unitOf = (a: Point2D, b: Point2D) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      return { x: dx / length, y: dy / length };
    };
    const d1 = before ? unitOf(rings[index - 1]!.point, before) : null;
    const d2 = after ? unitOf(rings[index]!.point, after) : null;
    if (d1 && d2) {
      const sum = { x: d1.x + d2.x, y: d1.y + d2.y };
      const length = Math.hypot(sum.x, sum.y);
      return length < 1e-9 ? d1 : { x: sum.x / length, y: sum.y / length };
    }
    return (d1 ?? d2)!;
  };
  const segmentDirection = (index: number): Point2D => {
    const a = rings[Math.max(0, index - (index + 1 < rings.length ? 0 : 1))]!.point;
    const b = rings[Math.min(rings.length - 1, index + (index + 1 < rings.length ? 1 : 0))]!.point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  };
  const corners = rings.map((ring, index) => {
    const bisector = directionAt(index);
    const segment = segmentDirection(index);
    // Across the bisector plane the ring stretches by 1 / cos(half turn).
    const stretch = 1 / Math.max(0.2, Math.abs(bisector.x * segment.x + bisector.y * segment.y));
    const across = { x: -bisector.y, y: bisector.x };
    const points: THREE.Vector3[] = [];
    for (let k = 0; k < ROUND_SEGMENTS; k += 1) {
      const phi = (2 * Math.PI * k) / ROUND_SEGMENTS;
      const a = ring.radius * Math.cos(phi) * stretch;
      points.push(new THREE.Vector3(ring.point.x + across.x * a, ring.point.y + across.y * a, ring.z + ring.radius * Math.sin(phi)));
    }
    return points;
  });
  const positions: number[] = [];
  for (let index = 1; index < corners.length; index += 1) {
    const r0 = corners[index - 1]!;
    const r1 = corners[index]!;
    for (let k = 0; k < ROUND_SEGMENTS; k += 1) {
      const next = (k + 1) % ROUND_SEGMENTS;
      const quad = [r0[k]!, r0[next]!, r1[next]!, r0[k]!, r1[next]!, r1[k]!];
      for (const vertex of quad) positions.push(vertex.x, vertex.y, vertex.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A flat disc square to `axis` (end cap, damper blade). */
function roundDisc(centre: THREE.Vector3, axis: Point2D, radius: number): THREE.BufferGeometry {
  const disc = new THREE.CircleGeometry(radius, ROUND_SEGMENTS);
  // CircleGeometry lies in XY facing +Z: turn +Z onto the plan axis.
  disc.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(axis.x, axis.y, 0).normalize()),
  ));
  disc.applyMatrix4(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z));
  return disc;
}

function orientedBox(centre: THREE.Vector3, axis: Point2D, sizeAxis: number, sizeAcross: number, sizeUp: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(sizeAxis, sizeAcross, sizeUp);
  const n = { x: -axis.y, y: axis.x };
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(axis.x, axis.y, 0),
    new THREE.Vector3(n.x, n.y, 0),
    new THREE.Vector3(0, 0, 1),
  );
  basis.setPosition(centre);
  geometry.applyMatrix4(basis);
  return geometry;
}

/** Flange frame at a joint: four bars around the outside of the section. */
function flangeFrame(joint: DuctJoint, heightMm: number, thicknessMm: number): THREE.BufferGeometry[] {
  const centre = new THREE.Vector3(joint.point.x, joint.point.y, joint.centreZ);
  const n = { x: -joint.direction.y, y: joint.direction.x };
  const w = joint.outerWidthMm;
  const h = joint.outerHeightMm;
  const offset = (across: number, up: number) => centre.clone().add(new THREE.Vector3(n.x * across, n.y * across, up));
  return [
    orientedBox(offset(0, h / 2 + heightMm / 2), joint.direction, thicknessMm, w + 2 * heightMm, heightMm),
    orientedBox(offset(0, -h / 2 - heightMm / 2), joint.direction, thicknessMm, w + 2 * heightMm, heightMm),
    orientedBox(offset(w / 2 + heightMm / 2, 0), joint.direction, thicknessMm, heightMm, h),
    orientedBox(offset(-w / 2 - heightMm / 2, 0), joint.direction, thicknessMm, heightMm, h),
  ];
}

function flangeHeight(joint: DuctJoint): { height: number; thickness: number; angle: boolean } | null {
  const hardware = joint.hardware;
  if (!hardware || joint.kind === 'unit-connection') return null;
  if (hardware.system === 'angle-flange' && hardware.angleMember) {
    return { height: hardware.angleMember.legMm, thickness: 2 * hardware.angleMember.thicknessMm + 3, angle: true };
  }
  if (hardware.system === 'ductmate') return { height: hardware.label.includes('45') ? 45 : hardware.label.includes('35') ? 35 : 25, thickness: 6, angle: false };
  return { height: 30, thickness: 6, angle: false };
}

export interface DuctMeshContext {
  allElements: HvacElement[];
  ductSettings?: DuctDesignSettings;
}

const DEFAULT_SETTINGS = resolveDuctSettings({});

type MeshPush = (name: string, mat: THREE.Material, geometry: THREE.BufferGeometry | null) => void;

/** A gored elbow's centreline in its own coordinates: straight gores between seams, half gores at the ends. */
function goredCentreline(elbow: DuctElbow): Point2D[] {
  const pieces = Math.max(2, elbow.gores ?? 5);
  const theta = (elbow.angleDeg * Math.PI) / 180;
  const step = theta / (pieces - 1);
  const centre = elbow.arcCentre!;
  const startAngle = Math.atan2(elbow.bendStart.y - centre.y, elbow.bendStart.x - centre.x);
  const onArc = (angle: number) => ({
    x: centre.x + Math.cos(startAngle + elbow.turnSign * angle) * elbow.centrelineRadiusMm,
    y: centre.y + Math.sin(startAngle + elbow.turnSign * angle) * elbow.centrelineRadiusMm,
  });
  const points = [elbow.startPoint, elbow.bendStart];
  for (let k = 0; k < pieces - 1; k += 1) points.push(onArc(step / 2 + k * step));
  points.push(elbow.bendEnd, elbow.endPoint);
  return points;
}

/**
 * The 3D centreline of a piece that is not level: a riser piece (straight up
 * or down its plan point) or a fitting in a riser's vertical plane. Null for
 * level pieces, which sweep along their plan path.
 */
export function piecePath3(piece: DuctPiece): DuctPoint3[] | null {
  if (piece.frame) {
    const frame = piece.frame;
    let local: Point2D[] | null = null;
    if (piece.kind === 'elbow' && piece.elbow) {
      const elbow = piece.elbow;
      local = elbow.style === 'square-vaned' ? [elbow.startPoint, elbow.corner, elbow.endPoint]
        : elbow.style === 'gored' ? goredCentreline(elbow)
          : [elbow.startPoint, ...sampleArc(elbow, elbow.centrelineRadiusMm, 12), elbow.endPoint];
    } else if (piece.kind === 'offset' && piece.offset) {
      local = piece.offset.centreline;
    }
    return local ? local.map((point) => frameToWorld(frame, point)) : null;
  }
  if (piece.vertical) return [{ ...piece.start, z: piece.centreZ }, { ...piece.end, z: piece.endCentreZ }];
  return null;
}

/** Riser pieces and vertical-plane fittings: 3D sweeps with the width held horizontal. */
function addVerticalPiece(piece: DuctPiece, path: DuctPoint3[], t: number, metal: THREE.Material, push: MeshPush): void {
  const heading = piece.frame?.heading ?? piece.direction;
  const across = { x: -heading.y, y: heading.x };
  const round = piece.diameterMm !== undefined;
  const halfWidth = piece.widthMm / 2 + t;
  const halfHeight = piece.heightMm / 2 + t;
  const first = path[0]!;
  const last = path[path.length - 1]!;
  const along = (fraction: number): DuctPoint3 => ({
    x: first.x + (last.x - first.x) * fraction, y: first.y + (last.y - first.y) * fraction, z: first.z + (last.z - first.z) * fraction,
  });
  const cap = material(DUCT_3D_COLORS.cap, 0.12, 0.55);
  if (piece.kind === 'end-cap') {
    const centre = new THREE.Vector3(piece.end.x, piece.end.y, piece.endCentreZ);
    push('duct-caps', cap, round ? flatDisc(centre, halfWidth) : orientedBox(centre, heading, 2 * halfHeight, 2 * halfWidth, 2));
    return;
  }
  if (piece.kind === 'transition') {
    // Concentric on a riser: necks at each end, the slope between.
    const neck = Math.min(piece.transition?.neckMm ?? 0, piece.lengthMm / 2);
    const k = piece.lengthMm > 0 ? neck / piece.lengthMm : 0;
    const points = [first, along(k), along(1 - k), last];
    if (round) {
      const r1 = piece.diameterMm! / 2 + t;
      const r2 = (piece.endDiameterMm ?? piece.diameterMm!) / 2 + t;
      push('duct-metal', metal, sweepCircularPath3(points, [r1, r1, r2, r2], across));
    } else {
      const a = { halfWidth, halfHeight };
      const b = { halfWidth: piece.endWidthMm / 2 + t, halfHeight: piece.endHeightMm / 2 + t };
      push('duct-metal', metal, sweepRectangularPath3(points, [a, a, b, b], across));
    }
    return;
  }
  const sweep = (points: DuctPoint3[], grow = 0) => (round
    ? sweepCircularPath3(points, piece.diameterMm! / 2 + t + grow, across)
    : sweepRectangularPath3(points, { halfWidth: halfWidth + grow, halfHeight: halfHeight + grow }, across));
  if (piece.kind === 'connector' && piece.lengthMm > 0) {
    const edge = Math.min(0.45, (piece.connectorMetalMm ?? piece.lengthMm * 0.3) / piece.lengthMm);
    push('duct-metal', metal, sweep([first, along(edge)]));
    push('duct-metal', metal, sweep([along(1 - edge), last]));
    push('duct-fabric', material(DUCT_3D_COLORS.fabric, 0.05, 0.95), sweep([along(edge), along(1 - edge)], 6));
    return;
  }
  push('duct-metal', metal, sweep(path));
  if (piece.kind === 'damper') {
    // One blade across the riser, part open, and the quadrant beside it.
    const mid = along(0.5);
    const centre = new THREE.Vector3(mid.x, mid.y, mid.z);
    const accent = material(DUCT_3D_COLORS.damper, 0.2, 0.5);
    const blade = round ? flatDisc(centre, halfWidth - 3) : orientedBox(centre, heading, 2 * halfHeight - 6, 2 * halfWidth - 6, 2);
    blade.applyMatrix4(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
    blade.applyMatrix4(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(across.x, across.y, 0), Math.PI / 6));
    blade.applyMatrix4(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z));
    push('duct-accessories', accent, blade);
    push('duct-accessories', accent, orientedBox(
      centre.clone().add(new THREE.Vector3(across.x * (halfWidth + 25), across.y * (halfWidth + 25), 0)), heading, 40, 50, 30));
  }
}

/** A horizontal disc (a round cap or damper blade on a riser). */
function flatDisc(centre: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const disc = new THREE.CircleGeometry(radius, ROUND_SEGMENTS);
  disc.applyMatrix4(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z));
  return disc;
}

/** Flange frame on a riser: four flat bars round the section (W across the heading, H along it). */
function flatFlangeFrame(joint: DuctJoint, heightMm: number, thicknessMm: number): THREE.BufferGeometry[] {
  const centre = new THREE.Vector3(joint.point.x, joint.point.y, joint.centreZ);
  const h = joint.direction;
  const n = { x: -h.y, y: h.x };
  const w = joint.outerWidthMm;
  const d = joint.outerHeightMm;
  const at = (along: number, across: number) => centre.clone().add(new THREE.Vector3(h.x * along + n.x * across, h.y * along + n.y * across, 0));
  return [
    orientedBox(at(d / 2 + heightMm / 2, 0), n, w + 2 * heightMm, heightMm, thicknessMm),
    orientedBox(at(-d / 2 - heightMm / 2, 0), n, w + 2 * heightMm, heightMm, thicknessMm),
    orientedBox(at(0, w / 2 + heightMm / 2), h, d, heightMm, thicknessMm),
    orientedBox(at(0, -w / 2 - heightMm / 2), h, d, heightMm, thicknessMm),
  ];
}

/** Round pieces: circular sweeps, lofts and discs (SMACNA chapter 3 fittings). */
function addRoundPiece(piece: DuctPiece, t: number, metal: THREE.Material, push: MeshPush): void {
  const radius = piece.diameterMm! / 2 + t;
  const endRadius = (piece.endDiameterMm ?? piece.diameterMm!) / 2 + t;
  const z = piece.centreZ;
  if (piece.kind === 'end-cap') {
    push('duct-caps', material(DUCT_3D_COLORS.cap, 0.12, 0.55), roundDisc(new THREE.Vector3(piece.end.x, piece.end.y, z), piece.direction, radius));
    return;
  }
  if (piece.kind === 'elbow' && piece.elbow) {
    // Gored: straight pieces between the seams (half gores at the ends), mitred at each seam.
    push('duct-metal', metal, sweepCircularRings(goredCentreline(piece.elbow).map((point) => ({ point, z, radius }))));
    return;
  }
  if (piece.kind === 'offset' && piece.offset) {
    push('duct-metal', metal, sweepCircularRings(piece.offset.centreline.map((point) => ({ point, z, radius }))));
    return;
  }
  if (piece.kind === 'transition') {
    const neck = Math.min(piece.transition?.neckMm ?? 0, piece.lengthMm / 2);
    const at = (distance: number) => ({ x: piece.start.x + piece.direction.x * distance, y: piece.start.y + piece.direction.y * distance });
    // Flat bottom: each ring's centre sits half its own diameter above the shared bottom.
    const ring = (point: Point2D, r: number) => ({ point, z: piece.bottomZ - t + r, radius: r });
    push('duct-metal', metal, sweepCircularRings([
      ring(piece.start, radius), ring(at(neck), radius), ring(at(piece.lengthMm - neck), endRadius), ring(piece.end, endRadius),
    ]));
    return;
  }
  if (piece.kind === 'takeoff' && piece.takeoff?.style === 'conical' && piece.takeoff.openingMm) {
    const mouth = piece.takeoff.openingMm / 2 + t;
    push('duct-metal', metal, sweepCircularRings([
      { point: piece.start, z: piece.bottomZ - t + mouth, radius: mouth }, { point: piece.end, z, radius },
    ]));
    return;
  }
  push('duct-metal', metal, sweepCircularRings([{ point: piece.start, z, radius }, { point: piece.end, z, radius }]));
  if (piece.kind === 'takeoff') {
    // Spin-in bead just outside the parent wall.
    const bead = { x: piece.start.x + piece.direction.x * 25, y: piece.start.y + piece.direction.y * 25 };
    const beadEnd = { x: bead.x + piece.direction.x * 8, y: bead.y + piece.direction.y * 8 };
    push('duct-flanges', material(DUCT_3D_COLORS.flange, 0.15, 0.5), sweepCircularRings([{ point: bead, z, radius: radius + 4 }, { point: beadEnd, z, radius: radius + 4 }]));
  }
  if (piece.kind === 'damper') {
    const mid = new THREE.Vector3((piece.start.x + piece.end.x) / 2, (piece.start.y + piece.end.y) / 2, z);
    const blade = roundDisc(mid, piece.direction, radius - 3);
    const axis = new THREE.Vector3(-piece.direction.y, piece.direction.x, 0);
    blade.applyMatrix4(new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z));
    blade.applyMatrix4(new THREE.Matrix4().makeRotationAxis(axis, Math.PI / 6));
    blade.applyMatrix4(new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z));
    const accent = material(DUCT_3D_COLORS.damper, 0.2, 0.5);
    push('duct-accessories', accent, blade);
    const n = { x: -piece.direction.y, y: piece.direction.x };
    push('duct-accessories', accent, orientedBox(mid.clone().add(new THREE.Vector3(n.x * (radius + 25), n.y * (radius + 25), 0)), piece.direction, 40, 50, 30));
  }
}

/** A vertical rod (a slim cylinder) from `bottomZ` up `lengthMm`. */
function rodGeometry(point: Point2D, bottomZ: number, lengthMm: number, diameterMm: number): THREE.BufferGeometry {
  const rod = new THREE.CylinderGeometry(diameterMm / 2, diameterMm / 2, Math.max(1, lengthMm), 8);
  // CylinderGeometry runs along +Y: stand it on +Z.
  rod.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  rod.applyMatrix4(new THREE.Matrix4().makeTranslation(point.x, point.y, bottomZ + lengthMm / 2));
  return rod;
}

/** Hangers (rods, trapeze angles, round bands) and riser angles. */
export function addDuctSupportMeshes(supports: DuctSupportPlan, push: MeshPush): void {
  const steel = material(DUCT_3D_COLORS.support, 0.2, 0.6);
  const rodMaterial = material(DUCT_3D_COLORS.rod, 0.25, 0.5);
  for (const hanger of supports.hangers) {
    const d = hanger.direction;
    const n = { x: -d.y, y: d.x };
    for (const rod of hanger.rods) push('duct-supports', rodMaterial, rodGeometry(rod.point, rod.bottomZ, rod.lengthMm, hanger.rod?.diameterMm ?? 10));
    if (hanger.bar) {
      // An equal angle under the duct: the flat leg bears on the duct, the upstand stiffens it.
      const { legMm, thicknessMm } = hanger.bar.member;
      const flat = new THREE.Vector3(hanger.point.x, hanger.point.y, hanger.supportZ - thicknessMm / 2);
      push('duct-supports', steel, orientedBox(flat, n, hanger.bar.lengthMm, legMm, thicknessMm));
      const upstand = new THREE.Vector3(hanger.point.x + d.x * (legMm / 2 - thicknessMm / 2), hanger.point.y + d.y * (legMm / 2 - thicknessMm / 2), hanger.supportZ - legMm / 2);
      push('duct-supports', steel, orientedBox(upstand, n, hanger.bar.lengthMm, thicknessMm, legMm));
    } else if (hanger.kind === 'band') {
      const radius = hanger.outerWidthMm / 2 + 1.5;
      const centreZ = hanger.supportZ + hanger.outerHeightMm / 2;
      push('duct-supports', steel, sweepCircularRings([
        { point: { x: hanger.point.x - d.x * 12.5, y: hanger.point.y - d.y * 12.5 }, z: centreZ, radius },
        { point: { x: hanger.point.x + d.x * 12.5, y: hanger.point.y + d.y * 12.5 }, z: centreZ, radius },
      ]));
    }
  }
  for (const riser of supports.risers) {
    const h = riser.heading;
    const n = { x: -h.y, y: h.x };
    const leg = riser.member === 'L40×4' ? 40 : 50;
    for (const side of [1, -1]) {
      const centre = new THREE.Vector3(riser.point.x + h.x * side * (riser.outerHeightMm / 2 + leg / 2), riser.point.y + h.y * side * (riser.outerHeightMm / 2 + leg / 2), riser.z);
      push('duct-supports', steel, orientedBox(centre, n, riser.lengthMm, leg, leg));
    }
  }
}

/**
 * A flexible runout as installed: a corrugated tube (its jacket on an insulated
 * form) along its curve, sagging between the supports.
 */
function addFlexMeshes(piece: DuctPiece, push: MeshPush): void {
  const flex = piece.flex!;
  const radius = piece.widthMm / 2 + flex.jacketMm;
  const supports = flexSupportStations(piece.lengthMm);
  const sagged = saggedFlexPoints({ points: flex.points, stations: flex.stations, lengthMm: piece.lengthMm }, supports);
  // Resample about every 25 mm so the corrugations read.
  const samples = Math.max(8, Math.round(piece.lengthMm / 25));
  const points = Array.from({ length: samples + 1 }, (_, index) => flexPointAt({ points: sagged, stations: flex.stations }, (piece.lengthMm * index) / samples));
  const radii = points.map((_, index) => radius + (index % 2 === 0 ? 1.5 : -1.5));
  const heading = { x: points[points.length - 1]!.x - points[0]!.x, y: points[points.length - 1]!.y - points[0]!.y };
  const across = Math.hypot(heading.x, heading.y) > 1 ? undefined : { x: 1, y: 0 };
  push('duct-flex', material(flex.type === 'm-un' ? DUCT_3D_COLORS.galvanised : DUCT_3D_COLORS.flexJacket, flex.type === 'm-un' ? 0.3 : 0.15, 0.55),
    sweepCircularPath3(points, radii, across));
}

/** One piece's sheet metal and its accessories, with the sheet `t` thick (grown by the insulation for its skin). */
function addPieceMeshes(piece: DuctPiece, t: number, metal: THREE.Material, push: MeshPush): void {
  if (piece.kind === 'flex' && piece.flex) {
    addFlexMeshes(piece, push);
    return;
  }
  const path3 = piecePath3(piece);
  if (path3) {
    addVerticalPiece(piece, path3, t, metal, push);
    return;
  }
  if (piece.diameterMm !== undefined) {
    addRoundPiece(piece, t, metal, push);
    return;
  }
  const halfWidth = piece.widthMm / 2 + t;
  const halfHeight = piece.heightMm / 2 + t;
  if (piece.kind === 'end-cap') {
    const centre = new THREE.Vector3(piece.end.x, piece.end.y, piece.centreZ);
    push('duct-caps', material(DUCT_3D_COLORS.cap, 0.12, 0.55), orientedBox(centre, piece.direction, 2, 2 * halfWidth, 2 * halfHeight));
    return;
  }
  if (piece.kind === 'plenum' && piece.plenum) {
    // The box: its sides, the blank far face, and the back face round the duct inlet.
    push('duct-metal', metal, sweepRectangularTube([piece.start, piece.end], piece.centreZ, halfWidth, halfHeight));
    const caps = material(DUCT_3D_COLORS.cap, 0.12, 0.55);
    push('duct-caps', caps, orientedBox(new THREE.Vector3(piece.end.x, piece.end.y, piece.centreZ), piece.direction, 2, 2 * halfWidth, 2 * halfHeight));
    const bottom = piece.centreZ - halfHeight;
    const inletW = Math.min(piece.plenum.inletWidthMm, 2 * halfWidth);
    const inletH = Math.min(piece.plenum.inletHeightMm, 2 * halfHeight);
    const n = { x: -piece.direction.y, y: piece.direction.x };
    const back = (across: number, up: number, width: number, height: number) => {
      if (width < 1 || height < 1) return;
      push('duct-caps', caps, orientedBox(new THREE.Vector3(piece.start.x + n.x * across, piece.start.y + n.y * across, up), piece.direction, 2, width, height));
    };
    back(0, bottom + inletH + (2 * halfHeight - inletH) / 2, 2 * halfWidth, 2 * halfHeight - inletH);
    const side = (2 * halfWidth - inletW) / 2;
    back(inletW / 2 + side / 2, bottom + inletH / 2, side, inletH);
    back(-(inletW / 2 + side / 2), bottom + inletH / 2, side, inletH);
    return;
  }
  if (piece.kind === 'connector') {
    const metalEdge = piece.connectorMetalMm ?? piece.lengthMm * 0.3;
    const d = piece.direction;
    const along = (distance: number) => ({ x: piece.start.x + d.x * distance, y: piece.start.y + d.y * distance });
    push('duct-metal', metal, sweepRectangularTube([piece.start, along(metalEdge)], piece.centreZ, halfWidth, halfHeight));
    push('duct-metal', metal, sweepRectangularTube([along(piece.lengthMm - metalEdge), piece.end], piece.centreZ, halfWidth, halfHeight));
    push('duct-fabric', material(DUCT_3D_COLORS.fabric, 0.05, 0.95),
      sweepRectangularTube([along(metalEdge), along(piece.lengthMm - metalEdge)], piece.centreZ, halfWidth + 6, halfHeight + 6));
    return;
  }
  if (piece.kind === 'transition') {
    const n = { x: -piece.direction.y, y: piece.direction.x };
    const neck = Math.min(piece.transition?.neckMm ?? 0, piece.lengthMm / 2);
    const at = (distance: number) => ({ x: piece.start.x + piece.direction.x * distance, y: piece.start.y + piece.direction.y * distance });
    const ring = (point: Point2D, width: number, height: number): DuctSweepRing => ({
      point, normal: n, halfWidth: width / 2 + t, halfHeight: height / 2 + t, centreZ: piece.bottomZ + height / 2,
    });
    push('duct-metal', metal, sweepRectangularRings([
      ring(piece.start, piece.widthMm, piece.heightMm), ring(at(neck), piece.widthMm, piece.heightMm),
      ring(at(piece.lengthMm - neck), piece.endWidthMm, piece.endHeightMm), ring(piece.end, piece.endWidthMm, piece.endHeightMm),
    ]));
    return;
  }
  if (piece.kind === 'takeoff' && piece.takeoff && piece.takeoff.leadInMm > 0) {
    const u = piece.direction;
    const v = piece.takeoff.parentDirection;
    const lead = Math.min(piece.takeoff.leadInMm, piece.lengthMm);
    const n = { x: -u.y, y: u.x };
    const at = (a: number, b: number) => ({ x: piece.start.x + u.x * a + v.x * b, y: piece.start.y + u.y * a + v.y * b });
    push('duct-metal', metal, sweepRectangularRings([
      { point: at(0, -lead / 2), normal: n, halfWidth: halfWidth + lead / 2, halfHeight, centreZ: piece.centreZ },
      { point: at(lead, 0), normal: n, halfWidth, halfHeight, centreZ: piece.centreZ },
      { point: at(piece.lengthMm, 0), normal: n, halfWidth, halfHeight, centreZ: piece.centreZ },
    ]));
    return;
  }
  if (piece.kind === 'damper') {
    push('duct-metal', metal, sweepRectangularTube([piece.start, piece.end], piece.centreZ, halfWidth, halfHeight));
    const mid = new THREE.Vector3((piece.start.x + piece.end.x) / 2, (piece.start.y + piece.end.y) / 2, piece.centreZ);
    const accent = material(DUCT_3D_COLORS.damper, 0.2, 0.5);
    // SMACNA Fig. 2-12 single blade, or Fig. 2-13 opposed blades stacked over the height, drawn part open.
    const blades = piece.damper?.blades ?? 1;
    const chord = (2 * halfHeight - 6) / blades;
    const axis = new THREE.Vector3(-piece.direction.y, piece.direction.x, 0);
    for (let index = 0; index < blades; index += 1) {
      const centre = mid.clone().add(new THREE.Vector3(0, 0, -halfHeight + 3 + chord * (index + 0.5)));
      const blade = orientedBox(centre, piece.direction, 2, 2 * halfWidth - 6, chord);
      blade.applyMatrix4(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
      blade.applyMatrix4(new THREE.Matrix4().makeRotationAxis(axis, (index % 2 === 0 ? 1 : -1) * Math.PI / 6));
      blade.applyMatrix4(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z));
      push('duct-accessories', accent, blade);
    }
    const n = { x: -piece.direction.y, y: piece.direction.x };
    push('duct-accessories', accent, orientedBox(
      mid.clone().add(new THREE.Vector3(n.x * (halfWidth + 25), n.y * (halfWidth + 25), 0)), piece.direction, 40, 50, 30));
    return;
  }
  if (piece.kind === 'split' && piece.split) {
    const split = piece.split;
    const parentHalfWidth = split.parentSection.widthMm / 2 + t;
    const parentHalfHeight = split.parentSection.heightMm / 2 + t;
    const centreZ = split.bottomZ + split.parentSection.heightMm / 2;
    if (split.style === 'bullhead') {
      const far = { x: split.origin.x + split.direction.x * split.depthMm, y: split.origin.y + split.direction.y * split.depthMm };
      push('duct-metal', metal, sweepRectangularTube([split.origin, far], centreZ, parentHalfWidth, parentHalfHeight));
      push('duct-caps', material(DUCT_3D_COLORS.cap, 0.12, 0.55),
        orientedBox(new THREE.Vector3(far.x, far.y, centreZ), split.direction, 2, 2 * parentHalfWidth, 2 * parentHalfHeight));
    } else {
      for (const branch of split.branches) {
        if (!branch.elbow) return;
        const elbow = branch.elbow;
        const path = [elbow.startPoint, ...sampleArc(elbow, elbow.centrelineRadiusMm, 12), elbow.endPoint];
        push('duct-metal', metal, sweepRectangularTube(path, split.bottomZ + branch.section.heightMm / 2, branch.section.widthMm / 2 + t, branch.section.heightMm / 2 + t));
      }
      for (const side of split.cappedSides) {
        const n = split.normal;
        const centre = new THREE.Vector3(split.origin.x + n.x * side * parentHalfWidth / 2, split.origin.y + n.y * side * parentHalfWidth / 2, centreZ);
        push('duct-caps', material(DUCT_3D_COLORS.cap, 0.12, 0.55), orientedBox(centre, split.direction, 2, parentHalfWidth, 2 * parentHalfHeight));
      }
    }
    return;
  }
  push('duct-metal', metal, sweepRectangularTube(piecePath(piece), piece.centreZ, halfWidth, halfHeight));
}
/** Build the run's meshes into `group` (which must sit at the world origin). */
export function addDuctRunMeshes(group: THREE.Group, element: HvacElement, context: DuctMeshContext): DuctFabricationPlan | null {
  const plan = getDuctRunPlan(element, context.allElements, context.ductSettings ?? DEFAULT_SETTINGS);
  if (!plan) return null;
  const buckets = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  const push = (name: string, mat: THREE.Material, geometry: THREE.BufferGeometry | null) => {
    if (!geometry) return;
    const bucket = buckets.get(name) ?? { material: mat, parts: [] };
    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    if (geometry.index) geometry.dispose();
    // Position and normal only: boxes and discs carry UVs the swept shells do not, and a bucket must merge.
    if (part.getAttribute('uv')) part.deleteAttribute('uv');
    bucket.parts.push(part);
    buckets.set(name, bucket);
  };
  // Low metalness: the scene has no environment map, and a metallic material
  // without one renders near-black instead of galvanised grey.
  const metal = material(plan.status === 'error' ? DUCT_3D_COLORS.galvanisedError : DUCT_3D_COLORS.galvanised, 0.12, 0.5);
  for (const piece of plan.pieces) addPieceMeshes(piece, piece.sheetThicknessMm ?? 1, metal, push);
  // NBR: a black skin at the insulation's outer face over every piece but the flexible connector.
  if (plan.insulationMm > 0) {
    const skin = material(DUCT_3D_COLORS.insulation, 0, 0.92);
    const skinPush: MeshPush = (name, _mat, geometry) => {
      if (name === 'duct-metal' || name === 'duct-caps') push('duct-insulation', skin, geometry);
      else geometry?.dispose();
    };
    for (const piece of plan.pieces) {
      // The connector must flex; a flexible runout carries its own jacket.
      if (piece.kind === 'connector' || piece.kind === 'split' || piece.kind === 'flex') continue;
      addPieceMeshes(piece, (piece.sheetThicknessMm ?? 1) + plan.insulationMm, skin, skinPush);
    }
  }
  for (const joint of plan.joints) {
    if (joint.hardware?.system === 'round-slip' || joint.hardware?.system === 'round-takeoff') {
      // Round slip joint: an RT-1 sleeve (102 mm) or an RT-5 crimp bead just proud of the duct.
      if (joint.hardware.system === 'round-takeoff') continue;
      const sleeve = (joint.hardware.sleeves ?? 0) > 0;
      const reach = sleeve ? 51 : 6;
      const radius = joint.outerWidthMm / 2 + 1.5;
      if (joint.vertical) {
        const at = (dz: number): DuctPoint3 => ({ x: joint.point.x, y: joint.point.y, z: joint.centreZ + dz });
        push('duct-flanges', material(DUCT_3D_COLORS.flange, 0.15, 0.5),
          sweepCircularPath3([at(-reach), at(reach)], radius, { x: -joint.direction.y, y: joint.direction.x }));
        continue;
      }
      const along = (distance: number) => ({ x: joint.point.x + joint.direction.x * distance, y: joint.point.y + joint.direction.y * distance });
      push('duct-flanges', material(DUCT_3D_COLORS.flange, 0.15, 0.5), sweepCircularRings([
        { point: along(-reach), z: joint.centreZ, radius }, { point: along(reach), z: joint.centreZ, radius },
      ]));
      continue;
    }
    const flange = flangeHeight(joint);
    if (!flange) continue;
    const mat = material(flange.angle ? DUCT_3D_COLORS.angle : DUCT_3D_COLORS.flange, 0.15, 0.5);
    const frame = joint.vertical ? flatFlangeFrame(joint, flange.height, flange.thickness) : flangeFrame(joint, flange.height, flange.thickness);
    for (const part of frame) push('duct-flanges', mat, part);
  }
  const settings = context.ductSettings ?? DEFAULT_SETTINGS;
  if (settings.showSupports) addDuctSupportMeshes(getDuctSupportPlan(plan, context.allElements, settings), push);
  for (const [name, bucket] of buckets) {
    const merged = bucket.parts.length === 1 ? bucket.parts[0]! : mergeGeometries(bucket.parts, false);
    if (bucket.parts.length > 1) bucket.parts.forEach((part) => part.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.name = name;
    mesh.renderOrder = 16;
    group.add(mesh);
  }
  group.userData.ductPlanStatus = plan.status;
  return plan;
}
