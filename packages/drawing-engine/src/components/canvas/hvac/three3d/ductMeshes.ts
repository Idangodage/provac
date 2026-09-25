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
import type { DuctFabricationPlan, DuctJoint, DuctPiece } from '../duct/ductFabricationPlanner';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { sampleArc } from '../duct/ductGeometry';
import { resolveDuctSettings, type DuctDesignSettings } from '../duct/ductSettings';

export const DUCT_3D_COLORS = {
  galvanised: '#b9c3cc',
  galvanisedError: '#e3a3a3',
  flange: '#8995a1',
  angle: '#5f6b77',
  fabric: '#34383e',
  cap: '#a6b1bb',
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
  return [piece.start, piece.end];
}

function dedupe(points: Point2D[]): Point2D[] {
  return points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y) > 1e-3);
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

function unit2(v: Point2D): Point2D {
  const length = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / length, y: v.y / length };
}

/** Box in a frame (axis along the duct, n across it, z up). */
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

/** Build the run's meshes into `group` (which must sit at the world origin). */
export function addDuctRunMeshes(group: THREE.Group, element: HvacElement, context: DuctMeshContext): DuctFabricationPlan | null {
  const plan = getDuctRunPlan(element, context.allElements, context.ductSettings ?? DEFAULT_SETTINGS);
  if (!plan) return null;
  const buckets = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  const push = (name: string, mat: THREE.Material, geometry: THREE.BufferGeometry | null) => {
    if (!geometry) return;
    const bucket = buckets.get(name) ?? { material: mat, parts: [] };
    bucket.parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
    if (geometry.index) geometry.dispose();
    buckets.set(name, bucket);
  };
  // Low metalness: the scene has no environment map, and a metallic material
  // without one renders near-black instead of galvanised grey.
  const metal = material(plan.status === 'error' ? DUCT_3D_COLORS.galvanisedError : DUCT_3D_COLORS.galvanised, 0.12, 0.5);
  for (const piece of plan.pieces) {
    const t = piece.sheetThicknessMm ?? 1;
    const halfWidth = piece.widthMm / 2 + t;
    const halfHeight = piece.heightMm / 2 + t;
    if (piece.kind === 'end-cap') {
      const centre = new THREE.Vector3(piece.end.x, piece.end.y, piece.centreZ);
      push('duct-caps', material(DUCT_3D_COLORS.cap, 0.12, 0.55), orientedBox(centre, piece.direction, 2, 2 * halfWidth, 2 * halfHeight));
      continue;
    }
    if (piece.kind === 'connector') {
      const metalEdge = piece.connectorMetalMm ?? piece.lengthMm * 0.3;
      const d = piece.direction;
      const along = (distance: number) => ({ x: piece.start.x + d.x * distance, y: piece.start.y + d.y * distance });
      push('duct-metal', metal, sweepRectangularTube([piece.start, along(metalEdge)], piece.centreZ, halfWidth, halfHeight));
      push('duct-metal', metal, sweepRectangularTube([along(piece.lengthMm - metalEdge), piece.end], piece.centreZ, halfWidth, halfHeight));
      push('duct-fabric', material(DUCT_3D_COLORS.fabric, 0.05, 0.95),
        sweepRectangularTube([along(metalEdge), along(piece.lengthMm - metalEdge)], piece.centreZ, halfWidth + 6, halfHeight + 6));
      continue;
    }
    push('duct-metal', metal, sweepRectangularTube(piecePath(piece), piece.centreZ, halfWidth, halfHeight));
  }
  for (const joint of plan.joints) {
    const flange = flangeHeight(joint);
    if (!flange) continue;
    const mat = material(flange.angle ? DUCT_3D_COLORS.angle : DUCT_3D_COLORS.flange, 0.15, 0.5);
    for (const part of flangeFrame(joint, flange.height, flange.thickness)) push('duct-flanges', mat, part);
  }
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
